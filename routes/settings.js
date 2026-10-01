const router = require('express').Router();
const store = require('../data/store');

router.get('/', (req, res) => res.json(store.settings));

router.put('/', (req, res) => {
  const rate = Number(req.body && req.body.rate);
  if (!(rate > 0 && rate < 1000)) return res.status(400).json({ error: 'Rate must be a positive number (per kWh).' });
  store.settings.rate = rate;
  res.json(store.settings);
});

module.exports = router;
