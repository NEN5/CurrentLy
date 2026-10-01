const router = require('express').Router();
const rates = require('../services/meralcoRates');

// Public: latest known Meralco rate (September 2026 until a newer month is found).
router.get('/meralco', async (req, res) => {
  try {
    rates.maybeRefresh().catch(() => {}); // lazy refresh (also works when the free Render instance slept)
    const latest = await rates.getLatest();
    if (!latest) return res.status(404).json({ error: 'No rate stored yet. Run schema.sql.' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(latest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual refresh, protected by ADMIN_KEY:  POST /api/rates/meralco/refresh  {"period":"2026-10"}
router.post('/meralco/refresh', async (req, res) => {
  try {
    if (!process.env.ADMIN_KEY || req.get('x-admin-key') !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Forbidden' });
    const period = (req.body && req.body.period) || rates.currentPeriod();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
    res.json(await rates.refreshPeriod(period));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Refresh failed: ' + err.message });
  }
});

module.exports = router;