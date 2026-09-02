/*
 * Money Radar.
 *
 * Two things banks can see clearly and almost never tell anyone:
 *
 *   1. Which payments are recurring — the subscriptions people forget they
 *      signed up for, and the ones that quietly raised their price. A bank
 *      shows the debit; it never says "this is the ninth month" or "this went
 *      up 25% in March".
 *
 *   2. What is about to be taken out. Failed auto-debits carry penalty fees,
 *      and the customer usually finds out afterwards. The bank already knows
 *      the instalments and bills that fall due next week, and the balance
 *      that has to cover them.
 *
 * Everything here is derived from the customer's own ledger. Nothing is
 * predicted that the transaction history does not support, and a run of
 * payments that is not clearly periodic is reported as irregular rather than
 * dressed up as a subscription.
 */

const store = require("./db");
const money = require("./money");
const notify = require("./notify");

const { fromMinor } = store;

/* Look-back window for spotting a pattern. */
const HISTORY_DAYS = 400;

/* Charges needed before a run of payments counts as recurring. */
const MIN_CHARGES = 3;

/* A cadence matches when every gap sits inside its tolerance. */
const CADENCES = [
  { name: "weekly", days: 7, tolerance: 2 },
  { name: "fortnightly", days: 14, tolerance: 3 },
  { name: "monthly", days: 30, tolerance: 5 },
  { name: "quarterly", days: 91, tolerance: 10 },
  { name: "yearly", days: 365, tolerance: 20 }
];

/* Card and UPI narrations vary; the payee is the stable part. */
const payeeKey = tx =>
  String(tx.counterparty_name || tx.counterparty_number || tx.description || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 864e5;

/*
 * Finds the cadence that fits a run of dates, or null when the gaps are not
 * consistent enough to call it recurring.
 */
function matchCadence(dates) {
  if (dates.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));

  for (const cadence of CADENCES) {
    if (gaps.every(gap => Math.abs(gap - cadence.days) <= cadence.tolerance)) {
      return cadence;
    }
  }
  return null;
}

/* ---------- subscriptions ---------- */

function detectSubscriptions(accountId) {
  const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();

  const rows = store.db.prepare(
    `SELECT * FROM transactions
     WHERE account_id = ? AND direction = 'out' AND created_at >= ?
     ORDER BY created_at`
  ).all(accountId, since);

  const groups = new Map();
  for (const tx of rows) {
    const key = payeeKey(tx);
    // Ignore one-off internal movements that are not merchant payments.
    if (!key || /safe send|recall|dispute|refund/i.test(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }

  const found = [];

  for (const [key, txs] of groups) {
    /*
     * Three charges, not two. Two payments give a single interval, and any
     * two payments are some number of days apart — that is enough to
     * accidentally label a pair of one-off recharges a weekly subscription
     * and extrapolate it into a large annual figure. Two intervals that
     * agree is the lowest bar worth calling a pattern.
     */
    if (txs.length < MIN_CHARGES) continue;

    const cadence = matchCadence(txs.map(t => t.created_at));
    if (!cadence) continue;

    const amounts = txs.map(t => t.amount);
    const typical = median(amounts);
    const latest = txs[txs.length - 1];
    const earliest = txs[0];

    const nextDue = new Date(latest.created_at);
    nextDue.setDate(nextDue.getDate() + cadence.days);

    /*
     * A rise is measured against what this subscription used to cost, not
     * against last month. Comparing only with the previous charge would stop
     * flagging an increase as soon as the new price had been billed twice —
     * which is exactly when the customer has still not noticed it.
     */
    const opening = amounts[0];
    const priceRise = latest.amount > opening
      ? {
          from: fromMinor(opening),
          to: fromMinor(latest.amount),
          percent: +(((latest.amount - opening) / opening) * 100).toFixed(1),
          // When the new price first appeared, so the change is dateable.
          since: (txs.find(t => t.amount === latest.amount) || latest).created_at
        }
      : null;

    // A year's worth at this cadence, which is the number people never work out.
    const perYear = Math.round(365 / cadence.days);

    found.push({
      payee: latest.counterparty_name || latest.description || key,
      cadence: cadence.name,
      charges: txs.length,
      typicalAmount: fromMinor(typical),
      lastAmount: fromMinor(latest.amount),
      lastCharged: latest.created_at,
      firstCharged: earliest.created_at,
      nextExpected: nextDue.toISOString(),
      annualCost: fromMinor(typical * perYear),
      category: latest.category,
      method: latest.method,
      priceRise
    });
  }

  return found.sort((a, b) => b.annualCost - a.annualCost);
}

/* ---------- what is about to be taken out ---------- */

/*
 * Commitments the ledger already knows about: recurring-deposit instalments,
 * bills with a due date, and the next charge for each detected subscription.
 */
function upcomingCommitments(userId, accountId, withinDays = 30) {
  const horizon = new Date(Date.now() + withinDays * 864e5);
  const items = [];

  for (const d of store.db.prepare(
    `SELECT * FROM deposits
     WHERE user_id = ? AND kind = 'RD' AND status = 'active'
       AND next_due IS NOT NULL AND instalments_paid < tenure_months`
  ).all(userId)) {
    if (new Date(d.next_due) <= horizon) {
      items.push({
        kind: "deposit",
        label: `RD instalment ${d.instalments_paid + 1} of ${d.tenure_months}`,
        amount: fromMinor(d.monthly_amount),
        due: d.next_due,
        certain: true
      });
    }
  }

  for (const b of store.db.prepare(
    "SELECT * FROM bills WHERE user_id = ? AND status = 'pending' AND due_date IS NOT NULL"
  ).all(userId)) {
    if (new Date(b.due_date) <= horizon) {
      items.push({
        kind: "bill",
        label: `${b.title} · ${b.provider}`,
        amount: fromMinor(b.amount),
        due: new Date(b.due_date).toISOString(),
        certain: true
      });
    }
  }

  for (const sub of detectSubscriptions(accountId)) {
    if (new Date(sub.nextExpected) <= horizon) {
      items.push({
        kind: "subscription",
        label: sub.payee,
        amount: sub.lastAmount,
        due: sub.nextExpected,
        // Predicted from a pattern, so flagged as an estimate rather than a fact.
        certain: false
      });
    }
  }

  return items.sort((a, b) => new Date(a.due) - new Date(b.due));
}

/* ---------- the radar summary ---------- */

function radar(user, account, { withinDays = 30, warnDays = 7 } = {}) {
  const subscriptions = detectSubscriptions(account.id);
  const commitments = upcomingCommitments(user.id, account.id, withinDays);

  const soon = commitments.filter(c =>
    new Date(c.due) <= new Date(Date.now() + warnDays * 864e5));

  const dueSoon = soon.reduce((sum, c) => sum + c.amount, 0);
  const balance = fromMinor(account.balance);

  return {
    subscriptions,
    commitments,
    annualSubscriptionCost: subscriptions.reduce((sum, s) => sum + s.annualCost, 0),
    priceRises: subscriptions.filter(s => s.priceRise),
    warnDays,
    dueSoon,
    balance,
    // The whole point: say it before the auto-debit fails, not after.
    shortfall: dueSoon > balance ? +(dueSoon - balance).toFixed(2) : 0
  };
}

/* ---------- duplicate payment guard ---------- */

const DUPLICATE_WINDOW_MINUTES = 10;

/*
 * A repeat of the same payee and amount within minutes is nearly always a
 * double tap or an impatient retry. Catching it before the money moves is
 * worth far more than refunding it afterwards.
 */
function recentIdenticalPayment(accountId, { counterparty, amountMinor }) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60000).toISOString();

  return store.db.prepare(
    `SELECT * FROM transactions
     WHERE account_id = ? AND direction = 'out' AND amount = ?
       AND IFNULL(counterparty_number,'') = IFNULL(?,'')
       AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(accountId, amountMinor, counterparty, since);
}

/*
 * Turns the radar's findings into alerts.
 *
 * Deliberately rate-limited: a sweep that runs hourly must not tell someone
 * about the same shortfall twelve times before lunch.
 */
function raiseRadarAlerts(user, account) {
  const summary = radar(user, account);

  if (summary.shortfall > 0) {
    notify.notifyOnce(user.id, "shortfall", 24, {
      kind: "shortfall",
      severity: "critical",
      title: `You are short ₹${summary.shortfall.toLocaleString("en-IN")} for what is due`,
      body: `₹${summary.dueSoon.toLocaleString("en-IN")} is due in the next ` +
        `${summary.warnDays} days and your balance is ` +
        `₹${summary.balance.toLocaleString("en-IN")}. Top up to avoid a failed auto-debit.`,
      link: "#/dashboard"
    });
  }

  for (const sub of summary.priceRises) {
    notify.notifyOnce(user.id, "price_rise", 24 * 30, {
      kind: "price_rise",
      severity: "warning",
      title: `${sub.payee} raised its price to ₹${sub.priceRise.to.toLocaleString("en-IN")}`,
      body: `Up from ₹${sub.priceRise.from.toLocaleString("en-IN")} ` +
        `(+${sub.priceRise.percent}%). That is ` +
        `₹${sub.annualCost.toLocaleString("en-IN")} a year.`,
      link: "#/dashboard"
    });
  }

  return summary;
}

module.exports = {
  radar, detectSubscriptions, MIN_CHARGES, raiseRadarAlerts, upcomingCommitments,
  recentIdenticalPayment, DUPLICATE_WINDOW_MINUTES, matchCadence
};
