// Phone numbers for SMS theft alerts.
// A number is only used by the ESP32 after its owner proves they have it: the server queues an
// OTP text, the ESP32 (SIM800L) sends it, and the owner types the code on the dashboard.
const crypto = require("crypto");
const userRouter = require("express").Router(); // mounted at /api/phones        (dashboard, JWT)
const deviceRouter = require("express").Router(); // mounted at /api/device        (ESP32, x-api-key)
const db = require("../data/db");
const requireAuth = require("../middleware/requireAuth");

const MAX_NUMBERS = 3; // per user, pending + verified
const OTP_TTL_SEC = 300; // a code is valid for 5 minutes
const OTP_MAX_TRIES = 5; // wrong guesses before the code is dead
const RESEND_GAP_SEC = 60; // minimum wait between codes for the same number
const OTP_PER_HOUR = 6; // codes per user per hour (each one costs SIM credit)
const SMS_MAX_ATTEMPTS = 3; // delivery attempts by the ESP32 before a text is marked failed
const ONLINE_WINDOW_SEC = Number(process.env.ONLINE_WINDOW_SEC) || 60;

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error("phones failed:", err.message);
    res.status(500).json({ error: "Server error" });
  });

// Philippine mobile numbers only: 09171234567, 9171234567, 639171234567 or +639171234567.
function normPhone(raw) {
  let s = String(raw || "").replace(/[\s\-().]/g, "");
  if (/^09\d{9}$/.test(s)) s = "+63" + s.slice(1);
  else if (/^639\d{9}$/.test(s)) s = "+" + s;
  else if (/^9\d{9}$/.test(s)) s = "+63" + s;
  return /^\+639\d{9}$/.test(s) ? s : null;
}

const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
// Only a keyed hash of the code is stored; the plain code lives in sms_queue until the ESP32 has sent it.
const hashCode = (phoneId, code) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`${phoneId}:${code}`)
    .digest("hex");

// Creates a fresh code for a number and queues the text. Returns { ok } or { status, error }.
async function issueOtp(userId, row) {
  const [[c]] = await db.execute(
    "SELECT COUNT(*) AS n FROM sms_queue WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)",
    [userId],
  );
  if (Number(c.n) >= OTP_PER_HOUR)
    return {
      status: 429,
      error: "Too many codes requested. Try again in an hour.",
    };

  const code = newCode();
  await db.execute(
    `UPDATE phone_numbers
     SET otp_hash = ?, otp_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), otp_tries = 0, otp_sent_at = NOW()
     WHERE id = ?`,
    [hashCode(row.id, code), OTP_TTL_SEC, row.id],
  );
  // An older code for this number must not be sent any more.
  await db.execute(
    "UPDATE sms_queue SET status = 'expired', body = '' WHERE phone_id = ? AND status = 'queued'",
    [row.id],
  );
  await db.execute(
    "INSERT INTO sms_queue (user_id, phone_id, to_number, body) VALUES (?, ?, ?, ?)",
    [
      userId,
      row.id,
      row.phone,
      `CurrentLy code: ${code}. Valid for 5 minutes. Do not share it.`,
    ],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dashboard API (JWT)
// ---------------------------------------------------------------------------

// GET /api/phones -> { max, numbers: [{ id, phone, status }] }
userRouter.get(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const [rows] = await db.execute(
      "SELECT id, phone, status FROM phone_numbers WHERE user_id = ? ORDER BY id",
      [req.user.id],
    );
    res.json({
      max: MAX_NUMBERS,
      numbers: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        status: r.status,
      })),
    });
  }),
);

// POST /api/phones {phone} -> 201 { id, phone, status:'pending', expiresInSec, deviceOnline }
userRouter.post(
  "/",
  requireAuth,
  wrap(async (req, res) => {
    const phone = normPhone((req.body || {}).phone);
    if (!phone)
      return res.status(400).json({
        error: "Enter a valid Philippine mobile number, e.g. 09171234567.",
      });

    const [dev] = await db.execute(
      "SELECT TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age_s FROM devices WHERE user_id = ? ORDER BY id LIMIT 1",
      [req.user.id],
    );
    if (!dev.length)
      return res.status(400).json({
        error: "Pair your meter first. It sends the verification text.",
      });
    const deviceOnline =
      dev[0].age_s !== null && Number(dev[0].age_s) <= ONLINE_WINDOW_SEC;

    const [rows] = await db.execute(
      `SELECT id, phone, status, TIMESTAMPDIFF(SECOND, otp_sent_at, NOW()) AS sent_ago
     FROM phone_numbers WHERE user_id = ?`,
      [req.user.id],
    );
    let row = rows.find((r) => r.phone === phone);
    if (row && row.status === "verified")
      return res.status(409).json({ error: "That number is already added." });

    if (row) {
      // already pending: behaves like Resend
      if (row.sent_ago !== null && Number(row.sent_ago) < RESEND_GAP_SEC)
        return res.status(429).json({
          error: `Wait ${RESEND_GAP_SEC - Number(row.sent_ago)} s before asking for another code.`,
        });
    } else {
      if (rows.length >= MAX_NUMBERS)
        return res.status(400).json({
          error: `You can register up to ${MAX_NUMBERS} numbers. Remove one first.`,
        });
      const [ins] = await db.execute(
        "INSERT INTO phone_numbers (user_id, phone) VALUES (?, ?)",
        [req.user.id, phone],
      );
      row = { id: ins.insertId, phone, created: true };
    }

    const r = await issueOtp(req.user.id, row);
    if (r.error) {
      if (row.created)
        await db.execute("DELETE FROM phone_numbers WHERE id = ?", [row.id]);
      return res.status(r.status).json({ error: r.error });
    }
    res.status(201).json({
      id: row.id,
      phone,
      status: "pending",
      expiresInSec: OTP_TTL_SEC,
      deviceOnline,
    });
  }),
);

// POST /api/phones/:id/resend
userRouter.post(
  "/:id/resend",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(404).json({ error: "Number not found." });
    const [rows] = await db.execute(
      `SELECT id, phone, status, TIMESTAMPDIFF(SECOND, otp_sent_at, NOW()) AS sent_ago
     FROM phone_numbers WHERE id = ? AND user_id = ?`,
      [id, req.user.id],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Number not found." });
    const row = rows[0];
    if (row.status !== "pending")
      return res
        .status(400)
        .json({ error: "That number is already verified." });
    if (row.sent_ago !== null && Number(row.sent_ago) < RESEND_GAP_SEC)
      return res.status(429).json({
        error: `Wait ${RESEND_GAP_SEC - Number(row.sent_ago)} s before asking for another code.`,
      });

    const r = await issueOtp(req.user.id, row);
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, expiresInSec: OTP_TTL_SEC });
  }),
);

// POST /api/phones/:id/verify {code}
userRouter.post(
  "/:id/verify",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const code = String((req.body || {}).code || "").trim();
    if (!Number.isInteger(id) || id < 1)
      return res.status(404).json({ error: "Number not found." });
    if (!/^\d{6}$/.test(code))
      return res.status(400).json({ error: "Enter the 6-digit code." });

    const [rows] = await db.execute(
      `SELECT status, otp_hash, otp_tries, (otp_expires_at > NOW()) AS fresh
     FROM phone_numbers WHERE id = ? AND user_id = ?`,
      [id, req.user.id],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Number not found." });
    const r = rows[0];
    if (r.status === "verified") return res.json({ ok: true });
    if (!r.otp_hash || !Number(r.fresh))
      return res
        .status(400)
        .json({ error: "Code expired. Tap Resend for a new one." });

    // Count the attempt first (atomic), so parallel guesses cannot exceed the limit.
    const [u] = await db.execute(
      "UPDATE phone_numbers SET otp_tries = otp_tries + 1 WHERE id = ? AND otp_tries < ?",
      [id, OTP_MAX_TRIES],
    );
    if (u.affectedRows !== 1)
      return res
        .status(429)
        .json({ error: "Too many wrong codes. Tap Resend for a new one." });

    const a = Buffer.from(hashCode(id, code)),
      b = Buffer.from(String(r.otp_hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const left = OTP_MAX_TRIES - Number(r.otp_tries) - 1;
      return res.status(400).json({
        error:
          left > 0
            ? `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.`
            : "Wrong code. Tap Resend for a new one.",
      });
    }

    await db.execute(
      `UPDATE phone_numbers SET status = 'verified', verified_at = NOW(), otp_hash = NULL, otp_expires_at = NULL
     WHERE id = ? AND status = 'pending'`,
      [id],
    );
    res.json({ ok: true });
  }),
);

// DELETE /api/phones/:id
userRouter.delete(
  "/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(404).json({ error: "Number not found." });
    const [d] = await db.execute(
      "DELETE FROM phone_numbers WHERE id = ? AND user_id = ?",
      [id, req.user.id],
    );
    if (!d.affectedRows)
      return res.status(404).json({ error: "Number not found." });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// ESP32 API (header x-api-key = devices.api_key)
// ---------------------------------------------------------------------------
const KEY_RE = /^[A-Za-z0-9]{16,64}$/;
const FAIL_MAX = 30,
  FAIL_WINDOW_MS = 60000; // 30 bad keys / minute / IP
const failures = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of failures) if (now > f.reset) failures.delete(k);
}, 60000).unref();

async function deviceAuth(req, res, next) {
  try {
    const f = failures.get(req.ip);
    if (f && Date.now() <= f.reset && f.n >= FAIL_MAX) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "Too many requests" });
    }
    const key = String(req.get("x-api-key") || "").trim();
    let dev = null;
    if (KEY_RE.test(key)) {
      const [rows] = await db.execute(
        "SELECT id, user_id FROM devices WHERE api_key = ?",
        [key],
      );
      dev = rows[0] || null;
    }
    if (!dev) {
      const now = Date.now(),
        cur = failures.get(req.ip);
      if (!cur || now > cur.reset)
        failures.set(req.ip, { n: 1, reset: now + FAIL_WINDOW_MS });
      else cur.n++;
      return res.status(401).json({ error: "Invalid API key" });
    }
    req.device = dev;
    next();
  } catch (err) {
    console.error("device auth failed:", err.message);
    res.status(500).json({ error: "Server error" });
  }
}

// GET /api/device/sync -> { phones: ['+639...'], sms: [{ id, to, body }] }
// phones = verified numbers (the only ones the ESP32 may text); sms = OTP texts waiting to be sent.
deviceRouter.get(
  "/sync",
  deviceAuth,
  wrap(async (req, res) => {
    const userId = req.device.user_id;
    const [phones] = await db.execute(
      "SELECT phone FROM phone_numbers WHERE user_id = ? AND status = 'verified' ORDER BY id",
      [userId],
    );
    const [sms] = await db.execute(
      `SELECT id, to_number, body FROM sms_queue
     WHERE user_id = ? AND status = 'queued' AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
     ORDER BY id LIMIT 2`,
      [userId, OTP_TTL_SEC],
    );
    res.set("Cache-Control", "no-store");
    res.json({
      phones: phones.map((p) => p.phone),
      sms: sms.map((s) => ({ id: s.id, to: s.to_number, body: s.body })),
    });
  }),
);

// POST /api/device/sms-result {id, ok}  (the plain code is erased once the text is sent or given up on)
deviceRouter.post(
  "/sms-result",
  deviceAuth,
  wrap(async (req, res) => {
    const id = Number((req.body || {}).id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(400).json({ error: "Send {id, ok}." });
    if ((req.body || {}).ok === true) {
      await db.execute(
        "UPDATE sms_queue SET status = 'sent', sent_at = NOW(), body = '' WHERE id = ? AND user_id = ? AND status = 'queued'",
        [id, req.device.user_id],
      );
    } else {
      // MySQL evaluates SET left to right: status/body still see the old attempts, so attempts goes last.
      await db.execute(
        `UPDATE sms_queue
       SET status = IF(attempts + 1 >= ?, 'failed', 'queued'),
           body = IF(attempts + 1 >= ?, '', body),
           attempts = attempts + 1
       WHERE id = ? AND user_id = ? AND status = 'queued'`,
        [SMS_MAX_ATTEMPTS, SMS_MAX_ATTEMPTS, id, req.device.user_id],
      );
    }
    res.json({ ok: true });
  }),
);

// Housekeeping: drop old texts and numbers that were never verified.
setInterval(() => {
  db.execute(
    "DELETE FROM sms_queue WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)",
  ).catch(() => {});
  db.execute(
    "DELETE FROM phone_numbers WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)",
  ).catch(() => {});
}, 3600000).unref();

module.exports = { userRouter, deviceRouter, deviceAuth };
