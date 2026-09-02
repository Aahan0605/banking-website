/*
 * SQLite storage, using Node's built-in node:sqlite driver so the app has
 * no native dependencies and needs no database server.
 *
 * All money is stored as an INTEGER number of paise (1/100 rupee). Balances
 * are never held in floating point, so repeated transfers cannot accumulate
 * rounding drift.
 */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const { hashPassword } = require("./auth");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "abpay.db");

const BANK = {
  name: "AB Pay",
  upiHandle: "abpay",
  ifscPrefix: "ABPY0"
};

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  password        TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  surname         TEXT    NOT NULL,
  mobile          TEXT    NOT NULL UNIQUE,
  upi_id          TEXT    NOT NULL UNIQUE,
  upi_pin         TEXT,
  pan             TEXT,
  address         TEXT,
  branch          TEXT,
  nominee         TEXT,
  date_registered TEXT    NOT NULL,
  last_login      TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number        TEXT    NOT NULL UNIQUE,
  ifsc          TEXT    NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'INR',
  account_type  TEXT    NOT NULL DEFAULT 'Savings',
  limit_monthly INTEGER NOT NULL DEFAULT 100000000,
  date_opened   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction           TEXT    NOT NULL CHECK (direction IN ('in','out')),
  amount              INTEGER NOT NULL CHECK (amount > 0),
  balance_after       INTEGER NOT NULL,
  counterparty_number TEXT,
  counterparty_name   TEXT,
  method              TEXT    NOT NULL DEFAULT 'UPI',
  category            TEXT    NOT NULL DEFAULT 'Other',
  description         TEXT,
  reference           TEXT,
  created_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, created_at);

CREATE TABLE IF NOT EXISTS bills (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  provider   TEXT    NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  reference  TEXT,
  image      TEXT,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  due_date   TEXT,
  created_at TEXT    NOT NULL,
  paid_at    TEXT
);

/* Beneficiaries: either a bank account (IFSC) or a UPI address. */
CREATE TABLE IF NOT EXISTS payees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','upi')),
  account_number TEXT,
  ifsc           TEXT,
  upi_id         TEXT,
  created_at     TEXT    NOT NULL
);

/*
 * Safe Send — escrowed peer-to-peer payments. Funds leave the sender's
 * balance immediately but are held by the bank until the sender releases
 * them, either party cancels, or the deadline passes and they auto-refund.
 */
CREATE TABLE IF NOT EXISTS protected_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  receiver_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount              INTEGER NOT NULL CHECK (amount > 0),
  description         TEXT,
  status              TEXT    NOT NULL DEFAULT 'held'
                              CHECK (status IN ('held','released','refunded')),
  marked_shipped      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  deadline            TEXT    NOT NULL,
  settled_at          TEXT
);

/* Fixed and recurring deposits. */
CREATE TABLE IF NOT EXISTS deposits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('FD','RD')),
  principal       INTEGER NOT NULL CHECK (principal > 0),
  monthly_amount  INTEGER,
  rate            REAL    NOT NULL,
  tenure_months   INTEGER NOT NULL,
  maturity_amount INTEGER NOT NULL,
  opened_at       TEXT    NOT NULL,
  maturity_at     TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','closed','matured')),
  closed_at       TEXT
);

/*
 * Cards — the one we issue, plus any the customer adds from other banks.
 *
 * Only the last four digits are ever stored. The full card number is checked
 * in the browser and never sent to this server, and no CVV is accepted
 * anywhere, so this table cannot leak a usable card.
 */
CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL DEFAULT 'debit' CHECK (kind IN ('debit','credit')),
  issuer        TEXT    NOT NULL DEFAULT 'AB Pay',
  label         TEXT,
  last4         TEXT,
  number        TEXT,
  network       TEXT    NOT NULL DEFAULT 'RuPay',
  expiry        TEXT    NOT NULL,
  is_own        INTEGER NOT NULL DEFAULT 1,
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','blocked')),
  atm_enabled   INTEGER NOT NULL DEFAULT 1,
  pos_enabled   INTEGER NOT NULL DEFAULT 1,
  online_enabled INTEGER NOT NULL DEFAULT 1,
  intl_enabled  INTEGER NOT NULL DEFAULT 0,
  daily_limit   INTEGER NOT NULL DEFAULT 5000000,
  created_at    TEXT
);

/*
 * Bank accounts the customer has told us about, at any bank.
 *
 * For an AB Pay account we hold the ledger, so the live balance is shown. For
 * any other bank we can validate and store the routing details and pay into
 * it, but we cannot read its balance — that needs the customer's consent
 * through the RBI Account Aggregator framework, which a licensed FIU brokers.
 * The balance_source column records which of those is true rather than
 * letting the UI guess.
 */
CREATE TABLE IF NOT EXISTS linked_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_number TEXT    NOT NULL,
  ifsc           TEXT    NOT NULL,
  bank           TEXT    NOT NULL,
  branch_code    TEXT,
  holder_name    TEXT,
  nickname       TEXT,
  account_type   TEXT    NOT NULL DEFAULT 'Savings',
  balance_source TEXT    NOT NULL DEFAULT 'external'
                         CHECK (balance_source IN ('ledger','external')),
  created_at     TEXT    NOT NULL,
  UNIQUE (user_id, account_number, ifsc)
);

/*
 * Autopay mandates — a standing instruction to debit a recurring charge.
 *
 * Every mandate carries max_amount, the ceiling the customer approved. A
 * merchant that raises its price above that ceiling is refused and flagged
 * for review rather than silently charged, which is the whole point of a
 * mandate having a limit.
 */
CREATE TABLE IF NOT EXISTS mandates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payee        TEXT    NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  max_amount   INTEGER NOT NULL CHECK (max_amount > 0),
  cadence      TEXT    NOT NULL,
  cadence_days INTEGER NOT NULL CHECK (cadence_days > 0),
  next_due     TEXT    NOT NULL,
  until        TEXT,
  status       TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','cancelled','needs_review')),
  charges_made INTEGER NOT NULL DEFAULT 0,
  total_paid   INTEGER NOT NULL DEFAULT 0,
  last_charged TEXT,
  last_error   TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (user_id, payee)
);

/*
 * Payees the customer has told us to stop paying automatically.
 *
 * This is a stop-payment instruction: we refuse future automatic debits from
 * this merchant. It does not end the customer's contract with them — only the
 * merchant can do that — so the wording around it has to be exact.
 */
CREATE TABLE IF NOT EXISTS blocked_payees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payee      TEXT    NOT NULL,
  reason     TEXT,
  created_at TEXT    NOT NULL,
  UNIQUE (user_id, payee)
);

/*
 * Notifications. Everything the bank decides on its own — an autopay debit, a
 * price rise, a shortfall before a due date — is written here so the customer
 * sees it whether or not they happened to be looking at the page.
 */
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  severity   TEXT    NOT NULL DEFAULT 'info'
                     CHECK (severity IN ('info','warning','critical')),
  title      TEXT    NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notify_user ON notifications(user_id, created_at);

/* Failed sign-in attempts, so a password cannot be guessed indefinitely. */
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT    NOT NULL,
  succeeded  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(identifier, created_at);

/*
 * Single-use, expiring tokens for password resets and login one-time codes.
 * Only a hash is stored, so the table cannot be read to impersonate anyone.
 */
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('reset','otp')),
  token_hash TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

/* Transfers the customer has asked us to make on a future date. */
CREATE TABLE IF NOT EXISTS scheduled_transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account   TEXT    NOT NULL,
  ifsc         TEXT,
  payee_name   TEXT,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  description  TEXT,
  mode         TEXT    NOT NULL DEFAULT 'IMPS',
  run_on       TEXT    NOT NULL,
  repeat_days  INTEGER,
  status       TEXT    NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','sent','failed','cancelled')),
  last_error   TEXT,
  runs_made    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  completed_at TEXT
);

/* Cheque book, nominee updates and similar branch requests. */
CREATE TABLE IF NOT EXISTS service_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  details    TEXT,
  status     TEXT    NOT NULL DEFAULT 'open',
  ticket     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

/*
 * Disputes. A customer raises one against a transaction and the system tries
 * to settle it without a human: duplicate charges are refunded on the spot,
 * stuck outbound payments auto-reverse once the settlement window lapses, and
 * only cases that genuinely need judgement reach a banker.
 */
CREATE TABLE IF NOT EXISTS disputes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  reason          TEXT    NOT NULL,
  status          TEXT    NOT NULL
                          CHECK (status IN ('auto_resolved','awaiting_window','escalated','closed')),
  outcome         TEXT,
  refunded        INTEGER NOT NULL DEFAULT 0,
  needs_human     INTEGER NOT NULL DEFAULT 0,
  ticket          TEXT    NOT NULL,
  window_ends     TEXT,
  created_at      TEXT    NOT NULL,
  resolved_at     TEXT
);

/* The visible audit trail for a dispute. */
CREATE TABLE IF NOT EXISTS dispute_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  detail     TEXT,
  automated  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);

/*
 * Recall of a payment sent to the wrong person. Banks cannot reverse a valid
 * transfer unilaterally, so this asks the payee to return it and expires on
 * its own if they do not.
 */
CREATE TABLE IF NOT EXISTS recalls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  payer_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payee_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  reason          TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','returned','declined','expired')),
  created_at      TEXT    NOT NULL,
  deadline        TEXT    NOT NULL,
  settled_at      TEXT
);

/* Certificates a customer would otherwise have to visit a branch to collect. */
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  period_from TEXT,
  period_to   TEXT,
  reference   TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

/* UPI "request money" — a collect request sent to another AB Pay user. */
CREATE TABLE IF NOT EXISTS collect_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payer_account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount               INTEGER NOT NULL CHECK (amount > 0),
  note                 TEXT,
  status               TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','paid','declined')),
  created_at           TEXT    NOT NULL,
  settled_at           TEXT
);
`);

/* ---------- schema migration ---------- */

/*
 * Adds any column the current schema expects but an older database file is
 * missing, so an existing wallet survives an upgrade instead of needing the
 * file deleted.
 */
function ensureColumns(table, columns) {
  const present = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));

  for (const [name, definition] of Object.entries(columns)) {
    if (!present.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

/* Recurring deposits need to remember how much has actually been collected. */
/* Two-factor sign-in is per customer, and off until they turn it on. */
ensureColumns("users", {
  two_factor: "INTEGER NOT NULL DEFAULT 0"
});

ensureColumns("deposits", {
  instalments_paid: "INTEGER NOT NULL DEFAULT 1",
  next_due: "TEXT"
});

ensureColumns("cards", {
  notes: "TEXT",
  is_default: "INTEGER NOT NULL DEFAULT 0",
  track_spending: "INTEGER NOT NULL DEFAULT 1",
  expiry_reminder: "INTEGER NOT NULL DEFAULT 1",
  user_id: "INTEGER",
  kind: "TEXT NOT NULL DEFAULT 'debit'",
  issuer: "TEXT NOT NULL DEFAULT 'AB Pay'",
  label: "TEXT",
  last4: "TEXT",
  is_own: "INTEGER NOT NULL DEFAULT 1",
  created_at: "TEXT"
});

/*
 * Cards added from other banks have no account with us, so account_id must be
 * nullable. SQLite cannot drop a NOT NULL with ALTER, so a database created
 * before the wallet existed needs the table rebuilt around the data.
 */
(function relaxCardAccountId() {
  const column = db.prepare("PRAGMA table_info(cards)").all()
    .find(c => c.name === "account_id");
  if (!column || column.notnull === 0) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE cards_rebuilt (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT    NOT NULL DEFAULT 'debit' CHECK (kind IN ('debit','credit')),
        issuer        TEXT    NOT NULL DEFAULT 'AB Pay',
        label         TEXT,
        last4         TEXT,
        number        TEXT,
        network       TEXT    NOT NULL DEFAULT 'RuPay',
        expiry        TEXT    NOT NULL,
        is_own        INTEGER NOT NULL DEFAULT 1,
        status        TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','blocked')),
        atm_enabled   INTEGER NOT NULL DEFAULT 1,
        pos_enabled   INTEGER NOT NULL DEFAULT 1,
        online_enabled INTEGER NOT NULL DEFAULT 1,
        intl_enabled  INTEGER NOT NULL DEFAULT 0,
        daily_limit   INTEGER NOT NULL DEFAULT 5000000,
        created_at    TEXT
      );

      INSERT INTO cards_rebuilt
        (id, account_id, user_id, kind, issuer, label, last4, number, network,
         expiry, is_own, status, atm_enabled, pos_enabled, online_enabled,
         intl_enabled, daily_limit, created_at)
      SELECT id, account_id, user_id, kind, issuer, label, last4, number, network,
             expiry, is_own, status, atm_enabled, pos_enabled, online_enabled,
             intl_enabled, daily_limit, created_at
      FROM cards;

      DROP TABLE cards;
      ALTER TABLE cards_rebuilt RENAME TO cards;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");
})();

// Backfill rows written before the wallet existed.
db.exec(`
  UPDATE cards SET last4 = substr(number, -4) WHERE last4 IS NULL AND number IS NOT NULL;
  UPDATE cards SET user_id = (SELECT user_id FROM accounts WHERE accounts.id = cards.account_id)
    WHERE user_id IS NULL AND account_id IS NOT NULL;
`);

/* ---------- helpers ---------- */

const nowISO = () => new Date().toISOString();

// Derived from the row id, so account numbers are unique by construction.
const accountNumberFor = id => "5011" + String(10000000 + Number(id));

const toMinor = amount => Math.round(Number(amount) * 100);
const fromMinor = minor => Number(minor) / 100;

const maskCard = number => "XXXX XXXX XXXX " + number.slice(-4);

function uniqueUpiId(base) {
  const clean = String(base).toLowerCase().replace(/[^a-z0-9]/g, "") || "user";
  let candidate = `${clean}@${BANK.upiHandle}`;
  let n = 1;
  while (db.prepare("SELECT 1 FROM users WHERE upi_id = ?").get(candidate)) {
    candidate = `${clean}${++n}@${BANK.upiHandle}`;
  }
  return candidate;
}

/* ---------- users ---------- */

function createUser({ email, password, name, surname, mobile, address, branch, pan }) {
  const upiId = uniqueUpiId(`${name}${surname}`.slice(0, 14));
  const info = db.prepare(
    `INSERT INTO users (email, password, name, surname, mobile, upi_id, pan,
                        address, branch, date_registered)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(email.toLowerCase().trim(), password, name, surname, mobile, upiId,
        pan || null, address || null, branch, nowISO());

  return getUserById(Number(info.lastInsertRowid));
}

const getUserById = id => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const getUserByEmail = email =>
  db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
const getUserByUpiId = upi =>
  db.prepare("SELECT * FROM users WHERE upi_id = ?").get(String(upi).toLowerCase().trim());
const getUserByMobile = mobile =>
  db.prepare("SELECT * FROM users WHERE mobile = ?").get(String(mobile).trim());

const touchLogin = id =>
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(nowISO(), id);

/* ---------- accounts ---------- */

function openAccount(userId, branchCode, openingBalance = 0) {
  const info = db.prepare(
    `INSERT INTO accounts (user_id, number, ifsc, balance, date_opened)
     VALUES (?, '', ?, ?, ?)`
  ).run(userId, BANK.ifscPrefix + String(branchCode).padStart(6, "0"),
        openingBalance, nowISO());

  const id = Number(info.lastInsertRowid);
  db.prepare("UPDATE accounts SET number = ? WHERE id = ?").run(accountNumberFor(id), id);

  // Every account is issued a debit card.
  const number = "6522" + String(100000000000 + id * 7919).slice(-12);
  db.prepare(
    `INSERT INTO cards (account_id, user_id, kind, issuer, label, last4, number,
                        network, expiry, is_own, created_at)
     VALUES (?,?,'debit','AB Pay','AB Pay Debit',?,?,'RuPay',?,1,?)`
  ).run(id, userId, number.slice(-4), number,
        new Date(Date.now() + 5 * 365 * 864e5).toISOString().slice(0, 7), nowISO());

  return getAccountById(id);
}

const getAccountById = id => db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
const getAccountByUser = userId =>
  db.prepare("SELECT * FROM accounts WHERE user_id = ?").get(userId);
const getAccountByNumber = number =>
  db.prepare("SELECT * FROM accounts WHERE number = ?").get(String(number).trim());

const accountOwner = accountId => db.prepare(
  `SELECT u.* FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.id = ?`
).get(accountId);

const adjustBalance = (accountId, delta) =>
  db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(delta, accountId);

/* The card we issued for this account — the only one we can actually control. */
const getCard = accountId =>
  db.prepare("SELECT * FROM cards WHERE account_id = ? AND is_own = 1").get(accountId);

/* Everything in the customer's wallet, ours first. */
const listCards = userId =>
  db.prepare(
    "SELECT * FROM cards WHERE user_id = ? ORDER BY is_own DESC, kind, issuer, id"
  ).all(userId);

const getCardById = (id, userId) =>
  db.prepare("SELECT * FROM cards WHERE id = ? AND user_id = ?").get(id, userId);

/* ---------- transactions ---------- */

/*
 * Optional columns default to null rather than undefined, which node:sqlite
 * refuses to bind.
 */
function recordTransaction({
  accountId, direction, amount, balanceAfter,
  counterpartyNumber = null, counterpartyName = null,
  method = "UPI", category = "Other",
  description = null, reference = null, createdAt
}) {
  const info = db.prepare(
    `INSERT INTO transactions
      (account_id, direction, amount, balance_after, counterparty_number, counterparty_name,
       method, category, description, reference, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(accountId, direction, amount, balanceAfter, counterpartyNumber, counterpartyName,
        method, category, description, reference, createdAt || nowISO());
  return Number(info.lastInsertRowid);
}

const getTransaction = id =>
  db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);

function listTransactions(accountId, { from, to, limit, offset, q } = {}) {
  let sql = "SELECT * FROM transactions WHERE account_id = ?";
  const params = [accountId];
  if (from) { sql += " AND created_at >= ?"; params.push(from); }
  if (to)   { sql += " AND created_at <= ?"; params.push(to + "T23:59:59.999Z"); }
  if (q) {
    // Free text across the fields people actually remember.
    sql += ` AND (LOWER(IFNULL(description,'')) LIKE ?
                OR LOWER(IFNULL(counterparty_name,'')) LIKE ?
                OR LOWER(IFNULL(counterparty_number,'')) LIKE ?
                OR LOWER(IFNULL(reference,'')) LIKE ?
                OR LOWER(method) LIKE ? OR LOWER(category) LIKE ?)`;
    const like = "%" + String(q).toLowerCase().trim() + "%";
    params.push(like, like, like, like, like, like);
  }
  sql += " ORDER BY created_at DESC, id DESC";
  if (limit) {
    sql += " LIMIT ?";
    params.push(limit);
    if (offset) { sql += " OFFSET ?"; params.push(offset); }
  }
  return db.prepare(sql).all(...params);
}

/* Row count for the same filters, so a page knows how many there are. */
function countTransactions(accountId, { from, to, q } = {}) {
  let sql = "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?";
  const params = [accountId];
  if (from) { sql += " AND created_at >= ?"; params.push(from); }
  if (to)   { sql += " AND created_at <= ?"; params.push(to + "T23:59:59.999Z"); }
  if (q) {
    sql += ` AND (LOWER(IFNULL(description,'')) LIKE ?
              OR LOWER(IFNULL(counterparty_name,'')) LIKE ?
              OR LOWER(IFNULL(counterparty_number,'')) LIKE ?
              OR LOWER(IFNULL(reference,'')) LIKE ?
              OR LOWER(method) LIKE ? OR LOWER(category) LIKE ?)`;
    const like = "%" + String(q).toLowerCase().trim() + "%";
    params.push(like, like, like, like, like, like);
  }
  return db.prepare(sql).get(...params).n;
}

/* ---------- seed ---------- */

/*
 * Two demo customers so the app is usable immediately — a transfer needs a
 * real destination account, and the dashboard needs history to display.
 */
function seed() {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return;

  const demo = [
    {
      email: "demo@abpay.in", password: "demo1234", name: "Ananya", surname: "Sharma",
      mobile: "9876543210", pan: "ABCPS1234K", address: "12, MG Road, Indiranagar",
      branch: "Bengaluru — Indiranagar", branchCode: 1042, balance: 18452050
    },
    {
      email: "rahul@abpay.in", password: "demo1234", name: "Rahul", surname: "Verma",
      mobile: "9812345678", pan: "AXYPV5678L", address: "45, Bandra West",
      branch: "Mumbai — Bandra", branchCode: 2088, balance: 7310075
    }
  ];

  const created = demo.map(d => {
    const user = createUser({
      email: d.email, password: hashPassword(d.password), name: d.name, surname: d.surname,
      mobile: d.mobile, pan: d.pan, address: d.address, branch: d.branch
    });
    // Demo customers ship with a UPI PIN of 1234 so payments work immediately.
    db.prepare("UPDATE users SET upi_pin = ? WHERE id = ?")
      .run(hashPassword("1234"), user.id);

    return { user: getUserById(user.id), account: openAccount(user.id, d.branchCode, d.balance) };
  });

  const history = [
    ["out", 128000, "BigBasket", "Groceries", "UPI", -1],
    ["out", 45000, "Uber India", "Transport", "UPI", -2],
    ["in", 8500000, "Infosys Ltd — Salary", "Income", "NEFT", -3],
    ["out", 89900, "Swiggy", "Dining", "UPI", -4],
    ["out", 245000, "BESCOM Electricity", "Utilities", "Bill payment", -6],
    ["out", 59900, "Jio Recharge", "Recharge", "UPI", -8],
    ["out", 1250000, "Amazon India", "Shopping", "Debit card", -11]
  ];

  /*
   * Recurring charges going back four months, so the subscription detector
   * has a genuine pattern to find — including one that quietly went up.
   */
  const recurring = [
    { payee: "Netflix India", category: "Shopping", method: "Debit card",
      charges: [[-105, 19900], [-75, 19900], [-45, 24900], [-15, 24900]] },
    { payee: "Cult.fit Membership", category: "Other", method: "Debit card",
      charges: [[-100, 149900], [-70, 149900], [-40, 149900], [-10, 149900]] },
    { payee: "Spotify India", category: "Shopping", method: "UPI",
      charges: [[-95, 11900], [-65, 11900], [-35, 11900], [-5, 11900]] }
  ];

  const acc = created[0].account;
  let running = acc.balance;
  for (const [direction, amount, counterparty, category, method, dayOffset] of history) {
    const when = new Date();
    when.setDate(when.getDate() + dayOffset);
    recordTransaction({
      accountId: acc.id, direction, amount, balanceAfter: running,
      counterpartyName: counterparty, method, category, description: counterparty,
      createdAt: when.toISOString()
    });
    running += direction === "out" ? amount : -amount;
  }

  for (const sub of recurring) {
    for (const [dayOffset, amount] of sub.charges) {
      const when = new Date();
      when.setDate(when.getDate() + dayOffset);
      recordTransaction({
        accountId: acc.id, direction: "out", amount,
        balanceAfter: running, counterpartyName: sub.payee,
        method: sub.method, category: sub.category, description: sub.payee,
        createdAt: when.toISOString()
      });
      running += amount;
    }
  }

  db.prepare(
    `INSERT INTO payees (user_id, name, kind, account_number, ifsc, upi_id, created_at)
     VALUES (?,?,'upi',?,?,?,?)`
  ).run(created[0].user.id, "Rahul Verma", created[1].account.number,
        created[1].account.ifsc, created[1].user.upi_id, nowISO());

  db.prepare(
    `INSERT INTO bills (user_id, title, provider, amount, reference, status, due_date, created_at)
     VALUES (?,?,?,?,?,'pending',?,?)`
  ).run(created[0].user.id, "Electricity — March", "BESCOM", 241050, "BESC-4471902",
        new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), nowISO());
}

module.exports = {
  db, BANK, seed, nowISO, toMinor, fromMinor, maskCard,
  createUser, getUserById, getUserByEmail, getUserByUpiId, getUserByMobile, touchLogin,
  openAccount, getAccountById, getAccountByUser, getAccountByNumber, accountOwner,
  adjustBalance, getCard, listCards, getCardById,
  recordTransaction, listTransactions, countTransactions, getTransaction
};
