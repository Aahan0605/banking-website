/*
 * Tests for the Claude path of the assistant.
 * Run with: npm run test:assistant
 *
 * There is no API key in most environments, and calling the real API from a
 * test would cost money and depend on the network. What can go wrong here is
 * our own integration — the request we build, and how we read the reply — so
 * the SDK is replaced with a stub that records the request and returns a
 * canned response. Anthropic's service is not under test; our use of it is.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const TEST_DB = path.join(__dirname, "test-assistant.db");
fs.rmSync(TEST_DB, { force: true });
process.env.DB_FILE = TEST_DB;
process.env.SESSION_SECRET = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

/* ---------- stub the SDK before anything requires it ---------- */

let lastRequest = null;
let nextResponse = null;
let nextError = null;

class FakeAnthropic {
  constructor(options) {
    this.options = options;
    this.messages = {
      create: async request => {
        lastRequest = request;
        if (nextError) throw nextError;
        return nextResponse;
      }
    };
  }
}

const sdkPath = require.resolve("@anthropic-ai/sdk");
require.cache[sdkPath] = {
  id: sdkPath, filename: sdkPath, loaded: true, exports: FakeAnthropic
};

const store = require("./src/db");
const auth = require("./src/auth");
const assistant = require("./src/assistant");

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log("  ok  " + name);
};

/* ---------- fixtures ---------- */

const user = store.createUser({
  email: "claude@test.in", password: auth.hashPassword("password123"),
  name: "Meera", surname: "Rao", mobile: "9000000077", address: "", branch: "Test"
});
const account = store.openAccount(user.id, 1001, 250000_00);

store.recordTransaction({
  accountId: account.id, direction: "out", amount: 1999_00,
  balanceAfter: 250000_00, counterpartyName: "Testly",
  method: "UPI", category: "Shopping", description: "Testly"
});

const reply = text => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }]
});

const ask = (question, history = []) =>
  assistant.ask({ user: store.getUserById(user.id), question, history });

/* ---------- the tests ---------- */

async function run() {
  console.log("\nrequest we send to Claude");

  await check("uses the model and thinking mode we intend", async () => {
    nextResponse = reply("Your balance is fine.");
    await ask("what is my balance?");

    assert.strictEqual(lastRequest.model, "claude-opus-5");
    assert.deepStrictEqual(lastRequest.thinking, { type: "adaptive" });
    assert.strictEqual(lastRequest.output_config.effort, "low");
    assert.ok(lastRequest.max_tokens > 0);
  });

  await check("caches the stable rulebook, not the per-turn snapshot", async () => {
    nextResponse = reply("ok");
    await ask("hello");

    assert.ok(Array.isArray(lastRequest.system), "system must be blocks, not a string");
    assert.strictEqual(lastRequest.system.length, 2);

    const [rulebook, snapshot] = lastRequest.system;
    assert.deepStrictEqual(rulebook.cache_control, { type: "ephemeral" },
      "the rulebook is identical every turn and should be cached");
    assert.strictEqual(snapshot.cache_control, undefined,
      "the snapshot changes each turn, so caching it would waste a write");
    assert.match(snapshot.text, /Account snapshot/);
  });

  await check("sends this customer's real figures, and no one else's", async () => {
    const other = store.createUser({
      email: "other@test.in", password: auth.hashPassword("password123"),
      name: "Other", surname: "Person", mobile: "9000000078", address: "", branch: "Test"
    });
    const otherAccount = store.openAccount(other.id, 1001, 999_00);

    nextResponse = reply("ok");
    await ask("what is my balance?");

    const text = lastRequest.system[1].text;
    assert.ok(text.includes(account.number), "own account number should be present");
    assert.ok(!text.includes(otherAccount.number),
      "another customer's account must never reach the model");
    assert.ok(text.includes("Testly"), "recent transactions should be included");
  });

  await check("passes conversation history with roles normalised", async () => {
    nextResponse = reply("ok");
    await ask("and after that?", [
      { role: "user", content: "what is my balance?" },
      { role: "assistant", content: "It is ₹2,50,000." },
      { role: "weird", content: "should become user" }
    ]);

    const roles = lastRequest.messages.map(m => m.role);
    assert.deepStrictEqual(roles, ["user", "assistant", "user", "user"]);
    assert.strictEqual(lastRequest.messages.at(-1).content, "and after that?",
      "the live question goes last");
  });

  await check("caps history length and message size", async () => {
    nextResponse = reply("ok");
    const long = Array.from({ length: 20 }, (_, i) => ({
      role: "user", content: "x".repeat(5000) + i
    }));
    await ask("now what?", long);

    assert.ok(lastRequest.messages.length <= 9,
      "an unbounded history would grow the bill every turn");
    assert.ok(lastRequest.messages[0].content.length <= 2000,
      "a huge single message should be truncated");
  });

  console.log("\nreading the reply");

  await check("joins the text blocks and ignores the rest", async () => {
    nextResponse = {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "First line." },
        { type: "text", text: "Second line." }
      ]
    };
    const result = await ask("hello");

    assert.strictEqual(result.reply, "First line.\nSecond line.");
    assert.strictEqual(result.engine, "claude");
    assert.ok(!result.reply.includes("internal reasoning"),
      "thinking must never be shown to the customer");
  });

  await check("handles a refusal without showing an empty bubble", async () => {
    nextResponse = { stop_reason: "refusal", stop_details: { category: "other" }, content: [] };
    const result = await ask("something disallowed");

    assert.match(result.reply, /can't help/i);
    assert.strictEqual(result.engine, "claude");
  });

  await check("handles a reply with no text at all", async () => {
    nextResponse = { stop_reason: "end_turn", content: [] };
    const result = await ask("hello");
    assert.ok(result.reply.length > 0, "the customer must never get a blank answer");
  });

  console.log("\nwhen Claude is unavailable");

  await check("falls back to the grounded engine and says so", async () => {
    nextError = new Error("connection refused");
    const result = await ask("what is my balance?");
    nextError = null;

    assert.strictEqual(result.engine, "grounded", "a failed call must still answer");
    assert.strictEqual(result.degraded, true, "and must admit it was degraded");

    const balance = (store.getAccountById(account.id).balance / 100)
      .toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(result.reply.includes(balance), "the fallback still quotes the real balance");
  });

  await check("validation runs before any API call", async () => {
    lastRequest = null;
    await assert.rejects(() => ask("   "), /Ask a question/);
    assert.strictEqual(lastRequest, null, "an empty question must not reach the API");
  });

  console.log("\nengine selection");

  await check("uses Claude when a key is set, grounded when it is not", async () => {
    assert.strictEqual(assistant.hasKey(), true);

    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    assert.strictEqual(assistant.hasKey(), false);

    lastRequest = null;
    const result = await ask("what is my balance?");
    assert.strictEqual(result.engine, "grounded");
    assert.strictEqual(lastRequest, null, "no API call should be made without a key");

    process.env.ANTHROPIC_API_KEY = key;
  });

  fs.rmSync(TEST_DB, { force: true });
  console.log(`\n${passed} checks passed\n`);
}

run().catch(err => {
  fs.rmSync(TEST_DB, { force: true });
  console.error("\n" + err.stack + "\n");
  process.exit(1);
});
