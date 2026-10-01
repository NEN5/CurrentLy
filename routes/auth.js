// PLACEHOLDER auth. Accepts any well-formed input and returns a fake token.
// TODO: hash passwords with bcrypt, verify against the database, issue real JWTs.
const router = require('express').Router();
const store = require('../data/store');

const validEmail = e => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);
const fakeToken = () => 'demo-' + Math.random().toString(36).slice(2);

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const normMac = m => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,2}/g)?.join(':') || '';
const fail = (res, status, fields) => res.status(status).json({ error: Object.values(fields)[0], fields });

router.post('/signup', (req, res) => {
  const { email, password } = req.body || {};
  const mac = normMac(req.body && req.body.mac);
  const fields = {};
  if (!MAC_RE.test(mac)) fields.mac = 'Enter a valid MAC address (AA:BB:CC:DD:EE:FF).';
  if (!validEmail(email)) fields.email = 'Enter a valid email address.';
  if (!password || password.length < 6) fields.password = 'Password must be at least 6 characters.';
  if (Object.keys(fields).length) return fail(res, 400, fields);
  if (store.users.find(u => u.email === email)) return fail(res, 409, { email: 'That email is already registered.' });
  if (store.users.find(u => u.mac === mac)) return fail(res, 409, { mac: 'That device is already linked to an account.' });
  // ESP32 INTEGRATION: the MAC saved here links a device to its owner.
  // Later, sensor-data POSTs carrying this MAC can be matched to this user.
  const user = { name: email.split('@')[0], email, mac }; // password intentionally not stored in the placeholder
  store.users.push(user);
  res.status(201).json({ token: fakeToken(), user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const fields = {};
  if (!validEmail(email)) fields.email = 'Enter a valid email address.';
  if (!password) fields.password = 'Enter your password.';
  if (Object.keys(fields).length) return fail(res, 400, fields);
  const user = store.users.find(u => u.email === email) || { name: email.split('@')[0], email };
  res.json({ token: fakeToken(), user });
});

module.exports = router;
