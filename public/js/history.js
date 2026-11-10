// History page: outage / brown-out log and theft detection log.
// GET /api/history/outages -> { events: [{ kind, start, end, minutes, minVoltage, ongoing, lowVoltage,
//                                          before, after, afterPeak, kwhToday, kwhMonth, bill, projectedBill, currency }] }
// GET /api/history/theft   -> { events: [{ id, at, detail }] }
(() => {
  const $ = (id) => document.getElementById(id);
  const token = localStorage.getItem("token");
  if (!token) {
    location.href = "login.html";
    return;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const fmtWhen = (ms) =>
    new Date(ms).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  function fmtDuration(min) {
    if (min < 1) return "under 1 min";
    if (min < 60) return `${Math.round(min)} min`;
    const h = Math.floor(min / 60),
      m = Math.round(min % 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const num = (n, d) =>
    n.toLocaleString("en-PH", { minimumFractionDigits: d, maximumFractionDigits: d });
  const kwh = (n) => num(n, n < 1 ? 3 : 1);
  const money = (n, c) => `${c || "₱"}${num(n, 2)}`;
  const wv = (r) => `${Math.round(r.watts)} W · ${Math.round(r.voltage)} V`;

  const empty = (list, text) => list.replaceChildren(el("li", "hx-empty", text));
  const tile = (value, label) => {
    const t = el("div", "hx-tile");
    t.append(el("b", "", value), el("span", "", label));
    return t;
  };
  const stat = (label, value) => {
    const s = el("div", "hx-stat");
    s.append(el("span", "", label), el("b", "", value));
    return s;
  };

  // ---- outages --------------------------------------------------------------------------------
  function outageCard(e) {
    const isOutage = e.kind === "outage";
    const card = el("li", "hx-card" + (isOutage ? "" : " warn"));

    const left = el("div");
    const title = el("div", "hx-title", isOutage ? "Power outage" : "Brown out");
    if (e.ongoing) title.append(el("span", "hx-badge", "Still ongoing"));
    if (e.afterPeak && e.afterPeak.surge)
      title.append(el("span", "hx-badge surge", "⚠ Voltage surge"));
    left.append(title);
    let when = fmtWhen(e.start);
    if (!e.ongoing && e.end && isOutage && !e.lowVoltage) when += `  →  power back ${fmtWhen(e.end)}`;
    left.append(el("div", "hx-when", when));

    const dur = el("div", "hx-dur", e.ongoing ? "ongoing" : fmtDuration(e.minutes));
    dur.append(
      el(
        "small",
        "",
        e.lowVoltage
          ? "voltage near 0 V"
          : e.kind === "brownout" && e.minVoltage != null
            ? `dropped to ${Math.round(e.minVoltage)} V`
            : "duration",
      ),
    );
    const head = el("div", "hx-head");
    head.append(left, dur);
    card.append(head);

    const stats = el("div", "hx-stats");
    if (e.before) stats.append(stat("Before", wv(e.before)));
    if (e.after) stats.append(stat("When power returned", wv(e.after)));
    if (e.afterPeak)
      stats.append(stat(`Peak in next ${e.afterPeak.minutes} min`, wv(e.afterPeak)));
    if (e.kwhMonth != null) {
      if (e.kwhToday != null) stats.append(stat("Used today by then", `${kwh(e.kwhToday)} kWh`));
      stats.append(stat("Used this month by then", `${kwh(e.kwhMonth)} kWh`));
      stats.append(stat("Estimated bill", money(e.bill, e.currency)));
      stats.append(stat("Projected bill", money(e.projectedBill, e.currency)));
    }
    if (stats.children.length) card.append(stats);
    return card;
  }

  let outages = [];
  let filter = "all";
  function renderOutages() {
    const list = $("outageList");
    const shown = outages.filter((e) => filter === "all" || e.kind === filter);
    if (!shown.length)
      return empty(
        list,
        outages.length ? "Nothing in this filter." : "No outages or brown outs recorded.",
      );
    list.replaceChildren(...shown.map(outageCard));
  }
  function summarizeOutages() {
    const out = outages.filter((e) => e.kind === "outage");
    const brown = outages.filter((e) => e.kind === "brownout");
    const done = out.filter((e) => !e.ongoing);
    const total = done.reduce((s, e) => s + e.minutes, 0);
    const longest = done.reduce((m, e) => Math.max(m, e.minutes), 0);
    $("outageSummary").replaceChildren(
      tile(String(out.length), "Power outages"),
      tile(String(brown.length), "Brown outs"),
      tile(done.length ? fmtDuration(total) : "—", "Total downtime"),
      tile(done.length ? fmtDuration(longest) : "—", "Longest outage"),
    );
  }

  // ---- theft ----------------------------------------------------------------------------------
  function renderTheft(events) {
    const list = $("theftList");
    $("theftSummary").replaceChildren(
      tile(String(events.length), "Possible theft events"),
      tile(events.length ? fmtWhen(events[0].at) : "—", "Most recent"),
    );
    if (!events.length) return empty(list, "No theft detected.");
    list.replaceChildren(
      ...events.map((e) => {
        const card = el("li", "hx-card");
        const head = el("div", "hx-head");
        const left = el("div");
        left.append(el("div", "hx-title", "Possible theft detected"), el("div", "hx-when", fmtWhen(e.at)));
        head.append(left);
        card.append(head);
        if (e.detail) card.append(el("p", "hx-detail", e.detail));
        return card;
      }),
    );
  }

  // ---- loading --------------------------------------------------------------------------------
  const loaded = {};
  async function load(kind) {
    const msg = $("hxMsg");
    msg.textContent = "";
    const list = $(kind === "outages" ? "outageList" : "theftList");
    if (token === "guest") return empty(list, "Log in to see your history.");
    if (loaded[kind]) return;
    empty(list, "Loading…");
    try {
      const { events } = await API.get("/history/" + kind);
      if (!Array.isArray(events))
        throw new Error(
          "Could not reach the server. Check the connection and that the site points at your backend.",
        );
      loaded[kind] = true;
      if (kind === "outages") {
        outages = events;
        summarizeOutages();
        renderOutages();
      } else renderTheft(events);
    } catch (err) {
      empty(list, "");
      msg.textContent = err.message;
    }
  }

  function showTab(name) {
    for (const b of document.querySelectorAll(".hx-tabs button"))
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    $("paneOutages").hidden = name !== "outages";
    $("paneTheft").hidden = name !== "theft";
    history.replaceState(null, "", "#" + name);
    load(name);
  }
  for (const b of document.querySelectorAll(".hx-tabs button"))
    b.addEventListener("click", () => showTab(b.dataset.tab));
  for (const c of document.querySelectorAll(".hx-chip"))
    c.addEventListener("click", () => {
      filter = c.dataset.filter;
      for (const o of document.querySelectorAll(".hx-chip"))
        o.setAttribute("aria-pressed", String(o === c));
      renderOutages();
    });

  showTab(location.hash === "#theft" ? "theft" : "outages");
})();
