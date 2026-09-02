/*
 * Charts, drawn as inline SVG. No charting library.
 *
 * Palette note: the two-series pair (#2563eb / #ea8c00) was chosen by running
 * a colour-vision-deficiency check rather than by eye — blue/orange separates
 * cleanly for protan, deutan and tritan viewers, where the obvious green/red
 * pair does not. Identity never rests on colour alone: every multi-series
 * chart also carries a legend and direct labels.
 */

window.Charts = (() => {
  "use strict";

  const SERIES_IN = "#2563eb";
  const SERIES_OUT = "#ea8c00";
  const SINGLE = "#003874";

  const esc = value => String(value ?? "").replace(/[&<>"']/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN",
    { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const inrExact = n => "₹" + Number(n || 0).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const shortDate = iso => new Date(iso + "T00:00:00")
    .toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  const monthName = ym => new Date(ym + "-01T00:00:00")
    .toLocaleDateString("en-IN", { month: "short", year: "2-digit" });

  /* A "nice" axis maximum, so gridlines land on round numbers. */
  function niceMax(value) {
    if (value <= 0) return 100;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const scaled = value / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  }

  /* ---------- shared tooltip ---------- */

  let tip;
  function tooltip() {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "chart-tip";
      document.body.appendChild(tip);
    }
    return tip;
  }

  function showTip(html, event) {
    const el = tooltip();
    el.innerHTML = html;
    el.classList.add("show");

    const box = el.getBoundingClientRect();
    let left = event.clientX + 14;
    // Flip to the other side rather than overflow the viewport.
    if (left + box.width > window.innerWidth - 8) left = event.clientX - box.width - 14;
    el.style.left = Math.max(8, left) + "px";
    el.style.top = Math.max(8, event.clientY - box.height - 10) + "px";
  }

  const hideTip = () => tip && tip.classList.remove("show");

  /* ---------- daily spend trend ---------- */

  /*
   * One series, so no legend — the heading names it. Gridlines and axes stay
   * recessive; the line is the only thing at full strength.
   */
  function trend(el, daily) {
    const W = 720, H = 240;
    const padL = 54, padR = 14, padT = 14, padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const max = niceMax(Math.max(...daily.map(d => d.out), 1));
    const x = i => padL + (daily.length <= 1 ? 0 : (i / (daily.length - 1)) * plotW);
    const y = v => padT + plotH - (v / max) * plotH;

    const gridValues = [0, max / 2, max];
    const line = daily.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.out).toFixed(1)}`)
      .join(" ");
    const area = `${line} L${x(daily.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;

    // Label roughly six dates, whatever the range length.
    const tickEvery = Math.max(1, Math.round(daily.length / 6));

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
           aria-label="Daily spending over the last ${daily.length} days">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${SINGLE}" stop-opacity="0.16"/>
            <stop offset="100%" stop-color="${SINGLE}" stop-opacity="0"/>
          </linearGradient>
        </defs>

        ${gridValues.map(v => `
          <line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
          <text x="${padL - 8}" y="${y(v) + 4}" class="axis-label" text-anchor="end">
            ${esc(inr(v))}</text>`).join("")}

        <path d="${area}" fill="url(#trendFill)"/>
        <path d="${line}" fill="none" stroke="${SINGLE}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round"/>

        ${daily.map((d, i) => i % tickEvery === 0 ? `
          <text x="${x(i)}" y="${H - 8}" class="axis-label" text-anchor="middle">
            ${esc(shortDate(d.date))}</text>` : "").join("")}

        <g class="hit-layer">
          ${daily.map((d, i) => `
            <rect x="${(x(i) - plotW / daily.length / 2).toFixed(1)}" y="${padT}"
                  width="${(plotW / daily.length).toFixed(1)}" height="${plotH}"
                  fill="transparent" data-i="${i}"/>`).join("")}
        </g>
        <g class="crosshair" hidden>
          <line class="cross-line" y1="${padT}" y2="${padT + plotH}"/>
          <circle class="cross-dot" r="4.5" fill="${SINGLE}"/>
        </g>
      </svg>`;

    const svg = el.querySelector("svg");
    const cross = svg.querySelector(".crosshair");
    const crossLine = svg.querySelector(".cross-line");
    const dot = svg.querySelector(".cross-dot");

    svg.querySelector(".hit-layer").addEventListener("mousemove", event => {
      const rect = event.target.closest("rect");
      if (!rect) return;
      const i = Number(rect.dataset.i);
      const d = daily[i];

      cross.hidden = false;
      crossLine.setAttribute("x1", x(i));
      crossLine.setAttribute("x2", x(i));
      dot.setAttribute("cx", x(i));
      dot.setAttribute("cy", y(d.out));

      showTip(
        `<b>${esc(shortDate(d.date))}</b>` +
        `<span>Spent ${esc(inrExact(d.out))}</span>` +
        (d.in > 0 ? `<span>Received ${esc(inrExact(d.in))}</span>` : ""),
        event);
    });

    svg.addEventListener("mouseleave", () => { cross.hidden = true; hideTip(); });

    withTable(el, {
      caption: `Daily spending over the last ${daily.length} days`,
      columns: ["Date", "Spent", "Received"],
      rows: daily.map(d => [shortDate(d.date), inrExact(d.out), inrExact(d.in)])
    });
  }

  /* ---------- spending by category ---------- */

  /*
   * One measure across categories, so one hue: the category names on the axis
   * carry identity, and colouring each bar differently would encode nothing.
   */
  function categories(el, rows) {
    if (!rows.length) {
      el.innerHTML = `<div class="chart-empty">No spending in this period.</div>`;
      return;
    }

    const max = Math.max(...rows.map(r => r.total), 1);
    const total = rows.reduce((sum, r) => sum + r.total, 0);

    el.innerHTML = rows.map(r => {
      const pct = (r.total / max) * 100;
      const share = total > 0 ? (r.total / total) * 100 : 0;
      return `
        <div class="cbar" tabindex="0"
             data-tip="${esc(r.category)}|${esc(inrExact(r.total))}|${share.toFixed(1)}% of spending">
          <div class="cbar-name">${esc(r.category)}</div>
          <div class="cbar-track">
            <div class="cbar-fill" style="width:${pct.toFixed(1)}%"></div>
          </div>
          <div class="cbar-val">${esc(inrExact(r.total))}</div>
        </div>`;
    }).join("");

    el.querySelectorAll(".cbar").forEach(bar => {
      const [name, amount, share] = bar.dataset.tip.split("|");
      const show = event => showTip(
        `<b>${esc(name)}</b><span>${esc(amount)}</span><span>${esc(share)}</span>`, event);
      bar.addEventListener("mousemove", show);
      bar.addEventListener("mouseleave", hideTip);
    });

    withTable(el, {
      caption: "Spending by category",
      columns: ["Category", "Amount", "Share"],
      rows: rows.map(r => [
        r.category, inrExact(r.total),
        (total > 0 ? ((r.total / total) * 100).toFixed(1) : "0") + "%"
      ])
    });
  }

  /* ---------- money in vs money out ---------- */

  /*
   * Two series, so a legend is always present and both are direct-labelled —
   * identity never depends on colour alone.
   */
  function inOut(el, monthly) {
    if (!monthly.length) {
      el.innerHTML = `<div class="chart-empty">Not enough history yet.</div>`;
      return;
    }

    const W = 720, H = 250;
    const padL = 54, padR = 14, padT = 30, padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const max = niceMax(Math.max(...monthly.flatMap(m => [m.in, m.out]), 1));
    const groupW = plotW / monthly.length;
    const barW = Math.min(34, (groupW - 10) / 2);
    const y = v => padT + plotH - (v / max) * plotH;
    const gridValues = [0, max / 2, max];

    // A 2px gap keeps adjacent bars from reading as one shape.
    const bar = (cx, value, colour, label) => {
      const height = Math.max(0, plotH - (y(value) - padT));
      return `<rect x="${cx.toFixed(1)}" y="${y(value).toFixed(1)}"
                    width="${barW.toFixed(1)}" height="${height.toFixed(1)}"
                    rx="4" fill="${colour}" data-tip="${esc(label)}"/>`;
    };

    el.innerHTML = `
      <div class="legend">
        <span class="legend-item"><i style="background:${SERIES_IN}"></i>Money in</span>
        <span class="legend-item"><i style="background:${SERIES_OUT}"></i>Money out</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
           aria-label="Money in against money out, by month">
        ${gridValues.map(v => `
          <line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
          <text x="${padL - 8}" y="${y(v) + 4}" class="axis-label" text-anchor="end">
            ${esc(inr(v))}</text>`).join("")}

        ${monthly.map((m, i) => {
          const centre = padL + groupW * i + groupW / 2;
          return `
            ${bar(centre - barW - 1, m.in, SERIES_IN,
                  `${monthName(m.month)}|In ${inrExact(m.in)}`)}
            ${bar(centre + 1, m.out, SERIES_OUT,
                  `${monthName(m.month)}|Out ${inrExact(m.out)}`)}
            <text x="${centre}" y="${H - 10}" class="axis-label" text-anchor="middle">
              ${esc(monthName(m.month))}</text>`;
        }).join("")}
      </svg>`;

    el.querySelectorAll("rect[data-tip]").forEach(rect => {
      const [label, value] = rect.dataset.tip.split("|");
      rect.addEventListener("mousemove", event =>
        showTip(`<b>${esc(label)}</b><span>${esc(value)}</span>`, event));
      rect.addEventListener("mouseleave", hideTip);
    });

    withTable(el, {
      caption: "Money in against money out, by month",
      columns: ["Month", "In", "Out"],
      rows: monthly.map(m => [monthName(m.month), inrExact(m.in), inrExact(m.out)])
    });
  }

  /*
   * A readable table behind every chart.
   *
   * An SVG carries no numbers a screen reader can read out, and it does not
   * survive printing or forced-colours mode. The same data as a table is the
   * accessible equivalent, so identity and value never depend on seeing the
   * picture.
   */
  function withTable(container, { caption, columns, rows }) {
    const id = "tbl-" + Math.random().toString(36).slice(2, 8);

    const wrap = document.createElement("div");
    wrap.className = "chart-table-wrap";
    wrap.innerHTML = `
      <button class="chart-table-toggle" aria-expanded="false" aria-controls="${id}">
        View as table
      </button>
      <div class="chart-table" id="${id}" hidden>
        <table class="table">
          <caption class="sr-only">${esc(caption)}</caption>
          <thead><tr>${columns.map((c, i) =>
            `<th${i ? ' class="num"' : ""} scope="col">${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map(r => `<tr>${r.map((cell, i) =>
              `<td${i ? ' class="num"' : ""}>${esc(cell)}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    container.appendChild(wrap);

    const toggle = wrap.querySelector(".chart-table-toggle");
    const table = wrap.querySelector(".chart-table");

    toggle.onclick = () => {
      const open = table.hidden;
      table.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide table" : "View as table";
    };
  }

  return { trend, categories, inOut };
})();
