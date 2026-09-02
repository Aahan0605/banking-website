/*
 * IFSC codes.
 *
 * An Indian IFSC is 11 characters: four letters identifying the bank, a
 * reserved "0", then six characters identifying the branch. The bank half is
 * a fixed allocation, so it can be decoded offline — no network call, no API
 * key, and it still works when the machine is offline.
 *
 * The branch half is not derivable; only the issuing bank publishes that
 * mapping, so we report the branch code rather than inventing a location.
 */

const PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/* Bank codes as allocated by RBI/NPCI. */
const BANKS = {
  ABPY: "AB Pay",
  SBIN: "State Bank of India",
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda",
  CNRB: "Canara Bank",
  UBIN: "Union Bank of India",
  BKID: "Bank of India",
  IDIB: "Indian Bank",
  IOBA: "Indian Overseas Bank",
  CBIN: "Central Bank of India",
  MAHB: "Bank of Maharashtra",
  UCBA: "UCO Bank",
  PSIB: "Punjab & Sind Bank",
  YESB: "YES Bank",
  INDB: "IndusInd Bank",
  IDFB: "IDFC FIRST Bank",
  FDRL: "Federal Bank",
  RATN: "RBL Bank",
  BDBL: "Bandhan Bank",
  AUBL: "AU Small Finance Bank",
  ESFB: "Equitas Small Finance Bank",
  UJVN: "Ujjivan Small Finance Bank",
  KARB: "Karnataka Bank",
  SIBL: "South Indian Bank",
  CSBK: "CSB Bank",
  TMBL: "Tamilnad Mercantile Bank",
  DCBL: "DCB Bank",
  JAKA: "Jammu & Kashmir Bank",
  KVBL: "Karur Vysya Bank",
  CIUB: "City Union Bank",
  SCBL: "Standard Chartered Bank",
  CITI: "Citibank",
  HSBC: "HSBC India",
  DBSS: "DBS Bank India",
  DEUT: "Deutsche Bank",
  BARC: "Barclays Bank",
  PYTM: "Paytm Payments Bank",
  AIRP: "Airtel Payments Bank",
  IPOS: "India Post Payments Bank",
  FINO: "Fino Payments Bank",
  NSPB: "NSDL Payments Bank",
  JIOP: "Jio Payments Bank"
};

const normalise = code => String(code || "").toUpperCase().trim();

const isValid = code => PATTERN.test(normalise(code));

/*
 * Decodes what an IFSC can actually tell us. `bank` is null for a code that is
 * well-formed but whose four-letter prefix we do not carry — that is reported
 * honestly rather than guessed at.
 */
function decode(code) {
  const ifsc = normalise(code);
  if (!isValid(ifsc)) return null;

  const bankCode = ifsc.slice(0, 4);
  return {
    ifsc,
    bankCode,
    bank: BANKS[bankCode] || null,
    branchCode: ifsc.slice(5),
    known: Boolean(BANKS[bankCode])
  };
}

/* For the "which bank?" picker in the UI. */
const list = () => Object.entries(BANKS)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

module.exports = { PATTERN, BANKS, isValid, decode, list, normalise };
