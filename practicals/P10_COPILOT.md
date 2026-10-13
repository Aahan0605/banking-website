# Practical 10 — Exploring GitHub Copilot on AB Pay

**Aim:** demonstrate how GitHub Copilot helps with code generation, code completion, debugging, documentation and general productivity, using a personal-loan module for the AB Pay app.

**Files:** `p10_copilot/loan.js` (starter, with gaps and seeded bugs) and `p10_copilot/loan.test.js` (the tests that define "done").

## Setup

1. Install VS Code, then the **GitHub Copilot** and **GitHub Copilot Chat** extensions.
2. Sign in with GitHub (Copilot is free for verified students via the GitHub Student Developer Pack).
3. Open this repository in VS Code and open `practicals/p10_copilot/loan.js`.
4. In a terminal: `cd practicals/p10_copilot && node --test`. All three tests fail at first; that is the starting point.

For each exercise, take a screenshot of Copilot's suggestion and note in the table at the end whether you accepted it as-is, edited it, or rejected it.

## Exercise 1: Code generation from a comment

1. Place the cursor inside `emi()` on the `// TODO` line and delete it.
2. Wait for the grey ghost-text suggestion (or press `Alt+\` / `Option+\` to request one). Press `Tab` to accept.
3. Run `node --test`. **Exercise 1: emi** should pass.

**What to observe:** Copilot read the formula and the 0% edge case from the comment. Try removing the "0% loan" sentence, regenerate, and test `emi(12000, 0, 12)`. Does it divide by zero? This shows that the **comment is the spec**.

## Exercise 2: Code completion

1. In `schedule()`, below `let balance = principal;`, type `for (let month = 1;` and pause.
2. Accept suggestions line by line (`Ctrl+→` / `Cmd+→` accepts one word at a time). Open the alternatives panel (`Ctrl+Enter`) to compare several completions.
3. Run `node --test`. **Exercise 2** checks the first row exactly and that the final balance is **exactly 0**.

**What to observe:** a first suggestion often fails the "closing balance is 0" test because of rounding drift. The comment says the final payment absorbs rounding. Check whether Copilot honoured that, and fix it if not.

## Exercise 3: Debugging with Copilot Chat

`lateFee()` has **three** bugs.

1. Select the whole function and open Copilot Chat (`Ctrl+I` / `Cmd+I`), or type `/fix` in the Chat panel.
2. Prompt: *"The comment is the specification. Find every place this function disagrees with it."*
3. Apply the fix and run `node --test`. **Exercise 3** should pass.

<details><summary>Answer key (check after trying)</summary>

| Bug | Wrong | Right |
|---|---|---|
| Grace period is days 1–3 inclusive | `daysLate < 3` | `daysLate <= 3` |
| Every *started* week counts | `Math.floor(daysLate / 7)` | `Math.ceil(daysLate / 7)` |
| ₹500 is a cap | `Math.max(..., 500)` | `Math.min(..., 500)` |

</details>

**What to observe:** did Copilot find all three bugs, or only the obvious `max`/`min` one? Off-by-one boundaries are where AI fixes most often need a human check, which is why the tests exist.

## Exercise 4: Documentation

1. Select `schedule()` and run `/doc` in Copilot Chat. Accept the generated JSDoc block.
2. Ask Chat: *"Explain how src/money.js applies the monthly transfer limit."* Compare the explanation with the actual code.
3. Ask Chat to *"write a short README section for the loan module"*.

**What to observe:** was the JSDoc accurate about units (rupees, percent, months)? Did the explanation of `money.js` invent anything that isn't in the file?

## Exercise 5: Productivity (tests and a new feature)

1. Run `/tests` on `lateFee()` and compare Copilot's tests with `loan.test.js`. Did it think of the day-3 boundary?
2. Ask Copilot to add `prepaymentSavings(principal, annualRate, months, extra)`, which returns interest saved by paying `extra` rupees per month, and to write its test.
3. Time how long steps 1–2 take with Copilot, versus your estimate without it.

## Observations

| Exercise | Copilot feature | Accepted / edited / rejected | Tests passing first try? | Notes |
|---|---|---|---|---|
| 1 | Generation from comment | | | |
| 2 | Inline completion | | | |
| 3 | Chat `/fix` | | | |
| 4 | `/doc` + explain | | | |
| 5 | `/tests` + new feature | | | |

## Conclusion (fill in)

- Where Copilot saved the most time:
- Where it was wrong, and how the tests caught it:
- Why human review is still required for banking code:
