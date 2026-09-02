/*
 * Autopay mandates.
 *
 * A mandate is a standing instruction: at the end of each cycle the charge is
 * debited automatically, without the customer doing anything.
 *
 * The safety rules matter more than the convenience, because this moves money
 * on its own:
 *
 *   - Every mandate has an approved ceiling. A merchant that raises its price
 *     above that ceiling is NOT charged; the mandate is parked for review. A
 *     standing instruction the customer cannot bound is not a mandate, it is a
 *     blank cheque.
 *   - A debit that cannot be funded is skipped, never forced. The account is
 *     never pushed negative and the attempt is recorded.
 *   - A cycle is only advanced when money actually moved, so a skipped charge
 *     is retried rather than silently lost.
 *   - Cancelling is immediate and always available.
 */

const store = require("./db");
const money = require("./money");
const notify = require("./notify");


const { db, nowISO, fromMinor } = store;
const { MoneyError, atomically } = money;

/* Headroom above the observed price, so a small rise does not need re-approval. */
const DEFAULT_CAP_MULTIPLIER = 1.2;

const CADENCE_DAYS = {
  weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, yearly: 365
};

const publicMandate = m => ({
  id: m.id,
  payee: m.payee,
  amount: fromMinor(m.amount),
  maxAmount: fromMinor(m.max_amount),
  cadence: m.cadence,
  nextDue: m.next_due,
  until: m.until,
  status: m.status,
  chargesMade: m.charges_made,
  totalPaid: fromMinor(m.total_paid),
  lastCharged: m.last_charged,
  lastError: m.last_error
});

/* ---------- setting one up ---------- */

function createMandate({ userId, accountId, payee, amount, cadence, maxAmount, until }) {
  const name = String(payee || "").trim();
  if (!name) throw new MoneyError("Which payee is this autopay for?");

  const days = CADENCE_DAYS[cadence];
  if (!days) throw new MoneyError("Choose a valid billing cycle.");

  const minor = money.parseAmount(amount);
  const cap = maxAmount
    ? money.parseAmount(maxAmount)
    : Math.round(minor * DEFAULT_CAP_MULTIPLIER);

  if (cap < minor) {
    throw new MoneyError("The approved limit cannot be below the charge amount.");
  }

  const existing = db.prepare(
    "SELECT * FROM mandates WHERE user_id = ? AND payee = ?"
  ).get(userId, name);

  if (existing && existing.status !== "cancelled") {
    throw new MoneyError("Autopay is already set up for this payee.");
  }

  const nextDue = new Date();
  nextDue.setDate(nextDue.getDate() + days);

  /*
   * Cancelling keeps the row so its history survives, and the table holds one
   * mandate per payee. Turning autopay back on therefore revives that row —
   * inserting a second one would collide with the uniqueness constraint.
   *
   * The counters reset because this is a new arrangement; the money actually
   * paid stays on the transaction ledger, which is what the customer is shown.
   */
  if (existing) {
    db.prepare(
      `UPDATE mandates
       SET account_id = ?, amount = ?, max_amount = ?, cadence = ?, cadence_days = ?,
           next_due = ?, until = ?, status = 'active',
           charges_made = 0, total_paid = 0, last_charged = NULL, last_error = NULL,
           created_at = ?
       WHERE id = ?`
    ).run(accountId, minor, cap, cadence, days, nextDue.toISOString(),
          until || null, nowISO(), existing.id);

    return existing.id;
  }

  const info = db.prepare(
    `INSERT INTO mandates
       (user_id, account_id, payee, amount, max_amount, cadence, cadence_days,
        next_due, until, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(userId, accountId, name, minor, cap, cadence, days,
        nextDue.toISOString(), until || null, nowISO());

  return Number(info.lastInsertRowid);
}

const listMandates = userId =>
  db.prepare("SELECT * FROM mandates WHERE user_id = ? ORDER BY status, next_due")
    .all(userId).map(publicMandate);

const getMandate = (id, userId) =>
  db.prepare("SELECT * FROM mandates WHERE id = ? AND user_id = ?").get(id, userId);

function setMandateStatus(id, userId, status) {
  const mandate = getMandate(id, userId);
  if (!mandate) throw new MoneyError("Autopay not found.", 404);
  if (mandate.status === "cancelled") throw new MoneyError("This autopay is already cancelled.");

  if (!["active", "paused", "cancelled"].includes(status)) {
    throw new MoneyError("Unknown autopay status.");
  }

  // Resuming after a price rise clears the flag; the new price is now approved.
  db.prepare("UPDATE mandates SET status = ?, last_error = NULL WHERE id = ?")
    .run(status, id);
  return true;
}

/* Raising the ceiling is how a customer approves a price increase. */
function updateMandateCap(id, userId, maxAmount) {
  const mandate = getMandate(id, userId);
  if (!mandate) throw new MoneyError("Autopay not found.", 404);

  const cap = money.parseAmount(maxAmount);
  if (cap < mandate.amount) {
    throw new MoneyError("The approved limit cannot be below the charge amount.");
  }

  db.prepare(
    `UPDATE mandates SET max_amount = ?, status = 'active', last_error = NULL WHERE id = ?`
  ).run(cap, id);
  return true;
}

/* ---------- stop-payment instructions ---------- */

/*
 * Refuses future automatic debits from a merchant.
 *
 * This is what a bank can genuinely do. It does NOT end the customer's
 * contract with the merchant — only the merchant can do that — so anything
 * shown alongside it has to say so plainly, or a customer will stop paying a
 * service they are still signed up for and fall into arrears.
 */
function stopPayingPayee({ userId, payee, reason }) {
  const name = String(payee || "").trim();
  if (!name) throw new MoneyError("Which payee should we stop paying?");

  db.prepare(
    `INSERT OR IGNORE INTO blocked_payees (user_id, payee, reason, created_at)
     VALUES (?,?,?,?)`
  ).run(userId, name, reason || null, nowISO());

  // Any live mandate for them ends with it.
  db.prepare(
    `UPDATE mandates SET status = 'cancelled'
     WHERE user_id = ? AND LOWER(payee) = LOWER(?) AND status <> 'cancelled'`
  ).run(userId, name);

  return true;
}

function resumePayingPayee(userId, payee) {
  db.prepare("DELETE FROM blocked_payees WHERE user_id = ? AND LOWER(payee) = LOWER(?)")
    .run(userId, String(payee).trim());
  return true;
}

const isPayeeBlocked = (userId, payee) => Boolean(
  db.prepare("SELECT 1 FROM blocked_payees WHERE user_id = ? AND LOWER(payee) = LOWER(?)")
    .get(userId, String(payee).trim()));

const listBlockedPayees = userId =>
  db.prepare("SELECT * FROM blocked_payees WHERE user_id = ? ORDER BY payee").all(userId);

/* ---------- paying a cycle early ---------- */

/*
 * Debits the next charge now instead of waiting for the cycle to end, and
 * moves the cycle on so the customer is not billed twice for it.
 */
function payInAdvance(id, userId) {
  const mandate = getMandate(id, userId);
  if (!mandate) throw new MoneyError("Autopay not found.", 404);
  if (mandate.status === "cancelled") {
    throw new MoneyError("This autopay has been cancelled.");
  }
  if (isPayeeBlocked(userId, mandate.payee)) {
    throw new MoneyError(`Payments to ${mandate.payee} are stopped.`);
  }

  const account = store.getAccountById(mandate.account_id);
  if (account.balance < mandate.amount) {
    throw new MoneyError("Insufficient balance to pay this in advance.");
  }

  return atomically(() => {
    store.adjustBalance(account.id, -mandate.amount);

    store.recordTransaction({
      accountId: account.id, direction: "out", amount: mandate.amount,
      balanceAfter: store.getAccountById(account.id).balance,
      counterpartyName: mandate.payee,
      method: "Autopay", category: money.categorise(mandate.payee),
      description: `${mandate.payee} · paid in advance`,
      reference: "ADV" + Date.now().toString(36).toUpperCase(),
      createdAt: nowISO()
    });

    const next = new Date(mandate.next_due);
    next.setDate(next.getDate() + mandate.cadence_days);

    db.prepare(
      `UPDATE mandates
       SET next_due = ?, charges_made = charges_made + 1, total_paid = total_paid + ?,
           last_charged = ?, last_error = NULL
       WHERE id = ?`
    ).run(next.toISOString(), mandate.amount, nowISO(), id);

    return {
      paid: mandate.amount,
      nextDue: next.toISOString(),
      balance: store.getAccountById(account.id).balance
    };
  });
}

/* ---------- the collection run ---------- */

/*
 * Charges every mandate whose cycle has ended.
 *
 * Returns a summary rather than throwing, because one customer's failed debit
 * must not stop everyone else's from being collected.
 */
function collectDueMandates() {
  const due = db.prepare(
    "SELECT * FROM mandates WHERE status = 'active' AND next_due <= ?"
  ).all(nowISO());

  const result = { charged: 0, skipped: 0, flagged: 0, total: 0 };

  for (const mandate of due) {
    // A stop-payment instruction outranks the mandate.
    if (isPayeeBlocked(mandate.user_id, mandate.payee)) {
      db.prepare(
        "UPDATE mandates SET status = 'cancelled', last_error = ? WHERE id = ?"
      ).run(`Payments to ${mandate.payee} are stopped.`, mandate.id);
      continue;
    }

    // An expired mandate stops on its own.
    if (mandate.until && new Date(mandate.until) < new Date()) {
      db.prepare("UPDATE mandates SET status = 'cancelled' WHERE id = ?").run(mandate.id);
      continue;
    }

    /*
     * What the merchant is charging now: the most recent real charge from
     * this payee, whatever it was.
     *
     * This deliberately does NOT go through subscription detection. The cap is
     * a safety limit and must hold even when the payee's cadence has drifted
     * and the pattern is no longer recognised — otherwise a price rise that
     * also disturbed the rhythm would slip past the very check meant to catch
     * it, and the old amount would be charged instead.
     */
    const latest = db.prepare(
      `SELECT amount FROM transactions
       WHERE account_id = ? AND direction = 'out'
         AND LOWER(IFNULL(counterparty_name,'')) = LOWER(?)
         AND method <> 'Autopay'
       ORDER BY created_at DESC LIMIT 1`
    ).get(mandate.account_id, mandate.payee);

    const chargeMinor = latest ? latest.amount : mandate.amount;

    if (chargeMinor > mandate.max_amount) {
      db.prepare(
        `UPDATE mandates SET status = 'needs_review', last_error = ? WHERE id = ?`
      ).run(
        `${mandate.payee} now charges ₹${fromMinor(chargeMinor).toLocaleString("en-IN")}, ` +
        `above your approved limit of ₹${fromMinor(mandate.max_amount).toLocaleString("en-IN")}. ` +
        `Nothing was debited.`,
        mandate.id);
      notify.notify(mandate.user_id, {
        kind: "autopay_blocked", severity: "critical",
        title: `${mandate.payee} raised its price — nothing was debited`,
        body: `They now charge ₹${fromMinor(chargeMinor).toLocaleString("en-IN")}, ` +
          `above your approved limit of ` +
          `₹${fromMinor(mandate.max_amount).toLocaleString("en-IN")}. ` +
          `Approve the new limit or cancel.`,
        link: "#/dashboard"
      });
      result.flagged++;
      continue;
    }

    const account = store.getAccountById(mandate.account_id);
    if (!account || account.balance < chargeMinor) {
      // Leave next_due where it is so the charge is retried, not lost.
      db.prepare("UPDATE mandates SET last_error = ? WHERE id = ?").run(
        `Not enough balance on ${new Date().toLocaleDateString("en-IN")} to pay ` +
        `₹${fromMinor(chargeMinor).toLocaleString("en-IN")}. We will try again.`,
        mandate.id);
      notify.notify(mandate.user_id, {
        kind: "autopay_failed", severity: "warning",
        title: `Autopay for ${mandate.payee} could not be collected`,
        body: `₹${fromMinor(chargeMinor).toLocaleString("en-IN")} could not be taken — ` +
          `not enough balance. We will try again.`,
        link: "#/dashboard"
      });
      result.skipped++;
      continue;
    }

    atomically(() => {
      store.adjustBalance(account.id, -chargeMinor);

      store.recordTransaction({
        accountId: account.id, direction: "out", amount: chargeMinor,
        balanceAfter: store.getAccountById(account.id).balance,
        counterpartyName: mandate.payee,
        method: "Autopay", category: money.categorise(mandate.payee),
        description: `${mandate.payee} · autopay`,
        reference: "AP" + Date.now().toString(36).toUpperCase(),
        createdAt: nowISO()
      });

      // Only a successful debit moves the cycle on.
      const next = new Date(mandate.next_due);
      next.setDate(next.getDate() + mandate.cadence_days);

      db.prepare(
        `UPDATE mandates
         SET next_due = ?, charges_made = charges_made + 1, total_paid = total_paid + ?,
             last_charged = ?, amount = ?, last_error = NULL
         WHERE id = ?`
      ).run(next.toISOString(), chargeMinor, nowISO(), chargeMinor, mandate.id);
    });

    notify.notify(mandate.user_id, {
      kind: "autopay_charged", severity: "info",
      title: `${mandate.payee} — ₹${fromMinor(chargeMinor).toLocaleString("en-IN")} paid`,
      body: "Collected automatically by your autopay instruction.",
      link: "#/statement"
    });

    result.charged++;
    result.total += chargeMinor;
  }

  return result;
}

module.exports = {
  createMandate, listMandates, getMandate, setMandateStatus, updateMandateCap,
  stopPayingPayee, resumePayingPayee, isPayeeBlocked, listBlockedPayees, payInAdvance,
  collectDueMandates, publicMandate, CADENCE_DAYS, DEFAULT_CAP_MULTIPLIER
};
