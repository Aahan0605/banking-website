/*
 * Sign-in protection: rate limiting, one-time codes and password resets.
 *
 * Three rules shape everything here:
 *
 *   - Guessing must get slower. An unlimited password field is a password
 *     with no length.
 *   - Nothing recoverable is stored. Reset links and one-time codes live as
 *     hashes, so reading this table gets an attacker nowhere.
 *   - The answers must not leak who banks here. "Send a reset link" says the
 *     same thing whether or not the address exists.
 */

const crypto = require("crypto");
const store = require("./db");
const notify = require("./notify");

const { db, nowISO } = store;

/* Failed attempts allowed before the account stops answering, and for how long. */
const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

const RESET_TTL_MINUTES = 30;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_TRIES = 5;

/* Tokens are compared by hash, never by the value we handed out. */
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/* ---------- rate limiting ---------- */

const recordAttempt = (identifier, succeeded) =>
  db.prepare(
    "INSERT INTO login_attempts (identifier, succeeded, created_at) VALUES (?,?,?)"
  ).run(String(identifier || "").toLowerCase().trim(), succeeded ? 1 : 0, nowISO());

/*
 * How long this identifier must wait, in seconds. Counting only failures
 * since the last success means a legitimate sign-in clears the slate.
 */
function lockoutSeconds(identifier) {
  const id = String(identifier || "").toLowerCase().trim();
  const since = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();

  const lastSuccess = db.prepare(
    `SELECT created_at FROM login_attempts
     WHERE identifier = ? AND succeeded = 1 ORDER BY created_at DESC LIMIT 1`
  ).get(id);

  const from = lastSuccess && lastSuccess.created_at > since ? lastSuccess.created_at : since;

  const failures = db.prepare(
    `SELECT created_at FROM login_attempts
     WHERE identifier = ? AND succeeded = 0 AND created_at > ?
     ORDER BY created_at DESC`
  ).all(id, from);

  if (failures.length < MAX_ATTEMPTS) return 0;

  const unlocksAt = new Date(new Date(failures[0].created_at).getTime()
    + LOCKOUT_MINUTES * 60000);

  return Math.max(0, Math.ceil((unlocksAt - Date.now()) / 1000));
}

/* Keeps the table from growing without bound. */
const pruneAttempts = () =>
  db.prepare("DELETE FROM login_attempts WHERE created_at < ?")
    .run(new Date(Date.now() - 24 * 3600000).toISOString());

/* ---------- one-time values ---------- */

function issueToken(userId, purpose, value, ttlMinutes) {
  // Only one live token per purpose, so an older link cannot be reused.
  db.prepare(
    "UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL"
  ).run(nowISO(), userId, purpose);

  db.prepare(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at, created_at)
     VALUES (?,?,?,?,?)`
  ).run(userId, purpose, hash(value),
        new Date(Date.now() + ttlMinutes * 60000).toISOString(), nowISO());
}

/*
 * Checks a token and consumes it. Returns the user id on success, or null —
 * the caller must not be able to tell expired from wrong from already used.
 */
function consumeToken(purpose, value, { userId } = {}) {
  const rows = db.prepare(
    `SELECT * FROM auth_tokens
     WHERE purpose = ? AND used_at IS NULL AND expires_at > ?
       ${userId ? "AND user_id = ?" : ""}
     ORDER BY created_at DESC`
  ).all(...(userId ? [purpose, nowISO(), userId] : [purpose, nowISO()]));

  const digest = hash(value);

  for (const row of rows) {
    if (row.attempts >= OTP_MAX_TRIES) continue;

    if (safeEqual(row.token_hash, digest)) {
      db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ?").run(nowISO(), row.id);
      return row.user_id;
    }
    db.prepare("UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = ?").run(row.id);
  }
  return null;
}

/* ---------- password reset ---------- */

/*
 * Always behaves the same way from the outside. If the address is unknown we
 * do nothing and still report success, so this cannot be used to discover who
 * banks here.
 */
function requestPasswordReset(email) {
  const user = store.getUserByEmail(email || "");
  if (!user) return { sent: true, token: null };

  const token = crypto.randomBytes(32).toString("base64url");
  issueToken(user.id, "reset", token, RESET_TTL_MINUTES);

  notify.notify(user.id, {
    kind: "password_reset",
    severity: "critical",
    title: "Password reset requested",
    body: `A reset link was requested for your account. It expires in ` +
      `${RESET_TTL_MINUTES} minutes. If this was not you, your password is unchanged ` +
      `— tell us immediately.`
  });

  return { sent: true, token, user };
}

function completePasswordReset(token, newPassword, hashPassword) {
  if (String(newPassword || "").length < 8) {
    return { ok: false, message: "Password must be at least 8 characters." };
  }

  const userId = consumeToken("reset", token);
  if (!userId) {
    return { ok: false, message: "That reset link is invalid or has expired." };
  }

  db.prepare("UPDATE users SET password = ? WHERE id = ?")
    .run(hashPassword(newPassword), userId);

  // Any lockout is cleared: the person proved they control the address.
  db.prepare("DELETE FROM login_attempts WHERE identifier = ?")
    .run(store.getUserById(userId).email);

  notify.notify(userId, {
    kind: "security",
    severity: "critical",
    title: "Your password was changed",
    body: "If you did not do this, contact us at once."
  });

  return { ok: true };
}

/* ---------- login one-time code ---------- */

function issueLoginCode(user) {
  // Six digits, from a cryptographic source rather than Math.random.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  issueToken(user.id, "otp", code, OTP_TTL_MINUTES);

  notify.notify(user.id, {
    kind: "login_code",
    severity: "warning",
    title: `Your sign-in code is ${code}`,
    body: `It expires in ${OTP_TTL_MINUTES} minutes. We will never ask you for it.`
  });

  return code;
}

const verifyLoginCode = (user, code) =>
  consumeToken("otp", String(code || "").trim(), { userId: user.id }) !== null;

const setTwoFactor = (userId, enabled) =>
  db.prepare("UPDATE users SET two_factor = ? WHERE id = ?").run(enabled ? 1 : 0, userId);

module.exports = {
  MAX_ATTEMPTS, LOCKOUT_MINUTES, RESET_TTL_MINUTES, OTP_TTL_MINUTES,
  recordAttempt, lockoutSeconds, pruneAttempts,
  requestPasswordReset, completePasswordReset,
  issueLoginCode, verifyLoginCode, setTwoFactor
};
