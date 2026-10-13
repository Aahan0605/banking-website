/*
 * Practical 10 — starter file for the GitHub Copilot exercises.
 * Loan maths for an AB Pay personal-loan feature. Follow ../P10_COPILOT.md;
 * `node --test` in this folder tells you when each exercise is done.
 */

// Exercise 1 — code generation.
// Monthly EMI for a loan. `principal` in rupees, `annualRate` in percent
// (e.g. 10.5), `months` > 0. Formula: EMI = P·r·(1+r)^n / ((1+r)^n − 1) where
// r is the monthly rate as a fraction. A 0% loan is simply principal / months.
// Return rupees rounded to 2 decimals.
function emi(principal, annualRate, months) {
  // TODO: let Copilot write this from the comment above.
}

// Exercise 2 — code completion.
// Month-by-month repayment schedule. Returns an array of
// { month, payment, interest, principal, balance }, one entry per month,
// every value rounded to 2 decimals. The final payment absorbs rounding so
// the closing balance is exactly 0.
function schedule(principal, annualRate, months) {
  const payment = emi(principal, annualRate, months);
  const r = annualRate / 12 / 100;
  const rows = [];
  let balance = principal;
  // TODO: start typing the loop and accept Copilot's suggestions.
  return rows;
}

// Exercise 3 — debugging. This function has three bugs.
// Late fee on an overdue EMI: nothing within a 3-day grace period (days 1–3),
// otherwise 2% of the overdue amount for every started week late, capped at ₹500.
function lateFee(amount, daysLate) {
  if (daysLate < 3) return 0;
  const weeks = Math.floor(daysLate / 7);
  return Math.max(amount * 0.02 * weeks, 500);
}

module.exports = { emi, schedule, lateFee };
