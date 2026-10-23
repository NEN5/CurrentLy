// Texts received by the meter's SIM card (network notices such as low balance, promos, replies).
// The ESP32 reads them from the SIM800L and uploads them; the dashboard shows them under the bell.
const userRouter = require("express").Router(); // mounted at /api/inbox  (dashboard, JWT)
const deviceRouter = require("express").Router(); // mounted at /api/device (ESP32, x-api-key)
const db = require("../data/db");
const requireAuth = require("../middleware/requireAuth");
const { deviceAuth } = require("./phones");

const KEEP_PER_USER = 100; // newest texts kept per account
const MAX_BATCH = 5; // texts accepted per upload (server.js limits the request body to 4 kb)

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("inbox failed:", err.message);
    res.status(500).json({ error: "Server error" });
  });
// Plain text only: drop control characters (keeps new lines and tabs), then cut to length.
const clean = (v, max) =>
  String(v == null ? "" : v)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);

// POST /api/device/inbox {messages:[{from, text, at}]} -> { ok, saved }
deviceRouter.post(
  "/inbox",
  deviceAuth,
  wrap(async (req, res) => {
    const list = Array.isArray((req.body || {}).messages)
      ? req.body.messages.slice(0, MAX_BATCH)
      : null;
    if (!list)
      return res
        .status(400)
        .json({ error: "Send {messages:[{from,text,at}]}." });

    const userId = req.device.user_id;
    let saved = 0;
    for (const m of list) {
      const text = clean(m && m.text, 500);
      if (!text) continue;
      await db.execute(
        "INSERT INTO sim_inbox (user_id, sender, body, sim_time) VALUES (?, ?, ?, ?)",
        [userId, clean(m.from, 40) || "Unknown", text, clean(m.at, 32)],
      );
      saved++;
    }
    if (saved) {
      await db.execute(
        `DELETE FROM sim_inbox WHERE user_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM sim_inbox WHERE user_id = ? ORDER BY id DESC LIMIT ${KEEP_PER_USER}) t)`,
        [userId, userId],
      );
    }
    res.json({ ok: true, saved });
  }),
);

// GET /api/inbox -> { unread, messages: [{ id, from, text, at, read }] }  (newest first, max 50)
userRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const [rows] = await db.execute(
      `SELECT id, sender, body, UNIX_TIMESTAMP(received_at) * 1000 AS at_ms, (read_at IS NOT NULL) AS is_read
     FROM sim_inbox WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [req.user.id],
    );
    const [[c]] = await db.execute(
      "SELECT COUNT(*) AS n FROM sim_inbox WHERE user_id = ? AND read_at IS NULL",
      [req.user.id],
    );
    res.set("Cache-Control", "no-store");
    res.json({
      unread: Number(c.n),
      messages: rows.map((r) => ({
        id: r.id,
        from: r.sender,
        text: r.body,
        at: Number(r.at_ms),
        read: !!Number(r.is_read),
      })),
    });
  }),
);

// POST /api/inbox/read  -> marks everything read
userRouter.post(
  "/read",
  requireAuth,
  wrap(async (req, res) => {
    await db.execute(
      "UPDATE sim_inbox SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL",
      [req.user.id],
    );
    res.json({ ok: true });
  }),
);

// DELETE /api/inbox -> clears the list
userRouter.delete(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    await db.execute("DELETE FROM sim_inbox WHERE user_id = ?", [req.user.id]);
    res.json({ ok: true });
  }),
);

// Housekeeping: nothing older than 30 days.
setInterval(() => {
  db.execute(
    "DELETE FROM sim_inbox WHERE received_at < DATE_SUB(NOW(), INTERVAL 30 DAY)",
  ).catch(() => {});
}, 6 * 3600000).unref();

module.exports = { userRouter, deviceRouter };
