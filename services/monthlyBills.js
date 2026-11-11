// Monthly bill log (History > Monthly bills).
// When a Philippine calendar month is over, its total kWh (from daily_usage, the rollup kept forever)
// and the bill at that time's rate are saved as one row in monthly_bills. Runs 40 s after boot and
// hourly after that; a month is only ever logged once.
//
// TEMPORARY TEST TOOLS (marked "TEST" in the page): addTestMonth / clearTestMonths below, and the
// /api/history/bills/test routes that call them. Set BILL_TEST_TOOLS=off in the environment to switch
// them off, or delete everything marked "TEMPORARY" once you have seen the log working.
const db = require("../data/db");
const { meralcoRate } = require("./defaultRate");

const PH_OFFSET_MS = 8 * 3600 * 1000; // Philippine time = UTC+8 (no DST)
const SYMBOLS = { PHP: "₱" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TEST_TOOLS = (process.env.BILL_TEST_TOOLS || "on").toLowerCase() !== "off"; // TEMPORARY

const phNow = () => new Date(Date.now() + PH_OFFSET_MS);
const periodOf = (d) => d.toISOString().slice(0, 7); // 'YYYY-MM' from a UTC-shifted Date
const currentPeriod = () => periodOf(phNow());
const label = (p) => `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
const round2 = (n) => Math.round(n * 100) / 100;

// Created on demand (retried if it failed once), like theft_events.
let table = null;
function ensureTable() {
  if (!table)
    table = db
      .execute(
        `CREATE TABLE IF NOT EXISTS monthly_bills (
           id int NOT NULL AUTO_INCREMENT,
           user_id int NOT NULL,
           period char(7) NOT NULL,
           kwh decimal(10,3) NOT NULL DEFAULT 0,
           rate decimal(8,2) NOT NULL,
           amount decimal(10,2) NOT NULL,
           currency varchar(8) NOT NULL DEFAULT '₱',
           is_test tinyint(1) NOT NULL DEFAULT 0,
           created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (id),
           UNIQUE KEY uq_bill_user_period (user_id, period),
           CONSTRAINT fk_bill_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
         )`,
      )
      .catch((err) => {
        table = null;
        console.error("monthly_bills table:", err.message);
        throw err;
      });
  return table;
}

// The account's rate right now: its own custom rate, otherwise Meralco's.
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
    if (Number(t[0].use_custom) === 1) rate = Number(t[0].rate_per_kwh) || defaultRate;
  }
  return { rate, currency };
}

// Logs every finished month that has usage and is not logged yet, for every account.
async function closeMonths() {
  await ensureTable();
  // Make sure the last day of the month has been rolled up into daily_usage first.
  try {
    await require("./retention").run();
  } catch {}
  const firstOfThisMonth = currentPeriod() + "-01";
  const [rows] = await db.execute(
    `SELECT d.user_id AS user_id, DATE_FORMAT(du.day, '%Y-%m') AS period, SUM(du.kwh) AS kwh
     FROM daily_usage du JOIN devices d ON d.id = du.device_id
     WHERE du.day < ?
     GROUP BY d.user_id, period HAVING SUM(du.kwh) > 0`,
    [firstOfThisMonth],
  );
  const rates = new Map();
  let n = 0;
  for (const r of rows) {
    const [[have]] = await db.execute(
      "SELECT is_test FROM monthly_bills WHERE user_id = ? AND period = ?",
      [r.user_id, r.period],
    );
    if (have && !Number(have.is_test)) continue; // already logged
    if (!rates.has(r.user_id)) rates.set(r.user_id, await userRate(r.user_id));
    const { rate, currency } = rates.get(r.user_id);
    const kwh = Number(r.kwh);
    // A real month replaces a test entry for the same month.
    await db.execute(
      `INSERT INTO monthly_bills (user_id, period, kwh, rate, amount, currency, is_test)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE kwh = VALUES(kwh), rate = VALUES(rate), amount = VALUES(amount),
                               currency = VALUES(currency), is_test = 0`,
      [r.user_id, r.period, kwh, rate, round2(kwh * rate), currency],
    );
    n++;
  }
  if (n) console.log(`monthly bills: logged ${n} month(s)`);
  return n;
}

async function listBills(userId) {
  await ensureTable();
  const [rows] = await db.execute(
    `SELECT period, kwh, rate, amount, currency, is_test FROM monthly_bills
     WHERE user_id = ? ORDER BY period DESC LIMIT 120`,
    [userId],
  );
  return rows.map((r) => ({
    period: r.period,
    label: label(r.period),
    kwh: Number(r.kwh),
    rate: Number(r.rate),
    amount: Number(r.amount),
    currency: r.currency,
    test: !!Number(r.is_test),
  }));
}

// ---- TEMPORARY: test entries -----------------------------------------------------------------
// Adds one made-up month: the most recent past month (up to 24 back) that is not logged yet.
async function addTestMonth(userId) {
  await ensureTable();
  const { rate, currency } = await userRate(userId);
  const now = phNow();
  for (let i = 1; i <= 24; i++) {
    const p = periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
    const [[have]] = await db.execute(
      "SELECT 1 AS x FROM monthly_bills WHERE user_id = ? AND period = ?",
      [userId, p],
    );
    if (have) continue;
    const kwh = Math.round((150 + Math.random() * 300) * 1000) / 1000;
    await db.execute(
      `INSERT INTO monthly_bills (user_id, period, kwh, rate, amount, currency, is_test)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [userId, p, kwh, rate, round2(kwh * rate), currency],
    );
    return { added: label(p) };
  }
  return { added: null };
}

async function clearTestMonths(userId) {
  await ensureTable();
  const [r] = await db.execute("DELETE FROM monthly_bills WHERE user_id = ? AND is_test = 1", [userId]);
  return { removed: r.affectedRows };
}

function startScheduler() {
  const run = () => closeMonths().catch((err) => console.error("monthly bills failed:", err.message));
  setTimeout(run, 40000).unref();
  setInterval(run, 3600000).unref();
}

module.exports = { startScheduler, closeMonths, listBills, ensureTable, addTestMonth, clearTestMonths, TEST_TOOLS, currentPeriod, label };
