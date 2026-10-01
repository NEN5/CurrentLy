const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ----------------------------------------------------
// 1. GENERALIZED DASHBOARD SUMMARY (Directly from ESP32 Data)
// ----------------------------------------------------

// GET overall household energy usage & estimated bill
app.get('/api/dashboard/summary/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get current tariff rate for the user
    const [tariff] = await db.execute(
      'SELECT rate_per_kwh, currency FROM tariff_settings WHERE user_id = ?', 
      [userId]
    );
    
    const rate = tariff[0]?.rate_per_kwh || 12.00;
    const currency = tariff[0]?.currency || 'PHP';

    // Get latest total kWh consumed from the user's ESP32 device
    const [readings] = await db.execute(
      `SELECT sr.total_kwh, sr.active_power_watts, sr.recorded_at 
       FROM sensor_readings sr
       JOIN devices d ON sr.device_id = d.id
       WHERE d.user_id = ?
       ORDER BY sr.recorded_at DESC LIMIT 1`,
      [userId]
    );

    const latestkWh = readings[0]?.total_kwh || 0;
    const currentWatts = readings[0]?.active_power_watts || 0;
    const estimatedBill = (latestkWh * rate).toFixed(2);

    res.json({
      currency,
      rate_per_kwh: rate,
      current_power_watts: currentWatts,
      total_kwh: latestkWh,
      estimated_bill: Number(estimatedBill)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 2. STANDALONE CALCULATOR HELPER (Optional API route)
// ----------------------------------------------------

// POST quick estimation for an individual appliance
app.post('/api/calculator/estimate', async (req, res) => {
  try {
    const { watts, hours_per_day, rate_per_kwh, quantity } = req.body;
    
    const qty = quantity || 1;
    const dailyKwh = (watts * hours_per_day * qty) / 1000;
    const monthlyKwh = dailyKwh * 30;
    const monthlyCost = monthlyKwh * (rate_per_kwh || 12.00);

    res.json({
      daily_kwh: Number(dailyKwh.toFixed(2)),
      monthly_kwh: Number(monthlyKwh.toFixed(2)),
      monthly_cost: Number(monthlyCost.toFixed(2))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 3. ESP32 TELEMETRY INGESTION (Hardware Route)
// ----------------------------------------------------

app.post('/api/telemetry', async (req, res) => {
  try {
    const { api_key, voltage, current_amps, active_power_watts, total_kwh } = req.body;

    const [devices] = await db.execute('SELECT id FROM devices WHERE api_key = ?', [api_key]);
    if (devices.length === 0) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    const device_id = devices[0].id;

    await db.execute(
      `INSERT INTO sensor_readings (device_id, voltage, current_amps, active_power_watts, total_kwh)
       VALUES (?, ?, ?, ?, ?)`,
      [device_id, voltage, current_amps, active_power_watts, total_kwh]
    );

    await db.execute('UPDATE devices SET last_seen = NOW(), status = "online" WHERE id = ?', [device_id]);

    res.status(200).json({ message: 'Telemetry recorded successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));