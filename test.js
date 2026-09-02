/*
 * Self-checks for the parts that move money or guard access.
 * Run with: npm test
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Use a scratch database so tests never touch real data.
const TEST_DB = path.join(__dirname, "test-abpay.db");
fs.rmSync(TEST_DB, { force: true });
process.env.DB_FILE = TEST_DB;
process.env.SESSION_SECRET = "test-secret";

const store = require("./src/db");
const auth = require("./src/auth");
const money = require("./src/money");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log("  ok  " + name);
};

const checkAsync = async (name, fn) => {
  await fn();
  passed++;
  console.log("  ok  " + name);
};

const expectFailsAsync = async (fn, matcher) => {
  try {
    await fn();
  } catch (err) {
    assert.match(err.message, matcher, `wrong error: ${err.message}`);
    return;
  }
  assert.fail("expected this to be rejected, but it succeeded");
};

const expectFails = (fn, matcher) => {
  try {
    fn();
  } catch (err) {
    assert.match(err.message, matcher, `wrong error: ${err.message}`);
    return;
  }
  assert.fail("expected this to be rejected, but it succeeded");
};

/* ---------- fixtures ---------- */

const makeUser = (name, mobile, emailKey = name.toLowerCase()) => store.createUser({
  email: `${emailKey}@test.in`, password: auth.hashPassword("password123"),
  name, surname: "Test", mobile, address: "", branch: "Test branch"
});

const asha = makeUser("Asha", "9000000001");
const bharat = makeUser("Bharat", "9000000002");

const ashaAcc = store.openAccount(asha.id, 1001, 1000000_00); // ₹10,00,000
const bharatAcc = store.openAccount(bharat.id, 1001, 50000_00);

const balanceOf = id => store.getAccountById(id).balance;

console.log("\npasswords & tokens");

check("correct password verifies", () => {
  assert.ok(auth.verifyPassword("password123", store.getUserById(asha.id).password));
});

check("wrong password is rejected", () => {
  assert.ok(!auth.verifyPassword("wrong", store.getUserById(asha.id).password));
});

check("hashes are salted, so equal passwords differ", () => {
  assert.notStrictEqual(auth.hashPassword("same"), auth.hashPassword("same"));
});

check("a valid token resolves to its user", () => {
  assert.strictEqual(auth.verifyToken(auth.createToken(asha.id)), asha.id);
});

check("a tampered token is rejected", () => {
  const token = auth.createToken(asha.id);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: bharat.id, exp: 9e9 }))
    .toString("base64url");
  assert.strictEqual(auth.verifyToken(`${forged}.${sig}`), null);
  assert.strictEqual(auth.verifyToken(`${body}.${sig}x`), null);
});

check("garbage tokens are rejected", () => {
  assert.strictEqual(auth.verifyToken(""), null);
  assert.strictEqual(auth.verifyToken("nonsense"), null);
  assert.strictEqual(auth.verifyToken(null), null);
});

console.log("\naccount identity");

check("each customer gets a unique UPI ID on our handle", () => {
  assert.match(store.getUserById(asha.id).upi_id, /^ashatest@abpay$/);
  assert.notStrictEqual(store.getUserById(asha.id).upi_id,
                        store.getUserById(bharat.id).upi_id);
});

check("duplicate names still get distinct UPI IDs", () => {
  const twin = makeUser("Asha", "9000000009", "asha-twin");
  assert.notStrictEqual(store.getUserById(twin.id).upi_id,
                        store.getUserById(asha.id).upi_id);
});

check("every account is issued a debit card and an IFSC", () => {
  assert.ok(store.getCard(ashaAcc.id));
  assert.match(ashaAcc.ifsc, /^ABPY0\d{6}$/);
});

console.log("\namount validation");

check("rejects zero, negative and non-numeric amounts", () => {
  expectFails(() => money.parseAmount(0), /greater than zero/);
  expectFails(() => money.parseAmount(-5), /greater than zero/);
  expectFails(() => money.parseAmount("abc"), /greater than zero/);
  expectFails(() => money.parseAmount(Infinity), /greater than zero/);
});

check("rejects sub-paise precision", () => {
  expectFails(() => money.parseAmount(1.005), /one paisa/);
});

check("converts rupees to integer paise", () => {
  assert.strictEqual(money.parseAmount(12.34), 1234);
  assert.strictEqual(money.parseAmount("0.01"), 1);
});

check("enforces the ₹1 lakh UPI cap", () => {
  expectFails(() => money.parseAmount(100001, money.MAX_UPI), /exceeds the limit/);
  assert.strictEqual(money.parseAmount(100000, money.MAX_UPI), 100000_00);
});

console.log("\nQR / UPI payload parsing");

check("reads a real NPCI upi:// merchant QR", () => {
  const parsed = money.parsePaymentPayload(
    "upi://pay?pa=merchant@okaxis&pn=Chai%20Point&am=45.50&cu=INR&tn=Tea");
  assert.strictEqual(parsed.vpa, "merchant@okaxis");
  assert.strictEqual(parsed.name, "Chai Point");
  assert.strictEqual(parsed.amount, "45.50");
  assert.strictEqual(parsed.note, "Tea");
});

check("reads a bare VPA", () => {
  assert.strictEqual(money.parsePaymentPayload("someone@oksbi").vpa, "someone@oksbi");
});

check("rejects non-payment QR codes", () => {
  expectFails(() => money.parsePaymentPayload("https://example.com"), /not a payment code/);
  expectFails(() => money.parsePaymentPayload("hello world"), /not a payment code/);
  expectFails(() => money.parsePaymentPayload(""), /No QR payload/);
});

check("rejects non-INR UPI codes", () => {
  expectFails(() => money.parsePaymentPayload("upi://pay?pa=a@b&cu=USD"), /Only INR/);
});

check("tells our own customers apart from other banks", () => {
  const ours = money.resolveVpa(store.getUserById(asha.id).upi_id);
  assert.strictEqual(ours.external, false);
  assert.strictEqual(money.resolveVpa("stranger@okhdfcbank").external, true);
  expectFails(() => money.resolveVpa("ghost@abpay"), /No AB Pay customer/);
});

console.log("\ntransfers");

check("a transfer moves the exact amount and conserves the total", () => {
  const before = balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id);

  money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number,
    amount: 2500.50, description: "Rent"
  });

  assert.strictEqual(balanceOf(ashaAcc.id), 1000000_00 - 2500_50);
  assert.strictEqual(balanceOf(bharatAcc.id), 50000_00 + 2500_50);
  assert.strictEqual(balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id), before);
});

check("both sides get a ledger entry", () => {
  const out = store.listTransactions(ashaAcc.id, { limit: 1 })[0];
  const incoming = store.listTransactions(bharatAcc.id, { limit: 1 })[0];

  assert.strictEqual(out.direction, "out");
  assert.strictEqual(incoming.direction, "in");
  assert.strictEqual(out.amount, incoming.amount);
  assert.strictEqual(out.reference, incoming.reference);
  assert.strictEqual(out.balance_after, balanceOf(ashaAcc.id));
});

check("overdrawing is refused and changes nothing", () => {
  const before = balanceOf(ashaAcc.id);
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 9999999
  }), /Insufficient balance|exceeds the limit/);
  assert.strictEqual(balanceOf(ashaAcc.id), before);
});

check("transferring to yourself is refused", () => {
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: ashaAcc.number, amount: 1
  }), /your own account/);
});

check("an account we do not hold asks for an IFSC rather than failing", () => {
  // Since transfers may leave the bank, an unknown number is not an error —
  // it just needs routing information.
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: "000000000", amount: 1
  }), /not with AB Pay.*IFSC/i);
});

console.log("\nUPI payments");

check("paying an AB Pay UPI ID settles inside the bank", () => {
  const before = balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id);
  money.payUpi({
    fromAccountId: ashaAcc.id,
    vpa: store.getUserById(bharat.id).upi_id,
    amount: 750, note: "Lunch"
  });
  assert.strictEqual(balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id), before,
    "internal UPI must conserve the total");
});

check("paying another bank's VPA debits only the sender", () => {
  const before = balanceOf(ashaAcc.id);
  const bharatBefore = balanceOf(bharatAcc.id);

  const result = money.payUpi({
    fromAccountId: ashaAcc.id, vpa: "merchant@okaxis",
    amount: 320, note: "Chai", payeeName: "Chai Point"
  });

  assert.strictEqual(result.external, true);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 320_00);
  assert.strictEqual(balanceOf(bharatAcc.id), bharatBefore, "unrelated account untouched");

  const tx = store.listTransactions(ashaAcc.id, { limit: 1 })[0];
  assert.strictEqual(tx.counterparty_number, "merchant@okaxis");
  assert.strictEqual(tx.method, "UPI");
});

check("paying your own UPI ID is refused", () => {
  expectFails(() => money.payUpi({
    fromAccountId: ashaAcc.id, vpa: store.getUserById(asha.id).upi_id, amount: 10
  }), /your own/);
});

console.log("\nSafe Send escrow");

const escrowStart = balanceOf(ashaAcc.id);

check("creating a hold debits the sender but not yet the recipient", () => {
  const bharatBefore = balanceOf(bharatAcc.id);
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number,
    amount: 5000, description: "Marketplace camera"
  });

  assert.ok(id > 0);
  assert.strictEqual(balanceOf(ashaAcc.id), escrowStart - 5000_00);
  assert.strictEqual(balanceOf(bharatAcc.id), bharatBefore, "recipient must not be paid yet");
});

check("only the sender can release", () => {
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 100
  });
  expectFails(() => money.releaseProtectedPayment(id, bharatAcc.id), /Only the sender/);
  money.refundProtectedPayment(id, ashaAcc.id);
});

check("releasing pays the recipient exactly once", () => {
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 400
  });
  const bharatBefore = balanceOf(bharatAcc.id);

  money.releaseProtectedPayment(id, ashaAcc.id);
  assert.strictEqual(balanceOf(bharatAcc.id), bharatBefore + 400_00);

  expectFails(() => money.releaseProtectedPayment(id, ashaAcc.id), /already released/);
  assert.strictEqual(balanceOf(bharatAcc.id), bharatBefore + 400_00, "must not pay twice");
});

check("refunding returns the money to the sender", () => {
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 750
  });
  const held = balanceOf(ashaAcc.id);

  money.refundProtectedPayment(id, ashaAcc.id);
  assert.strictEqual(balanceOf(ashaAcc.id), held + 750_00);
  expectFails(() => money.refundProtectedPayment(id, ashaAcc.id), /already refunded/);
});

check("a stranger cannot touch someone else's hold", () => {
  const carol = makeUser("Carol", "9000000003");
  const carolAcc = store.openAccount(carol.id, 1001, 10000_00);
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 50
  });

  expectFails(() => money.refundProtectedPayment(id, carolAcc.id), /not party/);
  money.refundProtectedPayment(id, ashaAcc.id);
});

check("holds past their deadline auto-refund", () => {
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 600
  });
  const held = balanceOf(ashaAcc.id);

  store.db.prepare("UPDATE protected_payments SET deadline = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);

  assert.strictEqual(money.expireProtectedPayments(), 1);
  assert.strictEqual(balanceOf(ashaAcc.id), held + 600_00);
  assert.strictEqual(money.getProtectedPayment(id).status, "refunded");
});

check("escrow never creates or destroys money", () => {
  const total = balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id);
  const id = money.createProtectedPayment({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 1234.56
  });
  money.releaseProtectedPayment(id, ashaAcc.id);
  assert.strictEqual(balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id), total);
});

console.log("\ndeposits");

check("an FD debits the account and quotes a maturity value", () => {
  const before = balanceOf(ashaAcc.id);
  const fd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD",
    amount: 100000, tenureMonths: 12
  });

  assert.strictEqual(balanceOf(ashaAcc.id), before - 100000_00);
  assert.strictEqual(fd.rate, 6.80);
  assert.ok(fd.maturityAmount > 100000_00, "maturity must exceed principal");
});

check("FD interest compounds quarterly", () => {
  // ₹1,00,000 at 6.8% for 12 months, compounded quarterly.
  const expected = Math.round(100000_00 * Math.pow(1 + 6.8 / 400, 4));
  assert.strictEqual(money.fdMaturity(100000_00, 6.8, 12), expected);
});

check("an RD maturity exceeds the sum of its instalments", () => {
  const invested = 5000_00 * 12;
  assert.ok(money.rdMaturity(5000_00, 6.5, 12) > invested);
});

check("rejects unlisted tenures and sub-minimum amounts", () => {
  expectFails(() => money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD", amount: 10000, tenureMonths: 7
  }), /available tenures/);

  expectFails(() => money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD", amount: 500, tenureMonths: 12
  }), /Minimum fixed deposit/);
});

check("closing early pays back at least the principal, and only once", () => {
  const fd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD",
    amount: 50000, tenureMonths: 24
  });
  const before = balanceOf(ashaAcc.id);

  const result = money.closeDeposit(fd.id, asha.id);
  assert.strictEqual(result.matured, false);
  assert.ok(result.payout >= 50000_00, "principal must be returned");
  assert.strictEqual(balanceOf(ashaAcc.id), before + result.payout);

  expectFails(() => money.closeDeposit(fd.id, asha.id), /already closed/);
});

check("you cannot close someone else's deposit", () => {
  const fd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD",
    amount: 5000, tenureMonths: 12
  });
  expectFails(() => money.closeDeposit(fd.id, bharat.id), /not found/);
});

console.log("\ntransfers to other banks");

check("sends to any bank account given a valid IFSC", () => {
  const before = balanceOf(ashaAcc.id);
  const bharatBefore = balanceOf(bharatAcc.id);

  const result = money.transfer({
    fromAccountId: ashaAcc.id, toNumber: "50100234567890",
    ifsc: "HDFC0001234", beneficiaryName: "Priya Nair",
    amount: 4000, description: "Rent", method: "NEFT"
  });

  assert.strictEqual(result.external, true);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 4000_00);
  assert.strictEqual(balanceOf(bharatAcc.id), bharatBefore, "unrelated account untouched");

  const tx = store.listTransactions(ashaAcc.id, { limit: 1 })[0];
  assert.strictEqual(tx.counterparty_name, "Priya Nair");
  assert.strictEqual(tx.method, "NEFT");
});

check("an outside account without an IFSC is refused", () => {
  const before = balanceOf(ashaAcc.id);
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: "99887766554433", amount: 100
  }), /not with AB Pay.*IFSC/i);
  assert.strictEqual(balanceOf(ashaAcc.id), before);
});

check("a malformed IFSC is refused", () => {
  for (const bad of ["HDFC1234567", "HD0001234", "hdfc0001", "1234567890"]) {
    expectFails(() => money.transfer({
      fromAccountId: ashaAcc.id, toNumber: "99887766554433",
      ifsc: bad, amount: 100
    }), /valid IFSC/i);
  }
});

check("our own IFSC with an unknown account number is refused", () => {
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: "501199999999",
    ifsc: "ABPY0001042", amount: 100
  }), /No AB Pay account/i);
});

check("an outside transfer still respects the balance", () => {
  const before = balanceOf(ashaAcc.id);
  expectFails(() => money.transfer({
    fromAccountId: ashaAcc.id, toNumber: "50100234567890",
    ifsc: "HDFC0001234", amount: 99999999
  }), /Insufficient balance|exceeds the limit/);
  assert.strictEqual(balanceOf(ashaAcc.id), before);
});

check("an AB Pay account number still settles internally", () => {
  const total = balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id);
  const result = money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 300
  });
  assert.ok(!result.external, "should not leave the bank");
  assert.strictEqual(balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id), total);
});

console.log("\nzero-touch servicing");

const servicing = require("./src/servicing");

const lastTx = accId => store.listTransactions(accId, { limit: 1 })[0];
const disputeById = id => servicing.listDisputes(asha.id).find(d => d.id === id);

check("a duplicate charge is refunded on the spot, without a human", () => {
  // Two identical payments to the same outside merchant, seconds apart.
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "shop@okhdfcbank", amount: 999 });
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "shop@okhdfcbank", amount: 999 });

  const repeat = lastTx(ashaAcc.id);
  const before = balanceOf(ashaAcc.id);

  const id = servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id,
    transactionId: repeat.id, reason: "duplicate"
  });

  const d = disputeById(id);
  assert.strictEqual(d.status, "auto_resolved");
  assert.strictEqual(d.needs_human, 0);
  assert.strictEqual(balanceOf(ashaAcc.id), before + 999_00, "refund must be credited");
});

check("a payment that actually arrived is not clawed back", () => {
  money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number,
    amount: 500, description: "Wrong person"
  });
  const tx = lastTx(ashaAcc.id);
  const before = balanceOf(ashaAcc.id);

  const id = servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id,
    transactionId: tx.id, reason: "not_received"
  });

  const d = disputeById(id);
  assert.strictEqual(d.status, "closed");
  assert.match(d.outcome, /recall/i, "should point the customer at a recall");
  assert.strictEqual(balanceOf(ashaAcc.id), before, "must not refund a delivered payment");
});

check("an unsettled outside payment auto-reverses once the window lapses", () => {
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "stuck@okicici", amount: 1500 });
  const tx = lastTx(ashaAcc.id);

  const id = servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id,
    transactionId: tx.id, reason: "not_received"
  });
  assert.strictEqual(disputeById(id).status, "awaiting_window",
    "inside the window it should wait, not refund");

  const before = balanceOf(ashaAcc.id);
  store.db.prepare("UPDATE disputes SET window_ends = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);

  assert.strictEqual(servicing.sweepDisputes(), 1);
  assert.strictEqual(disputeById(id).status, "auto_resolved");
  assert.strictEqual(balanceOf(ashaAcc.id), before + 1500_00);
});

check("an unauthorised claim blocks the card and goes to a human", () => {
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "thief@okaxis", amount: 250 });
  const tx = lastTx(ashaAcc.id);

  const id = servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id,
    transactionId: tx.id, reason: "unauthorised"
  });

  const d = disputeById(id);
  assert.strictEqual(d.status, "escalated");
  assert.strictEqual(d.needs_human, 1, "fraud must not be auto-closed");
  assert.strictEqual(store.getCard(ashaAcc.id).status, "blocked");
});

check("the same payment cannot be disputed twice", () => {
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "shop2@okaxis", amount: 60 });
  const tx = lastTx(ashaAcc.id);
  servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id, transactionId: tx.id, reason: "not_received"
  });
  expectFails(() => servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id, transactionId: tx.id, reason: "not_received"
  }), /already open/);
});

check("credits and other people's payments cannot be disputed", () => {
  const credit = store.listTransactions(bharatAcc.id).find(t => t.direction === "in");
  expectFails(() => servicing.raiseDispute({
    userId: bharat.id, accountId: bharatAcc.id,
    transactionId: credit.id, reason: "not_received"
  }), /payments you sent/);

  const someoneElse = lastTx(bharatAcc.id);
  expectFails(() => servicing.raiseDispute({
    userId: asha.id, accountId: ashaAcc.id,
    transactionId: someoneElse.id, reason: "not_received"
  }), /not found/);
});

console.log("\npayment recall");

check("a recall returns the money and conserves the total", () => {
  money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number,
    amount: 800, description: "Typo"
  });
  const tx = lastTx(ashaAcc.id);
  const total = balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id);
  const ashaBefore = balanceOf(ashaAcc.id);

  const id = servicing.requestRecall({
    accountId: ashaAcc.id, transactionId: tx.id, reason: "Sent to the wrong person"
  });
  servicing.returnRecall(id, bharatAcc.id);

  assert.strictEqual(balanceOf(ashaAcc.id), ashaBefore + 800_00);
  assert.strictEqual(balanceOf(ashaAcc.id) + balanceOf(bharatAcc.id), total);
});

check("only the payee can return, and only once", () => {
  money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 120
  });
  const id = servicing.requestRecall({
    accountId: ashaAcc.id, transactionId: lastTx(ashaAcc.id).id
  });

  expectFails(() => servicing.returnRecall(id, ashaAcc.id), /received the money/);
  servicing.returnRecall(id, bharatAcc.id);
  expectFails(() => servicing.returnRecall(id, bharatAcc.id), /already returned/);
});

check("payments to other banks cannot be recalled", () => {
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "gone@okaxis", amount: 75 });
  expectFails(() => servicing.requestRecall({
    accountId: ashaAcc.id, transactionId: lastTx(ashaAcc.id).id
  }), /another bank/);
});

check("an ignored recall expires instead of hanging forever", () => {
  money.transfer({
    fromAccountId: ashaAcc.id, toNumber: bharatAcc.number, amount: 55
  });
  const id = servicing.requestRecall({
    accountId: ashaAcc.id, transactionId: lastTx(ashaAcc.id).id
  });

  store.db.prepare("UPDATE recalls SET deadline = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);

  assert.strictEqual(servicing.expireRecalls(), 1);
  expectFails(() => servicing.returnRecall(id, bharatAcc.id), /already expired/);
});

console.log("\ninstant documents");

check("an interest certificate is issued immediately and reports real figures", () => {
  money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "FD",
    amount: 200000, tenureMonths: 12
  });

  const doc = servicing.issueDocument({
    user: store.getUserById(asha.id), account: store.getAccountById(ashaAcc.id),
    kind: "interest_certificate"
  });
  assert.match(doc.reference, /^DOC/);

  const stored = servicing.getDocument(doc.id, asha.id);
  const text = servicing.renderDocument(
    stored, store.getUserById(asha.id), store.getAccountById(ashaAcc.id));

  assert.match(text, /INTEREST CERTIFICATE/);
  assert.match(text, new RegExp(doc.reference));
  assert.match(text, /FD\s+INR 2,00,000\.00/, "should list the deposit");
});

check("a balance certificate states the live balance", () => {
  const account = store.getAccountById(ashaAcc.id);
  const doc = servicing.issueDocument({
    user: store.getUserById(asha.id), account, kind: "balance_certificate"
  });
  const text = servicing.renderDocument(
    servicing.getDocument(doc.id, asha.id), store.getUserById(asha.id), account);

  const expected = (account.balance / 100).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(text.includes(expected), "certificate must quote the actual balance");
});

check("documents belong to their owner only", () => {
  const doc = servicing.issueDocument({
    user: store.getUserById(asha.id), account: store.getAccountById(ashaAcc.id),
    kind: "account_summary"
  });
  assert.ok(servicing.getDocument(doc.id, asha.id));
  assert.strictEqual(servicing.getDocument(doc.id, bharat.id), undefined);
});

check("unknown document types are refused", () => {
  expectFails(() => servicing.issueDocument({
    user: store.getUserById(asha.id), account: store.getAccountById(ashaAcc.id),
    kind: "loan_approval"
  }), /Unknown document/);
});

const assistant = require("./src/assistant");

async function assistantTests() {
console.log("\nAI customer care");

const ask = async question =>
  (await assistant.ask({ user: store.getUserById(asha.id), question })).reply;

// The tests below exercise the grounded engine, which is what runs with no
// ANTHROPIC_API_KEY set. Both engines read the same snapshot.
check("the snapshot is scoped to one customer", () => {
  const snap = assistant.snapshot(store.getUserById(asha.id));
  assert.strictEqual(snap.accountNumber, ashaAcc.number);
  assert.notStrictEqual(snap.accountNumber, bharatAcc.number);

  const text = assistant.snapshotText(snap);
  assert.ok(!text.includes(bharatAcc.number),
    "one customer's snapshot must not contain another's account number");
});

await checkAsync("it answers the balance with the real figure", async () => {
  const reply = await ask("what is my balance?");
  const expected = (balanceOf(ashaAcc.id) / 100).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(reply.includes(expected), `expected the live balance in: ${reply}`);
});

await checkAsync("it reports the most recent transaction", async () => {
  const reply = await ask("what was my last transaction?");
  assert.match(reply, /₹/);
  assert.match(reply, /Statement/i);
});

await checkAsync("it summarises spending from real categories", async () => {
  const reply = await ask("where did my money go?");
  assert.match(reply, /spent|no spending/i);
});

await checkAsync("it knows this customer's card state", async () => {
  const reply = await ask("is my card blocked?");
  assert.match(reply, new RegExp(store.getCard(ashaAcc.id).status, "i"));
});

await checkAsync("it routes a stuck payment to the automated flow", async () => {
  const reply = await ask("money was debited but not received");
  assert.match(reply, /Support/i);
  assert.match(reply, /automatic|refunded|reverses/i);
});

await checkAsync("it declines gracefully when it cannot answer", async () => {
  const reply = await ask("what is the airspeed of a swallow?");
  assert.match(reply, /balance|payments|service request/i);
});

await checkAsync("empty and oversized questions are refused", async () => {
  await expectFailsAsync(
    () => assistant.ask({ user: store.getUserById(asha.id), question: "  " }),
    /Ask a question/);
  await expectFailsAsync(
    () => assistant.ask({ user: store.getUserById(asha.id), question: "x".repeat(1001) }),
    /too long/);
});
}

console.log("\nrecurring deposits");

check("an RD collects its instalments instead of assuming them", () => {
  const before = balanceOf(ashaAcc.id);
  const rd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "RD",
    amount: 2000, tenureMonths: 12
  });

  // Opening takes the first instalment only.
  assert.strictEqual(balanceOf(ashaAcc.id), before - 2000_00);

  // Drive the schedule forward; each sweep collects one due instalment.
  for (let m = 0; m < 11; m++) {
    store.db.prepare("UPDATE deposits SET next_due = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), rd.id);
    money.collectDepositInstalments();
  }

  const row = store.db.prepare("SELECT * FROM deposits WHERE id = ?").get(rd.id);
  assert.strictEqual(row.instalments_paid, 12);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 2000_00 * 12,
    "every instalment must actually leave the account");
});

check("a matured RD pays interest, not free money", () => {
  const rd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "RD",
    amount: 1000, tenureMonths: 12
  });
  for (let m = 0; m < 11; m++) {
    store.db.prepare("UPDATE deposits SET next_due = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), rd.id);
    money.collectDepositInstalments();
  }

  const paidIn = 1000_00 * 12;
  const before = balanceOf(ashaAcc.id);
  store.db.prepare("UPDATE deposits SET maturity_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), rd.id);

  const result = money.closeDeposit(rd.id, asha.id);
  const gain = balanceOf(ashaAcc.id) - before - 0;

  assert.ok(result.payout > paidIn, "should return more than was paid in");
  // Interest on a 12-month RD is single-digit percent, never a multiple.
  assert.ok(result.payout < paidIn * 1.15,
    `payout ${result.payout} is implausibly large against ${paidIn} paid in`);
});

check("stopping payments does not earn the full projection", () => {
  const rd = money.openDeposit({
    userId: asha.id, accountId: ashaAcc.id, kind: "RD",
    amount: 3000, tenureMonths: 12
  });
  // Only the opening instalment is ever paid.
  const projected = store.db.prepare("SELECT maturity_amount FROM deposits WHERE id = ?")
    .get(rd.id).maturity_amount;

  store.db.prepare("UPDATE deposits SET maturity_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), rd.id);

  const result = money.closeDeposit(rd.id, asha.id);
  assert.ok(result.payout >= 3000_00, "the one instalment paid must come back");
  assert.ok(result.payout < projected / 5,
    "a single instalment must not collect a twelve-instalment projection");
});

check("an instalment is skipped rather than overdrawing the account", () => {
  const poor = makeUser("Poor", "9000000044", "poor");
  const poorAcc = store.openAccount(poor.id, 1001, 1200_00);

  const rd = money.openDeposit({
    userId: poor.id, accountId: poorAcc.id, kind: "RD",
    amount: 1000, tenureMonths: 12
  });
  store.db.prepare("UPDATE deposits SET next_due = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), rd.id);

  money.collectDepositInstalments();
  assert.ok(balanceOf(poorAcc.id) >= 0, "must never push the balance negative");
  assert.strictEqual(
    store.db.prepare("SELECT instalments_paid FROM deposits WHERE id=?").get(rd.id)
      .instalments_paid, 1, "the unaffordable instalment stays uncollected");
});

console.log("\nmoney radar");

const radar = require("./src/radar");

check("spots a monthly subscription and its annual cost", () => {
  const user = makeUser("Sub", "9000000055", "sub");
  const acc = store.openAccount(user.id, 1001, 100000_00);

  for (let m = 4; m >= 1; m--) {
    const when = new Date();
    when.setDate(when.getDate() - m * 30);
    store.recordTransaction({
      accountId: acc.id, direction: "out", amount: 49900,
      balanceAfter: 0, counterpartyName: "Prime Video",
      method: "Debit card", category: "Shopping", description: "Prime Video",
      createdAt: when.toISOString()
    });
  }

  const found = radar.detectSubscriptions(acc.id);
  const prime = found.find(s => s.payee === "Prime Video");
  assert.ok(prime, "should detect the recurring charge");
  assert.strictEqual(prime.cadence, "monthly");
  assert.strictEqual(prime.charges, 4);
  assert.strictEqual(prime.annualCost, 499 * 12);
});

check("flags a price rise that has already been billed twice", () => {
  const user = makeUser("Rise", "9000000056", "rise");
  const acc = store.openAccount(user.id, 1001, 100000_00);

  // 199, 199, 249, 249 — the rise must still show on the latest charge.
  [[120, 19900], [90, 19900], [60, 24900], [30, 24900]].forEach(([ago, amt]) => {
    const when = new Date();
    when.setDate(when.getDate() - ago);
    store.recordTransaction({
      accountId: acc.id, direction: "out", amount: amt, balanceAfter: 0,
      counterpartyName: "Streamly", method: "UPI", category: "Shopping",
      description: "Streamly", createdAt: when.toISOString()
    });
  });

  const sub = radar.detectSubscriptions(acc.id).find(s => s.payee === "Streamly");
  assert.ok(sub.priceRise, "a sustained increase must still be reported");
  assert.strictEqual(sub.priceRise.from, 199);
  assert.strictEqual(sub.priceRise.to, 249);
});

check("two payments alone are never called a subscription", () => {
  // Two one-off recharges a week apart must not become a "weekly" plan and
  // get extrapolated into a large annual figure.
  const user = makeUser("Pair", "9000000058", "pair");
  const acc = store.openAccount(user.id, 1001, 100000_00);

  [14, 7].forEach(ago => {
    const when = new Date();
    when.setDate(when.getDate() - ago);
    store.recordTransaction({
      accountId: acc.id, direction: "out", amount: 29900, balanceAfter: 0,
      counterpartyName: "Jio recharge", method: "Recharge", category: "Recharge",
      description: "Jio recharge", createdAt: when.toISOString()
    });
  });

  assert.strictEqual(
    radar.detectSubscriptions(acc.id).find(s => s.payee === "Jio recharge"),
    undefined, "two charges are one interval, not a pattern");
});

check("irregular payments are not called subscriptions", () => {
  const user = makeUser("Random", "9000000057", "random");
  const acc = store.openAccount(user.id, 1001, 100000_00);

  [2, 9, 40, 41].forEach(ago => {
    const when = new Date();
    when.setDate(when.getDate() - ago);
    store.recordTransaction({
      accountId: acc.id, direction: "out", amount: 15000, balanceAfter: 0,
      counterpartyName: "Corner Shop", method: "UPI", category: "Groceries",
      description: "Corner Shop", createdAt: when.toISOString()
    });
  });

  assert.strictEqual(
    radar.detectSubscriptions(acc.id).find(s => s.payee === "Corner Shop"),
    undefined, "uneven gaps are not a recurring charge");
});

check("catches an accidental repeat payment", () => {
  money.payUpi({ fromAccountId: ashaAcc.id, vpa: "twice@okaxis", amount: 250 });
  const twin = radar.recentIdenticalPayment(ashaAcc.id, {
    counterparty: "twice@okaxis", amountMinor: 250_00
  });
  assert.ok(twin, "an identical payment moments ago should be found");

  assert.strictEqual(radar.recentIdenticalPayment(ashaAcc.id, {
    counterparty: "twice@okaxis", amountMinor: 999_00
  }), undefined, "a different amount is not a duplicate");
});

console.log("\nautopay mandates");

const mandates = require("./src/mandates");

/* A payee with a charge on the ledger, so the cap has a real price to read. */
const seedCharge = (accId, payee, amountMinor, daysAgo = 1) => {
  const when = new Date();
  when.setDate(when.getDate() - daysAgo);
  store.recordTransaction({
    accountId: accId, direction: "out", amount: amountMinor, balanceAfter: 0,
    counterpartyName: payee, method: "Debit card", category: "Shopping",
    description: payee, createdAt: when.toISOString()
  });
};

const dueNow = id => store.db.prepare("UPDATE mandates SET next_due = ? WHERE id = ?")
  .run(new Date(Date.now() - 1000).toISOString(), id);

check("autopay debits automatically at the end of a cycle", () => {
  seedCharge(ashaAcc.id, "Streamflix", 499_00);
  const id = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Streamflix",
    amount: 499, cadence: "monthly", maxAmount: 600
  });

  const before = balanceOf(ashaAcc.id);
  dueNow(id);
  const run = mandates.collectDueMandates();

  assert.strictEqual(run.charged, 1);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 499_00);

  const m = mandates.getMandate(id, asha.id);
  assert.strictEqual(m.charges_made, 1);
  assert.ok(new Date(m.next_due) > new Date(), "the cycle must roll forward");
});

check("nothing is debited again until the next cycle ends", () => {
  const id = store.db.prepare(
    "SELECT id FROM mandates WHERE payee = 'Streamflix'").get().id;
  const before = balanceOf(ashaAcc.id);

  assert.strictEqual(mandates.collectDueMandates().charged, 0);
  assert.strictEqual(balanceOf(ashaAcc.id), before);
});

check("a price above the approved limit is refused, not charged", () => {
  seedCharge(ashaAcc.id, "Gymly", 1000_00, 40);
  const id = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Gymly",
    amount: 1000, cadence: "monthly", maxAmount: 1200
  });

  // The merchant raises the price beyond the ceiling.
  seedCharge(ashaAcc.id, "Gymly", 2500_00, 1);
  const before = balanceOf(ashaAcc.id);
  dueNow(id);

  const run = mandates.collectDueMandates();
  assert.strictEqual(run.flagged, 1);
  assert.strictEqual(run.charged, 0);
  assert.strictEqual(balanceOf(ashaAcc.id), before, "a rise above the cap must not be paid");

  const m = mandates.getMandate(id, asha.id);
  assert.strictEqual(m.status, "needs_review");
  assert.match(m.last_error, /above your approved limit/);
});

check("raising the limit is what approves the new price", () => {
  const m = store.db.prepare("SELECT * FROM mandates WHERE payee = 'Gymly'").get();
  const before = balanceOf(ashaAcc.id);

  mandates.updateMandateCap(m.id, asha.id, 2600);
  assert.strictEqual(mandates.getMandate(m.id, asha.id).status, "active");

  mandates.collectDueMandates();
  assert.strictEqual(balanceOf(ashaAcc.id), before - 2500_00);
});

check("an unaffordable charge is skipped, never overdrawn, and retried", () => {
  const broke = makeUser("Broke", "9000000061", "broke");
  const brokeAcc = store.openAccount(broke.id, 1001, 200_00);
  seedCharge(brokeAcc.id, "Bigly", 900_00, 40);

  const id = mandates.createMandate({
    userId: broke.id, accountId: brokeAcc.id, payee: "Bigly",
    amount: 900, cadence: "monthly", maxAmount: 1000
  });
  const due = new Date(Date.now() - 1000).toISOString();
  store.db.prepare("UPDATE mandates SET next_due = ? WHERE id = ?").run(due, id);

  const run = mandates.collectDueMandates();
  assert.strictEqual(run.skipped, 1);
  assert.strictEqual(balanceOf(brokeAcc.id), 200_00, "must never push the balance negative");

  const m = mandates.getMandate(id, broke.id);
  assert.strictEqual(m.charges_made, 0);
  assert.strictEqual(m.next_due, due, "the cycle must not advance on a failed debit");
  assert.match(m.last_error, /try again/i);
});

check("a paused or cancelled mandate never debits", () => {
  const id = store.db.prepare("SELECT id FROM mandates WHERE payee='Streamflix'").get().id;

  mandates.setMandateStatus(id, asha.id, "paused");
  dueNow(id);
  const before = balanceOf(ashaAcc.id);
  assert.strictEqual(mandates.collectDueMandates().charged, 0);
  assert.strictEqual(balanceOf(ashaAcc.id), before);

  mandates.setMandateStatus(id, asha.id, "cancelled");
  dueNow(id);
  assert.strictEqual(mandates.collectDueMandates().charged, 0);
  assert.strictEqual(balanceOf(ashaAcc.id), before);
});

check("autopay can be turned off and on again", () => {
  // Cancelling keeps the row, and the table allows one mandate per payee, so
  // re-enabling has to revive that row rather than insert a second one.
  seedCharge(ashaAcc.id, "Toggly", 400_00);
  const first = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Toggly",
    amount: 400, cadence: "monthly", maxAmount: 500
  });

  mandates.setMandateStatus(first, asha.id, "cancelled");

  const second = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Toggly",
    amount: 400, cadence: "monthly", maxAmount: 500
  });

  assert.strictEqual(second, first, "the cancelled mandate should be revived");
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM mandates WHERE payee = 'Toggly'")
      .get().n, 1, "no duplicate mandate row");

  const m = mandates.getMandate(second, asha.id);
  assert.strictEqual(m.status, "active");
  assert.strictEqual(m.charges_made, 0, "a re-enabled mandate starts a fresh cycle");
});

check("a revived mandate actually debits", () => {
  const id = store.db.prepare("SELECT id FROM mandates WHERE payee='Toggly'").get().id;
  const before = balanceOf(ashaAcc.id);
  dueNow(id);

  assert.strictEqual(mandates.collectDueMandates().charged, 1);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 400_00);
});

check("autopay cannot be set up twice while it is live", () => {
  expectFails(() => mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Toggly",
    amount: 400, cadence: "monthly", maxAmount: 500
  }), /already set up/);
});

check("a limit below the charge is refused", () => {
  expectFails(() => mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Toolow",
    amount: 500, cadence: "monthly", maxAmount: 100
  }), /cannot be below/);
});

check("mandates are private to their owner", () => {
  const m = store.db.prepare("SELECT * FROM mandates WHERE payee='Gymly'").get();
  assert.ok(mandates.getMandate(m.id, asha.id));
  assert.strictEqual(mandates.getMandate(m.id, bharat.id), undefined);
  expectFails(() => mandates.setMandateStatus(m.id, bharat.id, "cancelled"), /not found/);
});

console.log("\nsubscription actions");

check("paying in advance debits now and moves the cycle on", () => {
  seedCharge(ashaAcc.id, "Newsly", 300_00);
  const id = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Newsly",
    amount: 300, cadence: "monthly", maxAmount: 400
  });
  const wasDue = mandates.getMandate(id, asha.id).next_due;
  const before = balanceOf(ashaAcc.id);

  const result = mandates.payInAdvance(id, asha.id);

  assert.strictEqual(balanceOf(ashaAcc.id), before - 300_00);
  const m = mandates.getMandate(id, asha.id);
  assert.strictEqual(m.charges_made, 1);
  assert.ok(new Date(m.next_due) > new Date(wasDue),
    "paying early must push the next charge out, not bill twice");
});

check("a stop instruction cancels autopay and blocks future debits", () => {
  seedCharge(ashaAcc.id, "Stopme", 200_00);
  const id = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Stopme",
    amount: 200, cadence: "monthly", maxAmount: 250
  });

  mandates.stopPayingPayee({ userId: asha.id, payee: "Stopme" });
  assert.ok(mandates.isPayeeBlocked(asha.id, "Stopme"));
  assert.strictEqual(mandates.getMandate(id, asha.id).status, "cancelled");

  // Even if something re-activates it, the block still wins.
  store.db.prepare("UPDATE mandates SET status='active', next_due=? WHERE id=?")
    .run(new Date(Date.now() - 1000).toISOString(), id);

  const before = balanceOf(ashaAcc.id);
  mandates.collectDueMandates();
  assert.strictEqual(balanceOf(ashaAcc.id), before, "a stopped payee must never be debited");
  assert.strictEqual(mandates.getMandate(id, asha.id).status, "cancelled");
});

check("paying in advance is refused for a stopped payee", () => {
  seedCharge(ashaAcc.id, "Blocked", 100_00);
  const id = mandates.createMandate({
    userId: asha.id, accountId: ashaAcc.id, payee: "Blocked",
    amount: 100, cadence: "monthly", maxAmount: 150
  });
  mandates.stopPayingPayee({ userId: asha.id, payee: "Blocked" });

  expectFails(() => mandates.payInAdvance(id, asha.id), /stopped|cancelled/i);
});

check("payments can be allowed again", () => {
  mandates.resumePayingPayee(asha.id, "Stopme");
  assert.strictEqual(mandates.isPayeeBlocked(asha.id, "Stopme"), false);
});

check("a stop instruction is private to its owner", () => {
  mandates.stopPayingPayee({ userId: asha.id, payee: "Mine" });
  assert.ok(mandates.isPayeeBlocked(asha.id, "Mine"));
  assert.strictEqual(mandates.isPayeeBlocked(bharat.id, "Mine"), false);
});

console.log("\nsign-in protection");

const security = require("./src/security");
const notifyStore = require("./src/notify");

check("repeated wrong passwords lock the account", () => {
  const id = "lockme@test.in";
  assert.strictEqual(security.lockoutSeconds(id), 0);

  for (let i = 0; i < security.MAX_ATTEMPTS; i++) security.recordAttempt(id, false);

  const wait = security.lockoutSeconds(id);
  assert.ok(wait > 0, "should be locked out");
  assert.ok(wait <= security.LOCKOUT_MINUTES * 60);
});

check("a successful sign-in clears the failures", () => {
  const id = "clearme@test.in";
  for (let i = 0; i < security.MAX_ATTEMPTS - 1; i++) security.recordAttempt(id, false);
  security.recordAttempt(id, true);

  for (let i = 0; i < security.MAX_ATTEMPTS - 1; i++) security.recordAttempt(id, false);
  assert.strictEqual(security.lockoutSeconds(id), 0,
    "failures before a success must not count towards a lockout");
});

check("lockouts are per identifier", () => {
  const id = "only-me@test.in";
  for (let i = 0; i < security.MAX_ATTEMPTS; i++) security.recordAttempt(id, false);
  assert.ok(security.lockoutSeconds(id) > 0);
  assert.strictEqual(security.lockoutSeconds("someone-else@test.in"), 0);
});

check("a reset link changes the password and works only once", () => {
  const { token } = security.requestPasswordReset("asha@test.in");
  assert.ok(token, "a registered address gets a token");

  const first = security.completePasswordReset(token, "brandnewpass", auth.hashPassword);
  assert.strictEqual(first.ok, true);
  assert.ok(auth.verifyPassword("brandnewpass", store.getUserById(asha.id).password));

  const again = security.completePasswordReset(token, "otherpass123", auth.hashPassword);
  assert.strictEqual(again.ok, false, "a used link must not work twice");
});

check("an unknown address yields no token but does not error", () => {
  const result = security.requestPasswordReset("ghost@nowhere.in");
  assert.strictEqual(result.sent, true, "the caller must not learn the address is unknown");
  assert.strictEqual(result.token, null);
});

check("a short new password is refused", () => {
  const { token } = security.requestPasswordReset("bharat@test.in");
  const result = security.completePasswordReset(token, "short", auth.hashPassword);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /at least 8/);
});

check("a login code verifies once and only for its owner", () => {
  const user = store.getUserById(asha.id);
  const code = security.issueLoginCode(user);

  assert.match(code, /^\d{6}$/);
  assert.strictEqual(security.verifyLoginCode(store.getUserById(bharat.id), code), false,
    "another customer's code must not work");
  assert.strictEqual(security.verifyLoginCode(user, code), true);
  assert.strictEqual(security.verifyLoginCode(user, code), false, "a code is single use");
});

check("a wrong login code is refused", () => {
  const user = store.getUserById(asha.id);
  security.issueLoginCode(user);
  assert.strictEqual(security.verifyLoginCode(user, "000000"), false);
});

console.log("\nnotifications");

check("an alert is recorded and counted unread", () => {
  const before = notifyStore.unreadCount(bharat.id);
  const id = notifyStore.notify(bharat.id, {
    kind: "info", title: "Test alert", body: "Body", severity: "warning"
  });

  assert.ok(id);
  assert.strictEqual(notifyStore.unreadCount(bharat.id), before + 1);

  const list = notifyStore.list(bharat.id);
  assert.strictEqual(list[0].title, "Test alert");
  assert.strictEqual(list[0].read, false);
});

check("marking read reduces the count, and only for its owner", () => {
  const list = notifyStore.list(bharat.id);
  const before = notifyStore.unreadCount(bharat.id);

  assert.strictEqual(notifyStore.markRead(list[0].id, asha.id), false,
    "another customer must not clear this");
  assert.strictEqual(notifyStore.unreadCount(bharat.id), before);

  assert.strictEqual(notifyStore.markRead(list[0].id, bharat.id), true);
  assert.strictEqual(notifyStore.unreadCount(bharat.id), before - 1);
});

check("notifications are private to their owner", () => {
  notifyStore.notify(asha.id, { kind: "info", title: "Asha only" });
  assert.ok(notifyStore.list(asha.id).some(n => n.title === "Asha only"));
  assert.ok(!notifyStore.list(bharat.id).some(n => n.title === "Asha only"));
});

check("a repeating alert is not sent twice in its window", () => {
  const payload = { kind: "shortfall", title: "Short by 100", body: "x" };
  const first = notifyStore.notifyOnce(asha.id, "shortfall", 24, payload);
  const second = notifyStore.notifyOnce(asha.id, "shortfall", 24, payload);

  assert.ok(first, "the first should send");
  assert.strictEqual(second, null, "an hourly sweep must not repeat itself");
});

console.log("\nscheduled transfers & pagination");

check("a scheduled transfer sends when its date arrives", () => {
  const when = new Date(Date.now() - 1000).toISOString();
  store.db.prepare(
    `INSERT INTO scheduled_transfers
       (user_id, account_id, to_account, amount, description, mode, run_on, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(asha.id, ashaAcc.id, bharatAcc.number, 700_00, "Rent", "IMPS", when, store.nowISO());

  const before = balanceOf(ashaAcc.id);
  assert.strictEqual(money.runScheduledTransfers(), 1);
  assert.strictEqual(balanceOf(ashaAcc.id), before - 700_00);

  const row = store.db.prepare(
    "SELECT * FROM scheduled_transfers ORDER BY id DESC LIMIT 1").get();
  assert.strictEqual(row.status, "sent");
});

check("a scheduled transfer that fails is recorded, not retried blindly", () => {
  store.db.prepare(
    `INSERT INTO scheduled_transfers
       (user_id, account_id, to_account, amount, mode, run_on, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(asha.id, ashaAcc.id, bharatAcc.number, 99999999_00, "IMPS",
        new Date(Date.now() - 1000).toISOString(), store.nowISO());

  money.runScheduledTransfers();
  const row = store.db.prepare(
    "SELECT * FROM scheduled_transfers ORDER BY id DESC LIMIT 1").get();

  assert.strictEqual(row.status, "failed");
  assert.ok(row.last_error, "the reason must be kept for the customer");
});

check("transactions page without losing rows", () => {
  const total = store.countTransactions(ashaAcc.id);
  assert.ok(total > 5, "need enough history to page");

  const page1 = store.listTransactions(ashaAcc.id, { limit: 5, offset: 0 });
  const page2 = store.listTransactions(ashaAcc.id, { limit: 5, offset: 5 });

  assert.strictEqual(page1.length, 5);
  assert.ok(page2.length > 0);
  assert.strictEqual(
    new Set([...page1, ...page2].map(t => t.id)).size, page1.length + page2.length,
    "pages must not overlap");
});

check("the count honours the same filters as the list", () => {
  const q = { q: "Rent" };
  assert.strictEqual(
    store.countTransactions(ashaAcc.id, q),
    store.listTransactions(ashaAcc.id, q).length);
});

console.log("\nIFSC decoding");

const ifsc = require("./src/ifsc");

check("decodes the bank from a real IFSC", () => {
  assert.strictEqual(ifsc.decode("HDFC0001234").bank, "HDFC Bank");
  assert.strictEqual(ifsc.decode("SBIN0000456").bank, "State Bank of India");
  assert.strictEqual(ifsc.decode("KKBK0000958").bank, "Kotak Mahindra Bank");
  assert.strictEqual(ifsc.decode("hdfc0001234").bank, "HDFC Bank", "case-insensitive");
});

check("reports the branch code and never invents a branch name", () => {
  const d = ifsc.decode("UTIB0001122");
  assert.strictEqual(d.branchCode, "001122");
  assert.strictEqual(d.bank, "Axis Bank");
  assert.ok(!("branchName" in d), "the branch name is not derivable from an IFSC");
});

check("a well-formed code from an unlisted bank is reported honestly", () => {
  const d = ifsc.decode("ZZZZ0001234");
  assert.strictEqual(d.known, false);
  assert.strictEqual(d.bank, null, "must not guess a bank name");
  assert.strictEqual(d.bankCode, "ZZZZ");
});

check("malformed codes are rejected", () => {
  for (const bad of ["HDFC1234567", "HDF00001234", "HDFC000123", "", null, "12345678901"]) {
    assert.strictEqual(ifsc.decode(bad), null, `should reject ${bad}`);
  }
});

console.log("\ncard wallet");

check("every account is issued exactly one AB Pay card", () => {
  const own = store.listCards(asha.id).filter(c => c.is_own);
  assert.strictEqual(own.length, 1);
  assert.strictEqual(own[0].issuer, "AB Pay");
  assert.strictEqual(own[0].last4, own[0].number.slice(-4));
});

check("added cards are kept apart from the issued one", () => {
  store.db.prepare(
    `INSERT INTO cards (user_id, kind, issuer, label, last4, network, expiry,
                        is_own, created_at)
     VALUES (?,'credit','HDFC Bank','Travel','4321','Visa','2029-09',0,?)`
  ).run(asha.id, store.nowISO());

  const cards = store.listCards(asha.id);
  assert.strictEqual(cards.length, 2);
  // The issued card must remain the one getCard controls.
  assert.strictEqual(store.getCard(ashaAcc.id).issuer, "AB Pay");
  assert.strictEqual(cards.filter(c => !c.is_own)[0].issuer, "HDFC Bank");
});

check("a wallet card never stores the full number", () => {
  const added = store.listCards(asha.id).find(c => !c.is_own);
  assert.strictEqual(added.number, null,
    "only the last four digits may be persisted for an added card");
  assert.strictEqual(added.last4.length, 4);
});

check("wallets are private to their owner", () => {
  assert.strictEqual(store.listCards(bharat.id).filter(c => !c.is_own).length, 0);

  const ashaCard = store.listCards(asha.id).find(c => !c.is_own);
  assert.ok(store.getCardById(ashaCard.id, asha.id));
  assert.strictEqual(store.getCardById(ashaCard.id, bharat.id), undefined,
    "another customer must not be able to read this card");
});

console.log("\nstatements");

check("date filtering narrows the statement", () => {
  assert.ok(store.listTransactions(ashaAcc.id).length > 0);
  assert.strictEqual(store.listTransactions(ashaAcc.id, { from: "2999-01-01" }).length, 0);
});

assistantTests().then(() => {
  fs.rmSync(TEST_DB, { force: true });
  console.log(`\n${passed} checks passed\n`);
}).catch(err => {
  fs.rmSync(TEST_DB, { force: true });
  console.error("\n" + err.stack + "\n");
  process.exit(1);
});
