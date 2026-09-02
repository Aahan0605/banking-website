/*
 * Password hashing and session tokens, built on node:crypto.
 *
 * Passwords use scrypt with a per-user random salt. Tokens are a payload
 * plus an HMAC-SHA256 signature, verified with a constant-time compare, so
 * a client cannot alter the user id or expiry it carries.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/*
 * The signing key is persisted, otherwise every server restart would
 * invalidate all outstanding sessions and sign everyone out.
 */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const file = path.join(__dirname, "..", ".session-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  }
}

const SECRET = loadSecret();
const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

const b64url = buf =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = str => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/* ---------- passwords ---------- */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(plain, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/* ---------- tokens ---------- */

const sign = payload =>
  b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());

function createToken(userId) {
  const body = b64url(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  }));
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  // Compare as fixed-length buffers; timingSafeEqual throws on length mismatch.
  if (expected.length !== signature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  let claims;
  try {
    claims = JSON.parse(fromB64url(body).toString());
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims.sub;
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken, TOKEN_TTL_SECONDS };
