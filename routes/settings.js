const router = require('express').Router();
const db = require('../data/db');
const requireAuth = require('../middleware/requireAuth');

const SYMBOLS = { PHP: '₱' };
const shape = t => ({ rate: Number(t.rate_per_kwh) || 12, currency: SYMBOLS[t.currency] || t.currency || '₱' });

// GET /api/settings  (guests get the default)
router.get('/', requireAuth.optional, async (req, res) => {
  if (!req.user) return res.json({ rate: 12, currency: '₱' });
  try {
    const [rows] = await db.execute('SELECT rate_per_kwh, currency FROM tariff_settings WHERE user_id = ?', [req.user.id]);
    res.json(rows.length ? shape(rows[0]) : { rate: 12, currency: '₱' });
  } catch (err) {
    console.error('settings get failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/settings  { rate }
router.put('/', requireAuth, async (req, res) => {
  const rate = Number(req.body && req.body.rate);
  if (!(rate > 0 && rate < 1000)) return res.status(400).json({ error: 'Rate must be a positive number (per kWh).' });
  try {
    // tariff_settings has one row per user (created at signup); upsert covers older accounts.
    await db.execute(
      `INSERT INTO tariff_settings (user_id, rate_per_kwh) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE rate_per_kwh = VALUES(rate_per_kwh)`, [req.user.id, rate]);
    const [rows] = await db.execute('SELECT rate_per_kwh, currency FROM tariff_settings WHERE user_id = ?', [req.user.id]);
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('settings put failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;