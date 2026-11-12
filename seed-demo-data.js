// SIMULATED TEST DATA for CurrentLy (dashboard / history / bill-estimate testing only).
// Generates ~3 weeks of 1-minute household readings ending right now, under a separate "demo" device
// so it never mixes with your real meter's rows and can be removed with --clear.
// This is synthetic data. Do not present it as measured data in the thesis.
//
//   node seed-demo-data.js --email you@example.com            write to the database
//   node seed-demo-data.js --email you@example.com --clear    remove the demo device and all its rows
//   node seed-demo-data.js --dry                              print a summary only, no database needed
//
// Options: --days 21  --bill 2350 (target monthly bill in PHP)  --rate 14.00 (default: Meralco rate from the app)
//          --seed 7 (change for a different but repeatable pattern)  --no-events (skip outages/brown out/theft rows)
//
// Re-running replaces the previous demo rows, so the data always ends at "now".
// Layout: raw 1-minute readings for the last 14 days (the retention window), and daily_usage totals for
// the older days, exactly how the app stores real data.

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);

const DRY = has("--dry");
const CLEAR = has("--clear");
const EMAIL = val("--email", "");
const DAYS = Number(val("--days", 21));
const TARGET_BILL = Number(val("--bill", 2350)); // a bit under last month's 2,563.97
const SEED = Number(val("--seed", 7));
const EVENTS = !has("--no-events");
const RAW_DAYS = 14; // keep equal to RETENTION_DAYS in services/retention.js
const DEMO_MAC = "DE:MO:SE:ED:00:01";

const MIN = 60000,
  DAY = 86400000,
  PH = 8 * 3600000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const phDayStart = (ms) => Math.floor((ms + PH) / DAY) * DAY - PH; // UTC ms of PH midnight

// Repeatable random numbers.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;

// ---- one PH day of watts, per minute (before scaling) ----
function dayProfile(dow, weather) {
  const w = new Float64Array(1440);
  const fridgeOff = Math.floor(rand() * 45);
  const add = (from, to, watts) => {
    for (let m = Math.max(0, Math.round(from)); m < Math.min(1440, Math.round(to)); m++) w[m] += watts;
  };
  const weekend = dow === 0 || dow === 6;
  for (let m = 0; m < 1440; m++) {
    w[m] += 48 + 8 * gauss(); // standby: router, chargers, TV standby
    if ((m + fridgeOff) % 45 < 17) w[m] += 125 + 10 * gauss(); // refrigerator compressor
  }
  add(330, 390, 45); // morning lights
  add(1050, 1380, 85 + 20 * rand()); // evening lights
  add(1080 + 20 * rand(), 1350 - 20 * rand(), 120); // TV / computer in the evening
  if (!weekend) add(540, 1020, 55 * (rand() > 0.3 ? 1 : 0)); // laptop / study in the day
  else add(600, 960, 90 * (rand() > 0.4 ? 1 : 0)); // weekend: TV / console in the day
  const cook = 345 + 25 * rand();
  add(cook, cook + 25, 520); // rice cooker
  add(cook + 5, cook + 9, 1150); // kettle
  if (rand() > 0.5) add(660 + 30 * rand(), 700 + 30 * rand(), 1000); // lunch: induction / microwave
  for (let i = 0; i < 3; i++) add(300 + i * 480 + 60 * rand(), 305 + i * 480 + 60 * rand(), 380); // water pump
  if (dow === 6 || dow === 3) {
    const s = 540 + 30 * rand();
    for (let m = s; m < s + 60; m += 12) add(m, m + 6, 380); // washing machine
  }
  if (dow === 0) add(1140 + 20 * rand(), 1170 + 20 * rand(), 800); // ironing
  // Air conditioner at night (and on hot afternoons): 10-minute blocks, more of them on hotter days
  const duty = Math.min(0.9, 0.35 + 0.45 * weather);
  const acBlock = (from, to) => {
    for (let m = from; m < to; m += 10) if (rand() < duty) add(m, m + 10, 620 + 140 * weather + 30 * gauss());
  };
  acBlock(1290, 1440);
  acBlock(0, 330);
  if (weather > 0.9 || weekend) acBlock(780, 960);
  for (let m = 0; m < 1440; m++) w[m] += (m % 7 === 0 ? 1 : 0) * 8 * rand(); // small bumps
  return w;
}

// ---- build the whole series ----
const nowMs = Math.floor(Date.now() / MIN) * MIN;
const startMs = nowMs - DAYS * DAY;

async function getRate() {
  if (val("--rate", "")) return Number(val("--rate"));
  if (DRY) return 14.0;
  try {
    return await require("./services/defaultRate").meralcoRate();
  } catch (e) {
    return 14.0;
  }
}

// events: [startMs, endMs, kind] (outages have no readings; brown out has low voltage)
function makeEvents() {
  if (!EVENTS) return { gaps: [], brown: [], theft: [] };
  const at = (daysAgo, hh, mm) => phDayStart(nowMs - daysAgo * DAY) + (hh * 60 + mm) * MIN;
  return {
    gaps: [
      [at(11, 14, 20), at(11, 14, 20) + 38 * MIN],
      [at(5, 2, 5), at(5, 2, 5) + 12 * MIN],
    ],
    brown: [[at(8, 19, 10), at(8, 19, 10) + 22 * MIN]],
    theft: [
      [at(9, 22, 15), "Line 485W vs Home 212W (gap 273W)"],
      [at(2, 14, 40), "Line 392W vs Home 141W (gap 251W)"],
    ],
  };
}

function build(rate) {
  const ev = makeEvents();
  const kwhPerDayTarget = TARGET_BILL / rate / 30;
  const rows = []; // {t, v, a, w, e}
  const days = new Map(); // PH 'YYYY-MM-DD' -> kWh
  let e = 12.3456; // meter's cumulative kWh at the start
  const firstDay = phDayStart(startMs);
  const lastDay = phDayStart(nowMs);
  let weather = 0.8;
  for (let d0 = firstDay; d0 <= lastDay; d0 += DAY) {
    const dow = new Date(d0 + PH).getUTCDay();
    weather = Math.min(1.3, Math.max(0.4, 0.75 * weather + 0.25 * (0.85 + 0.35 * gauss()) + 0.05));
    const prof = dayProfile(dow, weather);
    const raw = prof.reduce((s, x) => s + x, 0) / 60000; // kWh of the unscaled day
    const dayTarget = kwhPerDayTarget * 0.93 * (dow === 0 || dow === 6 ? 1.1 : 0.96) * (0.9 + 0.2 * weather) * (1 + 0.04 * gauss());
    const k = dayTarget / raw;
    for (let m = 0; m < 1440; m++) {
      const t = d0 + m * MIN;
      if (t < startMs || t > nowMs) continue;
      if (ev.gaps.some(([s, f]) => t >= s && t < f)) continue; // power out: no reading
      let watts = prof[m] * k * (1 + 0.025 * gauss());
      const inBrown = ev.brown.some(([s, f]) => t >= s && t < f);
      if (inBrown) watts *= 0.82;
      watts = Math.max(18, watts);
      let volts = 229.5 + 1.8 * Math.sin((m / 1440) * 2 * Math.PI - 1) - watts / 1000 * 1.1 + 0.7 * gauss();
      if (inBrown) volts = 186 + 6 * rand() - 3;
      const pf = Math.min(0.97, 0.62 + 0.3 * Math.min(1, watts / 600));
      const amps = watts / (volts * pf);
      e += watts / 60000;
      const day = ymd(t + PH);
      days.set(day, (days.get(day) || 0) + watts / 60000);
      rows.push({ t, v: volts, a: amps, w: watts, e });
    }
  }
  return { rows, days, ev, rate };
}

function summary({ rows, days, rate }) {
  const keys = [...days.keys()].sort();
  console.log(`Rows: ${rows.length}  | from ${new Date(rows[0].t + PH).toISOString().slice(0, 16)} to ${new Date(rows[rows.length - 1].t + PH).toISOString().slice(0, 16)} (PH)`);
  console.log(`Rate used: PHP ${rate.toFixed(2)}/kWh | target monthly bill: PHP ${TARGET_BILL}\n`);
  let total = 0;
  for (const k of keys) {
    const x = days.get(k);
    total += x;
    console.log(`${k} ${new Date(k + "T00:00:00Z").toUTCString().slice(0, 3)}  ${x.toFixed(2)} kWh  PHP ${(x * rate).toFixed(0)}`);
  }
  const avg = total / keys.length;
  console.log(`\nAverage/day: ${avg.toFixed(2)} kWh | per 30 days: ${(avg * 30).toFixed(0)} kWh = PHP ${(avg * 30 * rate).toFixed(2)}`);
  const ph = new Date(nowMs + PH);
  const dom = ph.getUTCDate(),
    ym = ymd(nowMs + PH).slice(0, 7);
  const mtd = keys.filter((k) => k.startsWith(ym)).reduce((s, k) => s + days.get(k), 0);
  const dim = new Date(Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth() + 1, 0)).getUTCDate();
  console.log(`This month so far: ${mtd.toFixed(1)} kWh = PHP ${(mtd * rate).toFixed(2)} | projected: PHP ${((mtd / dom) * dim * rate).toFixed(2)}`);
}

async function main() {
  const rate = await getRate();
  const data = build(rate);
  summary(data);
  if (DRY) return console.log("\n(dry run: nothing written)");
  if (!EMAIL) throw new Error("Pass --email <the account that should see the data>");

  const db = require("./data/db");
  try {
    const [[user]] = await db.execute("SELECT id FROM users WHERE email = ?", [EMAIL]);
    if (!user) throw new Error(`No account with email ${EMAIL}`);
    let [[dev]] = await db.execute("SELECT id FROM devices WHERE mac = ?", [DEMO_MAC]);

    // wipe any earlier demo rows (so a re-run ends at "now")
    if (dev) {
      await db.execute("DELETE FROM sensor_readings WHERE device_id = ?", [dev.id]);
      await db.execute("DELETE FROM daily_usage WHERE device_id = ?", [dev.id]);
      await db.execute("DELETE FROM theft_events WHERE device_id = ?", [dev.id]).catch(() => {});
      if (CLEAR) await db.execute("DELETE FROM devices WHERE id = ?", [dev.id]);
    }
    if (CLEAR) return console.log("Demo device and its data removed.");

    if (!dev) {
      const key = require("crypto").randomBytes(24).toString("hex");
      // last_seen stays NULL so the dashboard's Online pill keeps following your real meter
      await db.execute("INSERT INTO devices (user_id, mac, api_key, status) VALUES (?, ?, ?, 'offline')", [user.id, DEMO_MAC, key]);
      [[dev]] = await db.execute("SELECT id FROM devices WHERE mac = ?", [DEMO_MAC]);
    }

    // raw readings only for the retention window; older days are stored as daily totals
    const rawFrom = phDayStart(nowMs - RAW_DAYS * DAY);
    const raw = data.rows.filter((r) => r.t >= rawFrom);
    for (let i = 0; i < raw.length; i += 1000) {
      const chunk = raw.slice(i, i + 1000).map((r) => [
        dev.id,
        +r.v.toFixed(1),
        +r.a.toFixed(3),
        +r.w.toFixed(1),
        +r.e.toFixed(4),
        sqlUtc(r.t),
      ]);
      await db.query(
        "INSERT INTO sensor_readings (device_id, voltage, current_amps, active_power_watts, total_kwh, recorded_at) VALUES ?",
        [chunk],
      );
    }
    const today = ymd(nowMs + PH);
    for (const [day, kwh] of data.days) {
      if (day >= today) continue; // today stays in raw rows
      await db.execute(
        "INSERT INTO daily_usage (device_id, day, kwh) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE kwh = VALUES(kwh)",
        [dev.id, day, +kwh.toFixed(4)],
      );
    }
    if (data.ev.theft.length) {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS theft_events (
           id int NOT NULL AUTO_INCREMENT, user_id int NOT NULL, device_id int NOT NULL,
           detected_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, detail varchar(200) DEFAULT NULL,
           PRIMARY KEY (id), KEY idx_theft_user (user_id, detected_at),
           CONSTRAINT fk_theft_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE)`,
      );
      for (const [t, detail] of data.ev.theft)
        await db.execute("INSERT INTO theft_events (user_id, device_id, detected_at, detail) VALUES (?, ?, ?, ?)", [user.id, dev.id, sqlUtc(t), detail]);
    }
    console.log(`\nWrote ${raw.length} readings + ${data.days.size - 1} daily totals + ${data.ev.theft.length} theft entries for ${EMAIL}.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
