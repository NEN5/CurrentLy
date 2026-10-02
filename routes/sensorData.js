// ESP32 ingestion + per-user dashboard data (MySQL). No in-memory store.
const router = require('express').Router();
const deviceRouter = require('express').Router();
const db = require('../data/db');
const requireAuth = require('../middleware/requireAuth');

// A device counts as online / livePower is shown while its last reading is this fresh.
// Keep it above the firmware send interval (15-30 s) or the pill will flap.
const ONLINE_WINDOW_SEC = Number(process.env.ONLINE_WINDOW_SEC) || 60;
const PH_OFFSET_MS = 8 * 3600 * 1000; // Philippine time = UTC+8 (no DST)
// /summary reads raw readings for the last N PH days and daily_usage (rollup) for anything older.
// Keep it well below RETENTION_DAYS in services/retention.js.
const RAW_SUMMARY_DAYS = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SYMBOLS = { PHP: '₱' };

// ---------------------------------------------------------------------------
// ESP32 ingestion: POST /api/sensor-data   (also mounted as /api/telemetry)
// Header x-api-key = devices.api_key. Body: {voltage, current, power, energy}
// The only SQL the device can trigger: look up devices by api_key, INSERT one
// sensor_readings row, UPDATE that device's last_seen/status.
// ---------------------------------------------------------------------------
const LIMITS = { voltage: 500, current: 200, power: 50000, energy: 10000000 };
const MIN_GAP_MS = 2000;            // max one accepted reading per device every 2 s
const FAIL_MAX = 30, FAIL_WINDOW_MS = 60000; // 30 bad keys / minute / IP
const lastAccepted = new Map();     // device id -> ms
const failures = new Map();         // ip -> { n, reset }

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastAccepted) if (now - t > 60000) lastAccepted.delete(k);
  for (const [k, f] of failures) if (now > f.reset) failures.delete(k);
}, 60000).unref();

function blocked(ip) {
  const f = failures.get(ip);
  return !!f && Date.now() <= f.reset && f.n >= FAIL_MAX;
}
function noteFailure(ip) {
  const now = Date.now(), f = failures.get(ip);
  if (!f || now > f.reset) failures.set(ip, { n: 1, reset: now + FAIL_WINDOW_MS });
  else f.n++;
}

async function ingest(req, res) {
  try {
    if (blocked(req.ip)) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many requests' }); }

    const b = req.body || {};
    const key = String(req.get('x-api-key') || b.api_key || '').trim();
    if (!key) { noteFailure(req.ip); return res.status(401).json({ error: 'Missing API key' }); }
    if (!/^[A-Za-z0-9]{16,64}$/.test(key)) { noteFailure(req.ip); return res.status(401).json({ error: 'Invalid API key' }); }

    const [rows] = await db.execute('SELECT id FROM devices WHERE api_key = ?', [key]);
    if (!rows.length) { noteFailure(req.ip); return res.status(401).json({ error: 'Invalid API key' }); }
    const deviceId = rows[0].id;

    // Accept the long field names too, so the /api/telemetry alias keeps working.
    const pick = (...names) => names.map(n => b[n]).find(v => v !== undefined);
    const v = {
      voltage: pick('voltage'),
      current: pick('current', 'current_amps'),
      power: pick('power', 'active_power_watts'),
      energy: pick('energy', 'total_kwh')
    };
    for (const [name, val] of Object.entries(v)) {
      if (typeof val !== 'number' || !isFinite(val) || val < 0 || val > LIMITS[name])
        return res.status(400).json({ error: 'Required numbers: voltage, current, power, energy (>= 0, within sensor range)' });
    }

    const now = Date.now();
    if (now - (lastAccepted.get(deviceId) || 0) < MIN_GAP_MS) {
      res.set('Retry-After', '2');
      return res.status(429).json({ error: 'Sending too fast' });
    }
    lastAccepted.set(deviceId, now);

    await db.execute(
      `INSERT INTO sensor_readings (device_id, voltage, current_amps, active_power_watts, total_kwh)
       VALUES (?, ?, ?, ?, ?)`,
      [deviceId, v.voltage, v.current, v.power, v.energy]);
    await db.execute("UPDATE devices SET last_seen = NOW(), status = 'online' WHERE id = ?", [deviceId]);

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('ingest failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}
router.post('/', ingest);

// ---------------------------------------------------------------------------
// Helpers (Philippine calendar math on a UTC-shifted Date; read with getUTC*)
// ---------------------------------------------------------------------------
const ymd = d => d.toISOString().slice(0, 10);
const sqlUtc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------------------
// GET /api/sensor-data/summary  (auth optional; guests get zeros)
// Days older than RAW_SUMMARY_DAYS come from daily_usage (rollup, see services/retention.js);
// the most recent days are computed from raw readings and override the rollup.
// ---------------------------------------------------------------------------
router.get('/summary', requireAuth.optional, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    let rate = 12, currency = '₱';
    const perDay = new Map(); // 'YYYY-MM-DD' (PH) -> kWh
    let livePower = null;

    const ph = new Date(Date.now() + PH_OFFSET_MS);
    const y = ph.getUTCFullYear(), m = ph.getUTCMonth(), dom = ph.getUTCDate();

    if (userId) {
      const [t] = await db.execute('SELECT rate_per_kwh, currency FROM tariff_settings WHERE user_id = ?', [userId]);
      if (t.length) { rate = Number(t[0].rate_per_kwh) || 12; currency = SYMBOLS[t[0].currency] || t[0].currency; }

      const fromDay = ymd(new Date(Date.UTC(y, m - 5, 1)));                   // first day shown (PH date)
      const rawFromDay = ymd(new Date(Date.UTC(y, m, dom - RAW_SUMMARY_DAYS))); // raw readings cover this day onward
      // One extra day of raw rows so the first delta of rawFromDay is not lost.
      const scanFromUtc = Date.UTC(y, m, dom - RAW_SUMMARY_DAYS - 1) - PH_OFFSET_MS;

      // Older days: pre-computed rollup.
      const [old] = await db.execute(
        `SELECT DATE_FORMAT(du.day, '%Y-%m-%d') AS day, SUM(du.kwh) AS kwh
         FROM daily_usage du JOIN devices d ON d.id = du.device_id
         WHERE d.user_id = ? AND du.day >= ? AND du.day < ?
         GROUP BY du.day`,
        [userId, fromDay, rawFromDay]);
      for (const r of old) perDay.set(r.day, Number(r.kwh) || 0);

      // Recent days: daily kWh = sum of positive deltas between consecutive cumulative readings.
      const [days] = await db.execute(
        `SELECT day, SUM(delta) AS kwh FROM (
           SELECT DATE_FORMAT(DATE_ADD(sr.recorded_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS day,
                  GREATEST(sr.total_kwh - LAG(sr.total_kwh) OVER (
                    PARTITION BY sr.device_id ORDER BY sr.recorded_at, sr.id), 0) AS delta
           FROM sensor_readings sr
           JOIN devices d ON d.id = sr.device_id
           WHERE d.user_id = ? AND sr.recorded_at >= ?
         ) x WHERE delta IS NOT NULL AND day >= ? GROUP BY day`,
        [userId, sqlUtc(scanFromUtc), rawFromDay]);
      for (const r of days) perDay.set(r.day, Number(r.kwh) || 0);

      const [live] = await db.execute(
        `SELECT sr.active_power_watts AS w FROM sensor_readings sr
         JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= NOW() - INTERVAL ? SECOND
         ORDER BY sr.recorded_at DESC, sr.id DESC LIMIT 1`,
        [userId, ONLINE_WINDOW_SEC]);
      if (live.length) livePower = Number(live[0].w);
    }

    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(ph.getTime() - i * 86400000);
      daily.push({ label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, value: perDay.get(ymd(d)) || 0 });
    }
    const monthSums = new Map();
    for (const [k, v] of perDay) monthSums.set(k.slice(0, 7), (monthSums.get(k.slice(0, 7)) || 0) + v);
    const monthly = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      monthly.push({ label: MONTHS[d.getUTCMonth()], value: monthSums.get(ymd(d).slice(0, 7)) || 0 });
    }

    const monthKwh = monthly[5].value;
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const projectedKwh = monthKwh / dom * daysInMonth;
    res.json({
      rate, currency, monthKwh, projectedKwh,
      bill: monthKwh * rate, projectedBill: projectedKwh * rate,
      todayKwh: perDay.get(ymd(ph)) || 0,
      livePower, daily, monthly
    });
  } catch (err) {
    console.error('summary failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sensor-data/history?minutes=60  (auth optional; guests get zeros)
// Average watts per time bucket -> { minutes, bucketMinutes, points:[{label,value}] }
// Bucket = 1 min, widened so a range never exceeds ~120 points. Empty buckets = 0.
// Labels are HH:MM Philippine time. Shaped for drawTrend() in public/js/charts.js.
// Reads raw rows only, so ranges beyond RETENTION_DAYS are not a concern (max is 24 h).
// ---------------------------------------------------------------------------
router.get('/history', requireAuth.optional, async (req, res) => {
  try {
    let minutes = parseInt(req.query.minutes, 10);
    if (!Number.isFinite(minutes)) minutes = 60;
    minutes = Math.min(1440, Math.max(5, minutes));
    const bucketMin = minutes <= 120 ? 1 : Math.ceil(minutes / 120);
    const bucketSec = bucketMin * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const first = Math.floor((nowSec - minutes * 60) / bucketSec);
    const last = Math.floor(nowSec / bucketSec);

    const avg = new Map(); // bucket index -> average watts
    if (req.user) {
      const [rows] = await db.execute(
        `SELECT FLOOR(UNIX_TIMESTAMP(sr.recorded_at) / ?) AS b, AVG(sr.active_power_watts) AS w
         FROM sensor_readings sr
         JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= NOW() - INTERVAL ? MINUTE
         GROUP BY b`,
        [bucketSec, req.user.id, minutes + bucketMin]);
      for (const r of rows) avg.set(Number(r.b), Number(r.w) || 0);
    }

    const pad = n => String(n).padStart(2, '0');
    const points = [];
    for (let b = first; b <= last; b++) {
      const t = new Date(b * bucketSec * 1000 + PH_OFFSET_MS);
      points.push({
        label: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
        value: Math.round((avg.get(b) || 0) * 10) / 10
      });
    }
    res.json({ minutes, bucketMinutes: bucketMin, points });
  } catch (err) {
    console.error('history failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sensor-data/latest  (auth) -> { latest: {...} | null }
// ---------------------------------------------------------------------------
router.get('/latest', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT d.mac, sr.voltage, sr.current_amps, sr.active_power_watts, sr.total_kwh,
              UNIX_TIMESTAMP(sr.recorded_at) * 1000 AS at_ms
       FROM sensor_readings sr JOIN devices d ON d.id = sr.device_id
       WHERE d.user_id = ? ORDER BY sr.recorded_at DESC, sr.id DESC LIMIT 1`, [req.user.id]);
    if (!rows.length) return res.json({ latest: null });
    const r = rows[0];
    res.json({ latest: {
      deviceId: r.mac, voltage: Number(r.voltage), current: Number(r.current_amps),
      power: Number(r.active_power_watts), energy: Number(r.total_kwh), at: Number(r.at_ms)
    } });
  } catch (err) {
    console.error('latest failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/device/status  (auth optional)  one device per user is assumed
// Age is computed in SQL so the server's own timezone never matters.
// ---------------------------------------------------------------------------
deviceRouter.get('/status', requireAuth.optional, async (req, res) => {
  const out = { state: 'offline', online: false, deviceId: null, lastSeen: null, serverTime: Date.now() };
  try {
    if (req.user) {
      const [rows] = await db.execute(
        `SELECT mac, UNIX_TIMESTAMP(last_seen) * 1000 AS seen_ms,
                TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age_s
         FROM devices WHERE user_id = ? ORDER BY last_seen DESC, id LIMIT 1`, [req.user.id]);
      if (rows.length) {
        const r = rows[0];
        out.deviceId = r.mac;
        out.lastSeen = r.seen_ms === null ? null : Number(r.seen_ms);
        out.online = r.age_s !== null && Number(r.age_s) <= ONLINE_WINDOW_SEC;
        out.state = out.online ? 'online' : 'offline';
      }
    }
    res.json(out);
  } catch (err) {
    console.error('status failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, deviceRouter, ingest };