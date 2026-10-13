const test = require("node:test");
const assert = require("node:assert/strict");
const { emi, schedule, lateFee } = require("./loan");

test("Exercise 1: emi", () => {
  assert.equal(emi(100000, 12, 12), 8884.88);
  assert.equal(emi(500000, 10.5, 60), 10746.95);
  assert.equal(emi(12000, 0, 12), 1000);
});

test("Exercise 2: schedule", () => {
  const rows = schedule(100000, 12, 12);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], { month: 1, payment: 8884.88, interest: 1000, principal: 7884.88, balance: 92115.12 });
  assert.equal(rows.at(-1).balance, 0);
  const repaid = rows.reduce((sum, r) => sum + r.principal, 0);
  assert.equal(Math.round(repaid * 100) / 100, 100000);
});

test("Exercise 3: lateFee", () => {
  assert.equal(lateFee(10000, 0), 0);
  assert.equal(lateFee(10000, 3), 0);      // last day of grace
  assert.equal(lateFee(10000, 4), 200);    // first started week
  assert.equal(lateFee(10000, 8), 400);    // second started week
  assert.equal(lateFee(100000, 30), 500);  // capped
});
