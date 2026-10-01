# Electric Bill Dashboard (ESP32-ready starter)

Whole-household electric bill estimate (Meralco-style) in ₱, with a floating appliance calculator and a device online/offline pill.

## Run
```bash
npm install
npm start          # http://localhost:3000
```
Env vars: `PORT`, `USE_MOCK_DATA` (default `true`), `DEVICE_API_KEY` (default `change-me`).

## Structure
- `server.js` entry; `routes/` auth (placeholder), settings, sensorData (ESP32 + mock + device status)
- `data/store.js` in-memory store; swap for a database later
- `public/` login.html, index.html, css/style.css, js/{api,auth,charts,dashboard}.js

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup`, `/api/auth/login` | Placeholder, returns a fake token |
| GET/PUT | `/api/settings` | Rate per kWh |
| POST | `/api/sensor-data` | **ESP32 posts readings here** (header `x-api-key`) |
| GET | `/api/sensor-data/latest`, `/summary` | Dashboard data |
| GET/POST | `/api/sensor-data/mock` | Toggle simulated data |
| GET | `/api/device/status` | `online` / `offline` / `simulated` |

## Connecting the ESP32
1. Set `USE_MOCK_DATA=false` and a real `DEVICE_API_KEY`.
2. Have the ESP32 POST JSON every few seconds:
```bash
curl -X POST http://localhost:3000/api/sensor-data \
  -H "Content-Type: application/json" -H "x-api-key: change-me" \
  -d '{"deviceId":"esp32-01","voltage":220.4,"current":2.1,"power":462,"energy":123.45}'
```
`energy` is the device's cumulative kWh counter. The device shows Online for 30 seconds after each reading (`ONLINE_TIMEOUT_MS` in `data/store.js`).

## Formulas
`kWh/day = watts × hours ÷ 1000` · `cost = kWh × rate` · `month = day × 30`. The main bill is month-to-date kWh × rate. The default rate (₱12) is a placeholder; set your actual rate in Settings.
