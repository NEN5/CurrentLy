// History page: power events (outages / brown outs) and the theft log. Refreshes itself.
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

  const POLL_MS = 20000; // the meter posts every 20 s, so faster than this finds nothing new

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const clock = (ms) =>
    new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  const clockSec = (ms) =>
    new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function dayLabel(ms) {
    const now = Date.now();
    if (sameDay(ms, now)) return "Today";
    if (sameDay(ms, now - 86400000)) return "Yesterday";
    return new Date(ms).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
  }
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
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Groups events (newest first) under a heading per day, then builds each row with `row(e)`.
  function renderLog(host, events, timeOf, row, emptyText) {
    if (!events.length) return host.replaceChildren(el("p", "hx-empty", emptyText));
    const nodes = [];
    let last = null;
    for (const e of events) {
      const label = dayLabel(timeOf(e));
      if (label !== last) {
        nodes.push(el("h3", "hx-day", label));
        last = label;
      }
      nodes.push(row(e));
    }
    host.replaceChildren(...nodes);
  }

  // ---- power events ---------------------------------------------------------------------------
  function outageRow(e) {
    const isOutage = e.kind === "outage";
    const r = el("div", "hx-row");
    r.append(el("span", "hx-time", clock(e.start)));

    // One kind of entry; the text after the title says whether power was lost or only sagged.
    const what = el("div", "hx-what");
    what.append(el("b", "out", "Power outage / brown out"));
    if (e.ongoing) what.append(el("span", "sub", " · still ongoing"));
    else if (isOutage && e.end && !e.lowVoltage) what.append(el("span", "sub", ` · power back at ${clock(e.end)}`));
    else if (e.lowVoltage) what.append(el("span", "sub", " · voltage fell to near 0 V"));
    else if (e.minVoltage != null) what.append(el("span", "sub", ` · voltage dropped to ${Math.round(e.minVoltage)} V`));
    r.append(what);

    r.append(el("span", e.ongoing ? "hx-dur live" : "hx-dur", e.ongoing ? "ongoing" : fmtDuration(e.minutes)));

    const dl = el("dl", "hx-data");
    const add = (label, value, cls) => {
      dl.append(el("dt", "", label));
      dl.append(el("dd", cls || "", value));
    };
    if (e.before) add("Before", wv(e.before));
    if (e.after) add("When power returned", wv(e.after));
    if (e.afterPeak) {
      add(`Peak in next ${e.afterPeak.minutes} min`, wv(e.afterPeak));
      if (e.afterPeak.surge) add("Voltage surge", `${Math.round(e.afterPeak.voltage)} V when power came back`, "warn");
    }
    if (e.kwhMonth != null) {
      add(
        "Used by then",
        (e.kwhToday != null ? `${kwh(e.kwhToday)} kWh today · ` : "") + `${kwh(e.kwhMonth)} kWh this month`,
      );
      add("Bill", `${money(e.bill, e.currency)} so far · ${money(e.projectedBill, e.currency)} projected`);
    }
    if (dl.children.length) r.append(dl);
    return r;
  }

  let outages = [];
  function renderOutages() {
    renderLog($("outageList"), outages, (e) => e.start, outageRow, "No outages or brown outs recorded.");
  }
  function summarizeOutages() {
    const done = outages.filter((e) => e.kind === "outage" && !e.ongoing);
    const down = done.reduce((s, e) => s + e.minutes, 0);
    const parts = [];
    if (outages.some((e) => e.ongoing)) parts.push("Power appears to be out right now.");
    parts.push(
      outages.length
        ? `${plural(outages.length, "power event", "power events")} in the last 14 days` +
            (done.length ? `, ${fmtDuration(down)} without power in total.` : ".")
        : "No outages or brown outs in the last 14 days.",
    );
    $("outageSummary").textContent = parts.join(" ");
  }

  // ---- theft ----------------------------------------------------------------------------------
  let theft = [];
  function renderTheft() {
    $("theftSummary").textContent = theft.length
      ? `${plural(theft.length, "possible theft event", "possible theft events")}. Most recent: ${dayLabel(theft[0].at)}, ${clock(theft[0].at)}.`
      : "No theft detected.";
    renderLog(
      $("theftList"),
      theft,
      (e) => e.at,
      (e) => {
        const r = el("div", "hx-row");
        r.append(el("span", "hx-time", clock(e.at)));
        r.append(el("div", "hx-what", ""));
        r.lastChild.append(el("b", "out", "Possible theft detected"));
        r.append(el("span", "hx-dur", ""));
        if (e.detail) r.append(el("p", "hx-text", e.detail));
        return r;
      },
      "No theft detected.",
    );
  }

  // ---- loading and self-refresh -----------------------------------------------------------------
  const kinds = {
    outages: { data: () => outages, set: (v) => (outages = v), draw: () => (summarizeOutages(), renderOutages()), list: "outageList" },
    theft: { data: () => theft, set: (v) => (theft = v), draw: () => renderTheft(), list: "theftList" },
  };
  const seen = {}; // kind -> JSON of what is on screen, so the page only redraws when something changed
  let active = "outages";
  let timer = null;

  function stamp(kind, text, stale) {
    const s = document.querySelector(`.hx-updated[data-for="${kind}"]`);
    s.textContent = text;
    s.classList.toggle("stale", !!stale);
  }

  async function refresh(kind) {
    const k = kinds[kind];
    const msg = $("hxMsg");
    if (token === "guest") {
      $(k.list).replaceChildren(el("p", "hx-empty", "Log in to see your history."));
      return;
    }
    try {
      const { events } = await API.get("/history/" + kind);
      if (!Array.isArray(events))
        throw new Error("Could not reach the server. Check the connection and that the site points at your backend.");
      msg.textContent = "";
      const sig = JSON.stringify(events);
      if (sig !== seen[kind]) {
        seen[kind] = sig;
        k.set(events);
        k.draw();
      }
      stamp(kind, `Updated ${clockSec(Date.now())} · refreshes automatically`, false);
    } catch (err) {
      if (seen[kind] === undefined) {
        msg.textContent = err.message;
        $(k.list).replaceChildren();
      } else stamp(kind, "Connection lost, retrying…", true); // keep showing what we already have
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) refresh(active);
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(active); // catch up as soon as the tab is looked at again
  });

  function showTab(name) {
    active = name;
    for (const b of document.querySelectorAll(".hx-tabs button"))
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    $("paneOutages").hidden = name !== "outages";
    $("paneTheft").hidden = name !== "theft";
    history.replaceState(null, "", "#" + name);
    if (seen[name] === undefined) $(kinds[name].list).replaceChildren(el("p", "hx-empty", "Loading…"));
    refresh(name);
    schedule();
  }
  for (const b of document.querySelectorAll(".hx-tabs button"))
    b.addEventListener("click", () => showTab(b.dataset.tab));

  showTab(location.hash === "#theft" ? "theft" : "outages");
})();
