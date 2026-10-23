// The user's own electricity rate. By default the dashboard uses Meralco's current rate
// (see services/defaultRate.js); a custom rate is only used after the user sets one here.
const router = require('express').Router();
const db = require('../data/db');
const requireAuth = require('../middleware/requireAuth');
const { meralcoRate, round2 } = require('../services/defaultRate');

const MAX_RATE = 100; // pesos per kWh: far above any real rate, only guards against typos

// PUT /api/tariff {rate: 12.34}   -> custom rate (2 decimals)
// PUT /api/tariff {reset: true}   -> back to the Meralco default
router.put('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};

    if (body.reset === true) {
      await db.execute('UPDATE tariff_settings SET use_custom = 0 WHERE user_id = ?', [req.user.id]);
      return res.json({ custom: false, rate: await meralcoRate() });
    }

    const rate = round2(Number(body.rate));
    if (!isFinite(rate) || rate <= 0 || rate > MAX_RATE)
      return res.status(400).json({ error: `Enter a rate between 0.01 and ${MAX_RATE}.` });

    await db.execute(
      `INSERT INTO tariff_settings (user_id, rate_per_kwh, use_custom) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE rate_per_kwh = VALUES(rate_per_kwh), use_custom = 1`,
      [req.user.id, rate]);
    res.json({ custom: true, rate });
  } catch (err) {
    console.error('tariff failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
