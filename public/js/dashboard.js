if (!localStorage.getItem("token")) location.href = "/login.html";

const $ = (id) => document.getElementById(id);
let state = { range: "daily", summary: null };
const money = (n, c) =>
  c +
  n.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const kwh = (n) =>
  n.toLocaleString("en-PH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

// ---- Summary: bill, kWh, trend ---------------------------------------------
async function loadSummary() {
  const s = (state.summary = await API.get("/sensor-data/summary"));
  $("bill").textContent = money(s.bill, s.currency);
  $("projected").textContent =
    `Projected for the month: ${money(s.projectedBill, s.currency)}`;
  $("monthKwh").textContent = kwh(s.monthKwh);
  $("todayKwh").textContent = kwh(s.todayKwh);
  $("livePower").textContent =
    s.livePower === null ? "—" : Math.round(s.livePower);
  if (document.activeElement !== $("rate")) $("rate").value = s.rate;
  $("rateUnit").textContent = s.currency;
  $("calcRate").textContent = `${s.currency}${s.rate} per kWh`;
  renderChart();
}
function renderChart() {
  const s = state.summary;
  if (!s) return;
  $("chartHint").textContent =
    state.range === "daily" ? "Last 30 days" : "Last 6 months";
  drawTrend($("chart"), s[state.range], (p) => {
    $("readout").textContent = p
      ? `${p.label}: ${kwh(p.value)} kWh (${money(p.value * s.rate, s.currency)})`
      : "Hover or tap the chart for details";
  });
}
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () => {
    state.range = b.dataset.range;
    document
      .querySelectorAll("[data-range]")
      .forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderChart();
  }),
);

// ---- Live power: GET /api/sensor-data/history (average watts per bucket) -----
let histMinutes = 60;
async function loadHistory() {
  try {
    const h = await API.get("/sensor-data/history?minutes=" + histMinutes);
    $("liveHint").textContent = `Average watts, ${h.bucketMinutes}-min buckets`;
    drawTrend($("liveChart"), h.points, (p) => {
      $("liveReadout").textContent = p
        ? `${p.label}: ${Math.round(p.value)} W`
        : "Hover or tap the chart for details";
    });
  } catch {
    /* keep the last chart on a transient error */
  }
}
document.querySelectorAll("[data-hist]").forEach((b) =>
  b.addEventListener("click", () => {
    histMinutes = Number(b.dataset.hist);
    document
      .querySelectorAll("[data-hist]")
      .forEach((x) => x.setAttribute("aria-pressed", x === b));
    loadHistory();
  }),
);

// ---- ESP32 INTEGRATION: device status pill ---------------------------------
// Polls GET /api/device/status. The server marks the device online while the ESP32
// keeps POSTing to /api/sensor-data (timeout is ONLINE_TIMEOUT_MS in data/store.js).
async function loadStatus() {
  const d = await API.get("/device/status");
  const labels = { online: "Online", offline: "Offline" };
  $("status").dataset.state = d.state;
  $("statusText").textContent = labels[d.state];
  $("status").title = d.lastSeen
    ? `Last seen ${Math.round((d.serverTime - d.lastSeen) / 1000)} seconds ago`
    : "No data received yet";
}

// ---- Settings ----------------------------------------------------------------
$("rate").addEventListener("change", async (e) => {
  try {
    await API.put("/settings", { rate: Number(e.target.value) });
    $("rateMsg").textContent = "";
  } catch (err) {
    $("rateMsg").textContent = err.message;
  }
  loadSummary();
});
// Logout asks for confirmation first, to avoid accidental clicks.
const ldlg = $("logoutConfirm");
$("logout").addEventListener("click", () => ldlg.showModal());
$("logoutCancel").addEventListener("click", () => ldlg.close());
$("logoutYes").addEventListener("click", () => {
  localStorage.clear();
  location.href = "/login.html";
});
ldlg.addEventListener("click", (e) => {
  if (e.target === ldlg) ldlg.close();
});

// ---- Floating calculator (client-side only, no backend) ----------------------
const dlg = $("calc");
$("calcOpen").addEventListener("click", () => {
  dlg.showModal();
  calc();
});
$("calcClose").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => {
  if (e.target === dlg) dlg.close();
}); // click outside closes; Esc works natively
["watts", "hours"].forEach((id) => $(id).addEventListener("input", calc));
function calc() {
  const s = state.summary || { rate: 12, currency: "₱" };
  const w = Math.max(0, Number($("watts").value) || 0),
    h = Math.min(24, Math.max(0, Number($("hours").value) || 0));
  const day = (w * h) / 1000; // kWh per day
  $("rDayKwh").textContent = kwh(day);
  $("rMonthKwh").textContent = kwh(day * 30);
  $("rDay").textContent = money(day * s.rate, s.currency);
  $("rMonth").textContent = money(day * 30 * s.rate, s.currency);
}

// ---- Device pairing: 6-digit code with a countdown (the API key is never shown) ----
const pdlg = $("pair");
let pairTimer = null,
  pairEnd = 0;
function pairTick() {
  const left = Math.round((pairEnd - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(pairTimer);
    $("pairCode").textContent = "——";
    $("pairTimer").textContent = 'Code expired. Tap "New code".';
    return;
  }
  $("pairTimer").textContent =
    `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
async function newPairCode() {
  $("pairMsg").textContent = "";
  try {
    const r = await API.post("/device/pair-code");
    $("pairCode").textContent = r.code;
    pairEnd = Date.now() + r.expiresInSec * 1000;
    clearInterval(pairTimer);
    pairTimer = setInterval(pairTick, 1000);
    pairTick();
  } catch (err) {
    $("pairMsg").textContent = err.message;
  }
}
$("pairOpen").addEventListener("click", () => {
  pdlg.showModal();
  newPairCode();
});
$("pairNew").addEventListener("click", newPairCode);
$("pairClose").addEventListener("click", () => pdlg.close());
pdlg.addEventListener("close", () => clearInterval(pairTimer));
pdlg.addEventListener("click", (e) => {
  if (e.target === pdlg) pdlg.close();
});

loadSummary();
loadStatus();
loadHistory();
setInterval(loadSummary, 5000);
setInterval(loadStatus, 10000);
setInterval(loadHistory, 30000);

// Simulated data no longer exists: hide the old toggle if it is still in index.html.
$("mockToggle")?.closest("label")?.remove();

// ---- Meralco monthly rate (from /api/rates/meralco; defaults to September 2026) ----
async function loadMeralcoRate() {
  const el = $("rateKwh");
  if (!el) return;
  try {
    const r = await API.get("/rates/meralco");
    el.textContent = r.overall_rate_per_kwh.toFixed(4);
    el.title = `Meralco ${r.billing_period} (${r.rate_change.direction} of ₱${r.rate_change.amount_per_kwh.toFixed(4)}/kWh)`;
  } catch {
    /* keep the value already in the HTML */
  }
}
loadMeralcoRate();
setInterval(loadMeralcoRate, 6 * 3600 * 1000);

// ---- Nerd mode: raw PZEM readings + values derived from them -----------------------------
// Uses GET /sensor-data/latest (voltage, current, power, energy). S, Q and power factor are
// calculated here: S = V x A, Q = sqrt(S^2 - P^2), PF = P / S.
let nerdOn = localStorage.getItem("nerd") === "1";
const NERD_IDS = ["nV", "nA", "nW", "nVA", "nVAR", "nPF", "nKWH"];
function nerdBlank() {
  NERD_IDS.forEach((id) => {
    $(id).textContent = "—";
  });
}
async function loadNerd() {
  if (!nerdOn) return;
  if (localStorage.getItem("token") === "guest") {
    nerdBlank();
    return;
  } // /latest needs a login
  try {
    const stale = !state.summary || state.summary.livePower === null; // no fresh reading from the meter
    if (stale) {
      nerdBlank();
      return;
    }
    const { latest: r } = await API.get("/sensor-data/latest");
    if (!r) {
      nerdBlank();
      return;
    }
    const S = r.voltage * r.current; // apparent power, VA
    const Q = Math.sqrt(Math.max(S * S - r.power * r.power, 0)); // reactive power, var
    const pf = S > 0 ? Math.min(r.power / S, 1) : 0;
    $("nV").textContent = r.voltage.toFixed(1);
    $("nA").textContent = r.current.toFixed(3);
    $("nW").textContent = r.power.toFixed(1);
    $("nVA").textContent = S.toFixed(1);
    $("nVAR").textContent = Q.toFixed(1);
    $("nPF").textContent = pf.toFixed(2);
    $("nKWH").textContent = r.energy.toFixed(3);
  } catch {
    /* keep the last values on a transient error */
  }
}
function applyNerd() {
  $("nerdToggle").checked = nerdOn;
  $("nerdGrid").hidden = !nerdOn;
  $("livePower").hidden = nerdOn;
  $("liveLabel").hidden = nerdOn;
  document.querySelector(".metrics").classList.toggle("nerd", nerdOn);
  if (nerdOn) loadNerd();
}
$("nerdToggle").addEventListener("change", (e) => {
  nerdOn = e.target.checked;
  localStorage.setItem("nerd", nerdOn ? "1" : "0");
  applyNerd();
});
applyNerd();
setInterval(loadNerd, 5000);
// ---- Phone numbers: add a number, confirm it with a code the meter texts to it ----------------
const phdlg = $("phones");
let verifyingId = null;
function phoneMsg(text, good) {
  const el = $("phoneMsg");
  el.textContent = text || "";
  el.classList.toggle("ok", !!good);
}
function textBtn(label, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}
function showVerify(n) {
  verifyingId = n.id;
  $("phoneVerifyLabel").textContent =
    `Enter the 6-digit code sent to ${n.phone}`;
  $("phoneCode").value = "";
  $("phoneVerify").hidden = false;
  $("phoneCode").focus();
}
function hideVerify() {
  verifyingId = null;
  $("phoneVerify").hidden = true;
}
function renderPhones(numbers, max) {
  const list = $("phoneList");
  list.replaceChildren();
  if (!numbers.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No numbers yet.";
    list.append(li);
  }
  for (const n of numbers) {
    const li = document.createElement("li");
    li.className = "phone-item";
    const num = document.createElement("span");
    num.className = "phone-num";
    num.textContent = n.phone;
    const badge = document.createElement("span");
    badge.className = "phone-badge " + n.status;
    badge.textContent = n.status === "verified" ? "Verified" : "Pending";
    li.append(num, badge);
    if (n.status === "pending")
      li.append(textBtn("Enter code", () => showVerify(n)));
    li.append(textBtn("Remove", () => removePhone(n.id)));
    list.append(li);
  }
  $("phoneAdd").hidden = numbers.length >= max; // at the limit: remove one to add another
  if (
    verifyingId &&
    !numbers.some((n) => n.id === verifyingId && n.status === "pending")
  )
    hideVerify();
}
async function loadPhones() {
  try {
    const r = await API.get("/phones");
    renderPhones(r.numbers, r.max);
  } catch (err) {
    phoneMsg(err.message);
  }
}
async function removePhone(id) {
  phoneMsg("");
  try {
    await API.del("/phones/" + id);
  } catch (err) {
    phoneMsg(err.message);
  }
  loadPhones();
}
$("phoneAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  phoneMsg("");
  $("phoneSend").disabled = true;
  try {
    const r = await API.post("/phones", { phone: $("phoneInput").value });
    $("phoneInput").value = "";
    showVerify(r);
    phoneMsg(
      r.deviceOnline
        ? "Code is on its way. Your meter is sending the text."
        : "Waiting for your meter to come online to send the text. The code stays valid for 5 minutes.",
      true,
    );
    await loadPhones();
  } catch (err) {
    phoneMsg(err.message);
  } finally {
    $("phoneSend").disabled = false;
  }
});
$("phoneVerify").addEventListener("submit", async (e) => {
  e.preventDefault();
  phoneMsg("");
  try {
    await API.post(`/phones/${verifyingId}/verify`, {
      code: $("phoneCode").value.trim(),
    });
    hideVerify();
    phoneMsg("Number verified. Your meter will text it on theft alerts.", true);
    loadPhones();
  } catch (err) {
    phoneMsg(err.message);
  }
});
$("phoneResend").addEventListener("click", async () => {
  phoneMsg("");
  try {
    await API.post(`/phones/${verifyingId}/resend`);
    phoneMsg("New code requested.", true);
  } catch (err) {
    phoneMsg(err.message);
  }
});
$("phonesOpen").addEventListener("click", () => {
  phoneMsg("");
  phdlg.showModal();
  loadPhones();
});
$("phonesClose").addEventListener("click", () => phdlg.close());
phdlg.addEventListener("close", hideVerify);
phdlg.addEventListener("click", (e) => {
  if (e.target === phdlg) phdlg.close();
});

// ---- SIM messages: the bell shows how many texts the meter's SIM received since you last looked ----
const idlg = $("inbox");
function setBadge(n) {
  $("bellBadge").textContent = n > 99 ? "99+" : String(n);
  $("bellBadge").hidden = n < 1;
  $("bell").setAttribute("aria-label", n ? `Messages, ${n} new` : "Messages");
}
async function loadInboxCount() {
  if (localStorage.getItem("token") === "guest") return; // the inbox needs a login
  try {
    setBadge((await API.get("/inbox")).unread);
  } catch {
    /* keep the last count */
  }
}
function renderInbox(messages) {
  const list = $("inboxList");
  list.replaceChildren();
  if (!messages.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No messages yet.";
    list.append(li);
  }
  for (const m of messages) {
    const li = document.createElement("li");
    li.className = "inbox-item" + (m.read ? "" : " new");
    const top = document.createElement("div");
    top.className = "inbox-top";
    const from = document.createElement("span");
    from.className = "inbox-from";
    from.textContent = m.from;
    const time = document.createElement("span");
    time.className = "inbox-time";
    time.textContent = new Date(m.at).toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const body = document.createElement("p");
    body.className = "inbox-body";
    body.textContent = m.text;
    top.append(from, time);
    li.append(top, body);
    list.append(li);
  }
}
async function openInbox() {
  $("inboxMsg").textContent = "";
  idlg.showModal();
  try {
    const r = await API.get("/inbox");
    renderInbox(r.messages); // texts that were new when you opened it stay highlighted
    if (r.unread) await API.post("/inbox/read");
    setBadge(0);
  } catch (err) {
    $("inboxMsg").textContent = err.message;
  }
}
$("bell").addEventListener("click", openInbox);
$("inboxClose").addEventListener("click", () => idlg.close());
$("inboxClear").addEventListener("click", async () => {
  try {
    await API.del("/inbox");
    renderInbox([]);
    setBadge(0);
  } catch (err) {
    $("inboxMsg").textContent = err.message;
  }
});
idlg.addEventListener("click", (e) => {
  if (e.target === idlg) idlg.close();
});
loadInboxCount();
setInterval(loadInboxCount, 20000);
