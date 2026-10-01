// ESP32-ready routes + mock generator.
const router = require('express').Router();
const deviceRouter = require('express').Router();
const store = require('../data/store');
const { config } = store;

function addEnergy(kwh) {
  const k = store.dayKey();
  store.daily[k] = (store.daily[k] || 0) + kwh;
}
function record(r) {
  // `energy` is the device's cumulative kWh counter; we store the delta per day.
  if (store.prevEnergy !== null && r.energy >= store.prevEnergy) addEnergy(r.energy - store.prevEnergy);
  store.prevEnergy = r.energy;
  store.latest = { ...r, at: Date.now() };
  store.lastSeen = Date.now();
  store.deviceId = r.deviceId;
}

// ---- ESP32 INTEGRATION ----------------------------------------------------
// The ESP32 sends JSON over HTTP every few seconds:
//   POST /api/sensor-data   header: x-api-key: <DEVICE_API_KEY>
//   { "deviceId":"esp32-01", "voltage":220.4, "current":2.1, "power":462, "energy":123.45 }
// (voltage V, current A, power W, energy = cumulative kWh, e.g. from a PZEM-004T)
// Later: replace `record()` with an INSERT into your database.
router.post('/', (req, res) => {
  if (req.get('x-api-key') !== config.DEVICE_API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const { deviceId, voltage, current, power, energy } = req.body || {};
  const nums = [voltage, current, power, energy];
  if (!deviceId || nums.some(n => typeof n !== 'number' || !isFinite(n) || n < 0))
    return res.status(400).json({ error: 'Required: deviceId (string), voltage, current, power, energy (numbers >= 0)' });
  record({ deviceId, voltage, current, power, energy });
  res.status(201).json({ ok: true });
});

router.get('/latest', (req, res) => res.json({ latest: store.latest }));

// Dashboard numbers: month-to-date bill, today's kWh, daily (30d) and monthly (6mo) series.
router.get('/summary', (req, res) => {
  const now = new Date();
  const { rate, currency } = store.settings;
  const monthKey = store.dayKey(now).slice(0, 7);
  const sumMonth = m => Object.entries(store.daily).filter(([k]) => k.startsWith(m)).reduce((s, [, v]) => s + v, 0);

  const monthKwh = sumMonth(monthKey);
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedKwh = monthKwh / now.getDate() * dim;

  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    daily.push({ label: d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }), value: store.daily[store.dayKey(d)] || 0 });
  }
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.push({ label: d.toLocaleDateString('en-PH', { month: 'short' }), value: sumMonth(store.dayKey(d).slice(0, 7)) });
  }
  res.json({
    rate, currency, monthKwh, projectedKwh,
    bill: monthKwh * rate, projectedBill: projectedKwh * rate,
    todayKwh: store.daily[store.dayKey(now)] || 0,
    livePower: store.latest ? store.latest.power : null,
    daily, monthly
  });
});

// ---- Device status (nav pill) ---------------------------------------------
function status() {
  if (config.USE_MOCK_DATA) return { state: 'simulated', online: true, deviceId: store.deviceId, lastSeen: store.lastSeen };
  const age = store.lastSeen ? Date.now() - store.lastSeen : null;
  const online = age !== null && age < config.ONLINE_TIMEOUT_MS;
  return { state: online ? 'online' : 'offline', online, deviceId: store.deviceId, lastSeen: store.lastSeen };
}
deviceRouter.get('/status', (req, res) => res.json({ ...status(), serverTime: Date.now() }));

// Mock toggle (for previewing the pill states). Remove or lock down in production.
router.get('/mock', (req, res) => res.json({ enabled: config.USE_MOCK_DATA }));
router.post('/mock', (req, res) => {
  config.USE_MOCK_DATA = !!(req.body && req.body.enabled);
  if (!config.USE_MOCK_DATA) { store.latest = null; store.lastSeen = null; store.prevEnergy = null; }
  res.json({ enabled: config.USE_MOCK_DATA });
});

// ---- Mock generator: simulates a whole-house meter -------------------------
function seedMock() {
  const now = new Date();
  for (let i = 1; i <= 180; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    store.daily[store.dayKey(d)] = 9 + 3 * Math.sin(i / 4) + Math.random() * 3;
  }
  store.daily[store.dayKey(now)] = 10 * (now.getHours() + 1) / 24;
}
let cumulative = 1000;
setInterval(() => {
  if (!config.USE_MOCK_DATA) return;
  const h = new Date().getHours();
  const power = Math.round(250 + Math.random() * 400 + (h >= 18 && h <= 22 ? 600 : 0));
  const voltage = +(220 + (Math.random() * 6 - 3)).toFixed(1);
  cumulative += power * 5 / 3.6e6; // 5 seconds of usage in kWh
  record({ deviceId: 'mock-esp32', voltage, current: +(power / voltage).toFixed(2), power, energy: cumulative });
}, 5000);
seedMock();

module.exports = { router, deviceRouter };
