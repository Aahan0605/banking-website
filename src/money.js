/*
 * Money movement. Every balance change happens inside a SQLite transaction
 * so a failure part-way through cannot leave one side of a transfer applied.
 *
 * Amounts crossing this boundary are integer paise.
 */

const {
  db, BANK, nowISO, getAccountById, getAccountByNumber, getUserByUpiId, getUserByMobile,
  getAccountByUser, accountOwner, adjustBalance, recordTransaction
} = require("./db");

const MAX_TRANSFER = 1000000000;  // ₹10,00,000 per single bank transfer
const MAX_UPI = 10000000;         // ₹1,00,000 per UPI transaction (NPCI cap)

class MoneyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* Runs fn inside a database transaction, rolling back if it throws. */
function atomically(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/*
 * Validates a user-supplied amount. Rejects NaN, negatives, zero, values
 * with sub-paise precision, and absurd amounts before any balance is touched.
 */
function parseAmount(value, ceiling = MAX_TRANSFER) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new MoneyError("Enter an amount greater than zero.");
  }
  const minor = Math.round(num * 100);
  if (Math.abs(num * 100 - minor) > 1e-6) {
    throw new MoneyError("Amounts cannot be smaller than one paisa.");
  }
  if (minor > ceiling) {
    throw new MoneyError(
      `That exceeds the limit of ₹${(ceiling / 100).toLocaleString("en-IN")} for this payment type.`);
  }
  return minor;
}

/* Spending so far in the current calendar month, used against the monthly limit. */
function monthlySpend(accountId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
     WHERE account_id = ? AND direction = 'out' AND created_at >= ?`
  ).get(accountId, startOfMonth.toISOString());

  return Number(row.spent);
}

function assertWithinLimits(account, minor) {
  if (account.balance < minor) {
    throw new MoneyError("Insufficient balance for this payment.");
  }
  if (monthlySpend(account.id) + minor > account.limit_monthly) {
    throw new MoneyError("This payment would exceed your monthly limit.");
  }
}

const categorise = description => {
  const text = String(description || "").toLowerCase();
  if (/bigbasket|blinkit|zepto|dmart|grocer|kirana|market/.test(text)) return "Groceries";
  if (/uber|ola|rapido|irctc|petrol|fuel|metro|bus/.test(text)) return "Transport";
  if (/swiggy|zomato|restaurant|cafe|hotel|dominos|chai|tea|coffee|dhaba|canteen/.test(text)) {
    return "Dining";
  }
  if (/bescom|electric|water|gas|broadband|bill|dth/.test(text)) return "Utilities";
  if (/jio|airtel|vodafone|vi |bsnl|recharge/.test(text)) return "Recharge";
  if (/amazon|flipkart|myntra|ajio|shop/.test(text)) return "Shopping";
  if (/salary|stipend|income|interest/.test(text)) return "Income";
  if (/fd|rd|deposit/.test(text)) return "Investments";
  return "Other";
};

const reference = prefix => prefix + Date.now().toString(36).toUpperCase();

/* ---------- UPI address handling ---------- */

/*
 * Reads any payment QR we understand. Real Indian merchant QR codes use the
 * NPCI "upi://pay?pa=..." scheme, so those are the primary case; we also
 * accept our own deep links and a bare VPA typed by hand.
 */
function parsePaymentPayload(payload) {
  const raw = String(payload || "").trim();
  if (!raw) throw new MoneyError("No QR payload supplied.");

  // A bare VPA, e.g. "merchant@okaxis".
  if (/^[\w.\-]{2,64}@[a-z]{2,32}$/i.test(raw)) {
    return { vpa: raw.toLowerCase(), name: null, amount: null, note: null };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MoneyError("That QR code is not a payment code.");
  }

  const q = url.searchParams;

  // NPCI UPI intent, used by every Indian payment app and merchant QR.
  if (url.protocol === "upi:") {
    const vpa = q.get("pa");
    if (!vpa) throw new MoneyError("That UPI QR code has no payee address.");
    const currency = q.get("cu");
    if (currency && currency.toUpperCase() !== "INR") {
      throw new MoneyError("Only INR UPI payments are supported.");
    }
    return {
      vpa: vpa.toLowerCase(),
      name: q.get("pn"),
      amount: q.get("am"),
      note: q.get("tn")
    };
  }

  // Our own account QR.
  if (url.protocol === "abpay:") {
    const account = q.get("acc");
    if (!account) throw new MoneyError("That QR code has no account number.");
    return {
      account,
      vpa: q.get("vpa"),
      name: q.get("name"),
      amount: q.get("amount"),
      note: q.get("desc")
    };
  }

  throw new MoneyError("That QR code is not a payment code.");
}

/*
 * Works out who a VPA belongs to. If the handle is ours the payee is an
 * AB Pay customer and the money stays in the bank; anything else is an
 * external UPI address at another bank.
 */
function resolveVpa(vpa) {
  const address = String(vpa).toLowerCase().trim();
  const user = getUserByUpiId(address);

  if (user) {
    return { external: false, user, account: getAccountByUser(user.id),
             name: `${user.name} ${user.surname}` };
  }
  if (address.endsWith("@" + BANK.upiHandle)) {
    throw new MoneyError("No AB Pay customer has that UPI ID.", 404);
  }
  return { external: true, name: null, vpa: address };
}

/* ---------- transfers ---------- */

/* An IFSC is four letters, a zero, then six alphanumerics. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const isOurIfsc = ifsc => String(ifsc || "").toUpperCase().startsWith(BANK.ifscPrefix);

/*
 * Moves money to any Indian bank account.
 *
 * If the beneficiary banks with us the transfer settles internally and both
 * ledgers are written. Otherwise the money leaves our books through the
 * NEFT/IMPS rails, so only the sender's side is recorded — the receiving bank
 * credits their own customer. The beneficiary does not need an AB Pay account.
 */
function transfer({
  fromAccountId, toNumber, ifsc, beneficiaryName,
  amount, description, method = "IMPS", ceiling
}) {
  const minor = parseAmount(amount, ceiling);
  const from = getAccountById(fromAccountId);
  if (!from) throw new MoneyError("Source account not found.", 404);

  const to = getAccountByNumber(toNumber);

  if (!to) {
    // Not one of ours — send it out, provided we know where to.
    const code = String(ifsc || "").toUpperCase().trim();
    if (!code) {
      throw new MoneyError(
        "That account is not with AB Pay. Add the beneficiary's IFSC code to send it.");
    }
    if (!IFSC_PATTERN.test(code)) {
      throw new MoneyError("Enter a valid IFSC code, for example HDFC0001234.");
    }
    if (isOurIfsc(code)) {
      throw new MoneyError("No AB Pay account with that number exists.", 404);
    }
    if (!String(toNumber || "").trim()) {
      throw new MoneyError("Enter the beneficiary's account number.");
    }
    return payOutward({
      from, minor, toNumber: String(toNumber).trim(), ifsc: code,
      beneficiaryName, description, method
    });
  }

  if (to.id === from.id) throw new MoneyError("You cannot transfer to your own account.");

  assertWithinLimits(from, minor);

  return atomically(() => {
    adjustBalance(from.id, -minor);
    adjustBalance(to.id, minor);

    const sender = accountOwner(from.id);
    const receiver = accountOwner(to.id);
    const category = categorise(description);
    const ref = reference(method === "UPI" ? "UPI" : "REF");
    const at = nowISO();

    recordTransaction({
      accountId: from.id, direction: "out", amount: minor,
      balanceAfter: getAccountById(from.id).balance,
      counterpartyNumber: to.number,
      counterpartyName: `${receiver.name} ${receiver.surname}`,
      method, category, description, reference: ref, createdAt: at
    });

    recordTransaction({
      accountId: to.id, direction: "in", amount: minor,
      balanceAfter: getAccountById(to.id).balance,
      counterpartyNumber: from.number,
      counterpartyName: `${sender.name} ${sender.surname}`,
      method, category: "Income", description, reference: ref, createdAt: at
    });

    return { reference: ref, amount: minor, to: to.number };
  });
}

/*
 * Sends money out of the bank to a beneficiary at another institution.
 * Only the sender is debited; the receiving bank credits its own customer.
 */
function payOutward({ from, minor, toNumber, ifsc, beneficiaryName, description, method }) {
  assertWithinLimits(from, minor);

  return atomically(() => {
    adjustBalance(from.id, -minor);
    const ref = reference(method === "UPI" ? "UPI" : "REF");

    recordTransaction({
      accountId: from.id, direction: "out", amount: minor,
      balanceAfter: getAccountById(from.id).balance,
      counterpartyNumber: toNumber,
      counterpartyName: beneficiaryName || `${ifsc} ${toNumber}`,
      method, category: categorise(description || beneficiaryName),
      description: description || `${method} to ${beneficiaryName || toNumber}`,
      reference: ref, createdAt: nowISO()
    });

    return { reference: ref, amount: minor, to: toNumber, ifsc, external: true };
  });
}

/*
 * Pays a UPI address. AB Pay payees settle internally; addresses at other
 * banks leave our books, so only the sender's side is recorded.
 */
function payUpi({ fromAccountId, vpa, amount, note, payeeName }) {
  const minor = parseAmount(amount, MAX_UPI);
  const from = getAccountById(fromAccountId);
  if (!from) throw new MoneyError("Source account not found.", 404);

  const target = resolveVpa(vpa);

  if (!target.external) {
    if (target.account.id === from.id) {
      throw new MoneyError("You cannot pay your own UPI ID.");
    }
    return transfer({
      fromAccountId, toNumber: target.account.number, amount,
      description: note || `UPI to ${target.name}`, method: "UPI", ceiling: MAX_UPI
    });
  }

  assertWithinLimits(from, minor);

  return atomically(() => {
    adjustBalance(from.id, -minor);
    const ref = reference("UPI");

    recordTransaction({
      accountId: from.id, direction: "out", amount: minor,
      balanceAfter: getAccountById(from.id).balance,
      counterpartyNumber: target.vpa,
      counterpartyName: payeeName || target.vpa,
      method: "UPI", category: categorise(note || payeeName || target.vpa),
      description: note || `UPI payment to ${payeeName || target.vpa}`,
      reference: ref, createdAt: nowISO()
    });

    return { reference: ref, amount: minor, to: target.vpa, external: true };
  });
}

/* ---------- Safe Send (escrow) ---------- */

const SAFE_SEND_DAYS = 7;

/*
 * Holds funds with the bank instead of paying them straight out. The sender
 * is debited now, but the recipient is only credited on release, so a sender
 * who never receives what they paid for gets their money back.
 */
function createProtectedPayment({ fromAccountId, toNumber, amount, description, days = SAFE_SEND_DAYS }) {
  const minor = parseAmount(amount);
  const from = getAccountById(fromAccountId);
  if (!from) throw new MoneyError("Source account not found.", 404);

  const to = getAccountByNumber(toNumber);
  if (!to) throw new MoneyError("No account with that number exists.", 404);
  if (to.id === from.id) throw new MoneyError("You cannot send a protected payment to yourself.");

  assertWithinLimits(from, minor);

  const deadline = new Date(Date.now() + days * 864e5).toISOString();

  return atomically(() => {
    adjustBalance(from.id, -minor);
    const receiver = accountOwner(to.id);

    recordTransaction({
      accountId: from.id, direction: "out", amount: minor,
      balanceAfter: getAccountById(from.id).balance,
      counterpartyNumber: to.number,
      counterpartyName: `${receiver.name} ${receiver.surname}`,
      method: "Safe Send hold", category: categorise(description),
      description: description || "Protected payment held in escrow",
      reference: reference("SAFE"), createdAt: nowISO()
    });

    const info = db.prepare(
      `INSERT INTO protected_payments
         (sender_account_id, receiver_account_id, amount, description, created_at, deadline)
       VALUES (?,?,?,?,?,?)`
    ).run(from.id, to.id, minor, description || null, nowISO(), deadline);

    return Number(info.lastInsertRowid);
  });
}

const getProtectedPayment = id =>
  db.prepare("SELECT * FROM protected_payments WHERE id = ?").get(id);

/* Pays the held funds out to the recipient. Only the sender may release. */
function releaseProtectedPayment(id, byAccountId) {
  const pp = getProtectedPayment(id);
  if (!pp) throw new MoneyError("Protected payment not found.", 404);
  if (pp.sender_account_id !== byAccountId) {
    throw new MoneyError("Only the sender can release these funds.", 403);
  }
  if (pp.status !== "held") throw new MoneyError(`This payment is already ${pp.status}.`);

  return atomically(() => {
    adjustBalance(pp.receiver_account_id, pp.amount);
    const sender = accountOwner(pp.sender_account_id);

    recordTransaction({
      accountId: pp.receiver_account_id, direction: "in", amount: pp.amount,
      balanceAfter: getAccountById(pp.receiver_account_id).balance,
      counterpartyNumber: getAccountById(pp.sender_account_id).number,
      counterpartyName: `${sender.name} ${sender.surname}`,
      method: "Safe Send release", category: "Income",
      description: pp.description || "Protected payment released",
      reference: "SAFE-" + id, createdAt: nowISO()
    });

    db.prepare("UPDATE protected_payments SET status='released', settled_at=? WHERE id=?")
      .run(nowISO(), id);
    return true;
  });
}

/* Returns held funds to the sender. Either party may cancel while held. */
function refundProtectedPayment(id, byAccountId = null) {
  const pp = getProtectedPayment(id);
  if (!pp) throw new MoneyError("Protected payment not found.", 404);
  if (byAccountId !== null &&
      byAccountId !== pp.sender_account_id &&
      byAccountId !== pp.receiver_account_id) {
    throw new MoneyError("You are not party to this payment.", 403);
  }
  if (pp.status !== "held") throw new MoneyError(`This payment is already ${pp.status}.`);

  return atomically(() => {
    adjustBalance(pp.sender_account_id, pp.amount);

    recordTransaction({
      accountId: pp.sender_account_id, direction: "in", amount: pp.amount,
      balanceAfter: getAccountById(pp.sender_account_id).balance,
      counterpartyNumber: getAccountById(pp.receiver_account_id).number,
      counterpartyName: "Safe Send refund",
      method: "Safe Send refund", category: "Refund",
      description: "Refund: " + (pp.description || "protected payment"),
      reference: "SAFE-" + id, createdAt: nowISO()
    });

    db.prepare("UPDATE protected_payments SET status='refunded', settled_at=? WHERE id=?")
      .run(nowISO(), id);
    return true;
  });
}

/* Auto-refunds anything still held past its deadline. */
function expireProtectedPayments() {
  const due = db.prepare(
    "SELECT id FROM protected_payments WHERE status='held' AND deadline < ?"
  ).all(nowISO());

  for (const row of due) refundProtectedPayment(row.id);
  return due.length;
}

function listProtectedPayments(accountId) {
  return db.prepare(
    `SELECT p.*, s.number AS sender_number, r.number AS receiver_number
     FROM protected_payments p
     JOIN accounts s ON s.id = p.sender_account_id
     JOIN accounts r ON r.id = p.receiver_account_id
     WHERE p.sender_account_id = ? OR p.receiver_account_id = ?
     ORDER BY p.created_at DESC`
  ).all(accountId, accountId);
}

/* ---------- deposits ---------- */

/* Indicative card rates, in the range Indian banks currently publish. */
const FD_RATES = [
  { months: 6, rate: 6.00 },
  { months: 12, rate: 6.80 },
  { months: 24, rate: 7.10 },
  { months: 36, rate: 7.25 },
  { months: 60, rate: 7.00 }
];
const RD_RATES = [
  { months: 12, rate: 6.50 },
  { months: 24, rate: 6.75 },
  { months: 36, rate: 6.90 },
  { months: 60, rate: 6.75 }
];

const rateFor = (table, months) =>
  (table.find(r => r.months === Number(months)) || table[0]).rate;

/* Fixed deposit, compounded quarterly as Indian banks do. */
const fdMaturity = (principal, rate, months) =>
  Math.round(principal * Math.pow(1 + rate / 400, (months / 12) * 4));

/* Recurring deposit: monthly instalments, compounded monthly (annuity due). */
function rdMaturity(monthly, rate, months) {
  const i = rate / 1200;
  return Math.round(monthly * ((Math.pow(1 + i, months) - 1) / i) * (1 + i));
}

function openDeposit({ userId, accountId, kind, amount, tenureMonths }) {
  const months = Number(tenureMonths);
  const table = kind === "FD" ? FD_RATES : RD_RATES;
  if (!table.some(r => r.months === months)) {
    throw new MoneyError("Choose one of the available tenures.");
  }

  const minor = parseAmount(amount);
  if (kind === "FD" && minor < 100000) {
    throw new MoneyError("Minimum fixed deposit is ₹1,000.");
  }
  if (kind === "RD" && minor < 50000) {
    throw new MoneyError("Minimum monthly instalment is ₹500.");
  }

  const account = getAccountById(accountId);
  // An RD debits only the first instalment today.
  const debit = minor;
  if (account.balance < debit) {
    throw new MoneyError("Insufficient balance to fund this deposit.");
  }

  const rate = rateFor(table, months);
  const maturityAmount = kind === "FD"
    ? fdMaturity(minor, rate, months)
    : rdMaturity(minor, rate, months);

  const maturityAt = new Date();
  maturityAt.setMonth(maturityAt.getMonth() + months);

  return atomically(() => {
    adjustBalance(accountId, -debit);

    recordTransaction({
      accountId, direction: "out", amount: debit,
      balanceAfter: getAccountById(accountId).balance,
      counterpartyName: `AB Pay ${kind}`,
      method: kind === "FD" ? "Fixed deposit" : "Recurring deposit",
      category: "Investments",
      description: `${kind} opened · ${months} months @ ${rate}%`,
      reference: reference(kind), createdAt: nowISO()
    });

    // An RD collects the first instalment now; the rest fall due monthly.
    const nextDue = new Date();
    nextDue.setMonth(nextDue.getMonth() + 1);

    const info = db.prepare(
      `INSERT INTO deposits
        (user_id, account_id, kind, principal, monthly_amount, rate, tenure_months,
         maturity_amount, opened_at, maturity_at, instalments_paid, next_due)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(userId, accountId, kind, minor, kind === "RD" ? minor : null, rate, months,
          maturityAmount, nowISO(), maturityAt.toISOString(),
          1, kind === "RD" ? nextDue.toISOString() : null);

    return { id: Number(info.lastInsertRowid), rate, maturityAmount,
             maturityAt: maturityAt.toISOString() };
  });
}

/*
 * Collects any recurring-deposit instalments that have fallen due.
 *
 * Without this an RD would be quoted — and paid out — on a full schedule of
 * instalments while only the first was ever debited, which would create money
 * out of nothing at maturity.
 *
 * An instalment that cannot be funded is left due rather than forced, so the
 * account is never pushed negative; the deposit simply matures on whatever was
 * actually contributed.
 */
function collectDepositInstalments() {
  const due = db.prepare(
    `SELECT * FROM deposits
     WHERE kind = 'RD' AND status = 'active'
       AND next_due IS NOT NULL AND next_due <= ?
       AND instalments_paid < tenure_months`
  ).all(nowISO());

  let collected = 0;

  for (const deposit of due) {
    const account = getAccountById(deposit.account_id);
    if (!account || account.balance < deposit.monthly_amount) continue;

    atomically(() => {
      adjustBalance(account.id, -deposit.monthly_amount);

      recordTransaction({
        accountId: account.id, direction: "out", amount: deposit.monthly_amount,
        balanceAfter: getAccountById(account.id).balance,
        counterpartyName: "AB Pay RD",
        method: "RD instalment", category: "Investments",
        description: `RD instalment ${deposit.instalments_paid + 1} of ${deposit.tenure_months}`,
        reference: reference("RD"), createdAt: nowISO()
      });

      const next = new Date(deposit.next_due);
      next.setMonth(next.getMonth() + 1);

      db.prepare(
        "UPDATE deposits SET instalments_paid = instalments_paid + 1, next_due = ? WHERE id = ?"
      ).run(next.toISOString(), deposit.id);
    });
    collected++;
  }
  return collected;
}

/*
 * What a deposit has actually had paid into it — the basis for any payout.
 * For an FD that is the principal; for an RD it is however many instalments
 * were really collected, which may be fewer than the schedule projected.
 */
const contributed = deposit => deposit.kind === "FD"
  ? deposit.principal
  : deposit.monthly_amount * deposit.instalments_paid;

/*
 * Premature closure. Indian banks apply a penalty to the contracted rate, so
 * the customer gets their principal plus interest accrued at the reduced rate.
 */
function closeDeposit(id, userId) {
  const deposit = db.prepare("SELECT * FROM deposits WHERE id = ? AND user_id = ?")
    .get(id, userId);

  if (!deposit) throw new MoneyError("Deposit not found.", 404);
  if (deposit.status !== "active") throw new MoneyError("This deposit is already closed.");

  const matured = new Date(deposit.maturity_at) <= new Date();
  const paidIn = contributed(deposit);
  let payout;

  if (matured) {
    /*
     * The stored maturity_amount is the quote given when the deposit was
     * opened, which assumes every instalment is paid. Pay out on what was
     * actually contributed instead, or a customer who stopped paying would
     * still collect the full projection.
     */
    payout = deposit.kind === "FD"
      ? deposit.maturity_amount
      : rdMaturity(deposit.monthly_amount, deposit.rate, deposit.instalments_paid);
  } else {
    const monthsHeld = Math.max(0,
      (Date.now() - new Date(deposit.opened_at)) / (30 * 864e5));
    const penalised = Math.max(0, deposit.rate - 1); // 1% premature-withdrawal penalty
    payout = Math.round(paidIn * (1 + (penalised / 100) * (monthsHeld / 12)));
  }

  // Whatever the arithmetic, never pay back less than was put in.
  payout = Math.max(payout, paidIn);

  return atomically(() => {
    adjustBalance(deposit.account_id, payout);

    recordTransaction({
      accountId: deposit.account_id, direction: "in", amount: payout,
      balanceAfter: getAccountById(deposit.account_id).balance,
      counterpartyName: `AB Pay ${deposit.kind}`,
      method: matured ? "Deposit maturity" : "Premature closure",
      category: "Investments",
      description: matured
        ? `${deposit.kind} matured`
        : `${deposit.kind} closed early (1% rate penalty)`,
      reference: reference("CLS"), createdAt: nowISO()
    });

    db.prepare("UPDATE deposits SET status = ?, closed_at = ? WHERE id = ?")
      .run(matured ? "matured" : "closed", nowISO(), id);

    return { payout, matured };
  });
}

/*
 * Sends transfers whose date has arrived.
 *
 * A failure is recorded and left for the customer rather than retried blindly
 * — a scheduled payment that keeps failing usually needs a decision, not
 * another attempt.
 */
function runScheduledTransfers() {
  const notify = require("./notify");

  const due = db.prepare(
    "SELECT * FROM scheduled_transfers WHERE status = 'scheduled' AND run_on <= ?"
  ).all(nowISO());

  let sent = 0;

  for (const job of due) {
    try {
      const result = transfer({
        fromAccountId: job.account_id,
        toNumber: job.to_account,
        ifsc: job.ifsc,
        beneficiaryName: job.payee_name,
        amount: job.amount / 100,
        description: job.description || "Scheduled transfer",
        method: job.mode
      });

      // A repeating instruction lines up its next run; a one-off completes.
      if (job.repeat_days) {
        const next = new Date(job.run_on);
        next.setDate(next.getDate() + job.repeat_days);
        db.prepare(
          `UPDATE scheduled_transfers
           SET run_on = ?, runs_made = runs_made + 1, last_error = NULL WHERE id = ?`
        ).run(next.toISOString(), job.id);
      } else {
        db.prepare(
          `UPDATE scheduled_transfers
           SET status = 'sent', runs_made = runs_made + 1, completed_at = ?,
               last_error = NULL
           WHERE id = ?`
        ).run(nowISO(), job.id);
      }

      notify.notify(job.user_id, {
        kind: "scheduled_sent", severity: "info",
        title: `Scheduled transfer sent`,
        body: `${(job.amount / 100).toLocaleString("en-IN")} to ${job.to_account} ` +
          `(ref ${result.reference}).`,
        link: "#/statement"
      });
      sent++;
    } catch (err) {
      db.prepare(
        "UPDATE scheduled_transfers SET status = 'failed', last_error = ? WHERE id = ?"
      ).run(err.message, job.id);

      notify.notify(job.user_id, {
        kind: "scheduled_failed", severity: "critical",
        title: "A scheduled transfer could not be sent",
        body: `${(job.amount / 100).toLocaleString("en-IN")} to ${job.to_account} — ` +
          `${err.message}`,
        link: "#/transfer"
      });
    }
  }
  return sent;
}

module.exports = {
  MoneyError, atomically, parseAmount, transfer, payUpi, IFSC_PATTERN,
  runScheduledTransfers, parsePaymentPayload, resolveVpa,
  monthlySpend, categorise,
  createProtectedPayment, releaseProtectedPayment, refundProtectedPayment,
  expireProtectedPayments, listProtectedPayments, getProtectedPayment,
  openDeposit, closeDeposit, collectDepositInstalments, contributed, FD_RATES, RD_RATES, fdMaturity, rdMaturity, rateFor,
  SAFE_SEND_DAYS, MAX_UPI, MAX_TRANSFER
};
