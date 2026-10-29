// Theft log: the ESP32 reports when its LINE-vs-HOME check raises or clears an alarm,
// and the dashboard (sidebar > History > Theft log) lists those events.
const userRouter = require("express").Router(); // mounted at /api/theft   (dashboard, JWT)
const deviceRouter = require("express").Router(); // mounted at /api/device  (ESP32, x-api-key)
const db = require("../data/db");
const requireAuth = require("../middleware/requireAuth");
const { deviceAuth } = require("./phones");

const KEEP_PER_USER = 200; // newest events kept per account
// An open event whose meter stopped reporting (power cut, Wi-Fi lost) is shown as ended after this long.
// The firmware re-sends "still active" about every 60 s while an alarm lasts.
const STALE_SEC = 300;

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("theft failed:", err.message);
    res.status(500).json({ error: "Server error" });
  });
const num = (v, max) =>
  typeof v === "number" && isFinite(v) && v >= 0 && v <= max ? v : null;

// POST /api/device/theft {active, home, line, gap}
//   active true  -> opens an event (or refreshes the open one and keeps the biggest gap)
//   active false -> closes the open event
deviceRouter.post(
  "/theft",
  deviceAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    const userId = req.device.user_id;
    const deviceId = req.device.id;

    if (b.active === false) {
      await db.execute(
        "UPDATE theft_events SET ended_at = NOW() WHERE device_id = ? AND ended_at IS NULL",
        [deviceId],
      );
      return res.json({ ok: true });
    }
    if (b.active !== true)
      return res.status(400).json({ error: "Send {active, home, line, gap}." });

    const home = num(b.home, 50000),
      line = num(b.line, 50000),
      gap = num(b.gap, 50000);
    if (home === null || line === null || gap === null)
      return res
        .status(400)
        .json({ error: "home, line and gap must be watts (>= 0)." });

    const [open] = await db.execute(
      "SELECT id FROM theft_events WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
      [deviceId],
    );
    if (open.length) {
      await db.execute(
        `UPDATE theft_events SET home_w = ?, line_w = ?, gap_w = ?, peak_gap_w = GREATEST(peak_gap_w, ?)
         WHERE id = ?`,
        [home, line, gap, gap, open[0].id],
      );
    } else {
      await db.execute(
        `INSERT INTO theft_events (user_id, device_id, home_w, line_w, gap_w, peak_gap_w)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, deviceId, home, line, gap, gap],
      );
      await db.execute(
        `DELETE FROM theft_events WHERE user_id = ? AND id NOT IN (
           SELECT id FROM (SELECT id FROM theft_events WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP_PER_USER}) t)`,
        [userId, userId],
      );
    }
    res.json({ ok: true });
  }),
);

// GET /api/theft -> { ongoing, events: [{ id, start, end, ongoing, home, line, gap, peakGap }] }  (newest first, max 50)
userRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT id, home_w, line_w, peak_gap_w,
              UNIX_TIMESTAMP(started_at) * 1000 AS start_ms,
              UNIX_TIMESTAMP(ended_at) * 1000 AS end_ms,
              UNIX_TIMESTAMP(updated_at) * 1000 AS upd_ms,
              (ended_at IS NULL AND updated_at >= DATE_SUB(NOW(), INTERVAL ${STALE_SEC} SECOND)) AS ongoing
       FROM theft_events WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [req.user.id],
    );
    const events = rows.map((r) => {
      const ongoing = !!Number(r.ongoing);
      // Never closed by the meter and no longer reporting: end it at its last update.
      const end = ongoing ? null : r.end_ms !== null ? Number(r.end_ms) : Number(r.upd_ms);
      return {
        id: r.id,
        start: Number(r.start_ms),
        end,
        ongoing,
        home: Number(r.home_w),
        line: Number(r.line_w),
        peakGap: Number(r.peak_gap_w),
      };
    });
    res.set("Cache-Control", "no-store");
    res.json({ ongoing: events.some((e) => e.ongoing), events });
  }),
);

// DELETE /api/theft -> clears the log
userRouter.delete(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    await db.execute("DELETE FROM theft_events WHERE user_id = ?", [req.user.id]);
    res.json({ ok: true });
  }),
);

module.exports = { userRouter, deviceRouter };
