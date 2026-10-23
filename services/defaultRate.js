// The default electricity rate: Meralco's current overall rate, rounded to 2 decimals like a Meralco bill.
// Read straight from services/meralcoRates.js (same figure as the dashboard's "kWh Rate"), cached 10 minutes.
// If that is ever unavailable the last known value is used, and 12.00 only if there has never been one.
const { getLatest } = require('./meralcoRates');
const FALLBACK = 12;
const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, value: null };

const round2 = n => Math.round(n * 100) / 100;

async function meralcoRate() {
  if (cache.value !== null && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const latest = await getLatest();
    const value = round2(Number(latest && latest.overall_rate_per_kwh));
    if (isFinite(value) && value > 0) {
      cache = { at: Date.now(), value };
      return value;
    }
  } catch (err) {
    console.error('meralcoRate failed:', err.message);
  }
  if (cache.value !== null) cache.at = Date.now() - CACHE_MS + 60000; // keep the old value, retry in a minute
  return cache.value !== null ? cache.value : FALLBACK;
}

module.exports = { meralcoRate, round2 };
