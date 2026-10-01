// Real auth: bcrypt-hashed passwords in Aiven MySQL + JWT tokens.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../data/db');

const validEmail = e => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const normMac = m => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,2}/g)?.join(':') || '';
const fail = (res, status, fields) => res.status(status).json({ error: Object.values(fields)[0], fields });
const makeToken = u => jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const mac = normMac(req.body && req.body.mac);
    const fields = {};
    if (!MAC_RE.test(mac)) fields.mac = 'Enter a valid MAC address (AA:BB:CC:DD:EE:FF).';
    if (!validEmail(email)) fields.email = 'Enter a valid email address.';
    if (!password || password.length < 6) fields.password = 'Password must be at least 6 characters.';
    if (Object.keys(fields).length) return fail(res, 400, fields);

    const [e] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (e.length) return fail(res, 409, { email: 'That email is already registered.' });
    const [m] = await db.execute('SELECT id FROM users WHERE mac = ?', [mac]);
    if (m.length) return fail(res, 409, { mac: 'That device is already linked to an account.' });

    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.execute(
      'INSERT INTO users (email, password_hash, mac) VALUES (?, ?, ?)', [email, hash, mac]);
    const userId = r.insertId;

    // Link the ESP32 (by MAC) to this user, with its own API key for telemetry.
    const apiKey = crypto.randomBytes(24).toString('hex');
    await db.execute('INSERT INTO devices (user_id, mac, api_key) VALUES (?, ?, ?)', [userId, mac, apiKey]);
    await db.execute('INSERT INTO tariff_settings (user_id) VALUES (?)', [userId]);

    const user = { id: userId, name: email.split('@')[0], email, mac };
    res.status(201).json({ token: makeToken(user), user });
  } catch (err) {
    console.error('signup error:', err);
    if (err.code === 'ER_DUP_ENTRY') return fail(res, 409, { email: 'Email or device already registered.' });
    res.status(500).json({ error: 'Server error. Try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const fields = {};
    if (!validEmail(email)) fields.email = 'Enter a valid email address.';
    if (!password) fields.password = 'Enter your password.';
    if (Object.keys(fields).length) return fail(res, 400, fields);

    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash)))
      return fail(res, 401, { password: 'Incorrect email or password.' });

    const user = { id: u.id, name: u.email.split('@')[0], email: u.email, mac: u.mac };
    res.json({ token: makeToken(user), user });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
});

module.exports = router;