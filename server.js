/*
 * E-Bank server. Serves the single-page client and the JSON API.
 */

const path = require("path");
const express = require("express");

const store = require("./src/db");
const { router } = require("./src/api");
const {
  expireProtectedPayments, collectDepositInstalments, runScheduledTransfers
} = require("./src/money");
const { collectDueMandates } = require("./src/mandates");
const { pruneAttempts } = require("./src/security");

const app = express();
const PORT = process.env.PORT || 3000;

// Bill attachments arrive as data URLs, so allow a larger JSON body.
app.use(express.json({ limit: "3mb" }));

app.use("/api", router);

/*
 * "no-cache" still lets the browser cache, but forces it to revalidate against
 * the ETag every time — so an edited script is picked up on the next load
 * instead of serving a stale copy from disk.
 */
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  setHeaders: res => res.setHeader("Cache-Control", "no-cache")
}));
// jsQR is loaded straight from the package so the QR scanner needs no build step.
app.use("/vendor/jsQR.js", express.static(
  path.join(__dirname, "node_modules", "jsqr", "dist", "jsQR.js")
));

// Client-side routing: anything not under /api falls through to the app shell.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Unexpected server error." });
});

store.seed();
/*
 * Scheduled work. These also run on demand when the relevant page loads, so a
 * long-idle server never leaves a customer looking at stale figures.
 */
setInterval(() => {
  expireProtectedPayments();
  collectDepositInstalments();
  collectDueMandates();
  runScheduledTransfers();
  pruneAttempts();
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`AB Pay running on http://localhost:${PORT}`);
  console.log("Demo login: demo@abpay.in / demo1234 · UPI PIN 1234");
});
