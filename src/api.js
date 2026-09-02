/*
 * REST API. Every route below /api except signup, login and reference data
 * requires a valid session token; the authenticated user's own account is
 * resolved from that token, never from a client-supplied id.
 */

const express = require("express");
const QRCode = require("qrcode");

const store = require("./db");
const { hashPassword, verifyPassword, createToken, verifyToken, TOKEN_TTL_SECONDS } = require("./auth");
const money = require("./money");
const catalog = require("./catalog");
const payee = require("./payee");
const servicing = require("./servicing");
const assistant = require("./assistant");
const ifsc = require("./ifsc");
const radar = require("./radar");
const mandates = require("./mandates");
const notify = require("./notify");
const security = require("./security");

const router = express.Router();
const { fromMinor, BANK } = store;

// Indian digit grouping with paise, for messages shown to the customer.
const rupees = minor => "\u20B9" + fromMinor(minor).toLocaleString("en-IN",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- shaping ---------- */

const publicAccount = account => ({
  number: account.number,
  ifsc: account.ifsc,
  balance: fromMinor(account.balance),
  currency: account.currency,
  type: account.account_type,
  limitMonthly: fromMinor(account.limit_monthly),
  usedLimit: fromMinor(money.monthlySpend(account.id)),
  openedAt: account.date_opened
});

const publicTransaction = tx => ({
  id: tx.id,
  direction: tx.direction,
  amount: fromMinor(tx.amount),
  balanceAfter: fromMinor(tx.balance_after),
  counterpartyNumber: tx.counterparty_number,
  counterpartyName: tx.counterparty_name,
  method: tx.method,
  category: tx.category,
  description: tx.description,
  reference: tx.reference,
  date: tx.created_at
});

const publicUser = user => ({
  id: user.id,
  email: user.email,
  name: user.name,
  surname: user.surname,
  mobile: user.mobile,
  upiId: user.upi_id,
  hasUpiPin: !!user.upi_pin,
  twoFactor: !!user.two_factor,
  pan: user.pan,
  address: user.address,
  branch: user.branch,
  nominee: user.nominee,
  registeredAt: user.date_registered,
  lastLogin: user.last_login
});

const publicCard = card => ({
  masked: store.maskCard(card.number),
  network: card.network,
  expiry: card.expiry,
  status: card.status,
  atm: !!card.atm_enabled,
  pos: !!card.pos_enabled,
  online: !!card.online_enabled,
  international: !!card.intl_enabled,
  dailyLimit: fromMinor(card.daily_limit)
});

/*
 * Wraps a handler so thrown MoneyErrors become clean HTTP responses.
 *
 * Only errors we raised deliberately carry a message worth showing. Anything
 * else — a database constraint, a null dereference — gets logged in full and
 * answered generically, so internals like table and column names never reach
 * the customer.
 */
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) {
      console.error(err);
      return res.status(500).json({
        message: "Something went wrong at our end. Please try again."
      });
    }
    res.status(status).json({ message: err.message || "Request failed." });
  }
};

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const userId = verifyToken(header.replace(/^Bearer\s+/i, ""));
  if (!userId) return res.status(401).json({ message: "Please sign in again." });

  const user = store.getUserById(userId);
  if (!user) return res.status(401).json({ message: "Please sign in again." });

  req.user = user;
  req.account = store.getAccountByUser(user.id);
  next();
}

/*
 * UPI transactions are authorised with the customer's UPI PIN, exactly as
 * they are on the national network — a session alone is not enough.
 */
function requireUpiPin(req) {
  if (!req.user.upi_pin) {
    throw new money.MoneyError("Set your UPI PIN before making UPI payments.", 428);
  }
  const pin = (req.body && req.body.pin) || "";
  if (!verifyPassword(String(pin), req.user.upi_pin)) {
    throw new money.MoneyError("Incorrect UPI PIN.", 403);
  }
}

/* ---------- reference data ---------- */

router.get("/catalog", handle((req, res) => {
  res.json({
    bank: BANK.name,
    mobilePlans: catalog.MOBILE_PLANS,
    dthOperators: catalog.DTH_OPERATORS,
    billers: catalog.BILLERS,
    fdRates: money.FD_RATES,
    rdRates: money.RD_RATES,
    upiLimit: fromMinor(money.MAX_UPI)
  });
}));

/* ---------- real UPI collection (public) ---------- */

/*
 * Builds a genuine NPCI payment request for the address in src/payee.js.
 *
 * This is deliberately public and unauthenticated: the whole point is that a
 * visitor can scan it. Unlike the rest of this app it is not a simulation —
 * a scan here debits the payer's real bank account.
 *
 * The query is encoded by hand rather than with URLSearchParams, which would
 * emit "+" for spaces in the payee name; "%20" is read correctly by every
 * UPI app.
 */
router.get("/receive", handle(async (req, res) => {
  const params = [
    // "@" is legal unencoded in a query and is left literal in real UPI QRs,
    // so keep it that way rather than emitting %40.
    `pa=${encodeURIComponent(payee.vpa).replace(/%40/g, "@")}`,
    `pn=${encodeURIComponent(payee.name)}`,
    "cu=INR"
  ];

  const amount = Number(req.query.amount);
  if (Number.isFinite(amount) && amount > 0) {
    params.push(`am=${amount.toFixed(2)}`);
  }
  const note = String(req.query.note || "").trim();
  if (note) params.push(`tn=${encodeURIComponent(note.slice(0, 50))}`);

  const payload = "upi://pay?" + params.join("&");

  // High error correction, so the code still scans from a photographed screen.
  const dataUrl = await QRCode.toDataURL(payload, {
    width: 460, margin: 2, errorCorrectionLevel: "H",
    color: { dark: "#12263f", light: "#ffffff" }
  });

  res.json({
    payload, dataUrl,
    upiId: payee.vpa,
    name: payee.name,
    bank: payee.bank,
    // Tells the UI to label the page a placeholder rather than a live payee.
    configured: payee.configured,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    note: note || null
  });
}));

/* ---------- auth ---------- */

router.post("/signup", handle((req, res) => {
  const { name, surname, email, password, mobile, pan } = req.body || {};

  if (!name || !surname || !email || !password || !mobile) {
    return res.status(400).json({ message: "All fields are required." });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }
  if (!/^[6-9]\d{9}$/.test(String(mobile).trim())) {
    return res.status(400).json({ message: "Enter a valid 10-digit Indian mobile number." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/i.test(String(pan).trim())) {
    return res.status(400).json({ message: "Enter a valid PAN, e.g. ABCPS1234K." });
  }
  if (store.getUserByEmail(email)) {
    return res.status(409).json({ message: "An account with that email already exists." });
  }
  if (store.getUserByMobile(String(mobile).trim())) {
    return res.status(409).json({ message: "That mobile number is already registered." });
  }

  const branches = [
    { name: "Bengaluru — Indiranagar", code: 1042 },
    { name: "Mumbai — Bandra", code: 2088 },
    { name: "Delhi — Connaught Place", code: 3011 },
    { name: "Pune — Kothrud", code: 4123 },
    { name: "Hyderabad — Banjara Hills", code: 5077 }
  ];
  const branch = branches[Math.floor(Math.random() * branches.length)];

  const user = store.createUser({
    email,
    password: hashPassword(password),
    name: String(name).trim(),
    surname: String(surname).trim(),
    mobile: String(mobile).trim(),
    pan: pan ? String(pan).trim().toUpperCase() : null,
    address: "",
    branch: branch.name
  });

  // New customers start with a small opening credit so the demo is usable.
  const account = store.openAccount(user.id, branch.code, 500000);
  store.recordTransaction({
    accountId: account.id, direction: "in", amount: 500000,
    balanceAfter: account.balance, counterpartyName: `${BANK.name} welcome credit`,
    method: "Credit", category: "Income", description: "Account opening credit",
    reference: "WELCOME"
  });

  res.status(201).json({
    token: createToken(user.id),
    expiresIn: TOKEN_TTL_SECONDS,
    user: publicUser(user),
    account: publicAccount(store.getAccountById(account.id))
  });
}));

const session = user => ({
  token: createToken(user.id),
  expiresIn: TOKEN_TTL_SECONDS,
  user: publicUser(user),
  account: publicAccount(store.getAccountByUser(user.id))
});

router.post("/login", handle((req, res) => {
  const { email, password } = req.body || {};
  const identifier = String(email || "").toLowerCase().trim();

  // Refuse before checking the password, so a locked account cannot be probed.
  const wait = security.lockoutSeconds(identifier);
  if (wait > 0) {
    return res.status(429).json({
      message: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
      retryAfter: wait
    });
  }

  const user = identifier ? store.getUserByEmail(identifier) : null;

  // Same message either way, so the response cannot be used to probe emails.
  if (!user || !verifyPassword(password || "", user.password)) {
    security.recordAttempt(identifier, false);
    return res.status(401).json({ message: "Incorrect email or password." });
  }

  if (user.two_factor) {
    // The password was right, but the session is not issued until the code is.
    security.issueLoginCode(user);
    return res.json({
      otpRequired: true,
      email: user.email,
      message: `We sent a 6-digit code. It expires in ${security.OTP_TTL_MINUTES} minutes.`
    });
  }

  security.recordAttempt(identifier, true);
  store.touchLogin(user.id);
  res.json(session(user));
}));

/* Second step when two-factor sign-in is on. */
router.post("/login/verify", handle((req, res) => {
  const { email, code } = req.body || {};
  const identifier = String(email || "").toLowerCase().trim();

  const wait = security.lockoutSeconds(identifier);
  if (wait > 0) {
    return res.status(429).json({
      message: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`
    });
  }

  const user = identifier ? store.getUserByEmail(identifier) : null;
  if (!user || !security.verifyLoginCode(user, code)) {
    security.recordAttempt(identifier, false);
    return res.status(401).json({ message: "That code is wrong or has expired." });
  }

  security.recordAttempt(identifier, true);
  store.touchLogin(user.id);

  notify.notify(user.id, {
    kind: "security", severity: "info",
    title: "New sign-in to your account",
    body: `Signed in on ${new Date().toLocaleString("en-IN")}.`
  });

  res.json(session(user));
}));

/* ---------- password reset ---------- */

/*
 * Answers identically whether or not the address is registered, so this
 * endpoint cannot be used to find out who banks here.
 */
router.post("/password/forgot", handle((req, res) => {
  const result = security.requestPasswordReset((req.body || {}).email);

  const body = {
    message: "If that email is registered, a reset link is on its way. " +
      "The link expires in 30 minutes."
  };

  /*
   * With no mail provider configured the link would be unreachable, so in
   * development it is returned directly. Setting NOTIFY_WEBHOOK (or any real
   * mail transport) turns this off.
   */
  if (result.token && !process.env.NOTIFY_WEBHOOK) {
    body.devResetToken = result.token;
  }
  res.json(body);
}));

router.post("/password/reset", handle((req, res) => {
  const { token, password } = req.body || {};
  const result = security.completePasswordReset(token, password, hashPassword);

  if (!result.ok) return res.status(400).json({ message: result.message });
  res.json({ message: "Password changed. Sign in with your new password." });
}));

router.use(["/me", "/profile", "/dashboard", "/transactions", "/statement.csv", "/transfer",
            "/insights", "/payees", "/bills", "/safesend", "/qr", "/upi", "/deposits",
            "/recharge", "/billpay", "/card", "/requests",
            "/support", "/documents", "/analytics", "/assistant",
            "/linked", "/radar", "/autopay", "/subscriptions",
            "/notifications", "/security", "/scheduled", "/account"], requireAuth);

router.get("/me", handle((req, res) => {
  res.json({ user: publicUser(req.user), account: publicAccount(req.account) });
}));

router.post("/profile", handle((req, res) => {
  const { address, nominee, pan } = req.body || {};
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/i.test(String(pan).trim())) {
    return res.status(400).json({ message: "Enter a valid PAN, e.g. ABCPS1234K." });
  }

  store.db.prepare(
    "UPDATE users SET address = ?, nominee = ?, pan = ? WHERE id = ?"
  ).run(address ?? req.user.address, nominee ?? req.user.nominee,
        pan ? String(pan).toUpperCase() : req.user.pan, req.user.id);

  res.json({ message: "Profile updated.", user: publicUser(store.getUserById(req.user.id)) });
}));

/* ---------- dashboard ---------- */

router.get("/dashboard", handle((req, res) => {
  money.expireProtectedPayments();

  const account = store.getAccountByUser(req.user.id);
  const transactions = store.listTransactions(account.id, { limit: 8 }).map(publicTransaction);
  const held = money.listProtectedPayments(account.id).filter(p => p.status === "held");

  const deposits = store.db.prepare(
    "SELECT COALESCE(SUM(principal),0) AS total, COUNT(*) AS count FROM deposits WHERE user_id = ? AND status = 'active'"
  ).get(req.user.id);

  const pendingCollects = store.db.prepare(
    "SELECT COUNT(*) AS n FROM collect_requests WHERE payer_account_id = ? AND status = 'pending'"
  ).get(account.id).n;

  res.json({
    user: publicUser(req.user),
    account: publicAccount(account),
    transactions,
    protectedHeld: held.length,
    protectedHeldAmount: fromMinor(held
      .filter(p => p.sender_account_id === account.id)
      .reduce((sum, p) => sum + p.amount, 0)),
    depositsTotal: fromMinor(deposits.total),
    depositsCount: deposits.count,
    pendingCollects
  });
}));

/*
 * Spending grouped by category over a rolling 30-day window. A calendar
 * month would read as empty for anyone looking on the 1st.
 */
router.get("/insights", handle((req, res) => {
  const start = new Date(Date.now() - 30 * 864e5);

  const rows = store.db.prepare(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS count
     FROM transactions
     WHERE account_id = ? AND direction = 'out' AND created_at >= ?
     GROUP BY category ORDER BY total DESC`
  ).all(req.account.id, start.toISOString());

  res.json({
    since: start.toISOString().slice(0, 10),
    categories: rows.map(r => ({
      category: r.category, total: fromMinor(r.total), count: r.count
    })),
    total: fromMinor(rows.reduce((sum, r) => sum + Number(r.total), 0))
  });
}));

/* ---------- statement ---------- */

router.get("/transactions", handle((req, res) => {
  const { from, to, q } = req.query;

  // Paged, so a long history cannot be pulled into memory in one go.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const total = store.countTransactions(req.account.id, { from, to, q });
  const rows = store.listTransactions(req.account.id, { from, to, q, limit, offset });

  res.json({
    transactions: rows.map(publicTransaction),
    count: rows.length,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    hasMore: offset + rows.length < total
  });
}));

router.get("/statement.csv", handle((req, res) => {
  // The export mirrors exactly what the filtered table shows, search included.
  const { from, to, q } = req.query;
  const rows = store.listTransactions(req.account.id, { from, to, q });

  const escape = value => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = ["Date", "Narration", "Counterparty", "Account / UPI ID", "Mode",
                  "Category", "Type", "Amount (INR)", "Balance (INR)", "Reference"];

  const lines = [header.join(",")].concat(rows.map(tx => [
    tx.created_at.slice(0, 10), tx.description, tx.counterparty_name, tx.counterparty_number,
    tx.method, tx.category, tx.direction === "out" ? "Debit" : "Credit",
    (tx.direction === "out" ? "-" : "") + fromMinor(tx.amount).toFixed(2),
    fromMinor(tx.balance_after).toFixed(2), tx.reference
  ].map(escape).join(",")));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="statement-${req.account.number}.csv"`);
  res.send(lines.join("\n"));
}));

/* ---------- bank transfers (IMPS / NEFT) ---------- */

router.post("/transfer", handle((req, res) => {
  const { toAccount, ifsc, amount, description, mode, savePayee, payeeName } = req.body || {};
  if (!toAccount) return res.status(400).json({ message: "Enter a destination account number." });

  const method = ["IMPS", "NEFT", "RTGS"].includes(mode) ? mode : "IMPS";
  if (method === "RTGS" && money.parseAmount(amount) < 20000000) {
    return res.status(400).json({ message: "RTGS is for transfers of ₹2,00,000 and above." });
  }

  /*
   * Catch a double tap before the money moves. The caller re-sends with
   * confirmDuplicate once the customer says they meant it.
   */
  if (!(req.body || {}).confirmDuplicate) {
    const twin = radar.recentIdenticalPayment(req.account.id, {
      counterparty: String(toAccount).trim(),
      amountMinor: money.parseAmount(amount)
    });
    if (twin) {
      return res.status(409).json({
        duplicate: true,
        message: `You already sent ${rupees(twin.amount)} to this account ` +
          `${Math.max(1, Math.round((Date.now() - new Date(twin.created_at)) / 60000))} ` +
          `minute(s) ago. Send it again?`
      });
    }
  }

  const result = money.transfer({
    fromAccountId: req.account.id,
    toNumber: toAccount,
    ifsc,
    beneficiaryName: payeeName,
    amount,
    description: description || `${method} transfer`,
    method
  });

  if (savePayee) {
    // The beneficiary may be at another bank, so fall back to what was typed.
    const target = store.getAccountByNumber(toAccount);
    const name = target
      ? payeeName || (() => {
          const owner = store.accountOwner(target.id);
          return `${owner.name} ${owner.surname}`;
        })()
      : payeeName || String(toAccount);

    store.db.prepare(
      `INSERT INTO payees (user_id, name, kind, account_number, ifsc, upi_id, created_at)
       VALUES (?,?,'bank',?,?,?,?)`
    ).run(req.user.id, name,
          target ? target.number : String(toAccount).trim(),
          target ? target.ifsc : String(ifsc || "").toUpperCase(),
          target ? store.accountOwner(target.id).upi_id : null,
          store.nowISO());
  }

  res.status(201).json({
    message: result.external
      ? `${method} sent to ${result.ifsc} ${result.to}.`
      : `${method} transfer completed.`,
    reference: result.reference,
    external: !!result.external,
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

/*
 * Looks up an account number before money moves. AB Pay accounts return a
 * verified name; anything else needs an IFSC and the payer's own care.
 */
router.post("/transfer/verify", handle((req, res) => {
  const { toAccount } = req.body || {};
  const target = toAccount ? store.getAccountByNumber(toAccount) : null;

  if (!target) {
    return res.json({ internal: false, needsIfsc: true });
  }
  const owner = store.accountOwner(target.id);
  res.json({
    internal: true,
    needsIfsc: false,
    name: `${owner.name} ${owner.surname}`,
    ifsc: target.ifsc,
    isSelf: target.id === req.account.id
  });
}));

/* ---------- UPI ---------- */

router.post("/upi/pin", handle((req, res) => {
  const { pin, currentPin } = req.body || {};
  if (!/^\d{4}$|^\d{6}$/.test(String(pin || ""))) {
    return res.status(400).json({ message: "UPI PIN must be 4 or 6 digits." });
  }
  // Changing an existing PIN requires the old one.
  if (req.user.upi_pin && !verifyPassword(String(currentPin || ""), req.user.upi_pin)) {
    return res.status(403).json({ message: "Current UPI PIN is incorrect." });
  }

  store.db.prepare("UPDATE users SET upi_pin = ? WHERE id = ?")
    .run(hashPassword(String(pin)), req.user.id);

  res.json({ message: "UPI PIN set." });
}));

/*
 * Reads any scanned code and reports who would be paid, without paying.
 * Names for AB Pay payees come from our own records, not from the QR, so
 * a forged "pn" field cannot misrepresent who is being paid.
 */
router.post("/upi/resolve", handle((req, res) => {
  const { payload } = req.body || {};
  const parsed = money.parsePaymentPayload(payload);

  if (parsed.account && !parsed.vpa) {
    const target = store.getAccountByNumber(parsed.account);
    if (!target) return res.status(404).json({ message: `Not an ${BANK.name} account.` });
    const owner = store.accountOwner(target.id);
    return res.json({
      kind: "account", account: target.number, vpa: owner.upi_id,
      name: `${owner.name} ${owner.surname}`, verified: true,
      amount: parsed.amount, note: parsed.note,
      isSelf: target.id === req.account.id
    });
  }

  const target = money.resolveVpa(parsed.vpa);
  res.json({
    kind: "upi",
    vpa: parsed.vpa,
    // Verified names are ours; for other banks we can only show the QR's claim.
    name: target.external ? (parsed.name || parsed.vpa) : target.name,
    verified: !target.external,
    external: target.external,
    amount: parsed.amount,
    note: parsed.note,
    isSelf: !target.external && target.account.id === req.account.id
  });
}));

router.post("/upi/pay", handle((req, res) => {
  requireUpiPin(req);
  const { payload, vpa, amount, note, payeeName } = req.body || {};

  let address = vpa;
  let fixedAmount = null;
  let payeeNote = note;
  let name = payeeName;

  if (payload) {
    const parsed = money.parsePaymentPayload(payload);
    if (parsed.account && !parsed.vpa) {
      const target = store.getAccountByNumber(parsed.account);
      if (!target) return res.status(404).json({ message: "Payee account not found." });
      address = store.accountOwner(target.id).upi_id;
    } else {
      address = parsed.vpa;
    }
    // An amount fixed inside the QR wins over anything the payer types.
    fixedAmount = parsed.amount;
    payeeNote = payeeNote || parsed.note;
    name = name || parsed.name;
  }

  if (!address) return res.status(400).json({ message: "No UPI ID to pay." });

  if (!req.body.confirmDuplicate) {
    const twin = radar.recentIdenticalPayment(req.account.id, {
      counterparty: String(address).toLowerCase().trim(),
      amountMinor: money.parseAmount(fixedAmount || amount, money.MAX_UPI)
    });
    if (twin) {
      return res.status(409).json({
        duplicate: true,
        message: `You already paid ${rupees(twin.amount)} to ${address} ` +
          `${Math.max(1, Math.round((Date.now() - new Date(twin.created_at)) / 60000))} ` +
          `minute(s) ago. Pay again?`
      });
    }
  }

  const result = money.payUpi({
    fromAccountId: req.account.id,
    vpa: address,
    amount: fixedAmount || amount,
    note: payeeNote,
    payeeName: name
  });

  res.status(201).json({
    message: result.external
      ? `${rupees(result.amount)} sent to ${result.to}.`
      : "UPI payment successful.",
    reference: result.reference,
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

/* Pay by registered mobile number, as UPI apps allow. */
router.post("/upi/pay-mobile", handle((req, res) => {
  requireUpiPin(req);
  const { mobile, amount, note } = req.body || {};
  const payee = store.getUserByMobile(String(mobile || "").trim());
  if (!payee) return res.status(404).json({ message: `No ${BANK.name} customer with that number.` });

  const result = money.payUpi({
    fromAccountId: req.account.id, vpa: payee.upi_id, amount, note
  });

  res.status(201).json({
    message: `Paid ${payee.name} ${payee.surname}.`,
    reference: result.reference,
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

/* Builds a scannable QR asking someone to pay this account. */
router.get("/qr", handle(async (req, res) => {
  const { amount, note } = req.query;

  /*
   * Emitted in the NPCI upi:// format, so any Indian payment app can scan
   * and pay it, not just this one.
   */
  // Encoded by hand: URLSearchParams would emit "%40" for @ and "+" for
  // spaces, neither of which matches how real UPI QRs are written.
  const params = [
    `pa=${encodeURIComponent(req.user.upi_id).replace(/%40/g, "@")}`,
    `pn=${encodeURIComponent(`${req.user.name} ${req.user.surname}`)}`,
    "cu=INR"
  ];
  if (amount && Number(amount) > 0) params.push(`am=${Number(amount).toFixed(2)}`);
  if (note) params.push(`tn=${encodeURIComponent(note)}`);

  const payload = "upi://pay?" + params.join("&");
  const dataUrl = await QRCode.toDataURL(payload, {
    width: 320, margin: 1, color: { dark: "#101418", light: "#ffffff" }
  });

  res.json({ payload, dataUrl, upiId: req.user.upi_id, account: req.account.number });
}));

/* Request money from another AB Pay customer. */
router.get("/upi/collect", handle((req, res) => {
  const rows = store.db.prepare(
    `SELECT c.*, ra.number AS requester_number, pa.number AS payer_number
     FROM collect_requests c
     JOIN accounts ra ON ra.id = c.requester_account_id
     JOIN accounts pa ON pa.id = c.payer_account_id
     WHERE c.requester_account_id = ? OR c.payer_account_id = ?
     ORDER BY c.created_at DESC`
  ).all(req.account.id, req.account.id);

  res.json({
    requests: rows.map(r => ({
      id: r.id,
      role: r.requester_account_id === req.account.id ? "requester" : "payer",
      counterparty: r.requester_account_id === req.account.id
        ? store.accountOwner(r.payer_account_id).upi_id
        : store.accountOwner(r.requester_account_id).upi_id,
      amount: fromMinor(r.amount),
      note: r.note,
      status: r.status,
      createdAt: r.created_at
    }))
  });
}));

router.post("/upi/collect", handle((req, res) => {
  const { fromUpi, amount, note } = req.body || {};
  const payer = store.getUserByUpiId(String(fromUpi || "").trim());
  if (!payer) {
    return res.status(404).json({
      message: `Collect requests can only be sent to ${BANK.name} customers.`
    });
  }

  const payerAccount = store.getAccountByUser(payer.id);
  if (payerAccount.id === req.account.id) {
    return res.status(400).json({ message: "You cannot request money from yourself." });
  }

  store.db.prepare(
    `INSERT INTO collect_requests (requester_account_id, payer_account_id, amount, note, created_at)
     VALUES (?,?,?,?,?)`
  ).run(req.account.id, payerAccount.id, money.parseAmount(amount, money.MAX_UPI),
        note || null, store.nowISO());

  res.status(201).json({ message: `Request sent to ${payer.upi_id}.` });
}));

router.post("/upi/collect/:id/pay", handle((req, res) => {
  requireUpiPin(req);
  const request = store.db.prepare("SELECT * FROM collect_requests WHERE id = ?")
    .get(req.params.id);

  if (!request) return res.status(404).json({ message: "Request not found." });
  if (request.payer_account_id !== req.account.id) {
    return res.status(403).json({ message: "This request is not addressed to you." });
  }
  if (request.status !== "pending") {
    return res.status(409).json({ message: `This request is already ${request.status}.` });
  }

  const requester = store.accountOwner(request.requester_account_id);
  money.payUpi({
    fromAccountId: req.account.id,
    vpa: requester.upi_id,
    amount: fromMinor(request.amount),
    note: request.note || "UPI collect request"
  });

  store.db.prepare("UPDATE collect_requests SET status='paid', settled_at=? WHERE id=?")
    .run(store.nowISO(), request.id);

  res.json({
    message: "Request paid.",
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

router.post("/upi/collect/:id/decline", handle((req, res) => {
  const request = store.db.prepare("SELECT * FROM collect_requests WHERE id = ?")
    .get(req.params.id);

  if (!request) return res.status(404).json({ message: "Request not found." });
  if (request.payer_account_id !== req.account.id) {
    return res.status(403).json({ message: "This request is not addressed to you." });
  }
  store.db.prepare("UPDATE collect_requests SET status='declined', settled_at=? WHERE id=?")
    .run(store.nowISO(), request.id);

  res.json({ message: "Request declined." });
}));

/* ---------- recharge & bill payment ---------- */

router.post("/recharge", handle((req, res) => {
  const { type, operator, number, planId, amount } = req.body || {};

  if (type === "mobile") {
    const plans = catalog.MOBILE_PLANS[operator];
    if (!plans) return res.status(400).json({ message: "Choose a valid operator." });
    if (!/^[6-9]\d{9}$/.test(String(number || "").trim())) {
      return res.status(400).json({ message: "Enter a valid 10-digit mobile number." });
    }

    const plan = plans.find(p => p.id === planId);
    const value = plan ? plan.amount : amount;
    const minor = money.parseAmount(value, money.MAX_UPI);

    const account = store.getAccountById(req.account.id);
    if (account.balance < minor) {
      return res.status(400).json({ message: "Insufficient balance for this recharge." });
    }

    store.adjustBalance(account.id, -minor);
    store.recordTransaction({
      accountId: account.id, direction: "out", amount: minor,
      balanceAfter: store.getAccountById(account.id).balance,
      counterpartyNumber: String(number).trim(), counterpartyName: `${operator} recharge`,
      method: "Recharge", category: "Recharge",
      description: `${operator} · ${number}${plan ? " · " + plan.validity : ""}`,
      reference: "RCH" + Date.now().toString(36).toUpperCase()
    });

    return res.status(201).json({
      message: `Recharge of ${rupees(minor)} successful.`,
      balance: fromMinor(store.getAccountById(account.id).balance)
    });
  }

  if (type === "dth") {
    if (!catalog.DTH_OPERATORS.includes(operator)) {
      return res.status(400).json({ message: "Choose a valid DTH operator." });
    }
    const minor = money.parseAmount(amount, money.MAX_UPI);
    const account = store.getAccountById(req.account.id);
    if (account.balance < minor) {
      return res.status(400).json({ message: "Insufficient balance for this recharge." });
    }

    store.adjustBalance(account.id, -minor);
    store.recordTransaction({
      accountId: account.id, direction: "out", amount: minor,
      balanceAfter: store.getAccountById(account.id).balance,
      counterpartyNumber: String(number || "").trim(), counterpartyName: `${operator} DTH`,
      method: "Recharge", category: "Utilities",
      description: `${operator} DTH · ${number}`,
      reference: "DTH" + Date.now().toString(36).toUpperCase()
    });

    return res.status(201).json({
      message: "DTH recharge successful.",
      balance: fromMinor(store.getAccountById(account.id).balance)
    });
  }

  res.status(400).json({ message: "Unknown recharge type." });
}));

router.post("/billpay", handle((req, res) => {
  const { billerId, consumerNumber, amount } = req.body || {};
  const biller = catalog.BILLERS.find(b => b.id === billerId);
  if (!biller) return res.status(400).json({ message: "Choose a valid biller." });
  if (!consumerNumber) {
    return res.status(400).json({ message: `Enter your ${biller.label.toLowerCase()}.` });
  }

  const minor = money.parseAmount(amount);
  const account = store.getAccountById(req.account.id);
  if (account.balance < minor) {
    return res.status(400).json({ message: "Insufficient balance to pay this bill." });
  }

  store.adjustBalance(account.id, -minor);
  store.recordTransaction({
    accountId: account.id, direction: "out", amount: minor,
    balanceAfter: store.getAccountById(account.id).balance,
    counterpartyNumber: String(consumerNumber).trim(), counterpartyName: biller.name,
    method: "Bill payment", category: money.categorise(biller.category + " " + biller.name),
    description: `${biller.name} · ${biller.category}`,
    reference: "BBPS" + Date.now().toString(36).toUpperCase()
  });

  res.status(201).json({
    message: `${biller.name} bill paid.`,
    balance: fromMinor(store.getAccountById(account.id).balance)
  });
}));

/* ---------- deposits ---------- */

router.get("/deposits", handle((req, res) => {
  const rows = store.db.prepare(
    "SELECT * FROM deposits WHERE user_id = ? ORDER BY status, maturity_at"
  ).all(req.user.id);

  res.json({
    deposits: rows.map(d => ({
      id: d.id, kind: d.kind,
      principal: fromMinor(d.principal),
      monthlyAmount: d.monthly_amount ? fromMinor(d.monthly_amount) : null,
      rate: d.rate, tenureMonths: d.tenure_months,
      maturityAmount: fromMinor(d.maturity_amount),
      openedAt: d.opened_at, maturityAt: d.maturity_at,
      status: d.status, closedAt: d.closed_at
    })),
    fdRates: money.FD_RATES,
    rdRates: money.RD_RATES
  });
}));

/* Preview a maturity value without committing any money. */
router.post("/deposits/quote", handle((req, res) => {
  const { kind, amount, tenureMonths } = req.body || {};
  const table = kind === "RD" ? money.RD_RATES : money.FD_RATES;
  const months = Number(tenureMonths);
  const minor = money.parseAmount(amount);
  const rate = money.rateFor(table, months);

  const maturity = kind === "RD"
    ? money.rdMaturity(minor, rate, months)
    : money.fdMaturity(minor, rate, months);

  res.json({
    rate,
    invested: fromMinor(kind === "RD" ? minor * months : minor),
    maturityAmount: fromMinor(maturity),
    interest: fromMinor(maturity - (kind === "RD" ? minor * months : minor))
  });
}));

router.post("/deposits", handle((req, res) => {
  const { kind, amount, tenureMonths } = req.body || {};
  if (!["FD", "RD"].includes(kind)) {
    return res.status(400).json({ message: "Choose FD or RD." });
  }

  const result = money.openDeposit({
    userId: req.user.id, accountId: req.account.id, kind, amount, tenureMonths
  });

  res.status(201).json({
    message: `${kind} opened at ${result.rate}% p.a.`,
    ...result,
    maturityAmount: fromMinor(result.maturityAmount),
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

router.post("/deposits/:id/close", handle((req, res) => {
  const result = money.closeDeposit(Number(req.params.id), req.user.id);
  res.json({
    message: result.matured
      ? `Matured deposit credited: ${rupees(result.payout)}.`
      : `Closed early. ${rupees(result.payout)} credited after penalty.`,
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

/* ---------- debit card ---------- */

const NETWORKS = ["RuPay", "Visa", "Mastercard", "Amex", "Diners Club"];

router.get("/card", handle((req, res) => {
  const own = store.getCard(req.account.id);
  if (!own) return res.status(404).json({ message: "No card issued for this account." });

  const cards = store.listCards(req.user.id);
  const now = new Date();

  res.json({
    networks: NETWORKS,
    // Kept for the issued card's controls, which only apply to our own card.
    card: publicCard(own),
    cards: cards.map(c => {
      // "YYYY-MM" — expiry is the last day of that month.
      const [year, month] = String(c.expiry).split("-").map(Number);
      const expires = new Date(year, month, 0, 23, 59, 59);
      const daysLeft = Math.ceil((expires - now) / 864e5);

      return {
        id: c.id,
        kind: c.kind,
        issuer: c.issuer,
        label: c.label,
        last4: c.last4,
        network: c.network,
        expiry: c.expiry,
        isOwn: !!c.is_own,
        status: c.status,
        notes: c.notes,
        isDefault: !!c.is_default,
        trackSpending: !!c.track_spending,
        expiryReminder: !!c.expiry_reminder,
        expired: daysLeft < 0,
        expiringSoon: daysLeft >= 0 && daysLeft <= 90,
        daysLeft,
        controls: c.is_own ? {
          atm: !!c.atm_enabled,
          pos: !!c.pos_enabled,
          online: !!c.online_enabled,
          international: !!c.intl_enabled,
          dailyLimit: fromMinor(c.daily_limit)
        } : null
      };
    })
  });
}));

/*
 * Saves a card from another bank to the wallet.
 *
 * The request carries only the last four digits — the browser validates the
 * full number with a Luhn check and never transmits it, and no CVV is
 * accepted, so nothing here is enough to transact on the card.
 */
router.post("/card", handle((req, res) => {
  const { kind, issuer, label, last4, network, expiry } = req.body || {};

  if (!["debit", "credit"].includes(kind)) {
    return res.status(400).json({ message: "Choose debit or credit." });
  }
  if (!issuer || String(issuer).trim().length < 2) {
    return res.status(400).json({ message: "Enter the bank or issuer name." });
  }
  if (!/^\d{4}$/.test(String(last4 || ""))) {
    return res.status(400).json({ message: "Enter the last four digits of the card." });
  }
  if (!NETWORKS.includes(network)) {
    return res.status(400).json({ message: "Choose a valid card network." });
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(expiry || ""))) {
    return res.status(400).json({ message: "Enter the expiry as MM/YY." });
  }

  const duplicate = store.db.prepare(
    "SELECT 1 FROM cards WHERE user_id = ? AND last4 = ? AND issuer = ?"
  ).get(req.user.id, String(last4), String(issuer).trim());
  if (duplicate) {
    return res.status(409).json({ message: "That card is already in your wallet." });
  }

  store.db.prepare(
    `INSERT INTO cards (user_id, kind, issuer, label, last4, network, expiry,
                        is_own, created_at)
     VALUES (?,?,?,?,?,?,?,0,?)`
  ).run(req.user.id, kind, String(issuer).trim(),
        String(label || "").trim() || null, String(last4), network,
        String(expiry), store.nowISO());

  res.status(201).json({ message: "Card added to your wallet." });
}));

/*
 * Settings for a card in the wallet.
 *
 * Network-level controls (ATM, POS, online, international, blocking) can only
 * be changed by whoever issued the card, so for a saved card these are the
 * things AB Pay can genuinely act on: how it is labelled, whether it counts
 * towards spending summaries, and whether we warn before it expires.
 */
router.post("/card/:id/settings", handle((req, res) => {
  const card = store.getCardById(Number(req.params.id), req.user.id);
  if (!card) return res.status(404).json({ message: "Card not found." });

  const { label, kind, expiry, notes, isDefault, trackSpending, expiryReminder } =
    req.body || {};

  if (kind && !["debit", "credit"].includes(kind)) {
    return res.status(400).json({ message: "Choose debit or credit." });
  }
  if (expiry && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(expiry))) {
    return res.status(400).json({ message: "Enter the expiry as MM/YY." });
  }

  // Only one card can be the default.
  if (isDefault) {
    store.db.prepare("UPDATE cards SET is_default = 0 WHERE user_id = ?").run(req.user.id);
  }

  store.db.prepare(
    `UPDATE cards
     SET label = ?, kind = ?, expiry = ?, notes = ?,
         is_default = ?, track_spending = ?, expiry_reminder = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    label === undefined ? card.label : (String(label).trim() || null),
    kind || card.kind,
    expiry || card.expiry,
    notes === undefined ? card.notes : (String(notes).trim() || null),
    isDefault ? 1 : 0,
    trackSpending === undefined ? card.track_spending : (trackSpending ? 1 : 0),
    expiryReminder === undefined ? card.expiry_reminder : (expiryReminder ? 1 : 0),
    card.id, req.user.id);

  res.json({ message: "Card settings saved." });
}));

router.delete("/card/:id", handle((req, res) => {
  const card = store.getCardById(Number(req.params.id), req.user.id);
  if (!card) return res.status(404).json({ message: "Card not found." });
  if (card.is_own) {
    return res.status(400).json({
      message: "Your AB Pay card cannot be removed. Block it instead."
    });
  }
  store.db.prepare("DELETE FROM cards WHERE id = ? AND user_id = ?")
    .run(card.id, req.user.id);

  res.json({ message: "Card removed from your wallet." });
}));

router.post("/card/controls", handle((req, res) => {
  const { atm, pos, online, international, dailyLimit } = req.body || {};
  const card = store.getCard(req.account.id);

  const limit = dailyLimit === undefined
    ? card.daily_limit
    : money.parseAmount(dailyLimit);

  store.db.prepare(
    `UPDATE cards SET atm_enabled=?, pos_enabled=?, online_enabled=?,
                      intl_enabled=?, daily_limit=? WHERE id=?`
  ).run(atm ? 1 : 0, pos ? 1 : 0, online ? 1 : 0, international ? 1 : 0, limit, card.id);

  res.json({ message: "Card settings updated.",
             card: publicCard(store.getCard(req.account.id)) });
}));

router.post("/card/block", handle((req, res) => {
  const card = store.getCard(req.account.id);
  const status = card.status === "active" ? "blocked" : "active";
  store.db.prepare("UPDATE cards SET status = ? WHERE id = ?").run(status, card.id);

  res.json({
    message: status === "blocked" ? "Card blocked." : "Card unblocked.",
    card: publicCard(store.getCard(req.account.id))
  });
}));

/* ---------- service requests ---------- */

const REQUEST_TYPES = [
  "Cheque book", "Stop cheque", "Update nominee", "Account statement by post",
  "Interest certificate", "Locker enquiry", "Update address"
];

router.get("/requests", handle((req, res) => {
  res.json({
    types: REQUEST_TYPES,
    requests: store.db.prepare(
      "SELECT * FROM service_requests WHERE user_id = ? ORDER BY created_at DESC"
    ).all(req.user.id)
  });
}));

router.post("/requests", handle((req, res) => {
  const { type, details } = req.body || {};
  if (!REQUEST_TYPES.includes(type)) {
    return res.status(400).json({ message: "Choose a valid request type." });
  }

  const ticket = "SR" + Date.now().toString(36).toUpperCase();
  store.db.prepare(
    "INSERT INTO service_requests (user_id, type, details, ticket, created_at) VALUES (?,?,?,?,?)"
  ).run(req.user.id, type, details || null, ticket, store.nowISO());

  res.status(201).json({ message: `Request raised. Ticket ${ticket}.`, ticket });
}));

/* ---------- payees ---------- */

router.get("/payees", handle((req, res) => {
  res.json({
    payees: store.db.prepare(
      "SELECT * FROM payees WHERE user_id = ? ORDER BY name"
    ).all(req.user.id)
  });
}));

router.post("/payees", handle((req, res) => {
  const { name, kind, accountNumber, ifsc, upiId } = req.body || {};
  if (!name) return res.status(400).json({ message: "Enter a name." });

  if (kind === "upi") {
    if (!upiId) return res.status(400).json({ message: "Enter a UPI ID." });
  } else {
    if (!accountNumber) return res.status(400).json({ message: "Enter an account number." });
    if (!store.getAccountByNumber(accountNumber)) {
      return res.status(404).json({ message: `No ${BANK.name} account with that number.` });
    }
  }

  store.db.prepare(
    `INSERT INTO payees (user_id, name, kind, account_number, ifsc, upi_id, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(req.user.id, String(name).trim(), kind === "upi" ? "upi" : "bank",
        accountNumber || null, ifsc || null, upiId || null, store.nowISO());

  res.status(201).json({ message: "Payee saved." });
}));

router.delete("/payees/:id", handle((req, res) => {
  store.db.prepare("DELETE FROM payees WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  res.json({ message: "Payee removed." });
}));

/* ---------- bills tracker ---------- */

router.get("/bills", handle((req, res) => {
  const bills = store.db.prepare(
    "SELECT * FROM bills WHERE user_id = ? ORDER BY status, due_date"
  ).all(req.user.id);

  res.json({
    bills: bills.map(b => ({
      id: b.id, title: b.title, provider: b.provider, amount: fromMinor(b.amount),
      reference: b.reference, image: b.image, status: b.status,
      dueDate: b.due_date, createdAt: b.created_at, paidAt: b.paid_at
    }))
  });
}));

router.post("/bills", handle((req, res) => {
  const { title, provider, amount, reference, dueDate, image } = req.body || {};
  if (!title || !provider) {
    return res.status(400).json({ message: "Title and provider are required." });
  }
  const minor = money.parseAmount(amount);

  // Data-URL images are capped so a huge upload cannot bloat the database.
  if (image && String(image).length > 2_000_000) {
    return res.status(413).json({ message: "Attached image is too large (max ~1.5 MB)." });
  }

  const info = store.db.prepare(
    `INSERT INTO bills (user_id, title, provider, amount, reference, image, due_date, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(req.user.id, String(title).trim(), String(provider).trim(), minor,
        reference || null, image || null, dueDate || null, store.nowISO());

  res.status(201).json({ message: "Bill added.", id: Number(info.lastInsertRowid) });
}));

router.post("/bills/:id/pay", handle((req, res) => {
  const bill = store.db.prepare("SELECT * FROM bills WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user.id);

  if (!bill) return res.status(404).json({ message: "Bill not found." });
  if (bill.status === "paid") return res.status(409).json({ message: "This bill is already paid." });

  const account = store.getAccountByUser(req.user.id);
  if (account.balance < bill.amount) {
    return res.status(400).json({ message: "Insufficient balance to pay this bill." });
  }

  store.adjustBalance(account.id, -bill.amount);
  store.recordTransaction({
    accountId: account.id, direction: "out", amount: bill.amount,
    balanceAfter: store.getAccountById(account.id).balance,
    counterpartyName: bill.provider, method: "Bill payment", category: "Utilities",
    description: bill.title, reference: bill.reference || "BILL-" + bill.id
  });
  store.db.prepare("UPDATE bills SET status='paid', paid_at=? WHERE id=?")
    .run(store.nowISO(), bill.id);

  res.json({
    message: "Bill paid.",
    balance: fromMinor(store.getAccountById(account.id).balance)
  });
}));

router.delete("/bills/:id", handle((req, res) => {
  store.db.prepare("DELETE FROM bills WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(req.params.id, req.user.id);
  res.json({ message: "Bill removed." });
}));

/* ---------- Safe Send ---------- */

router.get("/safesend", handle((req, res) => {
  money.expireProtectedPayments();
  const account = req.account;

  res.json({
    payments: money.listProtectedPayments(account.id).map(p => ({
      id: p.id,
      role: p.sender_account_id === account.id ? "sender" : "recipient",
      counterparty: p.sender_account_id === account.id ? p.receiver_number : p.sender_number,
      amount: fromMinor(p.amount),
      description: p.description,
      status: p.status,
      markedShipped: !!p.marked_shipped,
      createdAt: p.created_at,
      deadline: p.deadline,
      settledAt: p.settled_at
    }))
  });
}));

router.post("/safesend", handle((req, res) => {
  const { toAccount, amount, description, days } = req.body || {};
  if (!toAccount) return res.status(400).json({ message: "Enter a destination account number." });

  const id = money.createProtectedPayment({
    fromAccountId: req.account.id,
    toNumber: toAccount,
    amount,
    description,
    days: Math.min(Math.max(Number(days) || money.SAFE_SEND_DAYS, 1), 30)
  });

  res.status(201).json({
    message: "Funds are held safely. Release them once you have what you paid for.",
    id,
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

router.post("/safesend/:id/release", handle((req, res) => {
  money.releaseProtectedPayment(Number(req.params.id), req.account.id);
  res.json({ message: "Funds released to the recipient." });
}));

router.post("/safesend/:id/refund", handle((req, res) => {
  money.refundProtectedPayment(Number(req.params.id), req.account.id);
  res.json({
    message: "Payment cancelled and refunded.",
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

/* Recipient signals they have sent the goods; visible to the sender. */
router.post("/safesend/:id/shipped", handle((req, res) => {
  const pp = money.getProtectedPayment(Number(req.params.id));
  if (!pp) return res.status(404).json({ message: "Protected payment not found." });
  if (pp.receiver_account_id !== req.account.id) {
    return res.status(403).json({ message: "Only the recipient can confirm dispatch." });
  }
  store.db.prepare("UPDATE protected_payments SET marked_shipped = 1 WHERE id = ?").run(pp.id);
  res.json({ message: "The sender has been notified." });
}));

/* ---------- zero-touch servicing ---------- */

const publicDispute = d => ({
  id: d.id,
  ticket: d.ticket,
  reason: servicing.REASONS[d.reason] || d.reason,
  status: d.status,
  outcome: d.outcome,
  refunded: fromMinor(d.refunded),
  needsHuman: !!d.needs_human,
  windowEnds: d.window_ends,
  createdAt: d.created_at,
  resolvedAt: d.resolved_at,
  events: servicing.disputeEvents(d.id).map(e => ({
    label: e.label, detail: e.detail, automated: !!e.automated, at: e.created_at
  }))
});

router.get("/support", handle((req, res) => {
  servicing.sweepDisputes();
  servicing.expireRecalls();

  const disputes = servicing.listDisputes(req.user.id);
  const resolvedAlone = disputes.filter(d => !d.needs_human && d.status !== "escalated");

  res.json({
    reasons: servicing.REASONS,
    settlementWindowHours: servicing.SETTLEMENT_WINDOW_HOURS,
    disputes: disputes.map(publicDispute),
    recalls: servicing.listRecalls(req.account.id).map(r => ({
      id: r.id,
      role: r.payer_account_id === req.account.id ? "payer" : "payee",
      counterparty: r.payer_account_id === req.account.id ? r.payee_number : r.payer_number,
      amount: fromMinor(r.amount),
      reason: r.reason,
      status: r.status,
      deadline: r.deadline,
      createdAt: r.created_at
    })),
    // Headline figure: how much of this was handled without a banker.
    settledWithoutHuman: resolvedAlone.length,
    totalCases: disputes.length
  });
}));

router.post("/support/disputes", handle((req, res) => {
  const { transactionId, reason } = req.body || {};
  const id = servicing.raiseDispute({
    userId: req.user.id,
    accountId: req.account.id,
    transactionId: Number(transactionId),
    reason
  });

  const dispute = servicing.listDisputes(req.user.id).find(d => d.id === id);
  res.status(201).json({
    message: dispute.status === "auto_resolved"
      ? "Resolved automatically — no need to contact us."
      : dispute.status === "escalated"
        ? "Escalated to our fraud team."
        : "Raised. It resolves itself if the payment is not confirmed in time.",
    dispute: publicDispute(dispute),
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

router.post("/support/recalls", handle((req, res) => {
  const { transactionId, reason } = req.body || {};
  servicing.requestRecall({
    accountId: req.account.id,
    transactionId: Number(transactionId),
    reason
  });
  res.status(201).json({ message: "Recall sent to the payee." });
}));

router.post("/support/recalls/:id/return", handle((req, res) => {
  servicing.returnRecall(Number(req.params.id), req.account.id);
  res.json({
    message: "Payment returned.",
    balance: fromMinor(store.getAccountById(req.account.id).balance)
  });
}));

router.post("/support/recalls/:id/decline", handle((req, res) => {
  servicing.declineRecall(Number(req.params.id), req.account.id);
  res.json({ message: "Recall declined." });
}));

/* ---------- instant documents ---------- */

router.get("/documents", handle((req, res) => {
  res.json({
    kinds: servicing.DOCUMENTS,
    financialYear: servicing.financialYear().label,
    documents: servicing.listDocuments(req.user.id).map(d => ({
      id: d.id,
      kind: d.kind,
      title: servicing.DOCUMENTS[d.kind] || d.kind,
      reference: d.reference,
      createdAt: d.created_at
    }))
  });
}));

router.post("/documents", handle((req, res) => {
  const doc = servicing.issueDocument({
    user: req.user, account: req.account, kind: (req.body || {}).kind
  });
  res.status(201).json({
    message: "Issued instantly — no branch visit needed.",
    ...doc
  });
}));

router.get("/documents/:id/download", handle((req, res) => {
  const doc = servicing.getDocument(Number(req.params.id), req.user.id);
  if (!doc) return res.status(404).json({ message: "Document not found." });

  const body = servicing.renderDocument(doc, req.user, req.account);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="${doc.kind}-${doc.reference}.txt"`);
  res.send(body);
}));

/* ---------- linked bank accounts ---------- */

/*
 * What we can honestly report for a linked account.
 *
 * If it is an AB Pay account we hold the ledger and return the live balance.
 * If it is at another bank we can validate the routing details from the IFSC
 * and pay into it, but reading its balance requires the customer's consent
 * through RBI's Account Aggregator network — so the balance is reported as
 * unavailable, never faked.
 */
function describeLinked(row) {
  const details = ifsc.decode(row.ifsc);
  const base = {
    id: row.id,
    accountNumber: row.account_number,
    masked: "••••" + String(row.account_number).slice(-4),
    ifsc: row.ifsc,
    bank: row.bank,
    branchCode: row.branch_code,
    holderName: row.holder_name,
    nickname: row.nickname,
    accountType: row.account_type,
    addedAt: row.created_at,
    isOurs: row.balance_source === "ledger"
  };

  if (row.balance_source !== "ledger") {
    return {
      ...base,
      balance: null,
      balanceStatus: "consent-required",
      balanceNote: `${row.bank} holds this account. Balances and statements can ` +
        "only be shared with your consent through an RBI Account Aggregator."
    };
  }

  const account = store.getAccountByNumber(row.account_number);
  if (!account) return { ...base, balance: null, balanceStatus: "unavailable" };

  const owner = store.accountOwner(account.id);
  return {
    ...base,
    holderName: base.holderName || `${owner.name} ${owner.surname}`,
    accountType: account.account_type,
    balance: fromMinor(account.balance),
    balanceStatus: "live",
    recent: store.listTransactions(account.id, { limit: 5 }).map(publicTransaction)
  };
}

router.get("/linked", handle((req, res) => {
  const rows = store.db.prepare(
    "SELECT * FROM linked_accounts WHERE user_id = ? ORDER BY balance_source DESC, id"
  ).all(req.user.id);

  res.json({
    banks: ifsc.list(),
    accounts: rows.map(describeLinked)
  });
}));

/* Decodes an IFSC so the form can name the bank before anything is saved. */
router.get("/linked/lookup", handle((req, res) => {
  const details = ifsc.decode(req.query.ifsc);
  if (!details) {
    return res.status(400).json({ message: "Enter a valid IFSC, for example HDFC0001234." });
  }
  res.json(details);
}));

router.post("/linked", handle((req, res) => {
  const { accountNumber, nickname, holderName, accountType } = req.body || {};

  const number = String(accountNumber || "").replace(/\s/g, "");
  if (!/^\d{6,20}$/.test(number)) {
    return res.status(400).json({ message: "Enter a valid bank account number." });
  }

  const details = ifsc.decode((req.body || {}).ifsc);
  if (!details) {
    return res.status(400).json({ message: "Enter a valid IFSC, for example HDFC0001234." });
  }
  if (!details.known) {
    return res.status(400).json({
      message: `We do not recognise the bank code ${details.bankCode}. Check the IFSC.`
    });
  }

  // Only an AB Pay account number that actually exists gets ledger access.
  const ours = details.bankCode === "ABPY" ? store.getAccountByNumber(number) : null;
  if (details.bankCode === "ABPY" && !ours) {
    return res.status(404).json({ message: "No AB Pay account with that number exists." });
  }

  const duplicate = store.db.prepare(
    "SELECT 1 FROM linked_accounts WHERE user_id = ? AND account_number = ? AND ifsc = ?"
  ).get(req.user.id, number, details.ifsc);
  if (duplicate) {
    return res.status(409).json({ message: "That account is already linked." });
  }

  store.db.prepare(
    `INSERT INTO linked_accounts
       (user_id, account_number, ifsc, bank, branch_code, holder_name, nickname,
        account_type, balance_source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.id, number, details.ifsc, details.bank, details.branchCode,
        String(holderName || "").trim() || null,
        String(nickname || "").trim() || null,
        String(accountType || "Savings").trim(),
        ours ? "ledger" : "external",
        store.nowISO());

  res.status(201).json({
    message: ours
      ? `${details.bank} account linked — live balance available.`
      : `${details.bank} account linked. You can pay into it right away.`,
    bank: details.bank
  });
}));

router.delete("/linked/:id", handle((req, res) => {
  store.db.prepare("DELETE FROM linked_accounts WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  res.json({ message: "Account unlinked." });
}));

/* ---------- notifications ---------- */

router.get("/notifications", handle((req, res) => {
  res.json({
    notifications: notify.list(req.user.id, { limit: 30 }),
    unread: notify.unreadCount(req.user.id)
  });
}));

router.post("/notifications/:id/read", handle((req, res) => {
  notify.markRead(Number(req.params.id), req.user.id);
  res.json({ unread: notify.unreadCount(req.user.id) });
}));

router.post("/notifications/read-all", handle((req, res) => {
  const cleared = notify.markAllRead(req.user.id);
  res.json({ message: `${cleared} notification(s) marked read.`, unread: 0 });
}));

/* ---------- two-factor sign-in ---------- */

router.post("/security/two-factor", handle((req, res) => {
  const enabled = Boolean((req.body || {}).enabled);

  // Turning it off is a security downgrade, so it needs the password.
  if (!enabled && !verifyPassword((req.body || {}).password || "", req.user.password)) {
    return res.status(403).json({ message: "Enter your password to turn this off." });
  }

  security.setTwoFactor(req.user.id, enabled);
  notify.notify(req.user.id, {
    kind: "security", severity: "warning",
    title: `Two-factor sign-in ${enabled ? "enabled" : "disabled"}`,
    body: enabled
      ? "You will be asked for a 6-digit code each time you sign in."
      : "Your account is now protected by password alone."
  });

  res.json({
    message: `Two-factor sign-in ${enabled ? "enabled" : "disabled"}.`,
    twoFactor: enabled
  });
}));

/* ---------- scheduled transfers ---------- */

router.get("/scheduled", handle((req, res) => {
  money.runScheduledTransfers();
  res.json({
    scheduled: store.db.prepare(
      "SELECT * FROM scheduled_transfers WHERE user_id = ? ORDER BY status, run_on"
    ).all(req.user.id).map(t => ({
      id: t.id,
      toAccount: t.to_account,
      ifsc: t.ifsc,
      payeeName: t.payee_name,
      amount: fromMinor(t.amount),
      description: t.description,
      mode: t.mode,
      runOn: t.run_on,
      repeatDays: t.repeat_days,
      status: t.status,
      runsMade: t.runs_made,
      lastError: t.last_error
    }))
  });
}));

router.post("/scheduled", handle((req, res) => {
  const { toAccount, ifsc, payeeName, amount, description, mode, runOn, repeatDays } =
    req.body || {};

  if (!toAccount) return res.status(400).json({ message: "Enter a destination account." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(runOn || ""))) {
    return res.status(400).json({ message: "Choose a date to send it on." });
  }

  const when = new Date(runOn + "T00:00:00Z");
  if (when < new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) {
    return res.status(400).json({ message: "That date is in the past." });
  }

  const minor = money.parseAmount(amount);
  const repeat = Number(repeatDays) > 0 ? Math.min(Number(repeatDays), 365) : null;

  store.db.prepare(
    `INSERT INTO scheduled_transfers
       (user_id, account_id, to_account, ifsc, payee_name, amount, description,
        mode, run_on, repeat_days, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.id, req.account.id, String(toAccount).trim(),
        ifsc ? String(ifsc).toUpperCase().trim() : null,
        payeeName || null, minor, description || null,
        ["IMPS", "NEFT", "RTGS"].includes(mode) ? mode : "IMPS",
        when.toISOString(), repeat, store.nowISO());

  res.status(201).json({
    message: `Transfer of ${rupees(minor)} scheduled for ` +
      `${when.toLocaleDateString("en-IN")}.`
  });
}));

router.delete("/scheduled/:id", handle((req, res) => {
  store.db.prepare(
    "UPDATE scheduled_transfers SET status='cancelled' WHERE id = ? AND user_id = ? AND status='scheduled'"
  ).run(req.params.id, req.user.id);
  res.json({ message: "Scheduled transfer cancelled." });
}));

/* ---------- data export ---------- */

/*
 * Everything held about this customer, in one file. India's DPDP Act gives
 * people the right to it, and it costs nothing to honour.
 */
router.get("/account/export", handle((req, res) => {
  const account = store.getAccountByUser(req.user.id);
  const q = (sql, ...params) => store.db.prepare(sql).all(...params);

  const bundle = {
    exportedAt: store.nowISO(),
    profile: publicUser(req.user),
    account: publicAccount(account),
    transactions: store.listTransactions(account.id).map(publicTransaction),
    cards: store.listCards(req.user.id).map(c => ({
      issuer: c.issuer, kind: c.kind, last4: c.last4, network: c.network,
      expiry: c.expiry, isOwn: !!c.is_own
    })),
    linkedAccounts: q("SELECT * FROM linked_accounts WHERE user_id = ?", req.user.id),
    deposits: q("SELECT * FROM deposits WHERE user_id = ?", req.user.id),
    payees: q("SELECT * FROM payees WHERE user_id = ?", req.user.id),
    bills: q("SELECT * FROM bills WHERE user_id = ?", req.user.id),
    autopay: mandates.listMandates(req.user.id),
    stoppedPayees: mandates.listBlockedPayees(req.user.id),
    disputes: servicing.listDisputes(req.user.id),
    documents: servicing.listDocuments(req.user.id),
    serviceRequests: q("SELECT * FROM service_requests WHERE user_id = ?", req.user.id),
    scheduledTransfers: q("SELECT * FROM scheduled_transfers WHERE user_id = ?", req.user.id),
    notifications: notify.list(req.user.id, { limit: 500 })
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="abpay-data-${account.number}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
}));

/* ---------- money radar ---------- */

router.get("/radar", handle((req, res) => {
  // Collect anything already due before reporting what is still ahead.
  money.collectDepositInstalments();
  money.runScheduledTransfers();
  mandates.collectDueMandates();

  const account = store.getAccountByUser(req.user.id);
  radar.raiseRadarAlerts(req.user, account);
  const active = mandates.listMandates(req.user.id);
  const byPayee = new Map(active.map(m => [m.payee.toLowerCase(), m]));

  const summary = radar.radar(req.user, account);

  res.json({
    ...summary,
    // Each detected subscription reports whether autopay is set up for it.
    subscriptions: summary.subscriptions.map(s => ({
      ...s,
      autopay: byPayee.get(s.payee.toLowerCase()) || null
    })),
    mandates: active,
    needsReview: active.filter(m => m.status === "needs_review")
  });
}));

/*
 * Everything about one recurring payee, for the panel that opens when a
 * subscription is tapped: its charge history, its autopay state, and whether
 * payments to it have been stopped.
 */
router.get("/radar/subscription", handle((req, res) => {
  const payee = String(req.query.payee || "").trim();
  if (!payee) return res.status(400).json({ message: "Which subscription?" });

  const detected = radar.detectSubscriptions(req.account.id)
    .find(s => s.payee.toLowerCase() === payee.toLowerCase());

  const history = store.db.prepare(
    `SELECT * FROM transactions
     WHERE account_id = ? AND direction = 'out'
       AND LOWER(IFNULL(counterparty_name,'')) = LOWER(?)
     ORDER BY created_at DESC LIMIT 12`
  ).all(req.account.id, payee).map(publicTransaction);

  if (!detected && !history.length) {
    return res.status(404).json({ message: "No payments to that payee." });
  }

  const mandate = mandates.listMandates(req.user.id)
    .find(m => m.payee.toLowerCase() === payee.toLowerCase() && m.status !== "cancelled");

  res.json({
    payee,
    detected: detected || null,
    history,
    paidToDate: history.reduce((sum, t) => sum + t.amount, 0),
    autopay: mandate || null,
    stopped: mandates.isPayeeBlocked(req.user.id, payee)
  });
}));

/* ---------- autopay mandates ---------- */

router.get("/autopay", handle((req, res) => {
  mandates.collectDueMandates();
  res.json({
    mandates: mandates.listMandates(req.user.id),
    cadences: Object.keys(mandates.CADENCE_DAYS)
  });
}));

router.post("/autopay", handle((req, res) => {
  const { payee, amount, cadence, maxAmount, until } = req.body || {};

  const id = mandates.createMandate({
    userId: req.user.id,
    accountId: req.account.id,
    payee, amount, cadence, maxAmount, until
  });

  const created = mandates.publicMandate(mandates.getMandate(id, req.user.id));
  res.status(201).json({
    message: `Autopay on for ${created.payee}. We will debit up to ` +
      `${rupees(Math.round(created.maxAmount * 100))} each ${created.cadence.replace(/ly$/, "")} cycle.`,
    mandate: created
  });
}));

/* Pay the next cycle now rather than waiting for it to fall due. */
router.post("/autopay/:id/advance", handle((req, res) => {
  const result = mandates.payInAdvance(Number(req.params.id), req.user.id);
  res.json({
    message: `Paid ${rupees(result.paid)} in advance. Next charge ` +
      `${new Date(result.nextDue).toLocaleDateString("en-IN")}.`,
    balance: fromMinor(result.balance)
  });
}));

/*
 * A stop-payment instruction. We can refuse the merchant's future debits; we
 * cannot end the customer's contract with them, and the message says so.
 */
router.post("/subscriptions/stop", handle((req, res) => {
  const { payee, reason } = req.body || {};
  mandates.stopPayingPayee({ userId: req.user.id, payee, reason });

  res.json({
    message: `Future automatic payments to ${String(payee).trim()} are stopped.`,
    note: "This stops us paying them. It does not cancel your subscription — " +
      "cancel with the merchant too, or you may still owe them."
  });
}));

router.post("/subscriptions/resume", handle((req, res) => {
  mandates.resumePayingPayee(req.user.id, (req.body || {}).payee);
  res.json({ message: "Automatic payments allowed again." });
}));

router.get("/subscriptions/stopped", handle((req, res) => {
  res.json({ stopped: mandates.listBlockedPayees(req.user.id) });
}));

router.post("/autopay/:id/pause", handle((req, res) => {
  mandates.setMandateStatus(Number(req.params.id), req.user.id, "paused");
  res.json({ message: "Autopay paused." });
}));

router.post("/autopay/:id/resume", handle((req, res) => {
  mandates.setMandateStatus(Number(req.params.id), req.user.id, "active");
  res.json({ message: "Autopay resumed." });
}));

router.delete("/autopay/:id", handle((req, res) => {
  mandates.setMandateStatus(Number(req.params.id), req.user.id, "cancelled");
  res.json({ message: "Autopay cancelled." });
}));

/* Approving a higher price is exactly raising the mandate's ceiling. */
router.post("/autopay/:id/limit", handle((req, res) => {
  mandates.updateMandateCap(Number(req.params.id), req.user.id,
    (req.body || {}).maxAmount);
  res.json({ message: "Approved limit updated. Autopay is active again." });
}));

/* ---------- spending analytics ---------- */

/*
 * Series for the charts: a daily spend trend, money in against money out by
 * month, and the category split. Computed here so the client only draws.
 */
router.get("/analytics", handle((req, res) => {
  const { from, to } = req.query;
  const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

  /*
   * Everything here is anchored to UTC midnight. Transaction timestamps are
   * UTC, and a local-midnight Date would render back as the previous day in
   * any timezone ahead of UTC — so a range of 1–15 Aug came back as 31 Jul.
   */
  const utcMidnight = value => new Date(value + "T00:00:00Z");

  let since, until, days;

  if (isDate(from) && isDate(to)) {
    since = utcMidnight(from);
    until = utcMidnight(to);
    if (until < since) [since, until] = [until, since];

    days = Math.round((until - since) / 864e5) + 1;
    // A custom range still has to stay chartable.
    if (days > 366) {
      return res.status(400).json({ message: "Choose a range of a year or less." });
    }
  } else {
    days = Math.min(Math.max(Number(req.query.days) || 30, 7), 366);
    until = utcMidnight(new Date().toISOString().slice(0, 10));
    since = new Date(until.getTime() - (days - 1) * 864e5);
  }

  const rows = store.db.prepare(
    `SELECT created_at, direction, amount, category FROM transactions
     WHERE account_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at`
  ).all(req.account.id, since.toISOString(),
        new Date(until.getTime() + 864e5 - 1).toISOString());

  // Seed every day so the line has no gaps where nothing was spent.
  const daily = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 864e5).toISOString().slice(0, 10);
    daily.set(d, { date: d, out: 0, in: 0 });
  }

  const byMonth = new Map();
  const byCategory = new Map();

  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    const month = row.created_at.slice(0, 7);

    if (daily.has(day)) daily.get(day)[row.direction] += row.amount;

    if (!byMonth.has(month)) byMonth.set(month, { month, in: 0, out: 0 });
    byMonth.get(month)[row.direction] += row.amount;

    if (row.direction === "out") {
      byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.amount);
    }
  }

  const daySeries = [...daily.values()].map(d => ({
    date: d.date, out: fromMinor(d.out), in: fromMinor(d.in)
  }));

  const categories = [...byCategory.entries()]
    .map(([category, total]) => ({ category, total: fromMinor(total) }))
    .sort((a, b) => b.total - a.total);

  const totalOut = daySeries.reduce((sum, d) => sum + d.out, 0);
  const totalIn = daySeries.reduce((sum, d) => sum + d.in, 0);

  res.json({
    days,
    from: since.toISOString().slice(0, 10),
    to: until.toISOString().slice(0, 10),
    daily: daySeries,
    monthly: [...byMonth.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-6)
      .map(m => ({ month: m.month, in: fromMinor(m.in), out: fromMinor(m.out) })),
    categories,
    totalOut,
    totalIn,
    net: totalIn - totalOut,
    dailyAverage: totalOut / days,
    busiestDay: daySeries.reduce((max, d) => (d.out > max.out ? d : max),
      { date: null, out: 0 })
  });
}));

/* ---------- AI customer care ---------- */

router.get("/assistant", handle((req, res) => {
  res.json({
    name: assistant.AGENT_NAME,
    engine: assistant.hasKey() ? "claude" : "grounded",
    model: assistant.hasKey() ? assistant.MODEL : null,
    suggestions: [
      "What is my balance?",
      "Where did my money go this month?",
      "A payment was debited but not received",
      "How do I send money to another bank?",
      "What is Safe Send?"
    ]
  });
}));

router.post("/assistant", handle(async (req, res) => {
  const { question, history } = req.body || {};
  const result = await assistant.ask({
    user: req.user,
    question,
    history: Array.isArray(history) ? history : []
  });
  res.json(result);
}));

module.exports = { router, requireAuth };
