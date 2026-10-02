// Retention: roll raw sensor_readings up into daily_usage (kWh per device per PH date),
// then delete raw rows older than RETENTION_DAYS. Runs 20 s after boot and hourly after that.
// Rollup is idempotent. Raw rows are only deleted in whole Philippine days, after their day is rolled up.
const db = require('../data/db');

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 14;
const PH_OFFSET_MS = 8 * 3600 * 1000; // Philippine time = UTC+8 (no DST)
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const sqlUtc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
let running = false;

// kWh per device per PH day = sum of positive deltas between consecutive cumulative readings
// (same rule the dashboard summary uses). Completed days only; today stays in raw rows.
async function rollup(todayStr) {
  const [rows] = await db.execute(
    `SELECT device_id, day, SUM(delta) AS kwh, MAX(day = first_day) AS is_first
     FROM (
       SELECT sr.device_id,
              DATE_FORMAT(DATE_ADD(sr.recorded_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS day,
              FIRST_VALUE(DATE_FORMAT(DATE_ADD(sr.recorded_at, INTERVAL 8 HOUR), '%Y-%m-%d'))
                OVER (PARTITION BY sr.device_id ORDER BY sr.recorded_at, sr.id) AS first_day,
              GREATEST(sr.total_kwh - LAG(sr.total_kwh) OVER (
                PARTITION BY sr.device_id ORDER BY sr.recorded_at, sr.id), 0) AS delta
       FROM sensor_readings sr
     ) x
     GROUP BY device_id, day`);

  let n = 0;
  for (const r of rows) {
    if (r.day >= todayStr) continue;                 // day still in progress
    const kwh = Number(r.kwh) || 0;
    if (Number(r.is_first)) {
      // Oldest raw day has no previous row for its first delta, so never overwrite a stored value with it.
      await db.execute('INSERT IGNORE INTO daily_usage (device_id, day, kwh) VALUES (?, ?, ?)', [r.device_id, r.day, kwh]);
    } else {
      await db.execute(
        'INSERT INTO daily_usage (device_id, day, kwh) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE kwh = VALUES(kwh)',
        [r.device_id, r.day, kwh]);
    }
    n++;
  }
  return n;
}

// Delete raw rows from PH days before (today - RETENTION_DAYS), in batches.
async function purge() {
  const ph = new Date(Date.now() + PH_OFFSET_MS);
  const cutoffUtc = Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth(), ph.getUTCDate() - RETENTION_DAYS) - PH_OFFSET_MS;
  let total = 0;
  for (;;) {
    const [r] = await db.execute('DELETE FROM sensor_readings WHERE recorded_at < ? LIMIT 5000', [sqlUtc(cutoffUtc)]);
    total += r.affectedRows;
    if (r.affectedRows < 5000) break;
  }
  return total;
}

async function run() {
  if (running) return;
  running = true;
  try {
    await rollup(ymd(Date.now() + PH_OFFSET_MS));
    const deleted = await purge();                   // only reached if the rollup succeeded
    if (deleted) console.log(`retention: deleted ${deleted} raw readings older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error('retention failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler() {
  setTimeout(run, 20000).unref();
  setInterval(run, 3600000).unref();
}

module.exports = { startScheduler, run };