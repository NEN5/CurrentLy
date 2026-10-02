if (!localStorage.getItem('token')) location.href = '/login.html';

const $ = id => document.getElementById(id);
let state = { range: 'daily', summary: null };
const money = (n, c) => c + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kwh = n => n.toLocaleString('en-PH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---- Summary: bill, kWh, trend ---------------------------------------------
async function loadSummary() {
  const s = state.summary = await API.get('/sensor-data/summary');
  $('bill').textContent = money(s.bill, s.currency);
  $('projected').textContent = `Projected for the month: ${money(s.projectedBill, s.currency)}`;
  $('monthKwh').textContent = kwh(s.monthKwh);
  $('todayKwh').textContent = kwh(s.todayKwh);
  $('livePower').textContent = s.livePower === null ? '—' : Math.round(s.livePower);
  if (document.activeElement !== $('rate')) $('rate').value = s.rate;
  $('rateUnit').textContent = s.currency;
  $('calcRate').textContent = `${s.currency}${s.rate} per kWh`;
  renderChart();
}
function renderChart() {
  const s = state.summary; if (!s) return;
  $('chartHint').textContent = state.range === 'daily' ? 'Last 30 days' : 'Last 6 months';
  drawTrend($('chart'), s[state.range], p => {
    $('readout').textContent = p ? `${p.label}: ${kwh(p.value)} kWh (${money(p.value * s.rate, s.currency)})` : 'Hover or tap the chart for details';
  });
}
document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
  state.range = b.dataset.range;
  document.querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderChart();
}));

// ---- Live power: GET /api/sensor-data/history (average watts per bucket) -----
let histMinutes = 60;
async function loadHistory() {
  try {
    const h = await API.get('/sensor-data/history?minutes=' + histMinutes);
    $('liveHint').textContent = `Average watts, ${h.bucketMinutes}-min buckets`;
    drawTrend($('liveChart'), h.points, p => {
      $('liveReadout').textContent = p ? `${p.label}: ${Math.round(p.value)} W` : 'Hover or tap the chart for details';
    });
  } catch { /* keep the last chart on a transient error */ }
}
document.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => {
  histMinutes = Number(b.dataset.hist);
  document.querySelectorAll('[data-hist]').forEach(x => x.setAttribute('aria-pressed', x === b));
  loadHistory();
}));

// ---- ESP32 INTEGRATION: device status pill ---------------------------------
// Polls GET /api/device/status. The server marks the device online while the ESP32
// keeps POSTing to /api/sensor-data (timeout is ONLINE_TIMEOUT_MS in data/store.js).
async function loadStatus() {
  const d = await API.get('/device/status');
  const labels = { online: 'Online', offline: 'Offline' };
  $('status').dataset.state = d.state;
  $('statusText').textContent = labels[d.state];
  $('status').title = d.lastSeen ? `Last seen ${Math.round((d.serverTime - d.lastSeen) / 1000)} seconds ago` : 'No data received yet';
}

// ---- Settings ----------------------------------------------------------------
$('rate').addEventListener('change', async e => {
  try { await API.put('/settings', { rate: Number(e.target.value) }); $('rateMsg').textContent = ''; }
  catch (err) { $('rateMsg').textContent = err.message; }
  loadSummary();
});
$('logout').addEventListener('click', () => { localStorage.clear(); location.href = '/login.html'; });

// ---- Floating calculator (client-side only, no backend) ----------------------
const dlg = $('calc');
$('calcOpen').addEventListener('click', () => { dlg.showModal(); calc(); });
$('calcClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // click outside closes; Esc works natively
['watts', 'hours'].forEach(id => $(id).addEventListener('input', calc));
function calc() {
  const s = state.summary || { rate: 12, currency: '₱' };
  const w = Math.max(0, Number($('watts').value) || 0), h = Math.min(24, Math.max(0, Number($('hours').value) || 0));
  const day = w * h / 1000; // kWh per day
  $('rDayKwh').textContent = kwh(day); $('rMonthKwh').textContent = kwh(day * 30);
  $('rDay').textContent = money(day * s.rate, s.currency); $('rMonth').textContent = money(day * 30 * s.rate, s.currency);
}

// ---- Device pairing: 6-digit code with a countdown (the API key is never shown) ----
const pdlg = $('pair'); let pairTimer = null, pairEnd = 0;
function pairTick() {
  const left = Math.round((pairEnd - Date.now()) / 1000);
  if (left <= 0) { clearInterval(pairTimer); $('pairCode').textContent = '——'; $('pairTimer').textContent = 'Code expired. Tap "New code".'; return; }
  $('pairTimer').textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
async function newPairCode() {
  $('pairMsg').textContent = '';
  try {
    const r = await API.post('/device/pair-code');
    $('pairCode').textContent = r.code;
    pairEnd = Date.now() + r.expiresInSec * 1000;
    clearInterval(pairTimer); pairTimer = setInterval(pairTick, 1000); pairTick();
  } catch (err) { $('pairMsg').textContent = err.message; }
}
$('pairOpen').addEventListener('click', () => { pdlg.showModal(); newPairCode(); });
$('pairNew').addEventListener('click', newPairCode);
$('pairClose').addEventListener('click', () => pdlg.close());
pdlg.addEventListener('close', () => clearInterval(pairTimer));
pdlg.addEventListener('click', e => { if (e.target === pdlg) pdlg.close(); });

loadSummary(); loadStatus(); loadHistory();
setInterval(loadSummary, 5000);
setInterval(loadStatus, 10000);
setInterval(loadHistory, 30000);

// Simulated data no longer exists: hide the old toggle if it is still in index.html.
$('mockToggle')?.closest('label')?.remove();

// ---- Meralco monthly rate (from /api/rates/meralco; defaults to September 2026) ----
async function loadMeralcoRate() {
  const el = $('rateKwh'); if (!el) return;
  try {
    const r = await API.get('/rates/meralco');
    el.textContent = r.overall_rate_per_kwh.toFixed(4);
    el.title = `Meralco ${r.billing_period} (${r.rate_change.direction} of ₱${r.rate_change.amount_per_kwh.toFixed(4)}/kWh)`;
  } catch { /* keep the value already in the HTML */ }
}
loadMeralcoRate();
setInterval(loadMeralcoRate, 6 * 3600 * 1000);