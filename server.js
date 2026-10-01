require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./data/db');
const requireAuth = require('./middleware/requireAuth');
const sensor = require('./routes/sensorData');

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in environment. Add it to .env (local) or Render env vars.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// Routes the frontend already uses
// ----------------------------------------------------
app.use('/api/auth', require('./routes/auth'));          // login + signup (MySQL)
app.use('/api/settings', require('./routes/settings'));
app.use('/api/sensor-data', sensor.router);
app.use('/api/device', sensor.deviceRouter);

// ----------------------------------------------------
// Dashboard summary (login required; user comes from the token)
// ----------------------------------------------------
app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [tariff] = await db.execute(
      'SELECT rate_per_kwh, currency FROM tariff_settings WHERE user_id = ?', [userId]);
    const rate = Number(tariff[0]?.rate_per_kwh) || 12.0;
    const currency = tariff[0]?.currency || 'PHP';

    const [readings] = await db.execute(
      `SELECT sr.total_kwh, sr.active_power_watts, sr.recorded_at
       FROM sensor_readings sr
       JOIN devices d ON sr.device_id = d.id
       WHERE d.user_id = ?
       ORDER BY sr.recorded_at DESC LIMIT 1`, [userId]);

    const latestkWh = Number(readings[0]?.total_kwh) || 0;
    const currentWatts = Number(readings[0]?.active_power_watts) || 0;

    res.json({
      currency,
      rate_per_kwh: rate,
      current_power_watts: currentWatts,
      total_kwh: latestkWh,
      estimated_bill: Number((latestkWh * rate).toFixed(2))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------------------------------------
// Appliance calculator
// ----------------------------------------------------
app.post('/api/calculator/estimate', (req, res) => {
  const { watts, hours_per_day, rate_per_kwh, quantity } = req.body || {};
  if (!(watts >= 0) || !(hours_per_day >= 0))
    return res.status(400).json({ error: 'watts and hours_per_day are required numbers.' });
  const qty = quantity || 1;
  const dailyKwh = (watts * hours_per_day * qty) / 1000;
  const monthlyKwh = dailyKwh * 30;
  const monthlyCost = monthlyKwh * (rate_per_kwh || 12.0);
  res.json({
    daily_kwh: Number(dailyKwh.toFixed(2)),
    monthly_kwh: Number(monthlyKwh.toFixed(2)),
    monthly_cost: Number(monthlyCost.toFixed(2))
  });
});

// ----------------------------------------------------
// ESP32 telemetry (authenticated by the device's api_key)
// ----------------------------------------------------
app.post('/api/telemetry', async (req, res) => {
  try {
    const api_key = req.body.api_key || req.headers['x-api-key'];
    const { voltage, current_amps, active_power_watts, total_kwh } = req.body;

    const [devices] = await db.execute('SELECT id FROM devices WHERE api_key = ?', [api_key]);
    if (devices.length === 0) return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    const device_id = devices[0].id;

    await db.execute(
      `INSERT INTO sensor_readings (device_id, voltage, current_amps, active_power_watts, total_kwh)
       VALUES (?, ?, ?, ?, ?)`,
      [device_id, voltage, current_amps, active_power_watts, total_kwh]);
    await db.execute("UPDATE devices SET last_seen = NOW(), status = 'online' WHERE id = ?", [device_id]);

    res.status(200).json({ message: 'Telemetry recorded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------------------------------------
// Static files + JSON 404 for unknown API paths (must stay last)
// ----------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));