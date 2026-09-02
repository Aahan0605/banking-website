/*
 * Notifications.
 *
 * The bank decides plenty on its own — it debits an autopay, spots a price
 * rise, works out that Tuesday's instalment will not clear. None of that is
 * worth anything if the customer only discovers it by opening the right page,
 * so every such event is recorded here and delivered.
 *
 * Delivery has two parts:
 *
 *   - The in-app centre, which always works and is the record of what was
 *     sent.
 *   - An outside channel (email or SMS). No provider is wired up, so those
 *     are written to the server log instead of being silently dropped — the
 *     integration point is one function, `deliver`.
 */

const store = require("./db");

const { db, nowISO } = store;

/* Whether a notification is also pushed outside the app. */
const EXTERNAL = {
  autopay_charged: true,
  autopay_blocked: true,
  autopay_failed: true,
  shortfall: true,
  price_rise: true,
  dispute_resolved: true,
  security: true,
  login_code: true,
  password_reset: true,
  collect_request: true,
  scheduled_sent: true,
  scheduled_failed: true,
  card_expiring: false,
  info: false
};

/*
 * Hands a notification to email or SMS.
 *
 * Swap the body of this function for a real provider and every alert in the
 * app starts being delivered — nothing else needs to change.
 */
function deliver(user, notification) {
  if (!EXTERNAL[notification.kind]) return;

  const line = `[notify:${notification.severity}] to ${user.email} / ${user.mobile} — ` +
    `${notification.title}${notification.body ? " — " + notification.body : ""}`;

  if (process.env.NOTIFY_WEBHOOK) {
    // Fire-and-forget: a delivery failure must never break a payment.
    fetch(process.env.NOTIFY_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: user.email, mobile: user.mobile, ...notification })
    }).catch(err => console.error("notify webhook failed:", err.message));
    return;
  }

  console.log(line);
}

/*
 * Records a notification and delivers it. Never throws: an alert failing must
 * not roll back the payment it was describing.
 */
function notify(userId, { kind, title, body, link, severity = "info" }) {
  try {
    const info = db.prepare(
      `INSERT INTO notifications (user_id, kind, severity, title, body, link, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(userId, kind, severity, title, body || null, link || null, nowISO());

    const user = store.getUserById(userId);
    if (user) deliver(user, { kind, severity, title, body, link });

    return Number(info.lastInsertRowid);
  } catch (err) {
    console.error("notify failed:", err.message);
    return null;
  }
}

/*
 * Sends at most one notification of a kind per window, so a sweep that runs
 * hourly does not tell someone about the same shortfall twelve times a day.
 */
function notifyOnce(userId, key, hours, payload) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  const recent = db.prepare(
    `SELECT 1 FROM notifications
     WHERE user_id = ? AND kind = ? AND IFNULL(title,'') = ? AND created_at >= ?`
  ).get(userId, payload.kind, payload.title, since);

  if (recent) return null;
  return notify(userId, payload);
}

const list = (userId, { limit = 30, unreadOnly = false } = {}) => db.prepare(
  `SELECT * FROM notifications
   WHERE user_id = ?${unreadOnly ? " AND read_at IS NULL" : ""}
   ORDER BY created_at DESC LIMIT ?`
).all(userId, limit).map(n => ({
  id: n.id,
  kind: n.kind,
  severity: n.severity,
  title: n.title,
  body: n.body,
  link: n.link,
  read: Boolean(n.read_at),
  at: n.created_at
}));

const unreadCount = userId => db.prepare(
  "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL"
).get(userId).n;

const markRead = (id, userId) =>
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
    .run(nowISO(), id, userId).changes > 0;

const markAllRead = userId =>
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(nowISO(), userId).changes;

module.exports = { notify, notifyOnce, list, unreadCount, markRead, markAllRead, deliver };
