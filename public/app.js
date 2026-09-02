/*
 * AB Pay single-page client.
 *
 * Views render into #app and are selected by the URL hash. All values that
 * originate from user input are escaped before being placed into markup.
 */

(() => {
  "use strict";

  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  let state = {
    token: localStorage.getItem("abpay_token"),
    user: null,
    account: null,
    catalog: null
  };
  let scanner = { stream: null, raf: null };


  /* ---------- UPI deep links ---------- */

  /*
   * "upi://" is a mobile-only scheme. On a desktop no app claims it, so the OS
   * hands it to whatever registered for unknown schemes — which is how a UPI
   * link ends up opening a messaging app. So we only ever render a upi:// link
   * on a phone, and give desktop users the QR and a copyable UPI ID instead.
   */
  const PLATFORM = (() => {
    const ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
    return "desktop";
  })();

  const isMobile = PLATFORM !== "desktop";

  /*
   * Per-app schemes. Android shows a chooser for a bare upi:// link, but iOS
   * has no such chooser, so there we name the apps individually.
   */
  const UPI_APPS = [
    { name: "Google Pay", scheme: payload => payload.replace(/^upi:/, "tez:") },
    { name: "PhonePe", scheme: payload => payload.replace(/^upi:\/\/pay/, "phonepe://pay") },
    { name: "Paytm", scheme: payload => payload.replace(/^upi:\/\/pay/, "paytmmp://pay") }
  ];

  /*
   * The launch controls for a payment payload, correct for this device.
   * `mount` is an element id that already exists in the markup.
   */
  function upiLaunchControls(payload, upiId) {
    if (PLATFORM === "android") {
      return `
        <a class="btn btn-block" href="${esc(payload)}">Open in UPI app</a>
        <button class="btn btn-ghost btn-block copy-upi" data-copy="${esc(upiId)}"
                style="margin-top:8px">Copy UPI ID</button>`;
    }

    if (PLATFORM === "ios") {
      return `
        <div class="upi-apps">
          ${UPI_APPS.map(app =>
            `<a class="btn btn-ghost btn-sm" href="${esc(app.scheme(payload))}">
               ${esc(app.name)}</a>`).join("")}
        </div>
        <button class="btn btn-ghost btn-block copy-upi" data-copy="${esc(upiId)}"
                style="margin-top:8px">Copy UPI ID</button>
        <p class="scan-hint">Opens the app if it is installed on this phone.</p>`;
    }

    // Desktop: a upi:// link here would be handed to an unrelated app.
    return `
      <button class="btn btn-block copy-upi" data-copy="${esc(upiId)}">Copy UPI ID</button>
      <p class="scan-hint">
        UPI apps run on your phone, so there is nothing to open on a computer —
        scan the code above with any UPI app, or copy the ID into it.
      </p>`;
  }

  /* Wires every copy button inside a container. */
  function wireCopyButtons(root) {
    (root || document).querySelectorAll(".copy-upi").forEach(button => {
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          toast("UPI ID copied", "ok");
        } catch {
          toast("Copy failed — select the ID and copy it manually.", "err");
        }
      };
    });
  }

  /* ---------- icons ---------- */

  const ICONS = {
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
    transfer: '<path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    bank: '<path d="m12 3 9 5H3Z"/><path d="M5 10v8"/><path d="M9 10v8"/><path d="M15 10v8"/><path d="M19 10v8"/><path d="M2 18h20"/>',
    document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    receipt: '<path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3Z"/><path d="M9 9h6"/><path d="M9 13h6"/>',
    power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z"/>',
    headset: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M4 13v3a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2Z"/><path d="M20 13v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2Z"/><path d="M18 18v1a2 2 0 0 1-2 2h-3"/><circle cx="12" cy="21" r="1"/>',
    bank2: '<path d="m12 3 9 5H3Z"/><path d="M5 10v8"/><path d="M12 10v8"/><path d="M19 10v8"/><path d="M2 18h20"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6.4 0 10 7 10 7a15 15 0 0 1-3 3.6"/><path d="M6.3 7.6A15 15 0 0 0 2 13s3.6 7 10 7a9.6 9.6 0 0 0 4.2-.9"/><path d="m2 2 20 20"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a2 2 0 0 0 3 0"/>'
  };

  const icon = (name, cls = "icon") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${ICONS[name] || ""}</svg>`;

  /* ---------- utilities ---------- */

  const esc = value => String(value ?? "").replace(/[&<>"']/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  // Indian digit grouping: 1,84,520.50 rather than 184,520.50
  const money = amount => "₹" + Number(amount ?? 0).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fmtDate = iso => !iso ? "—" : new Date(iso).toLocaleDateString("en-IN",
    { day: "2-digit", month: "short", year: "numeric" });

  const initials = user => ((user?.name?.[0] || "") + (user?.surname?.[0] || "")).toUpperCase();

  let toastTimer;
  function toast(message, kind = "") {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = "toast show " + kind;
    toastTimer = setTimeout(() => { toastEl.className = "toast " + kind; }, 3800);
  }

  async function api(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    if (state.token) headers.Authorization = "Bearer " + state.token;

    const res = await fetch("/api" + pathname, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (res.status === 401) {
      signOut();
      throw new Error("Your session expired. Please sign in again.");
    }
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const payload = isJson ? await res.json() : await res.text();

    if (!res.ok) {
      const err = new Error((payload && payload.message) || "Request failed.");
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  /* ---------- UPI PIN prompt ---------- */

  /*
   * UPI payments are authorised with a PIN, as on the real network. Resolves
   * with the entered PIN, or null if the customer backs out.
   */
  function askPin(title = "Enter UPI PIN") {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <p class="modal-sub">Your PIN authorises this payment.</p>
          <input id="pin-input" class="pin-input" type="password" inputmode="numeric"
                 maxlength="6" autocomplete="off" placeholder="••••">
          <div class="modal-actions">
            <button class="btn btn-ghost" id="pin-cancel">Cancel</button>
            <button class="btn" id="pin-ok">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const input = overlay.querySelector("#pin-input");
      const release = trapFocus(overlay, () => close(null));
      input.focus();

      const close = value => { release(); overlay.remove(); resolve(value); };
      overlay.querySelector("#pin-cancel").onclick = () => close(null);
      overlay.querySelector("#pin-ok").onclick = () => close(input.value);
      input.onkeydown = event => { if (event.key === "Enter") close(input.value); };
      overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
  }

  /*
   * Runs a payment call, prompting for a PIN and re-prompting if it is wrong
   * or not yet set.
   */
  async function payWithPin(pathname, body, title) {
    if (!state.user.hasUpiPin) {
      toast("Set your UPI PIN first — Services › UPI PIN", "err");
      location.hash = "#/services";
      return null;
    }
    const pin = await askPin(title);
    if (pin === null) return null;

    return api(pathname, { method: "POST", body: { ...body, pin } });
  }

  /* ---------- session ---------- */

  function signIn(session) {
    state.token = session.token;
    state.user = session.user;
    state.account = session.account;
    localStorage.setItem("abpay_token", session.token);
    location.hash = "#/dashboard";
    render();
  }

  function signOut() {
    removeAssistantLauncher();
    state = { token: null, user: null, account: null, catalog: null };
    localStorage.removeItem("abpay_token");
    location.hash = "#/login";
    render();
  }

  /* ---------- auth views ---------- */

  /* Marketing panel shown beside both auth forms. */
  const authAside = () => `
    <aside class="auth-aside">
      <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
      <div>
        <h2>Banking that keeps your money safe until you say so.</h2>
        <p>
          Scan any UPI QR, transfer instantly, open a deposit, and pay strangers
          without the risk — all from one account.
        </p>
        <ul class="aside-points">
          <li>${icon("scan")} <span>Scan and pay any UPI QR code</span></li>
          <li>${icon("transfer")} <span>IMPS, NEFT and RTGS transfers</span></li>
          <li>${icon("bank")} <span>Fixed and recurring deposits</span></li>
          <li>${icon("shield")} <span>Safe Send — escrow for marketplace payments</span></li>
        </ul>
      </div>
      <p style="font-size:0.78rem;opacity:0.6">
        Demonstration application. AB Pay is fictional and holds no real money.
      </p>
    </aside>`;

  function loginView() {
    app.innerHTML = `
      <div class="auth-wrap">
        ${authAside()}
        <div class="auth-panel">
          <div class="auth-card">
            <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
            <h1>Sign in</h1>
            <p class="sub">Net banking for your AB Pay account.</p>
            <div id="err"></div>
            <form id="login-form" novalidate>
              <div class="field">
                <label for="email">Email</label>
                <input id="email" type="email" autocomplete="username" required>
              </div>
              <div class="field">
                <label for="password">Password</label>
                <input id="password" type="password" autocomplete="current-password" required>
              </div>
              <button class="btn btn-block" type="submit">Sign in</button>
            </form>
            <p class="sub" style="margin:14px 0 0;text-align:center">
              <button class="link-btn" id="to-forgot">Forgot your password?</button>
            </p>
            <p class="sub" style="margin:10px 0 0;text-align:center">
              New to AB Pay? <button class="link-btn" id="to-signup">Open an account</button>
            </p>
            <div class="demo-hint">
              Demo login — <b>demo@abpay.in</b> / <b>demo1234</b><br>UPI PIN <b>1234</b>
            </div>
            <p class="sub" style="margin:14px 0 0;text-align:center;font-size:0.85rem">
              Just here to send a payment?
              <a href="#/receive" style="color:var(--red);font-weight:600">Pay by UPI</a>
            </p>
          </div>
        </div>
      </div>`;

    document.getElementById("to-signup").onclick = () => { location.hash = "#/signup"; };
    document.getElementById("to-forgot").onclick = () => { location.hash = "#/forgot"; };

    document.getElementById("login-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;

      const email = document.getElementById("email").value;
      try {
        const result = await api("/login", {
          method: "POST",
          body: { email, password: document.getElementById("password").value }
        });

        // Two-factor accounts get a code before any session is issued.
        if (result.otpRequired) return otpView(email, result.message);
        signIn(result);
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };
  }

  /* Second sign-in step for accounts with two-factor turned on. */
  function otpView(email, message) {
    app.innerHTML = `
      <div class="auth-wrap">
        ${authAside()}
        <div class="auth-panel">
          <div class="auth-card">
            <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
            <h1>Enter your code</h1>
            <p class="sub">${esc(message || "We sent a 6-digit code.")}</p>
            <div id="err"></div>
            <form id="otp-form" novalidate>
              <div class="field">
                <label for="otp">6-digit code</label>
                <input id="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
                       class="pin-input" style="letter-spacing:0.35em" required>
              </div>
              <button class="btn btn-block" type="submit">Sign in</button>
            </form>
            <p class="sub" style="margin:16px 0 0;text-align:center">
              <button class="link-btn" id="otp-back">Back to sign in</button>
            </p>
          </div>
        </div>
      </div>`;

    document.getElementById("otp").focus();
    document.getElementById("otp-back").onclick = () => { location.hash = "#/login"; render(); };

    document.getElementById("otp-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        signIn(await api("/login/verify", {
          method: "POST",
          body: { email, code: document.getElementById("otp").value }
        }));
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };
  }

  function forgotView() {
    app.innerHTML = `
      <div class="auth-wrap">
        ${authAside()}
        <div class="auth-panel">
          <div class="auth-card">
            <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
            <h1>Reset your password</h1>
            <p class="sub">We will send a link to your registered email.</p>
            <div id="err"></div>
            <form id="forgot-form" novalidate>
              <div class="field">
                <label for="f-email">Email</label>
                <input id="f-email" type="email" autocomplete="username" required>
              </div>
              <button class="btn btn-block" type="submit">Send reset link</button>
            </form>
            <div id="forgot-next"></div>
            <p class="sub" style="margin:18px 0 0;text-align:center">
              <button class="link-btn" id="forgot-back">Back to sign in</button>
            </p>
          </div>
        </div>
      </div>`;

    document.getElementById("forgot-back").onclick = () => { location.hash = "#/login"; render(); };

    document.getElementById("forgot-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const result = await api("/password/forgot", {
          method: "POST", body: { email: document.getElementById("f-email").value }
        });

        /*
         * With no mail provider wired up the link cannot arrive, so the
         * server hands it back in development and we show the form here.
         */
        document.getElementById("forgot-next").innerHTML = `
          <div class="demo-hint" style="margin-top:18px">${esc(result.message)}</div>
          ${result.devResetToken ? `
            <div class="field" style="margin-top:16px">
              <label for="r-token">Reset token (shown because email is not configured)</label>
              <input id="r-token" value="${esc(result.devResetToken)}">
            </div>
            <div class="field">
              <label for="r-pass">New password</label>
              <input id="r-pass" type="password" autocomplete="new-password">
            </div>
            <button class="btn btn-block" id="do-reset">Set new password</button>` : ""}`;

        const doReset = document.getElementById("do-reset");
        if (doReset) {
          doReset.onclick = async () => {
            try {
              const done = await api("/password/reset", {
                method: "POST",
                body: {
                  token: document.getElementById("r-token").value,
                  password: document.getElementById("r-pass").value
                }
              });
              toast(done.message, "ok");
              location.hash = "#/login";
              render();
            } catch (err) {
              document.getElementById("err").innerHTML =
                `<div class="form-error">${esc(err.message)}</div>`;
            }
          };
        }
        button.disabled = false;
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };
  }

  function signupView() {
    app.innerHTML = `
      <div class="auth-wrap">
        ${authAside()}
        <div class="auth-panel">
          <div class="auth-card">
            <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
            <h1>Open a savings account</h1>
            <p class="sub">Your account number, UPI ID and debit card are issued instantly.</p>
            <div id="err"></div>
            <form id="signup-form" novalidate>
              <div class="field-row">
                <div class="field">
                  <label for="name">First name</label>
                  <input id="name" required>
                </div>
                <div class="field">
                  <label for="surname">Surname</label>
                  <input id="surname" required>
                </div>
              </div>
              <div class="field">
                <label for="mobile">Mobile number</label>
                <input id="mobile" inputmode="numeric" maxlength="10"
                       placeholder="9876543210" required>
              </div>
              <div class="field">
                <label for="email">Email</label>
                <input id="email" type="email" autocomplete="username" required>
              </div>
              <div class="field">
                <label for="pan">PAN (optional)</label>
                <input id="pan" maxlength="10" placeholder="ABCPS1234K"
                       style="text-transform:uppercase">
              </div>
              <div class="field">
                <label for="password">Password</label>
                <input id="password" type="password" autocomplete="new-password" required>
              </div>
              <button class="btn btn-block" type="submit">Open account</button>
            </form>
            <p class="sub" style="margin:18px 0 0;text-align:center">
              Already a customer? <button class="link-btn" id="to-login">Sign in</button>
            </p>
          </div>
        </div>
      </div>`;

    document.getElementById("to-login").onclick = () => { location.hash = "#/login"; };

    document.getElementById("signup-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const session = await api("/signup", {
          method: "POST",
          body: {
            name: document.getElementById("name").value,
            surname: document.getElementById("surname").value,
            mobile: document.getElementById("mobile").value,
            email: document.getElementById("email").value,
            pan: document.getElementById("pan").value || undefined,
            password: document.getElementById("password").value
          }
        });
        signIn(session);
        toast(`Welcome! Your UPI ID is ${session.user.upiId}`, "ok");
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };
  }

  /* ---------- public payment page ---------- */

  /*
   * The one place in this app where money is real. Reachable without signing
   * in, because the point is that any visitor can scan it, and kept visually
   * distinct from the simulated balances everywhere else.
   */
  async function receiveView(params) {
    app.innerHTML = `
      <div class="pay-page">
        <div class="pay-card">
          <a class="pay-back" href="#/login">${icon("transfer")} Back to AB Pay demo</a>

          <div class="pay-live" id="pay-live-note">
            ${icon("alert")}
            <span><b>This is a real payment.</b> Scanning sends money from your
            bank account to the person below. It is not part of the demo.</span>
          </div>

          <div class="pay-to">Pay to</div>
          <h1 class="pay-name" id="pay-name">&nbsp;</h1>

          <div class="pay-qr"><img id="pay-qr" alt="UPI QR code"></div>

          <div class="pay-upi"><span id="pay-upi-id"></span></div>
          <div class="qr-state" id="pay-requested"></div>
          <div class="pay-bank" id="pay-bank"></div>

          <div class="pay-fields">
            <div class="field">
              <label for="pay-amount">Amount (optional)</label>
              <input id="pay-amount" type="number" step="0.01" min="1"
                     inputmode="decimal" placeholder="Payer chooses">
            </div>
            <div class="field">
              <label for="pay-note">Note (optional)</label>
              <input id="pay-note" maxlength="50" placeholder="What is it for?">
            </div>
          </div>

          <div id="pay-launch"></div>

          <div class="pay-apps">
            Works with Google Pay, PhonePe, Paytm, Amazon Pay, BHIM and any
            other UPI app.
          </div>
        </div>
      </div>`;

    const amountEl = document.getElementById("pay-amount");
    const noteEl = document.getElementById("pay-note");

    // A shared request carries its amount and note in the link.
    if (params) {
      const shared = Number(params.get("amount"));
      if (shared > 0) amountEl.value = shared;
      if (params.get("note")) noteEl.value = params.get("note");
    }

    const refresh = async () => {
      const query = new URLSearchParams();
      if (Number(amountEl.value) > 0) query.set("amount", amountEl.value);
      if (noteEl.value.trim()) query.set("note", noteEl.value.trim());

      const data = await api("/receive?" + query.toString());

      document.getElementById("pay-qr").src = data.dataUrl;
      const banner = document.getElementById("pay-requested");
      if (banner) {
        banner.innerHTML = data.amount
          ? `<span class="pill pill-green">Requesting ₹${
              Number(data.amount).toLocaleString("en-IN",
                { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>` +
            (data.note ? `<span class="qr-state-note">${esc(data.note)}</span>` : "")
          : "";
      }
      document.getElementById("pay-name").textContent = data.name;

      // Without RECEIVE_UPI_ID there is no real payee, so do not imply one.
      const note = document.getElementById("pay-live-note");
      if (note && !data.configured) {
        note.innerHTML = `${icon("alert")}<span><b>No payee configured.</b> ` +
          `This QR is a placeholder — set <code>RECEIVE_UPI_ID</code> to your ` +
          `UPI ID to make this page collect real payments.</span>`;
      }
      document.getElementById("pay-upi-id").textContent = data.upiId;
      document.getElementById("pay-bank").textContent = data.bank;
      // Only rendered as a launchable link on a phone — see upiLaunchControls.
      const launch = document.getElementById("pay-launch");
      launch.innerHTML = upiLaunchControls(data.payload, data.upiId);
      wireCopyButtons(launch);

    };

    let debounce;
    const queue = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 350); };
    amountEl.oninput = queue;
    noteEl.oninput = queue;

    refresh();
  }

  /* ---------- shell ---------- */

  const NAV = [
    ["#/dashboard", "Home"],
    ["#/pay", "UPI &amp; Scan"],
    ["#/transfer", "Transfer"],
    ["#/recharge", "Recharge &amp; Bills"],
    ["#/deposits", "Deposits"],
    ["#/cards", "Cards"],
    ["#/statement", "Statement"],
    ["#/services", "Services"],
    ["#/support", "Support"]
  ];

  function shell(route, inner) {
    app.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand"><span class="brand-mark">AB</span> AB Pay</div>
          <nav class="nav">
            ${NAV.map(([href, label]) =>
              `<a href="${href}" class="${route === href ? "active" : ""}">${label}</a>`).join("")}
          </nav>
          <div class="who">
            <button class="icon-btn bell" id="bell" aria-label="Notifications">
              ${icon("bell")}<span class="bell-dot" id="bell-dot" hidden></span>
            </button>
            <div class="meta">
              <div>${esc(state.user.name)} ${esc(state.user.surname)}</div>
              <small>${esc(state.user.upiId)}</small>
            </div>
            <div class="avatar">${esc(initials(state.user))}</div>
            <button class="icon-btn" id="signout" title="Sign out" aria-label="Sign out">
              ${icon("power")}</button>
          </div>
        </header>
        <main id="main">${inner}</main>
      </div>`;

    document.getElementById("signout").onclick = signOut;
    wireNotifications();
  }

  const loading = () => `<div class="spinner"></div>`;

  /*
   * Keeps keyboard focus inside a dialog while it is open, and hands it back
   * where it came from on close. Without this, tabbing walks out of the
   * dialog and into the page behind it, which a screen-reader or
   * keyboard-only user cannot see has happened.
   */
  function trapFocus(container, onEscape) {
    const previous = document.activeElement;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]';

    const focusable = () => [...container.querySelectorAll(selector)]
      .filter(el => el.offsetParent !== null);

    (focusable()[0] || container).focus();

    const onKey = event => {
      if (event.key === "Escape" && onEscape) return onEscape();
      if (event.key !== "Tab") return;

      const items = focusable();
      if (!items.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKey);

    return () => {
      container.removeEventListener("keydown", onKey);
      if (previous && previous.isConnected) previous.focus();
    };
  }

  /* ---------- notification centre ---------- */

  /*
   * Alerts the bank raises on its own — an autopay debit, a price rise, a
   * shortfall before a due date — are useless if the customer has to go
   * looking for them, so they surface here on every page.
   */
  async function wireNotifications() {
    const bell = document.getElementById("bell");
    const dot = document.getElementById("bell-dot");
    if (!bell) return;

    let panel = null;

    const refreshBadge = async () => {
      try {
        const { unread } = await api("/notifications");
        dot.hidden = unread === 0;
        dot.textContent = unread > 9 ? "9+" : String(unread);
      } catch { /* a badge is never worth an error */ }
    };

    const close = () => { panel?.remove(); panel = null; };

    bell.onclick = async () => {
      if (panel) return close();

      let data;
      try {
        data = await api("/notifications");
      } catch (err) {
        return toast(err.message, "err");
      }

      panel = document.createElement("div");
      panel.className = "notif-panel";
      panel.innerHTML = `
        <div class="notif-head">
          <span>Notifications</span>
          ${data.unread ? `<button class="link-btn" id="notif-all">Mark all read</button>` : ""}
        </div>
        <div class="notif-list">
          ${data.notifications.length ? data.notifications.map(n => `
            <button class="notif ${n.read ? "" : "unread"} sev-${esc(n.severity)}"
                    data-id="${n.id}" ${n.link ? `data-link="${esc(n.link)}"` : ""}>
              <div class="notif-title">${esc(n.title)}</div>
              ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ""}
              <div class="notif-at">${fmtDate(n.at)}</div>
            </button>`).join("")
            : `<div class="empty" style="padding:26px">Nothing new.</div>`}
        </div>`;
      document.body.appendChild(panel);

      const all = panel.querySelector("#notif-all");
      if (all) {
        all.onclick = async () => {
          await api("/notifications/read-all", { method: "POST" });
          close();
          refreshBadge();
        };
      }

      panel.querySelectorAll(".notif").forEach(item => {
        item.onclick = async () => {
          await api(`/notifications/${item.dataset.id}/read`, { method: "POST" });
          close();
          refreshBadge();
          if (item.dataset.link) location.hash = item.dataset.link;
        };
      });

      // Clicking anywhere else dismisses it.
      setTimeout(() => {
        document.addEventListener("click", function away(event) {
          if (panel && !panel.contains(event.target) && event.target !== bell) {
            close();
            document.removeEventListener("click", away);
          }
        });
      }, 0);
    };

    refreshBadge();
  }

  async function catalog() {
    if (!state.catalog) state.catalog = await api("/catalog");
    return state.catalog;
  }

  /* ---------- dashboard ---------- */

  async function dashboardView() {
    shell("#/dashboard", loading());
    const [data, insights, stats, radar] = await Promise.all([
      api("/dashboard"), api("/insights"), api("/analytics?days=30"), api("/radar")
    ]);

    state.user = data.user;
    state.account = data.account;

    const used = data.account.usedLimit;
    const limit = data.account.limitMonthly;
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Namaste, ${esc(data.user.name)}</h1>
        <p>${esc(data.account.type)} account · ${esc(data.user.branch || "—")}</p>
      </div>

      ${data.pendingCollects > 0 ? `
        <div class="alert-strip">
          ${icon("alert")}
          <span>You have <b>${data.pendingCollects}</b> pending payment request(s).</span>
          <a href="#/pay">Review</a>
        </div>` : ""}

      <div class="grid dash-top" style="margin-bottom:18px">
        <div class="card balance-card">
          <div class="balance-head">
            <h2>Available balance</h2>
            <button class="balance-eye" id="balance-eye"
                    aria-label="Show or hide balance"></button>
          </div>
          <div class="balance-amount" id="balance-amount"
               data-value="${esc(money(data.account.balance))}"></div>
          <div class="acct-no">A/C ${esc(data.account.number)} · IFSC ${esc(data.account.ifsc)}</div>
          <div class="acct-no">UPI ${esc(data.user.upiId)}</div>
          <div class="limit-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          <div class="limit-note">
            <span>Monthly limit used</span>
            <span>${money(used)} / ${money(limit)}</span>
          </div>
        </div>

        <div class="card">
          <h2>Quick actions</h2>
          <div class="quick-actions">
            <a class="qa" href="#/pay">${icon("scan", "icon icon-lg ico")} Scan &amp; Pay</a>
            <a class="qa" href="#/pay">${icon("transfer", "icon icon-lg ico")} UPI transfer</a>
            <a class="qa" href="#/recharge">${icon("phone", "icon icon-lg ico")} Recharge</a>
            <a class="qa" href="#/safesend">${icon("shield", "icon icon-lg ico")} Safe Send</a>
            <a class="qa" href="#/deposits">${icon("bank", "icon icon-lg ico")} Open FD</a>
          </div>
        </div>
      </div>

      <div class="grid grid-3" style="margin-bottom:18px">
        <div class="card stat">
          <h2>Deposits</h2>
          <div class="stat-value">${money(data.depositsTotal)}</div>
          <div class="stat-sub">${data.depositsCount} active FD/RD</div>
        </div>
        <div class="card stat">
          <h2>Held in Safe Send</h2>
          <div class="stat-value">${money(data.protectedHeldAmount)}</div>
          <div class="stat-sub">${data.protectedHeld} in progress</div>
        </div>
        <div class="card stat">
          <h2>Spent · 30 days</h2>
          <div class="stat-value">${money(insights.total)}</div>
          <div class="stat-sub">${insights.categories.length} categories</div>
        </div>
      </div>

      ${renderRadar(radar)}

      <div class="card" style="margin-bottom:18px">
        <div class="chart-head">
          <h2 id="trend-title">Daily spending</h2>
          <div class="range-picker">
            ${[[7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"]].map(([d, label]) =>
              `<button class="range-btn" data-days="${d}">${label}</button>`).join("")}
            <button class="range-btn" data-custom="1">Custom</button>
          </div>
        </div>

        <div class="range-custom" id="range-custom" hidden>
          <div class="field">
            <label for="r-from">From</label>
            <input id="r-from" type="date">
          </div>
          <div class="field">
            <label for="r-to">To</label>
            <input id="r-to" type="date">
          </div>
          <button class="btn btn-sm" id="r-apply">Apply</button>
        </div>

        <div class="chart-meta" id="range-meta"></div>
        <div id="chart-trend"></div>
      </div>

      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="card">
          <h2>Money in vs money out</h2>
          <div id="chart-inout"></div>
        </div>
        <div class="card">
          <h2 id="cat-title">Spending by category</h2>
          <div id="chart-categories"></div>
        </div>
      </div>`;

    wireAutopay();
    wireBalanceToggle();
    wireRangePicker(stats);
    drawDashboardCharts(stats);
  }

  /*
   * Hiding the balance is standard in Indian payment apps — people check their
   * phone in public. The choice is per-device, so localStorage is the right
   * home for it.
   */
  function wireBalanceToggle() {
    const amount = document.getElementById("balance-amount");
    const button = document.getElementById("balance-eye");
    if (!amount || !button) return;

    let hidden = false;
    try {
      hidden = localStorage.getItem("abpay_hide_balance") === "1";
    } catch {
      hidden = false;
    }

    const paint = () => {
      amount.textContent = hidden ? "••••••" : amount.dataset.value;
      button.innerHTML = icon(hidden ? "eyeOff" : "eye");
      button.setAttribute("aria-pressed", String(hidden));
    };

    button.onclick = () => {
      hidden = !hidden;
      try {
        localStorage.setItem("abpay_hide_balance", hidden ? "1" : "0");
      } catch { /* private browsing — the toggle still works for this view */ }
      paint();
    };

    paint();
  }

  /* Lets the customer re-scope every chart on the page to a period they choose. */
  function wireRangePicker(initial) {
    const meta = document.getElementById("range-meta");
    const custom = document.getElementById("range-custom");
    const buttons = [...document.querySelectorAll(".range-btn")];

    const describe = stats => {
      document.getElementById("trend-title").textContent =
        `Daily spending · ${rangeLabel(stats)}`;
      document.getElementById("cat-title").textContent =
        `Spending by category · ${rangeLabel(stats)}`;
      meta.innerHTML =
        `<span>Average <b>${money(stats.dailyAverage)}</b>/day</span>` +
        `<span>Total out <b>${money(stats.totalOut)}</b></span>` +
        `<span>Total in <b>${money(stats.totalIn)}</b></span>`;
    };

    const load = async query => {
      try {
        const stats = await api("/analytics?" + query);
        drawDashboardCharts(stats);
        describe(stats);
        return stats;
      } catch (err) {
        toast(err.message, "err");
      }
    };

    buttons.forEach(button => {
      button.onclick = () => {
        buttons.forEach(b => b.classList.toggle("active", b === button));

        if (button.dataset.custom) {
          custom.hidden = false;
          const today = new Date().toISOString().slice(0, 10);
          document.getElementById("r-to").value = today;
          document.getElementById("r-from").value =
            new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
          return;
        }
        custom.hidden = true;
        load(`days=${button.dataset.days}`);
      };
    });

    document.getElementById("r-apply").onclick = () => {
      const from = document.getElementById("r-from").value;
      const to = document.getElementById("r-to").value;
      if (!from || !to) return toast("Pick both dates.", "err");
      load(`from=${from}&to=${to}`);
    };

    // 30 days is the default the page loaded with.
    buttons.find(b => b.dataset.days === "30")?.classList.add("active");
    describe(initial);
  }

  const rangeLabel = stats =>
    stats.days <= 90 ? `last ${stats.days} days` : `${fmtDate(stats.from)} – ${fmtDate(stats.to)}`;

  /*
   * Money Radar: the recurring charges a customer has stopped noticing, the
   * ones that quietly went up, and what is about to leave the account.
   */
  function renderRadar(r) {
    const hasSubs = r.subscriptions.length > 0;
    const soon = r.commitments.filter(c =>
      new Date(c.due) <= new Date(Date.now() + r.warnDays * 864e5));

    if (!hasSubs && !soon.length) return "";

    return `
      <div class="card radar" style="margin-bottom:18px">
        <div class="chart-head">
          <h2>Money radar</h2>
          ${hasSubs ? `<div class="chart-meta">
            <span>Subscriptions <b>${r.subscriptions.length}</b></span>
            <span>Costing <b>${money(r.annualSubscriptionCost)}</b>/year</span>
          </div>` : ""}
        </div>

        ${r.shortfall > 0 ? `
          <div class="radar-alert">
            ${icon("alert")}
            <span><b>${money(r.dueSoon)} is due in the next ${r.warnDays} days</b>
            and your balance is ${money(r.balance)} — you are short
            ${money(r.shortfall)}. Top up to avoid a failed auto-debit.</span>
          </div>` : ""}

        ${(r.needsReview || []).length ? `
          <div class="radar-alert">
            ${icon("alert")}
            <div>
              <b>Autopay stopped — a price went above your approved limit</b>
              ${r.needsReview.map(m => `
                <div class="radar-rise-row">
                  ${esc(m.lastError || m.payee)}
                  <button class="link-btn" data-autopay-approve="${m.id}"
                          data-payee="${esc(m.payee)}">Approve new limit</button>
                </div>`).join("")}
            </div>
          </div>` : ""}

        ${r.priceRises.length ? `
          <div class="radar-rise">
            ${icon("alert")}
            <div>
              <b>${r.priceRises.length} subscription${
                r.priceRises.length > 1 ? "s have" : " has"} gone up</b>
              ${r.priceRises.map(s => `
                <div class="radar-rise-row">
                  ${esc(s.payee)} — ${money(s.priceRise.from)} to
                  <b>${money(s.priceRise.to)}</b>
                  (+${s.priceRise.percent}%) since ${fmtDate(s.priceRise.since)}
                </div>`).join("")}
            </div>
          </div>` : ""}

        <div class="grid grid-2" style="gap:18px">
          ${hasSubs ? `
            <div>
              <h3 class="radar-h3">Recurring payments</h3>
              ${r.subscriptions.map(s => {
                const ap = s.autopay;
                return `
                <div class="radar-row">
                  <div>
                    <button class="radar-payee link-plain"
                            data-sub="${esc(s.payee)}">${esc(s.payee)}</button>
                    <div class="radar-meta">${esc(s.cadence)} · ${s.charges} charges ·
                      next ${fmtDate(s.nextExpected)}</div>
                    ${ap ? `
                      <div class="autopay-chip ${esc(ap.status)}">
                        ${ap.status === "active"
                          ? `Autopay on · up to ${money(ap.maxAmount)}`
                          : ap.status === "paused" ? "Autopay paused"
                          : "Autopay needs review"}
                      </div>` : ""}
                  </div>
                  <div class="radar-amounts">
                    <b>${money(s.lastAmount)}</b>
                    <span class="radar-meta">${money(s.annualCost)}/yr</span>
                  </div>
                </div>`;
              }).join("")}
            </div>` : ""}

          ${soon.length ? `
            <div>
              <h3 class="radar-h3">Due in the next ${r.warnDays} days</h3>
              ${soon.map(c => `
                <div class="radar-row">
                  <div>
                    <div class="radar-payee">${esc(c.label)}</div>
                    <div class="radar-meta">${fmtDate(c.due)}${
                      c.certain ? "" : " · predicted from your history"}</div>
                  </div>
                  <b>${money(c.amount)}</b>
                </div>`).join("")}
              <div class="radar-total">
                <span>Total due</span><b>${money(r.dueSoon)}</b>
              </div>
            </div>` : ""}
        </div>
      </div>`;
  }

  /*
   * The radar card itself only opens a subscription and clears a flagged
   * mandate. Every autopay control lives inside the panel, so a row stays a
   * summary rather than a row of buttons.
   */
  function wireAutopay() {
    const card = document.querySelector(".radar");
    if (!card) return;

    card.onclick = async event => {
      const open = event.target.closest("[data-sub]");
      if (open) return openSubscription(open.dataset.sub);

      const approve = event.target.closest("[data-autopay-approve]");
      if (!approve) return;

      const answer = prompt(`New approved limit for ${approve.dataset.payee} (₹):`);
      if (answer === null) return;

      approve.disabled = true;
      try {
        const result = await api(`/autopay/${approve.dataset.autopayApprove}/limit`, {
          method: "POST", body: { maxAmount: answer }
        });
        toast(result.message, "ok");
        dashboardView();
      } catch (err) {
        toast(err.message, "err");
        approve.disabled = false;
      }
    };
  }

  /*
   * Everything about one recurring payee, with the actions a bank can
   * genuinely offer: pay the next cycle early, or stop paying them.
   */
  async function openSubscription(payee) {
    let data;
    try {
      data = await api(`/radar/subscription?payee=${encodeURIComponent(payee)}`);
    } catch (err) {
      return toast(err.message, "err");
    }

    const d = data.detected;
    const ap = data.autopay;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <div class="sub-head">
          <div>
            <h3>${esc(data.payee)}</h3>
            <div class="modal-sub">
              ${d ? `${esc(d.cadence)} · ${d.charges} charges · ${money(d.annualCost)}/yr`
                  : `${data.history.length} payment(s) on record`}
            </div>
          </div>
          <button class="icon-btn" id="sub-close" aria-label="Close">${icon("close")}</button>
        </div>

        ${data.stopped ? `
          <div class="radar-alert" style="margin-bottom:14px">
            ${icon("alert")}
            <span>Automatic payments to this payee are <b>stopped</b>.</span>
          </div>` : ""}

        ${d && d.priceRise ? `
          <div class="radar-rise" style="margin-bottom:14px">
            ${icon("alert")}
            <span>Price rose from ${money(d.priceRise.from)} to
              <b>${money(d.priceRise.to)}</b> (+${d.priceRise.percent}%)
              since ${fmtDate(d.priceRise.since)}</span>
          </div>` : ""}

        <div class="sub-stats">
          <div><span>Last charge</span><b>${money(
            d ? d.lastAmount : (data.history[0]?.amount || 0))}</b></div>
          <div><span>Paid so far</span><b>${money(data.paidToDate)}</b></div>
          <div><span>Autopay</span><b>${ap
            ? (ap.status === "active" ? "On" : esc(ap.status.replace(/_/g, " ")))
            : "Off"}</b></div>
        </div>

        ${ap && ap.status === "active" ? `
          <div class="sub-note">
            Next charge ${fmtDate(ap.nextDue)}, up to ${money(ap.maxAmount)}.
          </div>` : ""}

        <!-- Autopay is set up here and nowhere else, so the radar row stays a
             summary rather than a row of controls. -->
        ${!data.stopped ? `
          <div class="sub-autopay">
            <div class="sub-autopay-head">
              <span>Autopay</span>
              ${ap ? `<span class="autopay-chip ${esc(ap.status)}">${
                ap.status === "active" ? `On · up to ${money(ap.maxAmount)}`
                : ap.status === "paused" ? "Paused"
                : "Needs review"}</span>` : `<span class="autopay-chip off">Off</span>`}
            </div>

            ${ap && ap.status === "needs_review" && ap.lastError
              ? `<div class="sub-note" style="margin:0 0 10px">${esc(ap.lastError)}</div>` : ""}

            <div class="sub-autopay-actions">
              ${!ap
                ? `<button class="btn btn-sm" id="ap-on">Turn on autopay</button>`
                : ap.status === "active"
                  ? `<button class="btn btn-sm btn-ghost" id="ap-pause">Pause autopay</button>
                     <button class="btn btn-sm btn-ghost" id="ap-limit">Change limit</button>
                     <button class="btn btn-sm btn-danger" id="ap-off">Turn off</button>`
                  : ap.status === "needs_review"
                    ? `<button class="btn btn-sm" id="ap-limit">Approve new limit</button>
                       <button class="btn btn-sm btn-danger" id="ap-off">Turn off</button>`
                    : `<button class="btn btn-sm" id="ap-resume">Resume autopay</button>
                       <button class="btn btn-sm btn-danger" id="ap-off">Turn off</button>`}
            </div>
          </div>` : ""}

        <div class="sub-actions">
          ${ap && ap.status !== "cancelled" ? `
            <button class="btn" id="sub-advance">Pay next cycle now</button>` : ""}
          ${data.stopped
            ? `<button class="btn btn-ghost" id="sub-resume">Allow payments again</button>`
            : `<button class="btn btn-danger" id="sub-stop">Cancel subscription</button>`}
        </div>

        <!--
          A bank can refuse a merchant's debits; it cannot end the customer's
          contract with them. Saying otherwise would leave people in arrears.
        -->
        <p class="sub-disclaimer">
          Cancelling here stops <b>us paying them</b>. It does not close your account
          with ${esc(data.payee)} — cancel with them too, or you may still owe money.
        </p>

        <h4 class="sub-h4">Charge history</h4>
        <div class="sub-history">
          ${data.history.map(t => `
            <div class="sub-row">
              <span>${fmtDate(t.date)}</span>
              <span class="radar-meta">${esc(t.method)}</span>
              <b>${money(t.amount)}</b>
            </div>`).join("") || `<div class="radar-meta">No charges recorded.</div>`}
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const release = trapFocus(overlay, () => close());
    const close = () => { release(); overlay.remove(); };
    overlay.querySelector("#sub-close").onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };

    const run = async (fn, button, { reopen = true } = {}) => {
      button.disabled = true;
      try {
        const result = await fn();
        toast(result.message, "ok");
        if (result.note) setTimeout(() => toast(result.note, ""), 3200);
        close();
        await dashboardView();
        // Reopen on the fresh data so the new state is visible immediately.
        if (reopen) openSubscription(data.payee);
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };

    const on = overlay.querySelector("#ap-on");
    if (on) {
      on.onclick = () => {
        const charge = d ? d.lastAmount : (data.history[0]?.amount || 0);
        const cadence = d ? d.cadence : "monthly";

        // The ceiling is the customer's call, so it is asked for, never assumed.
        const answer = prompt(
          `Autopay for ${data.payee}\n\nCurrent charge: ${money(charge)}\n\n` +
          `We will never debit more than the limit you set here — if the price ` +
          `rises above it, autopay stops and asks you.\n\nApproved limit (₹):`,
          Math.ceil(charge * 1.2));
        if (answer === null) return;

        run(() => api("/autopay", {
          method: "POST",
          body: { payee: data.payee, amount: charge, cadence, maxAmount: answer }
        }), on);
      };
    }

    const pause = overlay.querySelector("#ap-pause");
    if (pause) pause.onclick = () =>
      run(() => api(`/autopay/${ap.id}/pause`, { method: "POST" }), pause);

    const resumeAp = overlay.querySelector("#ap-resume");
    if (resumeAp) resumeAp.onclick = () =>
      run(() => api(`/autopay/${ap.id}/resume`, { method: "POST" }), resumeAp);

    const off = overlay.querySelector("#ap-off");
    if (off) {
      off.onclick = () => {
        if (!confirm("Turn off autopay? Nothing further will be debited automatically.")) return;
        run(() => api(`/autopay/${ap.id}`, { method: "DELETE" }), off);
      };
    }

    const limit = overlay.querySelector("#ap-limit");
    if (limit) {
      limit.onclick = () => {
        const answer = prompt(
          `Approved limit for ${data.payee} (₹).\n\n` +
          `Autopay will refuse anything above this.`, ap.maxAmount);
        if (answer === null) return;
        run(() => api(`/autopay/${ap.id}/limit`, {
          method: "POST", body: { maxAmount: answer }
        }), limit);
      };
    }

    const advance = overlay.querySelector("#sub-advance");
    if (advance) {
      advance.onclick = () => {
        if (!confirm(`Pay ${money(ap.amount)} to ${data.payee} now?`)) return;
        run(() => api(`/autopay/${ap.id}/advance`, { method: "POST" }), advance);
      };
    }

    const stop = overlay.querySelector("#sub-stop");
    if (stop) {
      stop.onclick = () => {
        if (!confirm(
          `Stop all future automatic payments to ${data.payee}?\n\n` +
          `This does not cancel your subscription with them — do that separately ` +
          `or you may still owe money.`)) return;
        run(() => api("/subscriptions/stop", {
          method: "POST", body: { payee: data.payee }
        }), stop, { reopen: false });
      };
    }

    const resume = overlay.querySelector("#sub-resume");
    if (resume) {
      resume.onclick = () => run(() => api("/subscriptions/resume", {
        method: "POST", body: { payee: data.payee }
      }), resume);
    }
  }

  /* Charts are drawn after the markup lands in the DOM. */
  function drawDashboardCharts(stats) {
    if (!window.Charts) return;
    Charts.trend(document.getElementById("chart-trend"), stats.daily);
    Charts.inOut(document.getElementById("chart-inout"), stats.monthly);
    Charts.categories(document.getElementById("chart-categories"), stats.categories);
  }

  /* ---------- UPI & scan ---------- */

  async function payView() {
    shell("#/pay", loading());
    // The QR shown here is the real one — a simulated VPA cannot be scanned
    // by any real UPI app, so displaying one would just look broken.
    const [real, collects] = await Promise.all([api("/receive"), api("/upi/collect")]);
    const cat = await catalog();

    const pending = collects.requests.filter(r => r.status === "pending");

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>UPI &amp; Scan</h1>
        <p>Pay any UPI QR code, UPI ID or mobile number.
           Up to ${money(cat.upiLimit)} per transaction.</p>
      </div>

      <div class="upi-grid">
        <!-- Pay -->
        <section class="card upi-pane">
          <h2>Scan &amp; pay</h2>

          <div class="scan-stage">
            <video id="scan-video" playsinline muted></video>
            <canvas id="scan-canvas" hidden></canvas>
            <div class="scan-frame" aria-hidden="true"></div>
          </div>
          <p class="scan-hint" id="scan-hint">Starting camera…</p>

          <div class="upi-or"><span>or enter it manually</span></div>

          <form id="paste-form" class="inline-form" novalidate>
            <input id="paste-payload" placeholder="upi://pay?pa=…  ·  name@oksbi">
            <button class="btn btn-ghost" type="submit">Check</button>
          </form>

          <div id="qr-result"></div>
        </section>

        <!-- Receive -->
        <section class="card upi-pane upi-receive">
          <h2>Receive</h2>

          <div class="pay-live">
            ${icon("alert")}
            <span>${real.configured
              ? "<b>Real payment.</b> This code pays a live bank account, not the demo balance."
              : "<b>No payee configured.</b> This QR is a placeholder — set " +
                "<code>RECEIVE_UPI_ID</code> to collect real payments."}</span>
          </div>

          <div class="receive-payee">
            <div class="receive-label">Pay to</div>
            <div class="receive-name" id="qr-name">${esc(real.name)}</div>
            <div class="receive-sub">${esc(real.upiId)} · ${esc(real.bank)}</div>
          </div>

          <div class="qr-frame">
            <img id="qr-img" src="${real.dataUrl}" alt="UPI QR code for ${esc(real.upiId)}">
          </div>

          <!-- What this QR currently asks for, so the state is never a guess. -->
          <div class="qr-state" id="qr-state">
            <span class="pill">Open — payer enters the amount</span>
          </div>

          <details class="request-builder" id="request-builder">
            <summary>${icon("transfer")} Ask for a specific amount</summary>

            <div class="request-body">
              <div class="amount-input">
                <span class="amount-prefix">₹</span>
                <input id="qr-amount" type="number" step="0.01" min="0"
                       inputmode="decimal" placeholder="0.00">
              </div>

              <div class="chips">
                ${[100, 500, 1000, 2000].map(v =>
                  `<button type="button" class="chip" data-amount="${v}">₹${
                    v.toLocaleString("en-IN")}</button>`).join("")}
              </div>

              <input id="qr-note" class="request-note" maxlength="50"
                     placeholder="What is it for? (optional)">

              <div class="request-actions">
                <button class="btn btn-ghost btn-sm" id="qr-clear">Clear</button>
                <button class="btn btn-sm" id="qr-share">${icon("link")} Share request</button>
              </div>
            </div>
          </details>

          <div id="qr-launch" class="upi-launch">
            ${upiLaunchControls(real.payload, real.upiId)}
          </div>

          <p class="scan-hint">
            Standard NPCI format — Google Pay, PhonePe, Paytm and any UPI app can scan it.
            Your in-app UPI ID is <b>${esc(state.user.upiId)}</b>.
          </p>
        </section>
      </div>

      <div class="upi-grid" style="margin-top:18px">
        <section class="card upi-pane">
          <h2>Pay a UPI ID or mobile</h2>
          <div id="err"></div>
          <form id="upi-form" novalidate>
            <div class="field">
              <label for="u-to">UPI ID or 10-digit mobile</label>
              <input id="u-to" placeholder="rahulverma@abpay  ·  9812345678" required>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="u-amount">Amount (₹)</label>
                <input id="u-amount" type="number" step="0.01" min="0.01" required>
              </div>
              <div class="field">
                <label for="u-note">Note</label>
                <input id="u-note" placeholder="e.g. Dinner split">
              </div>
            </div>
            <button class="btn btn-block" type="submit">Pay</button>
          </form>
        </section>

        <section class="card upi-pane">
          <h2>Request money</h2>
          <div id="err2"></div>
          <form id="collect-form" novalidate>
            <div class="field">
              <label for="c-from">Request from (AB Pay UPI ID)</label>
              <input id="c-from" placeholder="rahulverma@abpay" required>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="c-amount">Amount (₹)</label>
                <input id="c-amount" type="number" step="0.01" min="0.01" required>
              </div>
              <div class="field">
                <label for="c-note">Note</label>
                <input id="c-note" placeholder="Reason">
              </div>
            </div>
            <button class="btn btn-ghost btn-block" type="submit">Send request</button>
          </form>

          <div class="upi-pending">
            <div class="upi-pending-head">
              Pending requests
              ${pending.length ? `<span class="pill pill-amber">${pending.length}</span>` : ""}
            </div>
            <div id="collect-list">${renderCollects(collects.requests)}</div>
          </div>
        </section>
      </div>`;

    /* --- receive: the payment-request builder --- */
    const amountEl = document.getElementById("qr-amount");
    const noteEl = document.getElementById("qr-note");
    const stateEl = document.getElementById("qr-state");

    /*
     * Rebuilds the QR from the current amount and note. The code updates as
     * you type — there is no "apply" step to forget, and the badge under it
     * always says what the QR is currently asking for.
     */
    const rebuild = async () => {
      const amount = Number(amountEl.value);
      const note = noteEl.value.trim();

      const query = new URLSearchParams();
      if (amount > 0) query.set("amount", amount);
      if (note) query.set("note", note);

      const fresh = await api("/receive?" + query.toString());

      document.getElementById("qr-img").src = fresh.dataUrl;
      const launch = document.getElementById("qr-launch");
      launch.innerHTML = upiLaunchControls(fresh.payload, fresh.upiId);
      wireCopyButtons(launch);

      stateEl.innerHTML = amount > 0
        ? `<span class="pill pill-green">Asking for ${esc(money(amount))}</span>` +
          (note ? `<span class="qr-state-note">${esc(note)}</span>` : "")
        : `<span class="pill">Open — payer enters the amount</span>`;

      return { fresh, amount, note };
    };

    let rebuildTimer;
    const queueRebuild = () => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuild, 350);
    };
    amountEl.oninput = queueRebuild;
    noteEl.oninput = queueRebuild;

    document.querySelector("#request-builder .chips").onclick = event => {
      const chip = event.target.closest("[data-amount]");
      if (!chip) return;
      amountEl.value = chip.dataset.amount;
      rebuild();
    };

    document.getElementById("qr-clear").onclick = event => {
      event.preventDefault();
      amountEl.value = "";
      noteEl.value = "";
      rebuild();
      toast("QR is open again — the payer chooses the amount", "ok");
    };

    /*
     * Shares a link to the public payment page rather than the raw upi:// text,
     * so whoever receives it gets a page with the QR, the name and the amount —
     * readable on a desktop as well as a phone.
     */
    document.getElementById("qr-share").onclick = async event => {
      event.preventDefault();
      const amount = Number(amountEl.value);
      const note = noteEl.value.trim();

      const query = new URLSearchParams();
      if (amount > 0) query.set("amount", amount);
      if (note) query.set("note", note);

      const link = `${location.origin}/#/receive${
        query.toString() ? "?" + query.toString() : ""}`;
      const title = amount > 0
        ? `Pay ${money(amount)} to ${real.name}`
        : `Pay ${real.name}`;

      if (navigator.share) {
        try {
          await navigator.share({ title, text: title, url: link });
          return;
        } catch {
          // Cancelled or unsupported — fall through to copying.
        }
      }
      try {
        await navigator.clipboard.writeText(link);
        toast("Payment request link copied", "ok");
      } catch {
        toast(link, "");
      }
    };

    /* --- scan / paste --- */
    document.getElementById("paste-form").onsubmit = event => {
      event.preventDefault();
      resolveAndConfirm(document.getElementById("paste-payload").value.trim());
    };

    /* --- pay --- */
    document.getElementById("upi-form").onsubmit = async event => {
      event.preventDefault();
      const to = document.getElementById("u-to").value.trim();
      const amount = document.getElementById("u-amount").value;
      const note = document.getElementById("u-note").value;

      try {
        const isMobile = /^[6-9]\d{9}$/.test(to);
        const path = isMobile ? "/upi/pay-mobile" : "/upi/pay";
        const base = isMobile ? { mobile: to, amount, note } : { vpa: to, amount, note };

        let result;
        try {
          result = await payWithPin(path, base, "Confirm UPI payment");
        } catch (err) {
          if (err.status !== 409 || !err.payload?.duplicate) throw err;
          if (!confirm(err.message)) return;
          result = await payWithPin(path, { ...base, confirmDuplicate: true },
            "Confirm UPI payment");
        }
        if (!result) return;
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        location.hash = "#/dashboard";
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    /* --- request --- */
    document.getElementById("collect-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/upi/collect", {
          method: "POST",
          body: {
            fromUpi: document.getElementById("c-from").value.trim(),
            amount: document.getElementById("c-amount").value,
            note: document.getElementById("c-note").value
          }
        });
        toast(result.message, "ok");
        payView();
      } catch (err) {
        document.getElementById("err2").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    document.getElementById("collect-list").onclick = async event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      button.disabled = true;

      try {
        const action = button.dataset.action;
        const result = action === "pay"
          ? await payWithPin(`/upi/collect/${button.dataset.id}/pay`, {}, "Approve request")
          : await api(`/upi/collect/${button.dataset.id}/decline`, { method: "POST" });

        if (!result) { button.disabled = false; return; }
        toast(result.message, "ok");
        payView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };

    wireCopyButtons(document.getElementById("qr-launch"));
    startScanner();
  }

  function renderCollects(requests) {
    const pending = requests.filter(r => r.status === "pending");
    if (!pending.length) {
      return `<div class="empty" style="padding:20px">No pending requests.</div>`;
    }
    return pending.map(r => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div class="ss-amount">${money(r.amount)}</div>
            <div class="ss-meta">
              ${r.role === "payer" ? "Requested by" : "Requested from"} ${esc(r.counterparty)}
              ${r.note ? " · " + esc(r.note) : ""}
            </div>
          </div>
          <span class="pill pill-amber">Pending</span>
        </div>
        ${r.role === "payer" ? `
          <div class="ss-actions">
            <button class="btn btn-sm" data-action="pay" data-id="${r.id}">Pay</button>
            <button class="btn btn-sm btn-danger" data-action="decline" data-id="${r.id}">
              Decline</button>
          </div>` : ""}
      </div>`).join("");
  }

  function startScanner() {
    const video = document.getElementById("scan-video");
    const canvas = document.getElementById("scan-canvas");
    const hint = document.getElementById("scan-hint");
    if (!video) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "environment" } })
      .then(stream => {
        scanner.stream = stream;
        video.srcObject = stream;
        video.play();
        hint.textContent = "Point the camera at any UPI QR code.";
        tick();
      })
      .catch(() => {
        hint.textContent = "Camera unavailable — paste a UPI code below instead.";
        video.style.display = "none";
      });

    function tick() {
      if (!scanner.stream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR ? window.jsQR(image.data, image.width, image.height) : null;

        if (found && found.data) {
          stopScanner();
          hint.textContent = "QR detected.";
          resolveAndConfirm(found.data);
          return;
        }
      }
      scanner.raf = requestAnimationFrame(tick);
    }
  }

  function stopScanner() {
    if (scanner.raf) cancelAnimationFrame(scanner.raf);
    if (scanner.stream) scanner.stream.getTracks().forEach(track => track.stop());
    scanner = { stream: null, raf: null };
  }

  /* Shows who would be paid and asks for confirmation before moving money. */
  async function resolveAndConfirm(payload) {
    const box = document.getElementById("qr-result");
    if (!payload) return toast("Scan or paste a UPI code first.", "err");

    try {
      const info = await api("/upi/resolve", { method: "POST", body: { payload } });
      if (info.isSelf) {
        box.innerHTML = `<div class="form-error">That is your own UPI ID.</div>`;
        return;
      }

      box.innerHTML = `
        <div class="confirm-box">
          <div class="confirm-label">Confirm payment</div>
          <div class="confirm-name">${esc(info.name)}</div>
          <div class="confirm-sub">
            ${esc(info.vpa || info.account)}
            ${info.verified
              ? `<span class="pill pill-green" style="margin-left:6px">AB Pay verified</span>`
              : `<span class="pill pill-amber" style="margin-left:6px">Other bank</span>`}
          </div>
          ${info.note ? `<div class="confirm-sub">${esc(info.note)}</div>` : ""}
          ${info.amount
            ? `<div class="confirm-amount">${money(info.amount)}</div>`
            : `<div class="field" style="margin-top:12px">
                 <label for="qr-pay-amount">Amount (₹)</label>
                 <input id="qr-pay-amount" type="number" step="0.01" min="0.01">
               </div>`}
          <button class="btn btn-block" id="qr-confirm" style="margin-top:13px">
            Pay ${info.amount ? money(info.amount) : "now"}
          </button>
        </div>`;

      document.getElementById("qr-confirm").onclick = async event => {
        event.target.disabled = true;
        try {
          const amountField = document.getElementById("qr-pay-amount");
          const result = await payWithPin("/upi/pay", {
            payload,
            amount: amountField ? amountField.value : undefined
          }, "Confirm UPI payment");

          if (!result) { event.target.disabled = false; return; }
          toast(`${result.message} Balance ${money(result.balance)}`, "ok");
          location.hash = "#/dashboard";
        } catch (err) {
          toast(err.message, "err");
          event.target.disabled = false;
        }
      };
    } catch (err) {
      box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
  }

  /* ---------- transfer ---------- */

  async function transferView() {
    const tab = location.hash === "#/safesend" ? "safe" : "bank";
    shell("#/transfer", loading());

    const [{ payees }, { payments }] = await Promise.all([
      api("/payees"), api("/safesend")
    ]);

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Fund transfer</h1>
        <p>Send to any Indian bank account — the person does not need an AB Pay account.</p>
      </div>

      <div class="tabs" role="tablist">
        <button class="tab ${tab === "bank" ? "active" : ""}" data-tab="bank" role="tab">
          ${icon("transfer")} Bank transfer</button>
        <button class="tab ${tab === "safe" ? "active" : ""}" data-tab="safe" role="tab">
          ${icon("shield")} Safe Send</button>
      </div>

      <section id="tab-bank" ${tab === "bank" ? "" : "hidden"}>
        <div class="grid grid-2">
          <div class="card">
            <h2>New transfer</h2>
            <div id="err"></div>
            <form id="transfer-form" novalidate>
              <div class="field">
                <label for="toAccount">Beneficiary account number</label>
                <input id="toAccount" placeholder="501110000002 or any bank account" required>
                <div id="verify" class="verify-note"></div>
              </div>
              <div class="field" id="ifsc-field" hidden>
                <label for="ifsc">Beneficiary IFSC</label>
                <input id="ifsc" placeholder="HDFC0001234" maxlength="11"
                       style="text-transform:uppercase">
              </div>
              <div class="field" id="benef-field" hidden>
                <label for="benefName">Beneficiary name</label>
                <input id="benefName" placeholder="As on their bank account">
              </div>
              ${payees.length ? `
                <div class="field">
                  <label for="payee">Or pick a saved beneficiary</label>
                  <select id="payee">
                    <option value="">— choose —</option>
                    ${payees.filter(p => p.account_number).map(p =>
                      `<option value="${esc(p.account_number)}"
                               data-ifsc="${esc(p.ifsc || "")}"
                               data-name="${esc(p.name)}">${esc(p.name)} · ${
                        esc(p.account_number)}</option>`).join("")}
                  </select>
                </div>` : ""}
              <div class="field-row">
                <div class="field">
                  <label for="amount">Amount (₹)</label>
                  <input id="amount" type="number" step="0.01" min="0.01" required>
                </div>
                <div class="field">
                  <label for="mode">Mode</label>
                  <select id="mode">
                    <option value="IMPS">IMPS — instant</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS — ₹2 lakh+</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label for="description">Remarks</label>
                <input id="description" placeholder="e.g. Rent for April">
              </div>
              <div class="field">
                <label style="display:flex;gap:8px;align-items:center;font-weight:500">
                  <input type="checkbox" id="savePayee" style="width:auto">
                  Save as beneficiary
                </label>
              </div>
              <button class="btn btn-block" type="submit">Transfer</button>
            </form>
          </div>

          <div class="grid" style="align-content:start">
            <div class="card">
              <h2>Before you send</h2>
              <p style="color:var(--muted);font-size:0.88rem;line-height:1.65;margin:0 0 14px">
                A transfer is immediate and cannot be reversed. If you are paying someone
                you do not know — an OLX or marketplace seller, a private ad — use
                <b style="color:var(--text)">Safe Send</b> instead. Your money is held by
                the bank and released only when you confirm you got what you paid for.
              </p>
              <button class="btn btn-ghost btn-sm" data-tab="safe">
                ${icon("shield")} Use Safe Send instead</button>
            </div>

            <div class="card">
              <h2>Saved beneficiaries</h2>
              <div id="payee-list">
                ${payees.length === 0
                  ? `<div class="empty" style="padding:20px">None saved yet.</div>`
                  : payees.map(p => `
                      <div class="ss-item">
                        <div class="ss-top">
                          <div>
                            <div style="font-weight:600">${esc(p.name)}</div>
                            <div class="ss-meta">${esc(p.account_number || p.upi_id)}${
                              p.ifsc ? " · " + esc(p.ifsc) : ""}</div>
                          </div>
                          <button class="btn btn-sm btn-danger" data-id="${p.id}">Remove</button>
                        </div>
                      </div>`).join("")}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="tab-safe" ${tab === "safe" ? "" : "hidden"}>
        <div class="feature-banner">
          ${icon("shield", "icon icon-lg ico")}
          <div>
            <h3>Your money waits with the bank, not with them</h3>
            <p>
              UPI made paying instant — and irreversible. Every bank warns you not to pay
              someone you do not know, then offers no way to do it safely. Safe Send does:
              the amount leaves your balance and is <b>held by AB Pay</b>. The seller can
              see the money is committed but cannot touch it. You release it once you have
              what you paid for — and if you never do, it is refunded automatically when
              the window closes.
            </p>
          </div>
        </div>

        <div class="grid grid-2">
          <div class="card" style="align-self:start">
            <h2>New protected payment</h2>
            <div id="ss-err"></div>
            <form id="ss-form" novalidate>
              <div class="field">
                <label for="ss-account">Seller's AB Pay account number</label>
                <input id="ss-account" placeholder="501110000002" required>
              </div>
              <div class="field">
                <label for="ss-amount">Amount (₹)</label>
                <input id="ss-amount" type="number" step="0.01" min="0.01" required>
              </div>
              <div class="field">
                <label for="ss-desc">What are you paying for?</label>
                <input id="ss-desc" placeholder="e.g. Used iPhone from OLX">
              </div>
              <div class="field">
                <label for="ss-days">Auto-refund if not released within</label>
                <select id="ss-days">
                  <option value="3">3 days</option>
                  <option value="7" selected>7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </select>
              </div>
              <button class="btn btn-block" type="submit">Hold funds safely</button>
            </form>
            <p style="color:var(--muted);font-size:0.8rem;margin:12px 0 0;line-height:1.55">
              Escrow needs both sides on our books, so Safe Send works between AB Pay
              accounts. Use a bank transfer for anyone else.
            </p>
          </div>

          <div class="card">
            <h2>Your protected payments</h2>
            <div id="ss-list">${renderSafeSendList(payments)}</div>
          </div>
        </div>
      </section>`;

    /* --- tabs --- */
    const showTab = which => {
      document.getElementById("tab-bank").hidden = which !== "bank";
      document.getElementById("tab-safe").hidden = which !== "safe";
      document.querySelectorAll(".tab").forEach(t =>
        t.classList.toggle("active", t.dataset.tab === which));
    };
    document.querySelectorAll("[data-tab]").forEach(button => {
      button.onclick = () => showTab(button.dataset.tab);
    });

    /* --- beneficiary lookup: is this account ours? --- */
    const accountEl = document.getElementById("toAccount");
    const ifscField = document.getElementById("ifsc-field");
    const benefField = document.getElementById("benef-field");
    const verifyEl = document.getElementById("verify");

    let verifyTimer;
    const verify = async () => {
      const value = accountEl.value.trim();
      if (value.length < 6) {
        verifyEl.textContent = "";
        ifscField.hidden = benefField.hidden = true;
        return;
      }
      try {
        const info = await api("/transfer/verify", {
          method: "POST", body: { toAccount: value }
        });
        if (info.internal) {
          verifyEl.innerHTML = info.isSelf
            ? `<span class="verify-warn">That is your own account.</span>`
            : `<span class="verify-ok">${esc(info.name)} · ${esc(info.ifsc)}</span>`;
          ifscField.hidden = benefField.hidden = true;
        } else {
          verifyEl.innerHTML =
            `<span class="verify-note-text">Not an AB Pay account — ` +
            `add the IFSC and we will send it to their bank.</span>`;
          ifscField.hidden = benefField.hidden = false;
        }
      } catch {
        verifyEl.textContent = "";
      }
    };
    accountEl.oninput = () => { clearTimeout(verifyTimer); verifyTimer = setTimeout(verify, 350); };

    const payeeSelect = document.getElementById("payee");
    if (payeeSelect) {
      payeeSelect.onchange = () => {
        const option = payeeSelect.selectedOptions[0];
        if (!payeeSelect.value) return;
        accountEl.value = payeeSelect.value;
        if (option.dataset.ifsc) document.getElementById("ifsc").value = option.dataset.ifsc;
        if (option.dataset.name) document.getElementById("benefName").value = option.dataset.name;
        verify();
      };
    }

    document.getElementById("transfer-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button[type=submit]");
      button.disabled = true;
      const body = {
        toAccount: accountEl.value.trim(),
        ifsc: document.getElementById("ifsc").value.trim(),
        payeeName: document.getElementById("benefName").value.trim(),
        amount: document.getElementById("amount").value,
        mode: document.getElementById("mode").value,
        description: document.getElementById("description").value,
        savePayee: document.getElementById("savePayee").checked
      };

      const send = async () => api("/transfer", { method: "POST", body });

      try {
        let result;
        try {
          result = await send();
        } catch (err) {
          // A near-identical payment moments ago is usually a double tap.
          if (err.status !== 409 || !err.payload?.duplicate) throw err;
          if (!confirm(err.message)) { button.disabled = false; return; }
          body.confirmDuplicate = true;
          result = await send();
        }
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        location.hash = "#/dashboard";
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };

    document.getElementById("payee-list").onclick = async event => {
      const button = event.target.closest("button[data-id]");
      if (!button) return;
      await api(`/payees/${button.dataset.id}`, { method: "DELETE" });
      toast("Beneficiary removed", "ok");
      transferView();
    };

    /* --- Safe Send --- */
    document.getElementById("ss-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const result = await api("/safesend", {
          method: "POST",
          body: {
            toAccount: document.getElementById("ss-account").value.trim(),
            amount: document.getElementById("ss-amount").value,
            description: document.getElementById("ss-desc").value,
            days: document.getElementById("ss-days").value
          }
        });
        toast(result.message, "ok");
        location.hash = "#/safesend";
        transferView();
      } catch (err) {
        document.getElementById("ss-err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };

    document.getElementById("ss-list").onclick = async event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(`/safesend/${button.dataset.id}/${button.dataset.action}`,
          { method: "POST" });
        toast(result.message, "ok");
        transferView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }


  /* ---------- recharge & bills ---------- */

  async function rechargeView() {
    shell("#/recharge", loading());
    const [cat, { bills }] = await Promise.all([catalog(), api("/bills")]);

    const operators = Object.keys(cat.mobilePlans);
    const categories = [...new Set(cat.billers.map(b => b.category))];

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Recharge &amp; bill payments</h1>
        <p>Mobile, DTH, electricity, gas, broadband and more.</p>
      </div>

      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="card">
          <h2>Mobile recharge</h2>
          <div id="err-m"></div>
          <div class="field">
            <label for="m-operator">Operator</label>
            <select id="m-operator">
              ${operators.map(o => `<option>${esc(o)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="m-number">Mobile number</label>
            <input id="m-number" inputmode="numeric" maxlength="10"
                   value="${esc(state.user.mobile)}">
          </div>
          <div id="plan-list"></div>
        </div>

        <div class="card">
          <h2>Pay a bill</h2>
          <div id="err-b"></div>
          <form id="bill-form" novalidate>
            <div class="field">
              <label for="b-category">Category</label>
              <select id="b-category">
                ${categories.map(c => `<option>${esc(c)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="b-biller">Biller</label>
              <select id="b-biller"></select>
            </div>
            <div class="field">
              <label for="b-consumer" id="b-consumer-label">Consumer number</label>
              <input id="b-consumer" required>
            </div>
            <div class="field">
              <label for="b-amount">Amount (₹)</label>
              <input id="b-amount" type="number" step="0.01" min="0.01" required>
            </div>
            <button class="btn btn-block" type="submit">Pay bill</button>
          </form>

          <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
            <h2>DTH recharge</h2>
            <form id="dth-form" novalidate>
              <div class="field-row">
                <div class="field">
                  <label for="d-operator">Operator</label>
                  <select id="d-operator">
                    ${cat.dthOperators.map(o => `<option>${esc(o)}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="d-amount">Amount (₹)</label>
                  <input id="d-amount" type="number" step="0.01" min="0.01" required>
                </div>
              </div>
              <div class="field">
                <label for="d-number">Subscriber ID</label>
                <input id="d-number" required>
              </div>
              <button class="btn btn-block btn-ghost" type="submit">Recharge DTH</button>
            </form>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Bill reminders</h2>
        <div id="bill-list">${renderBills(bills)}</div>
      </div>`;

    /* --- mobile plans --- */
    const renderPlans = () => {
      const operator = document.getElementById("m-operator").value;
      document.getElementById("plan-list").innerHTML = cat.mobilePlans[operator].map(p => `
        <div class="plan" data-plan="${esc(p.id)}">
          <div>
            <div style="font-weight:600">${money(p.amount)}</div>
            <div class="ss-meta">${esc(p.validity)} · ${esc(p.detail)}</div>
          </div>
          <button class="btn btn-sm" data-plan="${esc(p.id)}">Recharge</button>
        </div>`).join("");
    };
    document.getElementById("m-operator").onchange = renderPlans;
    renderPlans();

    document.getElementById("plan-list").onclick = async event => {
      const button = event.target.closest("button[data-plan]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api("/recharge", {
          method: "POST",
          body: {
            type: "mobile",
            operator: document.getElementById("m-operator").value,
            number: document.getElementById("m-number").value.trim(),
            planId: button.dataset.plan
          }
        });
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        rechargeView();
      } catch (err) {
        document.getElementById("err-m").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };

    /* --- billers --- */
    const renderBillers = () => {
      const category = document.getElementById("b-category").value;
      const list = cat.billers.filter(b => b.category === category);
      document.getElementById("b-biller").innerHTML =
        list.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
      document.getElementById("b-consumer-label").textContent = list[0]?.label || "Consumer number";
    };
    document.getElementById("b-category").onchange = renderBillers;
    renderBillers();

    document.getElementById("bill-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/billpay", {
          method: "POST",
          body: {
            billerId: document.getElementById("b-biller").value,
            consumerNumber: document.getElementById("b-consumer").value.trim(),
            amount: document.getElementById("b-amount").value
          }
        });
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        rechargeView();
      } catch (err) {
        document.getElementById("err-b").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    document.getElementById("dth-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/recharge", {
          method: "POST",
          body: {
            type: "dth",
            operator: document.getElementById("d-operator").value,
            number: document.getElementById("d-number").value.trim(),
            amount: document.getElementById("d-amount").value
          }
        });
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        rechargeView();
      } catch (err) {
        toast(err.message, "err");
      }
    };

    document.getElementById("bill-list").onclick = async event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      button.disabled = true;
      try {
        if (button.dataset.action === "pay") {
          const result = await api(`/bills/${button.dataset.id}/pay`, { method: "POST" });
          toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        } else {
          await api(`/bills/${button.dataset.id}`, { method: "DELETE" });
          toast("Reminder removed", "ok");
        }
        rechargeView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }

  function renderBills(bills) {
    if (!bills.length) {
      return `<div class="empty">${icon("receipt", "icon icon-lg")}No bill reminders.</div>`;
    }
    return bills.map(b => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div style="font-weight:600">${esc(b.title)}</div>
            <div class="ss-meta">${esc(b.provider)}${
              b.reference ? " · " + esc(b.reference) : ""} · Due ${fmtDate(b.dueDate)}</div>
          </div>
          <div style="text-align:right">
            <div class="ss-amount">${money(b.amount)}</div>
            ${b.status === "paid"
              ? `<span class="pill pill-green">Paid</span>`
              : `<span class="pill pill-amber">Pending</span>`}
          </div>
        </div>
        ${b.status === "pending" ? `
          <div class="ss-actions">
            <button class="btn btn-sm" data-action="pay" data-id="${b.id}">Pay now</button>
            <button class="btn btn-sm btn-danger" data-action="delete" data-id="${b.id}">
              Remove</button>
          </div>` : ""}
      </div>`).join("");
  }

  /* ---------- deposits ---------- */

  async function depositsView() {
    shell("#/deposits", loading());
    const data = await api("/deposits");

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Deposits</h1>
        <p>Fixed and recurring deposits at AB Pay card rates.</p>
      </div>

      <div class="grid grid-2">
        <div class="card" style="align-self:start">
          <h2>Open a deposit</h2>
          <div id="err"></div>
          <form id="dep-form" novalidate>
            <div class="field">
              <label for="d-kind">Type</label>
              <select id="d-kind">
                <option value="FD">Fixed Deposit — one-time</option>
                <option value="RD">Recurring Deposit — monthly</option>
              </select>
            </div>
            <div class="field">
              <label for="d-amount" id="d-amount-label">Deposit amount (₹)</label>
              <input id="d-amount" type="number" step="1" min="1000" value="100000" required>
            </div>
            <div class="field">
              <label for="d-tenure">Tenure</label>
              <select id="d-tenure"></select>
            </div>
            <div id="quote" class="quote-box"></div>
            <button class="btn btn-block" type="submit" style="margin-top:14px">Open deposit</button>
          </form>
        </div>

        <div class="card">
          <h2>Your deposits</h2>
          <div id="dep-list">${renderDeposits(data.deposits)}</div>
          <h2 style="margin-top:20px">Card rates</h2>
          <div class="table-scroll">
            <table class="table">
              <thead><tr><th>Tenure</th><th class="num">FD rate</th><th class="num">RD rate</th></tr></thead>
              <tbody>
                ${data.fdRates.map(f => {
                  const rd = data.rdRates.find(r => r.months === f.months);
                  return `<tr>
                    <td>${f.months} months</td>
                    <td class="num">${f.rate.toFixed(2)}%</td>
                    <td class="num">${rd ? rd.rate.toFixed(2) + "%" : "—"}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
          <p style="margin:11px 0 0;color:var(--muted);font-size:0.75rem">
            FD compounded quarterly · RD compounded monthly · 1% penalty on premature closure.
          </p>
        </div>
      </div>`;

    const kindEl = document.getElementById("d-kind");
    const tenureEl = document.getElementById("d-tenure");
    const amountEl = document.getElementById("d-amount");

    const fillTenures = () => {
      const rates = kindEl.value === "RD" ? data.rdRates : data.fdRates;
      tenureEl.innerHTML = rates.map(r =>
        `<option value="${r.months}">${r.months} months — ${r.rate.toFixed(2)}%</option>`).join("");
      document.getElementById("d-amount-label").textContent =
        kindEl.value === "RD" ? "Monthly instalment (₹)" : "Deposit amount (₹)";
      amountEl.value = kindEl.value === "RD" ? 5000 : 100000;
    };

    const quote = async () => {
      try {
        const q = await api("/deposits/quote", {
          method: "POST",
          body: { kind: kindEl.value, amount: amountEl.value, tenureMonths: tenureEl.value }
        });
        document.getElementById("quote").innerHTML = `
          <div class="quote-row"><span>Rate</span><b>${q.rate.toFixed(2)}% p.a.</b></div>
          <div class="quote-row"><span>Total invested</span><b>${money(q.invested)}</b></div>
          <div class="quote-row"><span>Interest earned</span>
            <b class="amount-in">+${money(q.interest)}</b></div>
          <div class="quote-row total"><span>Maturity value</span>
            <b>${money(q.maturityAmount)}</b></div>`;
      } catch {
        document.getElementById("quote").innerHTML = "";
      }
    };

    kindEl.onchange = () => { fillTenures(); quote(); };
    tenureEl.onchange = quote;
    amountEl.oninput = quote;
    fillTenures();
    quote();

    document.getElementById("dep-form").onsubmit = async event => {
      event.preventDefault();
      const button = event.target.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const result = await api("/deposits", {
          method: "POST",
          body: { kind: kindEl.value, amount: amountEl.value, tenureMonths: tenureEl.value }
        });
        toast(`${result.message} Balance ${money(result.balance)}`, "ok");
        depositsView();
      } catch (err) {
        document.getElementById("err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
        button.disabled = false;
      }
    };

    document.getElementById("dep-list").onclick = async event => {
      const button = event.target.closest("button[data-id]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(`/deposits/${button.dataset.id}/close`, { method: "POST" });
        toast(result.message, "ok");
        depositsView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }

  function renderDeposits(deposits) {
    const active = deposits.filter(d => d.status === "active");
    if (!active.length) {
      return `<div class="empty">${icon("bank", "icon icon-lg")}No active deposits.</div>`;
    }
    return active.map(d => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div class="ss-amount">${money(d.principal)}${
              d.kind === "RD" ? " <span style='font-size:0.75rem'>/ month</span>" : ""}</div>
            <div class="ss-meta">${d.kind} · ${d.tenureMonths} months @ ${d.rate.toFixed(2)}%</div>
            <div class="ss-meta">Matures ${fmtDate(d.maturityAt)} · pays <b>${
              money(d.maturityAmount)}</b></div>
          </div>
          <span class="pill pill-green">Active</span>
        </div>
        <div class="ss-actions">
          <button class="btn btn-sm btn-danger" data-id="${d.id}">Close early</button>
        </div>
      </div>`).join("");
  }

  /* ---------- cards ---------- */

  /* Which card the hero panel is showing. Survives a re-render of the page. */
  let selectedCardId = null;

  async function cardsView() {
    shell("#/cards", loading());
    const data = await api("/card");

    const cards = data.cards;
    const own = cards.find(c => c.isOwn);
    const selected = cards.find(c => c.id === selectedCardId) || own;
    selectedCardId = selected.id;

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Cards</h1>
        <p>Your AB Pay card, plus every other card you carry — in one place.</p>
      </div>

      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="card" style="align-self:start">
          <h2>${selected.isOwn ? "Issued by AB Pay" : "Saved card"}</h2>
          <div id="hero-card">${renderHeroCard(selected)}</div>
          <div id="hero-actions">${renderHeroActions(selected)}</div>
        </div>

        <div class="card" id="detail-panel">${renderCardDetail(selected)}</div>
      </div>

      <div class="card">
        <div class="chart-head">
          <h2>Your wallet</h2>
          <button class="btn btn-sm" id="add-card-btn">Add a card</button>
        </div>
        <p style="color:var(--muted);font-size:0.83rem;margin:0 0 16px;line-height:1.6">
          Select a card to see its details above. Only the last four digits are stored —
          the full number is checked in your browser and never sent to us, and we never
          ask for a CVV.
        </p>

        <div id="add-card" hidden>
          <form id="card-form" class="wallet-form" novalidate>
            <div id="card-err"></div>
            <div class="field-row">
              <div class="field">
                <label for="k-kind">Card type</label>
                <select id="k-kind">
                  <option value="credit">Credit card</option>
                  <option value="debit">Debit card</option>
                </select>
              </div>
              <div class="field">
                <label for="k-issuer">Bank / issuer</label>
                <input id="k-issuer" placeholder="HDFC Bank" required>
              </div>
            </div>
            <div class="field">
              <label for="k-number">Card number</label>
              <input id="k-number" inputmode="numeric" autocomplete="off"
                     placeholder="Only the last 4 digits are saved" required>
              <div id="k-detect" class="verify-note"></div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="k-expiry">Expiry (MM/YY)</label>
                <input id="k-expiry" inputmode="numeric" maxlength="5"
                       placeholder="09/29" required>
              </div>
              <div class="field">
                <label for="k-label">Nickname (optional)</label>
                <input id="k-label" placeholder="e.g. Travel card">
              </div>
            </div>
            <div class="wallet-actions">
              <button class="btn btn-ghost" type="button" id="cancel-card">Cancel</button>
              <button class="btn" type="submit">Add card</button>
            </div>
          </form>
        </div>

        <div id="wallet">${renderWallet(cards, selected.id)}</div>
      </div>`;

    wireCardActions(data);

    /* --- selecting a card swaps the hero panel --- */
    document.getElementById("wallet").onclick = async event => {
      const remove = event.target.closest("button[data-remove]");
      if (remove) {
        remove.disabled = true;
        try {
          const result = await api(`/card/${remove.dataset.remove}`, { method: "DELETE" });
          // Fall back to the issued card if the selected one was just removed.
          if (Number(remove.dataset.remove) === selectedCardId) selectedCardId = null;
          toast(result.message, "ok");
          cardsView();
        } catch (err) {
          toast(err.message, "err");
          remove.disabled = false;
        }
        return;
      }

      const tile = event.target.closest("[data-card-id]");
      if (!tile) return;
      selectedCardId = Number(tile.dataset.cardId);
      cardsView();
    };

    /* --- add-card form --- */
    const panel = document.getElementById("add-card");
    document.getElementById("add-card-btn").onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById("k-issuer").focus();
    };
    document.getElementById("cancel-card").onclick = () => { panel.hidden = true; };

    const numberEl = document.getElementById("k-number");
    const detectEl = document.getElementById("k-detect");

    numberEl.oninput = () => {
      const digits = numberEl.value.replace(/\D/g, "").slice(0, 19);
      numberEl.value = digits.replace(/(.{4})/g, "$1 ").trim();

      if (digits.length < 4) { detectEl.textContent = ""; return; }
      const network = detectNetwork(digits);
      detectEl.innerHTML = digits.length >= 12
        ? (luhnValid(digits)
            ? `<span class="verify-ok">${esc(network)} · ending ${esc(digits.slice(-4))}</span>`
            : `<span class="verify-warn">That card number is not valid.</span>`)
        : `<span class="verify-note-text">${esc(network)}</span>`;
    };

    const expiryEl = document.getElementById("k-expiry");
    expiryEl.oninput = () => {
      const digits = expiryEl.value.replace(/\D/g, "").slice(0, 4);
      expiryEl.value = digits.length > 2
        ? digits.slice(0, 2) + "/" + digits.slice(2)
        : digits;
    };

    document.getElementById("card-form").onsubmit = async event => {
      event.preventDefault();
      const fail = message => {
        document.getElementById("card-err").innerHTML =
          `<div class="form-error">${esc(message)}</div>`;
      };

      const digits = numberEl.value.replace(/\D/g, "");
      if (digits.length < 12 || !luhnValid(digits)) {
        return fail("Enter a valid card number.");
      }

      const [mm, yy] = expiryEl.value.split("/");
      if (!mm || !yy || Number(mm) < 1 || Number(mm) > 12) {
        return fail("Enter the expiry as MM/YY.");
      }

      try {
        /*
         * Only the last four digits leave the browser. The full number was
         * used for the Luhn check above and is discarded here.
         */
        const result = await api("/card", {
          method: "POST",
          body: {
            kind: document.getElementById("k-kind").value,
            issuer: document.getElementById("k-issuer").value,
            label: document.getElementById("k-label").value,
            last4: digits.slice(-4),
            network: detectNetwork(digits),
            expiry: `20${yy}-${mm.padStart(2, "0")}`
          }
        });
        toast(result.message, "ok");
        cardsView();
      } catch (err) {
        fail(err.message);
      }
    };
  }

  /* The large card artwork for whichever card is selected. */
  function renderHeroCard(c) {
    const blocked = c.isOwn && c.status === "blocked";
    return `
      <div class="debit-card ${blocked ? "is-blocked" : ""} ${c.isOwn ? "" : "is-external"}">
        <div class="dc-top">
          <span>${esc(c.issuer)}</span>
          <span>${esc(c.network)}</span>
        </div>
        <div class="dc-number">•••• •••• •••• ${esc(c.last4)}</div>
        <div class="dc-bottom">
          <div>
            <div class="dc-label">Card holder</div>
            <div>${esc(state.user.name)} ${esc(state.user.surname)}</div>
          </div>
          <div>
            <div class="dc-label">Valid thru</div>
            <div>${esc(formatExpiry(c.expiry))}</div>
          </div>
        </div>
        ${blocked ? `<div class="dc-blocked">BLOCKED</div>` : ""}
      </div>`;
  }

  /* Block/unblock belongs only to the card we issued. */
  function renderHeroActions(c) {
    if (!c.isOwn) {
      return `<button class="btn btn-danger btn-block" data-remove="${c.id}"
                      style="margin-top:16px">Remove from wallet</button>`;
    }
    return `
      <button class="btn btn-block ${c.status === "blocked" ? "" : "btn-danger"}"
              id="block-btn" style="margin-top:16px">
        ${c.status === "blocked" ? "Unblock card" : `${icon("lock")} Block card`}
      </button>`;
  }

  /*
   * Right-hand panel: controls for our own card, plain details for a saved one
   * — we cannot switch another bank's card off at the network.
   */
  function renderCardDetail(c) {
    if (!c.isOwn) {
      return `
        <h2>Card settings</h2>
        <div id="err"></div>

        <div class="kv"><span>Issuer</span><b>${esc(c.issuer)}</b></div>
        <div class="kv"><span>Network</span><b>${esc(c.network)}</b></div>
        <div class="kv"><span>Card number</span><b>•••• ${esc(c.last4)}</b></div>
        <div class="kv"><span>Status</span>
          <b>${c.expired
                ? `<span class="pill pill-red">Expired</span>`
                : c.expiringSoon
                  ? `<span class="pill pill-amber">Expires in ${c.daysLeft} day(s)</span>`
                  : `<span class="pill pill-green">Valid</span>`}</b></div>

        <div class="field-row" style="margin-top:16px">
          <div class="field">
            <label for="s-label">Nickname</label>
            <input id="s-label" value="${esc(c.label || "")}" placeholder="e.g. Travel card">
          </div>
          <div class="field">
            <label for="s-kind">Card type</label>
            <select id="s-kind">
              <option value="credit" ${c.kind === "credit" ? "selected" : ""}>Credit card</option>
              <option value="debit" ${c.kind === "debit" ? "selected" : ""}>Debit card</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="s-expiry">Expiry (MM/YY)</label>
          <input id="s-expiry" maxlength="5" value="${esc(formatExpiry(c.expiry))}">
        </div>

        <div class="field">
          <label for="s-notes">Notes</label>
          <input id="s-notes" value="${esc(c.notes || "")}"
                 placeholder="e.g. 5% back on fuel">
        </div>

        <label class="toggle-row">
          <span>Default card for tracking</span>
          <input type="checkbox" data-setting="isDefault" ${c.isDefault ? "checked" : ""}>
        </label>
        <label class="toggle-row">
          <span>Count in my spending summaries</span>
          <input type="checkbox" data-setting="trackSpending" ${
            c.trackSpending ? "checked" : ""}>
        </label>
        <label class="toggle-row">
          <span>Remind me before it expires</span>
          <input type="checkbox" data-setting="expiryReminder" ${
            c.expiryReminder ? "checked" : ""}>
        </label>

        <button class="btn btn-block" id="save-settings" style="margin-top:16px">
          Save settings</button>

        <p style="color:var(--muted);font-size:0.8rem;margin:14px 0 0;line-height:1.6">
          ATM, POS, online and international switches — and blocking the card —
          are set at the card network, so only ${esc(c.issuer)} can change those.
          Everything above is what AB Pay controls.
        </p>`;
    }

    const controls = c.controls;
    return `
      <h2>Usage controls</h2>
      <p style="color:var(--muted);font-size:0.83rem;margin:0 0 14px;line-height:1.55">
        These switch the card off at the network, so they apply only to the card
        we issued.
      </p>
      <div id="err"></div>
      ${[["atm", "ATM withdrawals"], ["pos", "Card machines (POS)"],
         ["online", "Online payments"], ["international", "International usage"]]
        .map(([key, label]) => `
          <label class="toggle-row">
            <span>${label}</span>
            <input type="checkbox" data-control="${key}" ${controls[key] ? "checked" : ""}>
          </label>`).join("")}

      <div class="field" style="margin-top:16px">
        <label for="c-limit">Daily transaction limit (₹)</label>
        <input id="c-limit" type="number" step="100" min="100" value="${controls.dailyLimit}">
      </div>
      <button class="btn btn-block" id="save-controls">Save settings</button>`;
  }

  function wireCardActions() {
    const block = document.getElementById("block-btn");
    if (block) {
      block.onclick = async event => {
        event.target.disabled = true;
        const result = await api("/card/block", { method: "POST" });
        toast(result.message, "ok");
        cardsView();
      };
    }

    const save = document.getElementById("save-controls");
    if (save) {
      save.onclick = async () => {
        const get = key => document.querySelector(`[data-control="${key}"]`).checked;
        try {
          const result = await api("/card/controls", {
            method: "POST",
            body: {
              atm: get("atm"), pos: get("pos"),
              online: get("online"), international: get("international"),
              dailyLimit: document.getElementById("c-limit").value
            }
          });
          toast(result.message, "ok");
        } catch (err) {
          document.getElementById("err").innerHTML =
            `<div class="form-error">${esc(err.message)}</div>`;
        }
      };
    }

    const saveSettings = document.getElementById("save-settings");
    if (saveSettings) {
      saveSettings.onclick = async () => {
        const get = key => document.querySelector(`[data-setting="${key}"]`).checked;
        const [mm, yy] = document.getElementById("s-expiry").value.split("/");

        try {
          if (!mm || !yy || Number(mm) < 1 || Number(mm) > 12) {
            throw new Error("Enter the expiry as MM/YY.");
          }
          const result = await api(`/card/${selectedCardId}/settings`, {
            method: "POST",
            body: {
              label: document.getElementById("s-label").value,
              kind: document.getElementById("s-kind").value,
              expiry: `20${yy.padStart(2, "0")}-${mm.padStart(2, "0")}`,
              notes: document.getElementById("s-notes").value,
              isDefault: get("isDefault"),
              trackSpending: get("trackSpending"),
              expiryReminder: get("expiryReminder")
            }
          });
          toast(result.message, "ok");
          cardsView();
        } catch (err) {
          document.getElementById("err").innerHTML =
            `<div class="form-error">${esc(err.message)}</div>`;
        }
      };
    }

    // "Remove from wallet" sits beside the hero card as well as on each tile.
    const remove = document.querySelector("#hero-actions button[data-remove]");
    if (remove) {
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          const result = await api(`/card/${remove.dataset.remove}`, { method: "DELETE" });
          selectedCardId = null;
          toast(result.message, "ok");
          cardsView();
        } catch (err) {
          toast(err.message, "err");
          remove.disabled = false;
        }
      };
    }
  }

  /* "YYYY-MM" as the MM/YY printed on a card. */
  const formatExpiry = value => {
    const [year, month] = String(value).split("-");
    return month ? `${month}/${String(year).slice(-2)}` : String(value);
  };

  /* The Luhn checksum every real card number satisfies. */
  function luhnValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    return sum % 10 === 0;
  }

  /* Card network from the issuer prefix, as the major schemes allocate them. */
  function detectNetwork(digits) {
    if (/^3[47]/.test(digits)) return "Amex";
    if (/^3(?:0[0-5]|[68])/.test(digits)) return "Diners Club";
    if (/^4/.test(digits)) return "Visa";
    if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
    if (/^(60|65|81|82|508)/.test(digits)) return "RuPay";
    return "RuPay";
  }

  function renderWallet(cards, selectedId) {
    return `<div class="wallet-grid">${cards.map(c => `
      <button class="wallet-card ${c.expired ? "is-expired" : ""}
                     ${c.id === selectedId ? "is-selected" : ""}"
              data-card-id="${c.id}" aria-pressed="${c.id === selectedId}">
        <div class="wc-top">
          <span class="wc-issuer">${esc(c.issuer)}</span>
          <span class="pill">${esc(c.network)}</span>
        </div>
        <div class="wc-number">•••• ${esc(c.last4)}</div>
        <div class="wc-foot">
          <div>
            <div class="dc-label">${esc(c.kind === "credit" ? "Credit" : "Debit")}</div>
            <div class="wc-label">${esc(c.label || (c.isOwn ? "AB Pay" : "—"))}</div>
          </div>
          <div style="text-align:right">
            <div class="dc-label">Expires</div>
            <div>${esc(formatExpiry(c.expiry))}</div>
          </div>
        </div>
        ${c.expired
          ? `<div class="wc-flag expired">Expired</div>`
          : c.expiringSoon
            ? `<div class="wc-flag soon">Expires in ${c.daysLeft} day(s)</div>`
            : ""}
        ${c.isOwn && c.status === "blocked"
          ? `<div class="wc-flag expired">Blocked</div>` : ""}
      </button>`).join("")}</div>`;
  }

  function renderScheduled(items) {
    const live = items.filter(t => t.status !== "cancelled");
    if (!live.length) {
      return `<div class="empty">${icon("clock", "icon icon-lg")}
                Nothing scheduled.</div>`;
    }

    const pill = {
      scheduled: `<span class="pill pill-amber">Scheduled</span>`,
      sent: `<span class="pill pill-green">Sent</span>`,
      failed: `<span class="pill pill-red">Failed</span>`
    };

    return live.map(t => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div class="ss-amount">${money(t.amount)}</div>
            <div class="ss-meta">
              To ${esc(t.payeeName || t.toAccount)}${t.ifsc ? " · " + esc(t.ifsc) : ""}
              · ${esc(t.mode)}${t.description ? " · " + esc(t.description) : ""}
            </div>
            <div class="ss-meta">
              ${t.status === "sent" ? "Sent" : "Sends"} ${fmtDate(t.runOn)}${
                t.repeatDays ? ` · repeats every ${t.repeatDays} days` : ""}
            </div>
            ${t.lastError ? `<div class="countdown">${esc(t.lastError)}</div>` : ""}
          </div>
          ${pill[t.status] || ""}
        </div>
        ${t.status === "scheduled" ? `
          <div class="ss-actions">
            <button class="btn btn-sm btn-danger" data-cancel-sched="${t.id}">Cancel</button>
          </div>` : ""}
      </div>`).join("");
  }

  function wireSecurityAndScheduled() {
    /* --- two-factor --- */
    const tfa = document.getElementById("tfa");
    const passWrap = document.getElementById("tfa-pass-wrap");

    // Turning it off is a downgrade, so the password field appears for that.
    tfa.onchange = () => { passWrap.hidden = tfa.checked; };
    passWrap.hidden = tfa.checked;

    document.getElementById("save-2fa").onclick = async () => {
      try {
        const result = await api("/security/two-factor", {
          method: "POST",
          body: {
            enabled: tfa.checked,
            password: document.getElementById("tfa-pass").value
          }
        });
        toast(result.message, "ok");
        state.user = (await api("/me")).user;
        servicesView();
      } catch (err) {
        document.getElementById("err-2fa").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    /* --- data export: needs the auth header, so fetch as a blob --- */
    document.getElementById("export-data").onclick = async () => {
      const res = await fetch("/api/account/export",
        { headers: { Authorization: "Bearer " + state.token } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `abpay-data-${state.account.number}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Your data was downloaded", "ok");
    };

    /* --- scheduled transfers --- */
    const wrap = document.getElementById("sched-form-wrap");
    document.getElementById("sched-btn").onclick = () => {
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) {
        document.getElementById("sc-date").value =
          new Date(Date.now() + 864e5).toISOString().slice(0, 10);
        document.getElementById("sc-to").focus();
      }
    };
    document.getElementById("sched-cancel").onclick = () => { wrap.hidden = true; };

    document.getElementById("sched-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/scheduled", {
          method: "POST",
          body: {
            toAccount: document.getElementById("sc-to").value.trim(),
            ifsc: document.getElementById("sc-ifsc").value.trim(),
            amount: document.getElementById("sc-amount").value,
            runOn: document.getElementById("sc-date").value,
            repeatDays: document.getElementById("sc-repeat").value,
            description: document.getElementById("sc-note").value
          }
        });
        toast(result.message, "ok");
        servicesView();
      } catch (err) {
        document.getElementById("sched-err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    document.getElementById("sched-list").onclick = async event => {
      const button = event.target.closest("[data-cancel-sched]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(`/scheduled/${button.dataset.cancelSched}`,
          { method: "DELETE" });
        toast(result.message, "ok");
        servicesView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }

  /* ---------- linked bank accounts ---------- */

  /*
   * We hold the ledger for AB Pay accounts, so those show a live balance. For
   * an account at another bank we can validate and store the routing details
   * and pay into it, but its balance belongs to that bank — reading it needs
   * the customer's consent through an RBI Account Aggregator. The card says
   * so rather than showing a blank or an invented number.
   */
  function renderLinked(accounts) {
    if (!accounts.length) {
      return `<div class="empty">${icon("bank2", "icon icon-lg")}
                No accounts linked yet.</div>`;
    }

    return `<div class="linked-grid">${accounts.map(a => `
      <div class="linked-card ${a.isOurs ? "is-ours" : ""}">
        <div class="linked-top">
          <div>
            <div class="linked-bank">${esc(a.bank)}</div>
            <div class="linked-meta">${esc(a.masked)} · ${esc(a.ifsc)}</div>
          </div>
          ${a.isOurs
            ? `<span class="pill pill-green">Live</span>`
            : `<span class="pill">Linked</span>`}
        </div>

        ${a.balanceStatus === "live"
          ? `<div class="linked-balance">${money(a.balance)}</div>
             <div class="linked-meta">${esc(a.accountType)} · ${esc(a.holderName || "")}</div>
             ${a.recent && a.recent.length ? `
               <div class="linked-recent">
                 ${a.recent.slice(0, 3).map(t => `
                   <div class="linked-tx">
                     <span>${esc(t.description || t.counterpartyName || "Transaction")}</span>
                     <b class="${t.direction === "out" ? "amount-out" : "amount-in"}">
                       ${t.direction === "out" ? "−" : "+"}${money(t.amount)}</b>
                   </div>`).join("")}
               </div>` : ""}`
          : `<div class="linked-consent">
               ${icon("lock")}
               <span>${esc(a.balanceNote || "Balance not available.")}</span>
             </div>`}

        <div class="linked-foot">
          ${a.nickname ? `<span class="linked-meta">${esc(a.nickname)}</span>` : "<span></span>"}
          <button class="btn btn-sm btn-danger" data-unlink="${a.id}">Unlink</button>
        </div>
      </div>`).join("")}</div>`;
  }

  function wireLinkedAccounts() {
    const wrap = document.getElementById("link-form-wrap");
    if (!wrap) return;

    document.getElementById("link-btn").onclick = () => {
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) document.getElementById("l-number").focus();
    };
    document.getElementById("link-cancel").onclick = () => { wrap.hidden = true; };

    // Naming the bank as the IFSC is typed catches a typo before anything saves.
    const ifscEl = document.getElementById("l-ifsc");
    const bankEl = document.getElementById("l-bank");
    let lookupTimer;

    ifscEl.oninput = () => {
      ifscEl.value = ifscEl.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11);
      clearTimeout(lookupTimer);

      if (ifscEl.value.length < 11) { bankEl.textContent = ""; return; }
      lookupTimer = setTimeout(async () => {
        try {
          const info = await api(`/linked/lookup?ifsc=${encodeURIComponent(ifscEl.value)}`);
          bankEl.innerHTML = info.known
            ? `<span class="verify-ok">${esc(info.bank)} · branch ${esc(info.branchCode)}</span>`
            : `<span class="verify-warn">Bank code ${esc(info.bankCode)} not recognised.</span>`;
        } catch (err) {
          bankEl.innerHTML = `<span class="verify-warn">${esc(err.message)}</span>`;
        }
      }, 300);
    };

    document.getElementById("link-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/linked", {
          method: "POST",
          body: {
            accountNumber: document.getElementById("l-number").value,
            ifsc: ifscEl.value,
            holderName: document.getElementById("l-holder").value,
            nickname: document.getElementById("l-nick").value
          }
        });
        toast(result.message, "ok");
        servicesView();
      } catch (err) {
        document.getElementById("link-err").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    document.getElementById("linked-list").onclick = async event => {
      const button = event.target.closest("button[data-unlink]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(`/linked/${button.dataset.unlink}`, { method: "DELETE" });
        toast(result.message, "ok");
        servicesView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }

  /* ---------- services ---------- */

  async function servicesView() {
    shell("#/services", loading());
    const [data, docs, linked, sched] = await Promise.all([
      api("/requests"), api("/documents"), api("/linked"), api("/scheduled")
    ]);

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Services</h1>
        <p>Profile, UPI PIN and branch requests.</p>
      </div>

      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="card">
          <h2>UPI PIN</h2>
          <div id="err-pin"></div>
          <p style="color:var(--muted);font-size:0.86rem;margin:0 0 14px">
            ${state.user.hasUpiPin
              ? "Your UPI PIN authorises every UPI payment. Change it below."
              : "Set a UPI PIN to start making UPI payments."}
          </p>
          <form id="pin-form" novalidate>
            ${state.user.hasUpiPin ? `
              <div class="field">
                <label for="p-current">Current PIN</label>
                <input id="p-current" type="password" inputmode="numeric" maxlength="6" required>
              </div>` : ""}
            <div class="field">
              <label for="p-new">New PIN (4 or 6 digits)</label>
              <input id="p-new" type="password" inputmode="numeric" maxlength="6" required>
            </div>
            <button class="btn btn-block" type="submit">
              ${state.user.hasUpiPin ? "Change PIN" : "Set PIN"}</button>
          </form>
        </div>

        <div class="card">
          <h2>Profile</h2>
          <div id="err-prof"></div>
          <form id="profile-form" novalidate>
            <div class="field">
              <label for="pr-address">Address</label>
              <input id="pr-address" value="${esc(state.user.address || "")}">
            </div>
            <div class="field-row">
              <div class="field">
                <label for="pr-nominee">Nominee</label>
                <input id="pr-nominee" value="${esc(state.user.nominee || "")}"
                       placeholder="Full name">
              </div>
              <div class="field">
                <label for="pr-pan">PAN</label>
                <input id="pr-pan" value="${esc(state.user.pan || "")}" maxlength="10"
                       style="text-transform:uppercase">
              </div>
            </div>
            <div class="kv"><span>Customer since</span><b>${fmtDate(state.user.registeredAt)}</b></div>
            <div class="kv"><span>Registered mobile</span><b>${esc(state.user.mobile)}</b></div>
            <div class="kv"><span>Branch</span><b>${esc(state.user.branch)}</b></div>
            <button class="btn btn-block" type="submit" style="margin-top:14px">Save profile</button>
          </form>
        </div>
      </div>

      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="card">
          <h2>Security</h2>
          <div id="err-2fa"></div>
          <label class="toggle-row">
            <span>
              Two-factor sign-in
              <div class="radar-meta">A 6-digit code each time you sign in.</div>
            </span>
            <input type="checkbox" id="tfa" ${state.user.twoFactor ? "checked" : ""}>
          </label>
          <div class="field" id="tfa-pass-wrap" hidden style="margin-top:14px">
            <label for="tfa-pass">Confirm your password to turn this off</label>
            <input id="tfa-pass" type="password" autocomplete="current-password">
          </div>
          <button class="btn btn-block" id="save-2fa" style="margin-top:14px">
            Save security settings</button>
        </div>

        <div class="card">
          <h2>Your data</h2>
          <p style="color:var(--muted);font-size:0.85rem;margin:0 0 14px;line-height:1.6">
            Download everything we hold about you — profile, transactions, cards,
            deposits, autopay, disputes and alerts — as one file.
          </p>
          <button class="btn btn-ghost btn-block" id="export-data">
            ${icon("download")} Download my data</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="chart-head">
          <h2>Scheduled transfers</h2>
          <button class="btn btn-sm" id="sched-btn">Schedule a transfer</button>
        </div>

        <div id="sched-form-wrap" hidden>
          <form id="sched-form" class="wallet-form" novalidate>
            <div id="sched-err"></div>
            <div class="field-row">
              <div class="field">
                <label for="sc-to">To account number</label>
                <input id="sc-to" placeholder="501110000002" required>
              </div>
              <div class="field">
                <label for="sc-ifsc">IFSC (other banks only)</label>
                <input id="sc-ifsc" maxlength="11" style="text-transform:uppercase">
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="sc-amount">Amount (₹)</label>
                <input id="sc-amount" type="number" step="0.01" min="0.01" required>
              </div>
              <div class="field">
                <label for="sc-date">Send on</label>
                <input id="sc-date" type="date" required>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="sc-repeat">Repeat</label>
                <select id="sc-repeat">
                  <option value="">Once</option>
                  <option value="7">Every week</option>
                  <option value="30">Every month</option>
                </select>
              </div>
              <div class="field">
                <label for="sc-note">Remarks</label>
                <input id="sc-note" placeholder="e.g. Rent">
              </div>
            </div>
            <div class="wallet-actions">
              <button class="btn btn-ghost" type="button" id="sched-cancel">Cancel</button>
              <button class="btn" type="submit">Schedule</button>
            </div>
          </form>
        </div>

        <div id="sched-list">${renderScheduled(sched.scheduled)}</div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="chart-head">
          <h2>Your bank accounts</h2>
          <button class="btn btn-sm" id="link-btn">Link an account</button>
        </div>
        <p style="color:var(--muted);font-size:0.83rem;margin:0 0 16px;line-height:1.6">
          Add an account at any Indian bank. We read the bank and branch straight
          from the IFSC, keep it for payments, and warn you if anything looks wrong.
        </p>

        <div id="link-form-wrap" hidden>
          <form id="link-form" class="wallet-form" novalidate>
            <div id="link-err"></div>
            <div class="field-row">
              <div class="field">
                <label for="l-number">Account number</label>
                <input id="l-number" inputmode="numeric" placeholder="50100234567890" required>
              </div>
              <div class="field">
                <label for="l-ifsc">IFSC</label>
                <input id="l-ifsc" maxlength="11" placeholder="HDFC0001234"
                       style="text-transform:uppercase" required>
                <div id="l-bank" class="verify-note"></div>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="l-holder">Account holder</label>
                <input id="l-holder" placeholder="Name on the account">
              </div>
              <div class="field">
                <label for="l-nick">Nickname (optional)</label>
                <input id="l-nick" placeholder="e.g. Salary account">
              </div>
            </div>
            <div class="wallet-actions">
              <button class="btn btn-ghost" type="button" id="link-cancel">Cancel</button>
              <button class="btn" type="submit">Link account</button>
            </div>
          </form>
        </div>

        <div id="linked-list">${renderLinked(linked.accounts)}</div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <h2>Certificates — issued instantly</h2>
        <p style="color:var(--muted);font-size:0.86rem;margin:0 0 14px;line-height:1.6">
          These normally mean a branch visit or a ticket someone has to action.
          Here they are generated from your live account data the moment you ask,
          with a reference number. Financial year ${esc(docs.financialYear)}.
        </p>
        <div class="doc-grid">
          ${Object.entries(docs.kinds).map(([kind, title]) => `
            <button class="doc-tile" data-kind="${esc(kind)}">
              ${icon("document", "icon icon-lg")}
              <span>${esc(title)}</span>
            </button>`).join("")}
        </div>
        <div id="doc-list" style="margin-top:16px">${renderDocuments(docs.documents)}</div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h2>Raise a request</h2>
          <div id="err-req"></div>
          <form id="req-form" novalidate>
            <div class="field">
              <label for="r-type">Request type</label>
              <select id="r-type">
                ${data.types.map(t => `<option>${esc(t)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="r-details">Details</label>
              <textarea id="r-details" rows="3" placeholder="Anything we should know"></textarea>
            </div>
            <button class="btn btn-block" type="submit">Submit request</button>
          </form>
        </div>

        <div class="card">
          <h2>Your requests</h2>
          ${data.requests.length === 0
            ? `<div class="empty">${icon("list", "icon icon-lg")}No requests raised.</div>`
            : data.requests.map(r => `
                <div class="ss-item">
                  <div class="ss-top">
                    <div>
                      <div style="font-weight:600">${esc(r.type)}</div>
                      <div class="ss-meta">Ticket ${esc(r.ticket)} · ${fmtDate(r.created_at)}</div>
                      ${r.details ? `<div class="ss-meta">${esc(r.details)}</div>` : ""}
                    </div>
                    <span class="pill pill-amber">${esc(r.status)}</span>
                  </div>
                </div>`).join("")}
        </div>
      </div>`;

    document.getElementById("pin-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const current = document.getElementById("p-current");
        const result = await api("/upi/pin", {
          method: "POST",
          body: {
            pin: document.getElementById("p-new").value,
            currentPin: current ? current.value : undefined
          }
        });
        toast(result.message, "ok");
        state.user = (await api("/me")).user;
        servicesView();
      } catch (err) {
        document.getElementById("err-pin").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    document.getElementById("profile-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/profile", {
          method: "POST",
          body: {
            address: document.getElementById("pr-address").value,
            nominee: document.getElementById("pr-nominee").value,
            pan: document.getElementById("pr-pan").value || undefined
          }
        });
        state.user = result.user;
        toast(result.message, "ok");
      } catch (err) {
        document.getElementById("err-prof").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };

    wireLinkedAccounts();
    wireSecurityAndScheduled();

    document.querySelector(".doc-grid").onclick = async event => {
      const tile = event.target.closest("button[data-kind]");
      if (!tile) return;
      tile.disabled = true;
      try {
        const result = await api("/documents", {
          method: "POST", body: { kind: tile.dataset.kind }
        });
        toast(`${result.message} Ref ${result.reference}`, "ok");
        servicesView();
      } catch (err) {
        toast(err.message, "err");
        tile.disabled = false;
      }
    };

    /* Downloads need the auth header, so fetch as a blob rather than linking. */
    document.getElementById("doc-list").onclick = async event => {
      const button = event.target.closest("button[data-doc]");
      if (!button) return;

      const res = await fetch(`/api/documents/${button.dataset.doc}/download`,
        { headers: { Authorization: "Bearer " + state.token } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = button.dataset.name + ".txt";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Downloaded", "ok");
    };

    document.getElementById("req-form").onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api("/requests", {
          method: "POST",
          body: {
            type: document.getElementById("r-type").value,
            details: document.getElementById("r-details").value
          }
        });
        toast(result.message, "ok");
        servicesView();
      } catch (err) {
        document.getElementById("err-req").innerHTML =
          `<div class="form-error">${esc(err.message)}</div>`;
      }
    };
  }

  /* ---------- Safe Send ---------- */

  function renderSafeSendList(payments) {
    if (!payments.length) {
      return `<div class="empty">${icon("shield", "icon icon-lg")}No protected payments yet.</div>`;
    }

    return payments.map(p => {
      const statusPill = {
        held: `<span class="pill pill-amber">Held by bank</span>`,
        released: `<span class="pill pill-green">Released</span>`,
        refunded: `<span class="pill pill-red">Refunded</span>`
      }[p.status];

      const daysLeft = Math.ceil((new Date(p.deadline) - Date.now()) / 864e5);

      let actions = "";
      if (p.status === "held" && p.role === "sender") {
        actions = `
          <button class="btn btn-sm" data-action="release" data-id="${p.id}">
            Release funds</button>
          <button class="btn btn-sm btn-danger" data-action="refund" data-id="${p.id}">
            Cancel &amp; refund</button>`;
      } else if (p.status === "held" && p.role === "recipient") {
        actions = `
          ${p.markedShipped ? "" : `<button class="btn btn-sm btn-ghost"
            data-action="shipped" data-id="${p.id}">Mark as sent</button>`}
          <button class="btn btn-sm btn-danger" data-action="refund" data-id="${p.id}">
            Return funds</button>`;
      }

      return `
        <div class="ss-item">
          <div class="ss-top">
            <div>
              <div class="ss-amount">${money(p.amount)}</div>
              <div class="ss-meta">
                ${p.role === "sender" ? "To" : "From"} ${esc(p.counterparty)}
                ${p.description ? " · " + esc(p.description) : ""}
              </div>
            </div>
            ${statusPill}
          </div>
          ${p.status === "held"
            ? `<div class="countdown">Auto-refunds in ${daysLeft} day(s)${
                 p.markedShipped ? " · seller has marked it as sent" : ""}</div>`
            : `<div class="ss-meta" style="margin-top:6px">Settled ${fmtDate(p.settledAt)}</div>`}
          ${actions ? `<div class="ss-actions">${actions}</div>` : ""}
        </div>`;
    }).join("");
  }

  /* ---------- statement ---------- */

  async function statementView() {
    shell("#/statement", loading());

    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Account statement</h1>
        <p>Filter your history and export it.</p>
      </div>
      <div class="card">
        <div class="filters">
          <div class="field">
            <label for="from">From</label>
            <input id="from" type="date" value="${monthAgo}">
          </div>
          <div class="field">
            <label for="to">To</label>
            <input id="to" type="date" value="${today}">
          </div>
          <div class="field" style="flex:1;min-width:180px">
            <label for="q">Search</label>
            <input id="q" placeholder="Narration, payee or reference">
          </div>
          <button class="btn" id="apply">Apply</button>
          <button class="btn btn-ghost" id="csv">${icon("download")} Download CSV</button>
        </div>
        <div id="statement-body">${loading()}</div>
      </div>`;

    let page = 1;

    const load = async (goTo = 1) => {
      page = Math.max(1, goTo);
      const from = document.getElementById("from").value;
      const to = document.getElementById("to").value;
      const body = document.getElementById("statement-body");
      body.innerHTML = loading();

      const needle = document.getElementById("q").value.trim();
      const data = await api(`/transactions?from=${from}&to=${to}&page=${page}&limit=25` +
        (needle ? `&q=${encodeURIComponent(needle)}` : ""));

      const credits = data.transactions.filter(t => t.direction === "in")
        .reduce((sum, t) => sum + t.amount, 0);
      const debits = data.transactions.filter(t => t.direction === "out")
        .reduce((sum, t) => sum + t.amount, 0);

      body.innerHTML = `
        <div class="grid grid-3" style="margin-bottom:18px">
          <div class="card stat"><h2>Transactions</h2>
            <div class="stat-value">${data.total}</div></div>
          <div class="card stat"><h2>Credits</h2>
            <div class="stat-value amount-in">+${money(credits)}</div></div>
          <div class="card stat"><h2>Debits</h2>
            <div class="stat-value amount-out">−${money(debits)}</div></div>
        </div>
        ${data.transactions.length === 0
          ? `<div class="empty">${icon("document", "icon icon-lg")}No transactions in this period.</div>`
          : `<div class="table-scroll">
              <table class="table">
                <thead><tr>
                  <th>Date</th><th>Narration</th><th>Counterparty</th>
                  <th>Mode</th><th class="num">Amount</th><th class="num">Balance</th>
                </tr></thead>
                <tbody>
                  ${data.transactions.map(tx => `
                    <tr>
                      <td>${fmtDate(tx.date)}</td>
                      <td class="tx-desc">${esc(tx.description || "—")}</td>
                      <td>${esc(tx.counterpartyName || "—")}
                        <div class="tx-sub">${esc(tx.counterpartyNumber || "")}</div></td>
                      <td><span class="pill">${esc(tx.method)}</span></td>
                      <td class="num ${tx.direction === "out" ? "amount-out" : "amount-in"}">
                        ${tx.direction === "out" ? "−" : "+"}${money(tx.amount)}</td>
                      <td class="num">${money(tx.balanceAfter)}</td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div>
            ${data.pages > 1 ? `
              <div class="pager">
                <button class="btn btn-ghost btn-sm" id="prev"
                        ${data.page <= 1 ? "disabled" : ""}>Previous</button>
                <span>Page ${data.page} of ${data.pages}</span>
                <button class="btn btn-ghost btn-sm" id="next"
                        ${data.hasMore ? "" : "disabled"}>Next</button>
              </div>` : ""}`}`;

      const prev = document.getElementById("prev");
      const next = document.getElementById("next");
      if (prev) prev.onclick = () => load(page - 1);
      if (next) next.onclick = () => load(page + 1);
    };

    document.getElementById("apply").onclick = () => load(1);

    let searchTimer;
    document.getElementById("q").oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(1), 300);
    };

    /*
     * The CSV endpoint needs the auth header, so fetch it as a blob rather
     * than pointing the browser straight at the URL.
     */
    document.getElementById("csv").onclick = async () => {
      const from = document.getElementById("from").value;
      const to = document.getElementById("to").value;
      const needle = document.getElementById("q").value.trim();
      const res = await fetch(`/api/statement.csv?from=${from}&to=${to}` +
        (needle ? `&q=${encodeURIComponent(needle)}` : ""),
        { headers: { Authorization: "Bearer " + state.token } });

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `statement-${state.account.number}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Statement downloaded", "ok");
    };

    load();
  }

  function renderDocuments(documents) {
    if (!documents.length) {
      return `<div class="empty" style="padding:20px">
                Nothing issued yet — pick a certificate above.</div>`;
    }
    return documents.map(d => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div style="font-weight:600">${esc(d.title)}</div>
            <div class="ss-meta">Ref ${esc(d.reference)} · ${fmtDate(d.createdAt)}</div>
          </div>
          <button class="btn btn-sm btn-ghost" data-doc="${d.id}"
                  data-name="${esc(d.kind)}-${esc(d.reference)}">
            ${icon("download")} Download</button>
        </div>
      </div>`).join("");
  }

  /* ---------- AI customer care ---------- */

  /*
   * Chat against /api/assistant. The server answers from this customer's own
   * account snapshot, so replies quote real figures rather than generalities.
   */
  /*
   * One chat implementation, shared by the floating launcher and the panel on
   * the Support page. `root` must contain .chat, .chips and .chat-form.
   */
  function wireChat(root, agentName) {
    const chat = root.querySelector(".chat");
    const form = root.querySelector(".chat-form");
    const input = root.querySelector(".chat-input");
    if (!chat || !form) return null;

    const history = [];

    const bubble = (role, html) => {
      const wrap = document.createElement("div");
      wrap.className = "msg " + role;
      wrap.innerHTML = `<div class="bubble">${html}</div>`;
      chat.appendChild(wrap);
      chat.scrollTop = chat.scrollHeight;
      return wrap;
    };

    async function send(question) {
      const text = String(question || "").trim();
      if (!text) return;

      bubble("me", esc(text));
      history.push({ role: "user", content: text });
      input.value = "";

      const pending = bubble("bot", `<span class="typing"><i></i><i></i><i></i></span>`);

      try {
        const result = await api("/assistant", {
          method: "POST", body: { question: text, history: history.slice(0, -1) }
        });

        pending.querySelector(".bubble").innerHTML = esc(result.reply);
        if (result.degraded) {
          pending.insertAdjacentHTML("beforeend",
            `<div class="msg-note">Answered offline — the AI service was unreachable.</div>`);
        }
        history.push({ role: "assistant", content: result.reply });
      } catch (err) {
        pending.querySelector(".bubble").textContent = err.message;
        pending.classList.add("error");
      }
      chat.scrollTop = chat.scrollHeight;
    }

    form.onsubmit = event => { event.preventDefault(); send(input.value); };

    const chips = root.querySelector(".chips");
    if (chips) {
      chips.onclick = event => {
        const chip = event.target.closest(".chip");
        if (chip) send(chip.textContent.trim());
      };
    }

    return { send, focus: () => input.focus() };
  }

  /* ---------- floating assistant ---------- */

  /*
   * A launcher pinned to every signed-in page, so help is one tap away rather
   * than buried under Support — the pattern every payments app now uses.
   */
  let assistantPanel = null;

  async function mountAssistantLauncher() {
    if (document.getElementById("abhi-launcher")) return;

    const ai = await api("/assistant").catch(() => null);
    if (!ai) return;

    const name = ai.name || "Abhi";

    const launcher = document.createElement("button");
    launcher.id = "abhi-launcher";
    launcher.className = "abhi-launcher";
    launcher.setAttribute("aria-label", `Chat with ${name}`);
    launcher.innerHTML = `${icon("headset", "icon icon-lg")}<span>${esc(name)}</span>`;
    document.body.appendChild(launcher);

    const panel = document.createElement("section");
    panel.id = "abhi-panel";
    panel.className = "abhi-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", `${name}, customer care`);
    panel.innerHTML = `
      <header class="abhi-head">
        <div class="abhi-who">
          <div class="abhi-avatar">${icon("headset")}</div>
          <div>
            <div class="abhi-name">${esc(name)}</div>
            <div class="abhi-role">${ai.engine === "claude"
              ? "AI customer care" : "Customer care"}</div>
          </div>
        </div>
        <button class="icon-btn" id="abhi-close" aria-label="Close">${icon("close")}</button>
      </header>
      <div class="chat">
        <div class="msg bot">
          <div class="bubble">${esc(`Hi ${state.user.name}, I'm ${name}. Ask me anything `
            + `about your account — balance, a payment, your card, deposits, `
            + `or anything that went wrong.`)}</div>
        </div>
      </div>
      <div class="chips">
        ${(ai.suggestions || []).slice(0, 3)
          .map(q => `<button class="chip">${esc(q)}</button>`).join("")}
      </div>
      <form class="chat-form">
        <input class="chat-input" placeholder="Ask ${esc(name)}…"
               autocomplete="off" maxlength="1000">
        <button class="btn" type="submit">Send</button>
      </form>`;
    document.body.appendChild(panel);

    const chat = wireChat(panel, name);
    assistantPanel = { panel, launcher, chat };

    const toggle = open => {
      panel.hidden = !open;
      launcher.classList.toggle("is-open", open);
      if (open) chat.focus();
    };

    launcher.onclick = () => toggle(panel.hidden);
    panel.querySelector("#abhi-close").onclick = () => toggle(false);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) toggle(false);
    });
  }

  function removeAssistantLauncher() {
    document.getElementById("abhi-launcher")?.remove();
    document.getElementById("abhi-panel")?.remove();
    assistantPanel = null;
  }


  /* ---------- support: self-resolving disputes and recalls ---------- */

  async function supportView() {
    shell("#/support", loading());
    const [data, txs, ai] = await Promise.all([
      api("/support"), api("/transactions"), api("/assistant")
    ]);

    // Only outgoing payments can be disputed or recalled.
    const debits = txs.transactions.filter(t => t.direction === "out").slice(0, 25);

    document.getElementById("main").innerHTML = `
      <div class="page-head">
        <h1>Support</h1>
        <p>Most problems are settled by the system in seconds, not by a queue.</p>
      </div>

      <div class="feature-banner">
        ${icon("check", "icon icon-lg ico")}
        <div>
          <h3>Self-resolving support</h3>
          <p>
            "Money debited but not received" is the biggest reason people call a
            bank. Here it is handled in software: a double charge is refunded
            immediately, an unconfirmed payment to another bank reverses itself
            once the ${data.settlementWindowHours}-hour settlement window lapses,
            and a payment that genuinely arrived offers you a recall instead.
            Only fraud reaches a person — because only fraud needs one.
          </p>
          ${data.totalCases > 0 ? `
            <div class="resolve-stat">
              <b>${data.settledWithoutHuman} of ${data.totalCases}</b> of your cases
              settled without a banker.
            </div>` : ""}
        </div>
      </div>

      <div class="card assistant" style="margin-bottom:18px">
        <div class="chart-head">
          <h2>Ask ${esc(ai.name || "Abhi")}</h2>
          <span class="pill ${ai.engine === "claude" ? "pill-green" : ""}">
            ${ai.engine === "claude" ? esc(ai.model) : "Offline assistant"}</span>
        </div>
        <div class="chat" aria-live="polite">
          <div class="msg bot">
            <div class="bubble">${esc(`Hi ${state.user.name}, I'm ${ai.name || "Abhi"}. `
              + `Ask me anything about your account — I can see your balance, `
              + `payments, cards, deposits and open cases.`)}</div>
          </div>
        </div>
        <div class="chips">
          ${ai.suggestions.map(q => `<button class="chip">${esc(q)}</button>`).join("")}
        </div>
        <form class="chat-form">
          <input class="chat-input" placeholder="Type your question…" autocomplete="off"
                 maxlength="1000">
          <button class="btn" type="submit">Send</button>
        </form>
      </div>

      <div class="grid grid-2">
        <div class="card" style="align-self:start">
          <h2>Report a problem</h2>
          <div id="err"></div>
          ${debits.length === 0
            ? `<div class="empty">${icon("receipt", "icon icon-lg")}
                 No payments to report yet.</div>`
            : `<form id="dispute-form" novalidate>
                <div class="field">
                  <label for="d-tx">Which payment?</label>
                  <select id="d-tx">
                    ${debits.map(t => `<option value="${t.id}">${
                      fmtDate(t.date)} · ${money(t.amount)} · ${
                      esc(t.counterpartyName || t.description || "Payment")}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="d-reason">What went wrong?</label>
                  <select id="d-reason">
                    ${Object.entries(data.reasons).map(([k, v]) =>
                      `<option value="${esc(k)}">${esc(v)}</option>`).join("")}
                  </select>
                </div>
                <button class="btn btn-block" type="submit">Resolve it now</button>
              </form>

              <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
                <h2>Paid the wrong person?</h2>
                <p style="color:var(--muted);font-size:0.85rem;margin:0 0 12px;line-height:1.6">
                  A delivered payment cannot be reversed by the bank. Ask the payee
                  to send it back — they have ${data.recalls ? "3" : "3"} days to respond,
                  and the request lapses on its own after that.
                </p>
                <button class="btn btn-ghost btn-block" id="recall-btn">
                  Request a recall for the selected payment</button>
              </div>`}
        </div>

        <div class="card">
          <h2>Your cases</h2>
          <div id="case-list">${renderDisputes(data.disputes)}</div>

          <h2 style="margin-top:22px">Recalls</h2>
          <div id="recall-list">${renderRecalls(data.recalls)}</div>
        </div>
      </div>

      <div style="margin-top:18px">${helpCards()}</div>`;

    wireChat(document.querySelector(".assistant"), ai.name || "Abhi");

    const form = document.getElementById("dispute-form");
    if (form) {
      form.onsubmit = async event => {
        event.preventDefault();
        const button = event.target.querySelector("button[type=submit]");
        button.disabled = true;
        try {
          const result = await api("/support/disputes", {
            method: "POST",
            body: {
              transactionId: document.getElementById("d-tx").value,
              reason: document.getElementById("d-reason").value
            }
          });
          toast(result.message, result.dispute.needsHuman ? "" : "ok");
          supportView();
        } catch (err) {
          document.getElementById("err").innerHTML =
            `<div class="form-error">${esc(err.message)}</div>`;
          button.disabled = false;
        }
      };

      document.getElementById("recall-btn").onclick = async event => {
        event.target.disabled = true;
        try {
          const result = await api("/support/recalls", {
            method: "POST",
            body: { transactionId: document.getElementById("d-tx").value }
          });
          toast(result.message, "ok");
          supportView();
        } catch (err) {
          document.getElementById("err").innerHTML =
            `<div class="form-error">${esc(err.message)}</div>`;
          event.target.disabled = false;
        }
      };
    }

    document.getElementById("recall-list").onclick = async event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(
          `/support/recalls/${button.dataset.id}/${button.dataset.action}`,
          { method: "POST" });
        toast(result.message, "ok");
        supportView();
      } catch (err) {
        toast(err.message, "err");
        button.disabled = false;
      }
    };
  }

  function renderDisputes(disputes) {
    if (!disputes.length) {
      return `<div class="empty">${icon("check", "icon icon-lg")}No open cases.</div>`;
    }

    const pill = {
      auto_resolved: `<span class="pill pill-green">Resolved automatically</span>`,
      awaiting_window: `<span class="pill pill-amber">Auto-resolves shortly</span>`,
      escalated: `<span class="pill pill-red">With our team</span>`,
      closed: `<span class="pill">Closed</span>`
    };

    return disputes.map(d => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div style="font-weight:600">${esc(d.reason)}</div>
            <div class="ss-meta">Ticket ${esc(d.ticket)} · ${fmtDate(d.createdAt)}</div>
          </div>
          ${pill[d.status] || ""}
        </div>
        ${d.refunded > 0
          ? `<div class="ss-meta" style="margin-top:6px">
               Refunded <b class="amount-in">${money(d.refunded)}</b></div>` : ""}
        ${d.outcome ? `<div class="ss-meta" style="margin-top:4px">${esc(d.outcome)}</div>` : ""}
        <ol class="timeline">
          ${d.events.map(e => `
            <li class="${e.automated ? "auto" : "human"}">
              <b>${esc(e.label)}</b>
              ${e.detail ? `<span>${esc(e.detail)}</span>` : ""}
            </li>`).join("")}
        </ol>
      </div>`).join("");
  }

  function renderRecalls(recalls) {
    if (!recalls.length) {
      return `<div class="empty" style="padding:20px">No recalls.</div>`;
    }

    const pill = {
      pending: `<span class="pill pill-amber">Pending</span>`,
      returned: `<span class="pill pill-green">Returned</span>`,
      declined: `<span class="pill pill-red">Declined</span>`,
      expired: `<span class="pill">Expired</span>`
    };

    return recalls.map(r => `
      <div class="ss-item">
        <div class="ss-top">
          <div>
            <div class="ss-amount">${money(r.amount)}</div>
            <div class="ss-meta">
              ${r.role === "payer" ? "Asked" : "Asked by"} ${esc(r.counterparty)}
              ${r.reason ? " · " + esc(r.reason) : ""}
            </div>
          </div>
          ${pill[r.status] || ""}
        </div>
        ${r.status === "pending" && r.role === "payee" ? `
          <div class="ss-actions">
            <button class="btn btn-sm" data-action="return" data-id="${r.id}">
              Return the money</button>
            <button class="btn btn-sm btn-danger" data-action="decline" data-id="${r.id}">
              Decline</button>
          </div>` : ""}
        ${r.status === "pending" && r.role === "payer"
          ? `<div class="countdown">Lapses ${fmtDate(r.deadline)} if ignored</div>` : ""}
      </div>`).join("");
  }

  /* ---------- help ---------- */

  function helpCards() {
    return `
      <div class="grid grid-2">
        <div class="card">
          <h2>Payments</h2>
          <div class="help-q">
            <h3>Which QR codes can I scan?</h3>
            <p>Any standard UPI QR — the <code>upi://pay</code> format used by every
               Indian payment app and merchant. Point the camera at it, check the payee
               and amount, enter your UPI PIN and pay. You can also paste a UPI ID.</p>
          </div>
          <div class="help-q">
            <h3>How do I know the payee is genuine?</h3>
            <p>For AB Pay payees we show the name from our own records with a
               <b>verified</b> tag, never the name written inside the QR. For other banks
               we can only show what the code claims, and we label it as such.</p>
          </div>
          <div class="help-q">
            <h3>What are the limits?</h3>
            <p>UPI is capped at ₹1,00,000 per transaction as per NPCI rules. Bank
               transfers allow up to ₹10,00,000, and a monthly limit applies across all
               outgoing payments.</p>
          </div>
          <div class="help-q">
            <h3>IMPS, NEFT or RTGS?</h3>
            <p>IMPS is instant and works around the clock. NEFT settles in batches.
               RTGS is for high-value transfers of ₹2,00,000 and above.</p>
          </div>
          <div class="help-q">
            <h3>I forgot my UPI PIN</h3>
            <p>Go to Services › UPI PIN. You will need your current PIN to change it.</p>
          </div>
        </div>

        <div class="card">
          <h2>Safe Send</h2>
          <div class="help-q">
            <h3>What makes it different from UPI?</h3>
            <p>A UPI payment is gone the moment you approve it. With Safe Send the money
               leaves your balance but is held by the bank — the recipient can see it is
               committed but cannot spend it until you release it.</p>
          </div>
          <div class="help-q">
            <h3>When should I use it?</h3>
            <p>Any time you are paying someone you do not know personally: OLX and
               marketplace purchases, private ads, rental deposits, or a contractor
               asking for money up front.</p>
          </div>
          <div class="help-q">
            <h3>What if the seller never delivers?</h3>
            <p>Do nothing. If you never release the funds they are refunded to you
               automatically when your chosen window expires. You can also cancel at any
               point while the payment is still held.</p>
          </div>

          <h2 style="margin-top:22px">Deposits &amp; cards</h2>
          <div class="help-q">
            <h3>Can I break an FD early?</h3>
            <p>Yes. Premature closure returns your principal with interest at 1% below
               the contracted rate, which is standard practice.</p>
          </div>
          <div class="help-q">
            <h3>My card is lost</h3>
            <p>Go to Cards and block it immediately — it takes effect at once. You can
               also switch off ATM, online or international usage individually rather
               than blocking the whole card.</p>
          </div>
        </div>
      </div>`;
  }

  /* ---------- router ---------- */

  const ROUTES = {
    "#/dashboard": dashboardView,
    "#/pay": payView,
    "#/transfer": transferView,
    "#/safesend": transferView,
    "#/recharge": rechargeView,
    "#/deposits": depositsView,
    "#/cards": cardsView,
    "#/statement": statementView,
    "#/services": servicesView,
    "#/support": supportView
  };

  /*
   * A hash may carry a query, e.g. "#/receive?amount=500" — that is how a
   * shared payment request pre-fills. Split it before matching the route.
   */
  function parseHash() {
    const raw = location.hash || "#/dashboard";
    const cut = raw.indexOf("?");
    return {
      route: cut === -1 ? raw : raw.slice(0, cut),
      params: new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1))
    };
  }

  async function render() {
    stopScanner();
    const { route, params } = parseHash();

    // The real-payment page is public — no session required to scan it.
    if (route === "#/receive") {
      removeAssistantLauncher();
      try {
        return await receiveView(params);
      } catch (err) {
        return toast(err.message, "err");
      }
    }

    if (!state.token) {
      removeAssistantLauncher();
      if (route === "#/signup") return signupView();
      if (route === "#/forgot") return forgotView();
      return loginView();
    }

    // Restore the session on a page reload before rendering anything private.
    if (!state.user) {
      try {
        const me = await api("/me");
        state.user = me.user;
        state.account = me.account;
      } catch {
        return loginView();
      }
    }

    const view = ROUTES[route] || dashboardView;
    try {
      await view();
      mountAssistantLauncher();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  window.addEventListener("hashchange", render);
  render();
})();
