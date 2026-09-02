/*
 * Reference data for recharges and bill payments — the biller and plan
 * catalogue an Indian bank app would fetch from BBPS / the operators.
 */

const MOBILE_PLANS = {
  Jio: [
    { id: "jio-239", amount: 239, validity: "28 days", detail: "1.5 GB/day · Unlimited calls" },
    { id: "jio-299", amount: 299, validity: "28 days", detail: "2 GB/day · Unlimited calls" },
    { id: "jio-666", amount: 666, validity: "84 days", detail: "1.5 GB/day · Unlimited calls" },
    { id: "jio-3599", amount: 3599, validity: "365 days", detail: "2.5 GB/day · Unlimited calls" }
  ],
  Airtel: [
    { id: "air-265", amount: 265, validity: "28 days", detail: "1 GB/day · Unlimited calls" },
    { id: "air-359", amount: 359, validity: "28 days", detail: "2 GB/day · Unlimited calls" },
    { id: "air-859", amount: 859, validity: "84 days", detail: "2 GB/day · Unlimited calls" },
    { id: "air-3359", amount: 3359, validity: "365 days", detail: "2 GB/day · Disney+ Hotstar" }
  ],
  "Vi": [
    { id: "vi-269", amount: 269, validity: "28 days", detail: "1 GB/day · Unlimited calls" },
    { id: "vi-479", amount: 479, validity: "56 days", detail: "1.5 GB/day · Weekend data" },
    { id: "vi-901", amount: 901, validity: "84 days", detail: "2 GB/day · Unlimited calls" }
  ],
  BSNL: [
    { id: "bsnl-199", amount: 199, validity: "30 days", detail: "2 GB/day · Unlimited calls" },
    { id: "bsnl-599", amount: 599, validity: "90 days", detail: "3 GB/day · Unlimited calls" }
  ]
};

const DTH_OPERATORS = ["Tata Play", "Dish TV", "d2h", "Sun Direct", "Airtel Digital TV"];

const BILLERS = [
  { id: "bescom", name: "BESCOM", category: "Electricity", label: "Consumer number" },
  { id: "msedcl", name: "MSEDCL", category: "Electricity", label: "Consumer number" },
  { id: "bses-rajdhani", name: "BSES Rajdhani", category: "Electricity", label: "CA number" },
  { id: "tata-power", name: "Tata Power", category: "Electricity", label: "Consumer number" },
  { id: "adani", name: "Adani Electricity", category: "Electricity", label: "Consumer number" },
  { id: "indane", name: "Indane Gas", category: "Gas cylinder", label: "Consumer ID" },
  { id: "hp-gas", name: "HP Gas", category: "Gas cylinder", label: "Consumer ID" },
  { id: "bharat-gas", name: "Bharat Gas", category: "Gas cylinder", label: "Consumer ID" },
  { id: "mahanagar-gas", name: "Mahanagar Gas", category: "Piped gas", label: "Customer number" },
  { id: "act", name: "ACT Fibernet", category: "Broadband", label: "Account number" },
  { id: "jiofiber", name: "JioFiber", category: "Broadband", label: "Account number" },
  { id: "bwssb", name: "BWSSB", category: "Water", label: "RR number" },
  { id: "lic", name: "LIC of India", category: "Insurance", label: "Policy number" },
  { id: "fastag-icici", name: "FASTag Recharge", category: "FASTag", label: "Vehicle number" }
];

module.exports = { MOBILE_PLANS, DTH_OPERATORS, BILLERS };
