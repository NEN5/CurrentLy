// In-memory store (resets on restart).
// DATABASE: swap this module for MySQL/SQLite later; routes only talk to this object.
const config = {
  USE_MOCK_DATA: process.env.USE_MOCK_DATA !== 'false', // set USE_MOCK_DATA=false once the ESP32 is live
  ONLINE_TIMEOUT_MS: 30000,                              // device is "online" if last reading is newer than this
  DEVICE_API_KEY: process.env.DEVICE_API_KEY || 'change-me' // ESP32 sends this in the x-api-key header
};

const store = {
  config,
  settings: { rate: 12, currency: '₱' }, // placeholder rate per kWh, user-adjustable
  users: [],
  daily: {},        // { 'YYYY-MM-DD': kWh }
  latest: null,     // last reading { deviceId, voltage, current, power, energy, at }
  lastSeen: null,   // ms timestamp of last reading
  deviceId: null,
  prevEnergy: null  // previous cumulative kWh from the device, used to compute deltas
};

store.dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

module.exports = store;
