/*
 * The real-world UPI address behind the public "Pay" page.
 *
 * Everything else in this application is a simulation — balances, transfers
 * and Safe Send all move numbers in a local SQLite file. This is the one
 * exception: a QR built from this address is a genuine NPCI payment request,
 * and money scanned into it leaves the payer's real bank account.
 *
 * It is therefore configuration, never a committed value. A UPI ID is usually
 * someone's mobile number, so hard-coding one would publish a phone number to
 * anyone who reads the repository. Set these in the environment instead:
 *
 *   RECEIVE_UPI_ID="yourname@okhdfcbank" \
 *   RECEIVE_UPI_NAME="YOUR NAME" \
 *   RECEIVE_UPI_BANK="Your Bank" npm start
 *
 * Left unset, the page shows a clearly fake placeholder that no UPI app will
 * accept — which is the right default, because a stranger's account number is
 * the last thing that should appear here by accident.
 */

const configured = Boolean(process.env.RECEIVE_UPI_ID);

module.exports = {
  vpa: process.env.RECEIVE_UPI_ID || "example@upi",
  name: process.env.RECEIVE_UPI_NAME || "Not configured",
  bank: process.env.RECEIVE_UPI_BANK || "Set RECEIVE_UPI_ID to enable",

  /* The UI uses this to say the page is a placeholder rather than live. */
  configured
};
