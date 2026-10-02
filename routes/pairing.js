// Device pairing: the dashboard makes a 6-digit code; the ESP32 swaps it for its API key.
const router = require('express').Router();
const crypto = require('crypto');
const db = require('../data/db');
const requireAuth = require('../middleware/requireAuth');

const CODE_TTL_SEC = 600;
const IP_FAIL_MAX = 10, GLOBAL_FAIL_MAX = 100, FAIL_WINDOW_SEC = 600;
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const normMac = m => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,2}/g)?.join(':') || '';
const code6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const noteFailure = ip => db.execute('INSERT INTO claim_failures (ip) VALUES (?)', [ip]).catch(() => {});
setInterval(() => {
  db.execute('DELETE FROM claim_failures WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)').catch(() => {});
}, 3600000).unref();

// POST /api/device/pair-code (auth) -> { code, expiresInSec }. One row per user; a new code replaces the old one.
router.post('/pair-code', requireAuth, async (req, res) => {
  try {
    for (let i = 0; i < 5; i++) {
      const code = code6();
      try {
        await db.execute(
          `INSERT INTO pairing_codes (user_id, code, expires_at, used_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), NULL)
           ON DUPLICATE KEY UPDATE code = VALUES(code), expires_at = VALUES(expires_at), used_at = NULL`,
          [req.user.id, code, CODE_TTL_SEC]);
        res.set('Cache-Control', 'no-store');
        return res.json({ code, expiresInSec: CODE_TTL_SEC });
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; } // code collided with another user's: retry
    }
    res.status(503).json({ error: 'Try again.' });
  } catch (err) {
    console.error('pair-code failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/device/claim (no auth) body {code, mac} -> { api_key, mac } (key is rotated, shown once)
router.post('/claim', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const [[f]] = await db.execute(
      `SELECT SUM(ip = ?) AS mine, COUNT(*) AS total FROM claim_failures
       WHERE created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`, [req.ip, FAIL_WINDOW_SEC]);
    if (Number(f.mine || 0) >= IP_FAIL_MAX || Number(f.total) >= GLOBAL_FAIL_MAX) {
      res.set('Retry-After', String(FAIL_WINDOW_SEC));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const code = String((req.body || {}).code || '').trim();
    const mac = normMac((req.body || {}).mac);
    if (!/^\d{6}$/.test(code) || !MAC_RE.test(mac))
      return res.status(400).json({ error: 'Send a 6-digit code and the device MAC.' });

    const bad = { error: 'Invalid or expired code. Make a new one on the dashboard.' };
    const [c] = await db.execute(
      'SELECT user_id FROM pairing_codes WHERE code = ? AND used_at IS NULL AND expires_at > NOW()', [code]);
    if (!c.length) { await noteFailure(req.ip); return res.status(400).json(bad); }
    const userId = c[0].user_id;

    const [d] = await db.execute('SELECT id, mac FROM devices WHERE user_id = ? ORDER BY id LIMIT 1', [userId]);
    if (!d.length) return res.status(404).json({ error: 'No device on this account.' });
    const dev = d[0];

    if (dev.mac !== mac) { // adopt the real MAC unless another account already owns it
      const [x] = await db.execute(
        `SELECT (SELECT COUNT(*) FROM devices WHERE mac = ? AND id <> ?)
              + (SELECT COUNT(*) FROM users WHERE mac = ? AND id <> ?) AS n`, [mac, dev.id, mac, userId]);
      if (Number(x[0].n)) return res.status(409).json({ error: 'This device is already linked to another account.' });
    }

    // Atomic consume: only one request can flip used_at.
    const [u] = await db.execute(
      `UPDATE pairing_codes SET used_at = NOW()
       WHERE code = ? AND user_id = ? AND used_at IS NULL AND expires_at > NOW()`, [code, userId]);
    if (u.affectedRows !== 1) { await noteFailure(req.ip); return res.status(400).json(bad); }

    const apiKey = crypto.randomBytes(24).toString('hex'); // rotated: any older key stops working
    await db.execute('UPDATE devices SET mac = ?, api_key = ? WHERE id = ?', [mac, apiKey, dev.id]);
    if (dev.mac !== mac) await db.execute('UPDATE users SET mac = ? WHERE id = ?', [mac, userId]);

    res.status(201).json({ api_key: apiKey, mac });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This device is already linked to another account.' });
    console.error('claim failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;