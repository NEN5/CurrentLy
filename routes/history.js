// History logs shown under the dashboard's sidebar > History.
//   GET  /api/history/outages  (login)  power outages + brown outs, worked out from sensor_readings
//   GET  /api/history/theft    (login)  theft detections reported by the meter
//   POST /api/device/theft     (ESP32, x-api-key)  the meter reports a theft detection
const userRouter = require("express").Router(); // mounted at /api/history
const deviceRouter = require("express").Router(); // mounted at /api/device
const db = require("../data/db");
const requireAuth = require("../middleware/requireAuth");
const { deviceAuth } = require("./phones");
const { meralcoRate } = require("../services/defaultRate");

const DAYS = 14; // matches RETENTION_DAYS in services/retention.js (older raw readings are gone)
const GAP_SEC = Number(process.env.OUTAGE_GAP_SEC) || 300; // no reading for this long = outage
const LOST_V = 50; // PZEM voltage below this = mains is gone
const BROWNOUT_V = Number(process.env.BROWNOUT_V) || 200; // 230 V grid; below this = brown out
const LOW_JOIN_SEC = 120; // low readings closer than this belong to the same event
const KEEP_THEFT = 200; // newest theft events kept per account
const THEFT_MIN_GAP_SEC = 60; // ignore repeat reports inside this window

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("history failed:", err.message);
    res.status(500).json({ error: "Server error" });
  });

// Created on first start so no manual migration is needed.
db.execute(
  `CREATE TABLE IF NOT EXISTS theft_events (
     id int NOT NULL AUTO_INCREMENT,
     user_id int NOT NULL,
     device_id int NOT NULL,
     detected_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
     detail varchar(200) DEFAULT NULL,
     PRIMARY KEY (id),
     KEY idx_theft_user (user_id, detected_at),
     CONSTRAINT fk_theft_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   )`,
).catch((err) => console.error("theft_events table:", err.message));

// ---------------------------------------------------------------------------
// Outages and brown outs. No extra table: both are read from the raw readings.
//   outage   = the meter stopped reporting for GAP_SEC or more, or it reported voltage ~0
//   brownout = voltage stayed between LOST_V and BROWNOUT_V
// ---------------------------------------------------------------------------
function islands(rows, kind) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (cur && r.t - cur.end <= LOW_JOIN_SEC * 1000) {
      cur.end = r.t;
      cur.minVoltage = Math.min(cur.minVoltage, r.v);
    } else {
      if (cur) out.push(cur);
      cur = { kind, start: r.t, end: r.t, minVoltage: r.v };
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Extra detail for each outage / brown out, worked out from the same raw readings (no new table):
//   before   = last reading before it started (watts, volts)
//   after    = first reading after power came back, plus the peak in the next AFTER_MIN minutes
//   kWh today / this month at that moment, and the bill + projection they imply
// The bill uses the account's CURRENT rate. Only the newest DETAIL_EVENTS entries get this detail.
// ---------------------------------------------------------------------------
const PH_OFFSET_MS = 8 * 3600 * 1000; // Philippine time = UTC+8 (no DST)
const SURGE_V = Number(process.env.SURGE_V) || 253; // 230 V + 10 %: peak voltage at/above this = surge
const AFTER_MIN = 5; // minutes after power returns that are checked for a peak
const DETAIL_EVENTS = 12;
const SYMBOLS = { PHP: "₱" };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const secs = (ms) => Math.floor(ms / 1000);

async function userRate(userId) {
  const defaultRate = await meralcoRate();
  let rate = defaultRate,
    currency = "₱";
  const [t] = await db.execute(
    "SELECT rate_per_kwh, currency, use_custom FROM tariff_settings WHERE user_id = ?",
    [userId],
  );
  if (t.length) {
    currency = SYMBOLS[t[0].currency] || t[0].currency;
    if (Number(t[0].use_custom) === 1)
      rate = Number(t[0].rate_per_kwh) || defaultRate;
  }
  return { rate, currency };
}

// kWh used on that PH day and so far that PH month, up to time tMs.
// Older days come from daily_usage (rollup), recent days from raw readings (same rule as the summary).
async function kwhAsOf(userId, tMs) {
  const shifted = tMs + PH_OFFSET_MS;
  const ph = new Date(shifted);
  const y = ph.getUTCFullYear(),
    m = ph.getUTCMonth();
  const dayStr = ymd(shifted);
  const monthStart = ymd(Date.UTC(y, m, 1));
  const now = new Date(Date.now() + PH_OFFSET_MS);
  const rawFromDay = ymd(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAYS - 1)),
  );
  const lowerDay = monthStart > rawFromDay ? monthStart : rawFromDay;
  let month = 0,
    today = null;

  if (lowerDay <= dayStr) {
    const lowerUtcMs = Date.parse(lowerDay + "T00:00:00Z") - PH_OFFSET_MS;
    const [[r]] = await db.execute(
      `SELECT SUM(delta) AS m, SUM(CASE WHEN day = ? THEN delta ELSE 0 END) AS t FROM (
         SELECT DATE_FORMAT(DATE_ADD(sr.recorded_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS day,
                GREATEST(sr.total_kwh - LAG(sr.total_kwh) OVER (
                  PARTITION BY sr.device_id ORDER BY sr.recorded_at, sr.id), 0) AS delta
         FROM sensor_readings sr JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= FROM_UNIXTIME(?) AND sr.recorded_at <= FROM_UNIXTIME(?)
       ) x WHERE delta IS NOT NULL AND day >= ?`,
      [dayStr, userId, secs(lowerUtcMs) - 86400, secs(tMs), lowerDay],
    );
    month += Number(r.m) || 0;
    today = Number(r.t) || 0;
  }
  const upper = lowerDay < dayStr ? lowerDay : dayStr;
  if (monthStart < upper) {
    const [[o]] = await db.execute(
      `SELECT SUM(du.kwh) AS k FROM daily_usage du JOIN devices d ON d.id = du.device_id
       WHERE d.user_id = ? AND du.day >= ? AND du.day < ?`,
      [userId, monthStart, upper],
    );
    month += Number(o.k) || 0;
  }
  const dom = ph.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { today, month, dom, daysInMonth };
}

async function enrich(userId, e, { rate, currency }) {
  const out = { ...e, currency };
  try {
    const [[b]] = await db.execute(
      `SELECT sr.voltage AS v, sr.active_power_watts AS w FROM sensor_readings sr
       JOIN devices d ON d.id = sr.device_id
       WHERE d.user_id = ? AND sr.recorded_at <= FROM_UNIXTIME(?)
       ORDER BY sr.recorded_at DESC, sr.id DESC LIMIT 1`,
      [userId, secs(e.start)],
    );
    if (b) out.before = { watts: Number(b.w), voltage: Number(b.v) };

    const k = await kwhAsOf(userId, e.start);
    out.kwhToday = k.today;
    out.kwhMonth = k.month;
    out.bill = k.month * rate;
    out.projectedBill = (k.month / k.dom) * k.daysInMonth * rate;

    if (e.kind === "outage" && e.end) {
      const [[a]] = await db.execute(
        `SELECT sr.voltage AS v, sr.active_power_watts AS w FROM sensor_readings sr
         JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= FROM_UNIXTIME(?)
         ORDER BY sr.recorded_at, sr.id LIMIT 1`,
        [userId, secs(e.end)],
      );
      const [[p]] = await db.execute(
        `SELECT MAX(sr.voltage) AS pv, MAX(sr.active_power_watts) AS pw FROM sensor_readings sr
         JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= FROM_UNIXTIME(?) AND sr.recorded_at <= FROM_UNIXTIME(?)`,
        [userId, secs(e.end), secs(e.end) + AFTER_MIN * 60],
      );
      if (a) {
        out.after = { watts: Number(a.w), voltage: Number(a.v) };
        if (p && p.pv !== null)
          out.afterPeak = {
            watts: Number(p.pw),
            voltage: Number(p.pv),
            minutes: AFTER_MIN,
            surge: Number(p.pv) >= SURGE_V,
          };
      }
    }
  } catch (err) {
    console.error("outage detail failed:", err.message); // keep the plain entry
  }
  return out;
}

userRouter.get(
  "/outages",
  requireAuth,
  wrap(async (req, res) => {
    const events = [];

    // 1) Gaps between consecutive readings.
    const [gaps] = await db.execute(
      `SELECT UNIX_TIMESTAMP(prev) * 1000 AS s, UNIX_TIMESTAMP(cur) * 1000 AS e FROM (
         SELECT sr.recorded_at AS cur,
                LAG(sr.recorded_at) OVER (PARTITION BY sr.device_id ORDER BY sr.recorded_at, sr.id) AS prev
         FROM sensor_readings sr JOIN devices d ON d.id = sr.device_id
         WHERE d.user_id = ? AND sr.recorded_at >= NOW() - INTERVAL ? DAY
       ) x WHERE prev IS NOT NULL AND TIMESTAMPDIFF(SECOND, prev, cur) > ?`,
      [req.user.id, DAYS, GAP_SEC],
    );
    for (const g of gaps)
      events.push({
        kind: "outage",
        start: Number(g.s),
        end: Number(g.e),
        minutes: (Number(g.e) - Number(g.s)) / 60000,
        minVoltage: null,
      });

    // 2) Still silent right now: an outage that has not ended yet.
    const [[last]] = await db.execute(
      `SELECT UNIX_TIMESTAMP(MAX(sr.recorded_at)) * 1000 AS t,
              TIMESTAMPDIFF(SECOND, MAX(sr.recorded_at), NOW()) AS age
       FROM sensor_readings sr JOIN devices d ON d.id = sr.device_id WHERE d.user_id = ?`,
      [req.user.id],
    );
    if (last.t && Number(last.age) > GAP_SEC)
      events.push({
        kind: "outage",
        start: Number(last.t),
        end: null,
        ongoing: true,
        minutes: Number(last.age) / 60,
        minVoltage: null,
      });

    // 3) Readings with low voltage while the meter was still reporting.
    const [low] = await db.execute(
      `SELECT UNIX_TIMESTAMP(sr.recorded_at) * 1000 AS t, sr.voltage AS v
       FROM sensor_readings sr JOIN devices d ON d.id = sr.device_id
       WHERE d.user_id = ? AND sr.recorded_at >= NOW() - INTERVAL ? DAY AND sr.voltage < ?
       ORDER BY sr.recorded_at LIMIT 20000`,
      [req.user.id, DAYS, BROWNOUT_V],
    );
    const lost = low.filter((r) => Number(r.v) < LOST_V);
    const sag = low.filter((r) => Number(r.v) >= LOST_V);
    const conv = (r) => ({ t: Number(r.t), v: Number(r.v) });
    for (const e of islands(lost.map(conv), "outage"))
      events.push({ ...e, minutes: (e.end - e.start) / 60000, minVoltage: null });
    for (const e of islands(sag.map(conv), "brownout"))
      events.push({ ...e, minutes: (e.end - e.start) / 60000 });

    events.sort((a, b) => b.start - a.start);
    const list = events.slice(0, 100);
    const tariff = await userRate(req.user.id);
    const detailed = await Promise.all(
      list.slice(0, DETAIL_EVENTS).map((e) => enrich(req.user.id, e, tariff)),
    );
    res.set("Cache-Control", "no-store");
    res.json({ events: detailed.concat(list.slice(DETAIL_EVENTS)) });
  }),
);

// ---------------------------------------------------------------------------
// Theft detection log
// ---------------------------------------------------------------------------
userRouter.get(
  "/theft",
  requireAuth,
  wrap(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT id, detail, UNIX_TIMESTAMP(detected_at) * 1000 AS at_ms
       FROM theft_events WHERE user_id = ? ORDER BY detected_at DESC, id DESC LIMIT 100`,
      [req.user.id],
    );
    res.set("Cache-Control", "no-store");
    res.json({
      events: rows.map((r) => ({ id: r.id, at: Number(r.at_ms), detail: r.detail })),
    });
  }),
);

// POST /api/device/theft {detail?: "..."} -> { ok, saved }
// Call it when the meter detects theft, next to sending the SMS alert.
deviceRouter.post(
  "/theft",
  deviceAuth,
  wrap(async (req, res) => {
    const detail =
      String((req.body || {}).detail || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .trim()
        .slice(0, 200) || null;
    const { id: deviceId, user_id: userId } = req.device;

    const [[recent]] = await db.execute(
      "SELECT COUNT(*) AS n FROM theft_events WHERE user_id = ? AND detected_at > DATE_SUB(NOW(), INTERVAL ? SECOND)",
      [userId, THEFT_MIN_GAP_SEC],
    );
    if (Number(recent.n)) return res.json({ ok: true, saved: false });

    await db.execute(
      "INSERT INTO theft_events (user_id, device_id, detail) VALUES (?, ?, ?)",
      [userId, deviceId, detail],
    );
    await db.execute(
      `DELETE FROM theft_events WHERE user_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM theft_events WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP_THEFT}) t)`,
      [userId, userId],
    );
    res.status(201).json({ ok: true, saved: true });
  }),
);

module.exports = { userRouter, deviceRouter };
