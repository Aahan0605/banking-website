/*
 * Zero-touch servicing.
 *
 * The work a bank actually spends its people on is not payments — it is
 * everything after: "money debited but not received", "I was charged twice",
 * "I paid the wrong person", and printing certificates over a counter. This
 * module resolves those in software, and escalates to a human only when the
 * case genuinely needs judgement.
 */

const store = require("./db");
const money = require("./money");

const { db, nowISO, fromMinor } = store;
const { MoneyError, atomically } = money;

/*
 * How long an outbound payment to another bank may stay unsettled before we
 * reverse it ourselves. RBI's turnaround-time rules give banks until the next
 * calendar day for failed UPI debits; we mirror that.
 */
const SETTLEMENT_WINDOW_HOURS = Number(process.env.SETTLEMENT_WINDOW_HOURS || 24);

/* A repeat of the same payee and amount within this window reads as a slip. */
const DUPLICATE_WINDOW_MINUTES = 5;

const RECALL_DAYS = 3;

const REASONS = {
  not_received: "Beneficiary did not receive it",
  duplicate: "Charged more than once",
  wrong_amount: "Wrong amount debited",
  unauthorised: "I did not authorise this"
};

const ticketFor = prefix => prefix + Date.now().toString(36).toUpperCase();

/* Indian digit grouping with paise, for anything the customer reads. */
const rupees = minor => "₹" + fromMinor(minor).toLocaleString("en-IN",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const logEvent = (disputeId, label, detail, automated = true) =>
  db.prepare(
    `INSERT INTO dispute_events (dispute_id, label, detail, automated, created_at)
     VALUES (?,?,?,?,?)`
  ).run(disputeId, label, detail || null, automated ? 1 : 0, nowISO());

/* ---------- disputes ---------- */

/*
 * Finds an earlier debit that looks like the same payment repeated — same
 * counterparty, same amount, minutes apart.
 */
function findDuplicateOf(tx) {
  const since = new Date(new Date(tx.created_at).getTime()
    - DUPLICATE_WINDOW_MINUTES * 60000).toISOString();

  return db.prepare(
    `SELECT * FROM transactions
     WHERE account_id = ? AND id <> ? AND direction = 'out'
       AND amount = ? AND IFNULL(counterparty_number,'') = IFNULL(?,'')
       AND created_at BETWEEN ? AND ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(tx.account_id, tx.id, tx.amount, tx.counterparty_number, since, tx.created_at);
}

/* Credits the customer back and writes the ledger entry for it. */
function reverse(dispute, tx, narration) {
  store.adjustBalance(tx.account_id, tx.amount);

  store.recordTransaction({
    accountId: tx.account_id, direction: "in", amount: tx.amount,
    balanceAfter: store.getAccountById(tx.account_id).balance,
    counterpartyNumber: tx.counterparty_number,
    counterpartyName: "AB Pay dispute resolution",
    method: "Auto-reversal", category: "Refund",
    description: narration, reference: dispute.ticket
  });

  db.prepare(
    `UPDATE disputes SET status='auto_resolved', outcome=?, refunded=?, resolved_at=?
     WHERE id=?`
  ).run(narration, tx.amount, nowISO(), dispute.id);
}

/*
 * Raises a dispute and immediately tries to settle it.
 *
 * The branches below are the whole point: each one is a case that would
 * otherwise become a phone call.
 */
function raiseDispute({ userId, accountId, transactionId, reason }) {
  if (!REASONS[reason]) throw new MoneyError("Choose a valid reason.");

  const tx = store.getTransaction(transactionId);
  if (!tx || tx.account_id !== accountId) {
    throw new MoneyError("Transaction not found.", 404);
  }
  if (tx.direction !== "out") {
    throw new MoneyError("Only payments you sent can be disputed.");
  }

  const existing = db.prepare(
    "SELECT * FROM disputes WHERE transaction_id = ? AND status <> 'closed'"
  ).get(transactionId);
  if (existing) throw new MoneyError("A dispute is already open on this payment.");

  return atomically(() => {
    const windowEnds = new Date(new Date(tx.created_at).getTime()
      + SETTLEMENT_WINDOW_HOURS * 3600000).toISOString();

    const info = db.prepare(
      `INSERT INTO disputes
         (user_id, account_id, transaction_id, reason, status, ticket, window_ends, created_at)
       VALUES (?,?,?,?,'awaiting_window',?,?,?)`
    ).run(userId, accountId, transactionId, reason,
          ticketFor("DSP"), windowEnds, nowISO());

    const dispute = db.prepare("SELECT * FROM disputes WHERE id = ?")
      .get(Number(info.lastInsertRowid));

    logEvent(dispute.id, "Dispute raised", REASONS[reason]);
    logEvent(dispute.id, "Checking payment record",
      `${rupees(tx.amount)} to ${tx.counterparty_name || tx.counterparty_number}`);

    /* 1. Charged twice — refund the repeat on the spot. */
    const twin = findDuplicateOf(tx);
    if (twin) {
      logEvent(dispute.id, "Duplicate detected",
        `An identical debit was made minutes earlier (ref ${twin.reference}).`);
      reverse(dispute, tx, "Duplicate payment refunded automatically");
      logEvent(dispute.id, "Refunded", `${rupees(tx.amount)} credited back.`);
      return dispute.id;
    }

    /* 2. Fraud claims are the one case a machine should not close alone. */
    if (reason === "unauthorised") {
      const card = store.getCard(accountId);
      if (card && card.status === "active") {
        db.prepare("UPDATE cards SET status='blocked' WHERE id=?").run(card.id);
        logEvent(dispute.id, "Card blocked", "Debit card frozen to stop further loss.");
      }
      db.prepare(
        "UPDATE disputes SET status='escalated', needs_human=1, outcome=? WHERE id=?"
      ).run("Referred to the fraud team with the full transaction trail", dispute.id);

      logEvent(dispute.id, "Escalated to fraud team",
        "Unauthorised-use claims are reviewed by a person.", false);
      return dispute.id;
    }

    /*
     * 3. The money reached another AB Pay customer, so it did arrive. The
     *    bank has no right to claw it back — offer a recall instead.
     */
    const internalPayee = tx.counterparty_number
      ? store.getAccountByNumber(tx.counterparty_number)
      : null;

    if (internalPayee) {
      db.prepare(
        "UPDATE disputes SET status='closed', outcome=?, resolved_at=? WHERE id=?"
      ).run("Payment was delivered — request a recall from the payee instead",
            nowISO(), dispute.id);

      logEvent(dispute.id, "Beneficiary credited",
        "The payee's account was credited, so this was not a failed payment.");
      logEvent(dispute.id, "Recall available",
        "You can ask the payee to return it from the Support page.");
      return dispute.id;
    }

    /* 4. Left the bank and the settlement window has lapsed — reverse it. */
    if (new Date(windowEnds) <= new Date()) {
      logEvent(dispute.id, "Settlement window lapsed",
        `No confirmation within ${SETTLEMENT_WINDOW_HOURS} hours.`);
      reverse(dispute, tx, "Unsettled payment reversed automatically");
      logEvent(dispute.id, "Refunded", `${rupees(tx.amount)} credited back.`);
      return dispute.id;
    }

    /* 5. Still inside the window — hold, and let the sweep settle it. */
    logEvent(dispute.id, "Awaiting settlement",
      `If it is not confirmed by ${new Date(windowEnds).toLocaleString("en-IN")}, ` +
      `it is refunded automatically. No follow-up needed.`);
    return dispute.id;
  });
}

/*
 * Refunds every dispute whose settlement window has passed. Runs on its own,
 * so a customer never has to chase one.
 */
function sweepDisputes() {
  const due = db.prepare(
    "SELECT * FROM disputes WHERE status='awaiting_window' AND window_ends < ?"
  ).all(nowISO());

  for (const dispute of due) {
    const tx = store.getTransaction(dispute.transaction_id);
    atomically(() => {
      logEvent(dispute.id, "Settlement window lapsed",
        `No confirmation within ${SETTLEMENT_WINDOW_HOURS} hours.`);
      reverse(dispute, tx, "Unsettled payment reversed automatically");
      logEvent(dispute.id, "Refunded", `${rupees(tx.amount)} credited back.`);
    });
  }
  return due.length;
}

const listDisputes = userId => db.prepare(
  "SELECT * FROM disputes WHERE user_id = ? ORDER BY created_at DESC"
).all(userId);

const disputeEvents = disputeId => db.prepare(
  "SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY id"
).all(disputeId);

/* ---------- recalls ---------- */

/* Asks whoever was paid to send it back. Only works within AB Pay. */
function requestRecall({ accountId, transactionId, reason }) {
  const tx = store.getTransaction(transactionId);
  if (!tx || tx.account_id !== accountId) {
    throw new MoneyError("Transaction not found.", 404);
  }
  if (tx.direction !== "out") {
    throw new MoneyError("Only payments you sent can be recalled.");
  }

  const payee = tx.counterparty_number
    ? store.getAccountByNumber(tx.counterparty_number)
    : null;
  if (!payee) {
    throw new MoneyError(
      "This went to an account at another bank, which we cannot recall from. " +
      "Raise a dispute instead.");
  }

  const open = db.prepare(
    "SELECT 1 FROM recalls WHERE transaction_id = ? AND status = 'pending'"
  ).get(transactionId);
  if (open) throw new MoneyError("A recall is already pending on this payment.");

  const info = db.prepare(
    `INSERT INTO recalls
       (transaction_id, payer_account_id, payee_account_id, amount, reason, created_at, deadline)
     VALUES (?,?,?,?,?,?,?)`
  ).run(transactionId, accountId, payee.id, tx.amount, reason || null, nowISO(),
        new Date(Date.now() + RECALL_DAYS * 864e5).toISOString());

  return Number(info.lastInsertRowid);
}

/* The payee agrees; the money goes back with a ledger entry on both sides. */
function returnRecall(id, byAccountId) {
  const recall = db.prepare("SELECT * FROM recalls WHERE id = ?").get(id);
  if (!recall) throw new MoneyError("Recall not found.", 404);
  if (recall.payee_account_id !== byAccountId) {
    throw new MoneyError("Only the person who received the money can return it.", 403);
  }
  if (recall.status !== "pending") {
    throw new MoneyError(`This recall is already ${recall.status}.`);
  }

  const payee = store.getAccountById(recall.payee_account_id);
  if (payee.balance < recall.amount) {
    throw new MoneyError("Your balance is not enough to return this payment.");
  }

  return atomically(() => {
    store.adjustBalance(recall.payee_account_id, -recall.amount);
    store.adjustBalance(recall.payer_account_id, recall.amount);

    const payer = store.getAccountById(recall.payer_account_id);
    const ref = "RCL" + recall.id;

    store.recordTransaction({
      accountId: recall.payee_account_id, direction: "out", amount: recall.amount,
      balanceAfter: store.getAccountById(recall.payee_account_id).balance,
      counterpartyNumber: payer.number, counterpartyName: "Recall returned",
      method: "Recall", category: "Refund",
      description: "Returned a payment received in error", reference: ref
    });

    store.recordTransaction({
      accountId: recall.payer_account_id, direction: "in", amount: recall.amount,
      balanceAfter: store.getAccountById(recall.payer_account_id).balance,
      counterpartyNumber: payee.number, counterpartyName: "Recall returned",
      method: "Recall", category: "Refund",
      description: "Payment returned by the payee", reference: ref
    });

    db.prepare("UPDATE recalls SET status='returned', settled_at=? WHERE id=?")
      .run(nowISO(), id);
    return true;
  });
}

function declineRecall(id, byAccountId) {
  const recall = db.prepare("SELECT * FROM recalls WHERE id = ?").get(id);
  if (!recall) throw new MoneyError("Recall not found.", 404);
  if (recall.payee_account_id !== byAccountId) {
    throw new MoneyError("Only the person who received the money can decline.", 403);
  }
  if (recall.status !== "pending") {
    throw new MoneyError(`This recall is already ${recall.status}.`);
  }
  db.prepare("UPDATE recalls SET status='declined', settled_at=? WHERE id=?")
    .run(nowISO(), id);
  return true;
}

function expireRecalls() {
  const due = db.prepare(
    "SELECT id FROM recalls WHERE status='pending' AND deadline < ?"
  ).all(nowISO());

  for (const row of due) {
    db.prepare("UPDATE recalls SET status='expired', settled_at=? WHERE id=?")
      .run(nowISO(), row.id);
  }
  return due.length;
}

const listRecalls = accountId => db.prepare(
  `SELECT r.*, pa.number AS payer_number, pe.number AS payee_number
   FROM recalls r
   JOIN accounts pa ON pa.id = r.payer_account_id
   JOIN accounts pe ON pe.id = r.payee_account_id
   WHERE r.payer_account_id = ? OR r.payee_account_id = ?
   ORDER BY r.created_at DESC`
).all(accountId, accountId);

/* ---------- instant documents ---------- */

const DOCUMENTS = {
  interest_certificate: "Interest certificate",
  balance_certificate: "Balance confirmation certificate",
  account_summary: "Account summary"
};

/* Indian financial year containing the given date: 1 April to 31 March. */
function financialYear(date = new Date()) {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return {
    label: `${year}-${String(year + 1).slice(2)}`,
    from: `${year}-04-01`,
    to: `${year + 1}-03-31`
  };
}

/*
 * Interest credited in the year, plus interest accrued so far on deposits
 * that have not matured — the figure people need for a tax return.
 */
function interestFor(userId, accountId, fy) {
  const credited = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE account_id = ? AND direction = 'in' AND category = 'Investments'
       AND created_at BETWEEN ? AND ?`
  ).get(accountId, fy.from, fy.to + "T23:59:59.999Z").total;

  const deposits = db.prepare(
    "SELECT * FROM deposits WHERE user_id = ? AND status = 'active'"
  ).all(userId);

  let accrued = 0;
  for (const d of deposits) {
    const months = Math.max(0,
      (Date.now() - new Date(d.opened_at)) / (30 * 864e5));
    accrued += Math.round(d.principal * (d.rate / 100) * (Math.min(months, d.tenure_months) / 12));
  }

  return { credited: Number(credited), accrued, deposits };
}

function issueDocument({ user, account, kind }) {
  if (!DOCUMENTS[kind]) throw new MoneyError("Unknown document type.");

  const fy = financialYear();
  const reference = ticketFor("DOC");

  const info = db.prepare(
    `INSERT INTO documents (user_id, kind, period_from, period_to, reference, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(user.id, kind, fy.from, fy.to, reference, nowISO());

  return { id: Number(info.lastInsertRowid), reference, kind, fy };
}

/* Renders a document as plain text, ready to download or print. */
function renderDocument(doc, user, account) {
  const rupees = minor => "INR " + fromMinor(minor).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const issued = new Date(doc.created_at).toLocaleString("en-IN");
  const fy = { label: `${doc.period_from.slice(0, 4)}-${doc.period_to.slice(2, 4)}`,
               from: doc.period_from, to: doc.period_to };

  const head = [
    "AB PAY",
    DOCUMENTS[doc.kind].toUpperCase(),
    "",
    `Reference       : ${doc.reference}`,
    `Issued          : ${issued}`,
    `Customer        : ${user.name} ${user.surname}`,
    `Account number  : ${account.number}`,
    `IFSC            : ${account.ifsc}`,
    `Branch          : ${user.branch || "-"}`,
    user.pan ? `PAN             : ${user.pan}` : null,
    "",
    "-".repeat(64),
    ""
  ].filter(Boolean);

  let body = [];

  if (doc.kind === "interest_certificate") {
    const { credited, accrued, deposits } = interestFor(user.id, account.id, fy);
    body = [
      `Financial year  : ${fy.label} (${fy.from} to ${fy.to})`,
      "",
      `Interest credited during the year : ${rupees(credited)}`,
      `Interest accrued, not yet paid    : ${rupees(accrued)}`,
      `Total interest income             : ${rupees(credited + accrued)}`,
      "",
      "Active deposits",
      ...(deposits.length === 0 ? ["  None"] : deposits.map(d =>
        `  ${d.kind}  ${rupees(d.principal)}  @ ${d.rate.toFixed(2)}%  ` +
        `${d.tenure_months} months  matures ${d.maturity_at.slice(0, 10)}`))
    ];
  }

  if (doc.kind === "balance_certificate") {
    body = [
      `This is to certify that the account below is maintained with AB Pay`,
      `and held the following balance as at ${issued}.`,
      "",
      `Account type    : ${account.account_type}`,
      `Closing balance : ${rupees(account.balance)}`,
      "",
      "Issued on the customer's request for their own records."
    ];
  }

  if (doc.kind === "account_summary") {
    const txs = store.listTransactions(account.id, { limit: 25 });
    const credits = txs.filter(t => t.direction === "in")
      .reduce((s, t) => s + t.amount, 0);
    const debits = txs.filter(t => t.direction === "out")
      .reduce((s, t) => s + t.amount, 0);

    body = [
      `Closing balance : ${rupees(account.balance)}`,
      `Credits (last ${txs.length}) : ${rupees(credits)}`,
      `Debits  (last ${txs.length}) : ${rupees(debits)}`,
      "",
      "Recent transactions",
      ...txs.map(t =>
        `  ${t.created_at.slice(0, 10)}  ${(t.direction === "out" ? "-" : "+")}` +
        `${fromMinor(t.amount).toFixed(2).padStart(12)}  ${t.description || ""}`)
    ];
  }

  return head.concat(body, [
    "",
    "-".repeat(64),
    "Issued electronically by AB Pay. No signature is required.",
    "This is a demonstration application and holds no real money."
  ]).join("\n");
}

const listDocuments = userId => db.prepare(
  "SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC"
).all(userId);

const getDocument = (id, userId) => db.prepare(
  "SELECT * FROM documents WHERE id = ? AND user_id = ?"
).get(id, userId);

module.exports = {
  REASONS, DOCUMENTS, SETTLEMENT_WINDOW_HOURS, RECALL_DAYS,
  raiseDispute, sweepDisputes, listDisputes, disputeEvents,
  requestRecall, returnRecall, declineRecall, expireRecalls, listRecalls,
  issueDocument, renderDocument, listDocuments, getDocument, financialYear
};
