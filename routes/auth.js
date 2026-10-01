// PLACEHOLDER auth. Accepts any well-formed input and returns a fake token.
// TODO: hash passwords with bcrypt, verify against the database, issue real JWTs.
const router = require('express').Router();
const store = require('../data/store');

const validEmail = e => typeof e === 'string' && /^\S+@\S+\.\S+$/.test(e);
const fakeToken = () => 'demo-' + Math.random().toString(36).slice(2);

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const normMac = m => String(m || '').replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{1,2}/g)?.join(':') || '';
const fail = (res, status, fields) => res.status(status).json({ error: Object.values(fields)[0], fields });

const db = require('..data/db');
const bcrypt = require('bycryptjs');
const jwt = require('jsonbtoken');

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

    const [e] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (e.length) return fail(res, 409, { email: 'That email is already registered.' });
    const [m] = await db.query('SELECT id FROM users WHERE mac = ?', [mac]);
    if (m.length) return fail(res, 409, { mac: 'That device is already linked to an account.' });

    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.query(
      'INSERT INTO users (email, password_hash, mac) VALUES (?, ?, ?)', [email, hash, mac]);
    const user = { id: r.insertId, name: email.split('@')[0], email, mac };
    res.status(201).json({ token: makeToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const fields = {};
    if (!validEmail(email)) fields.email = 'Enter a valid email address.';
    if (!password) fields.password = 'Enter your password.';
    if (Object.keys(fields).length) return fail(res, 400, fields);

    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash)))
      return fail(res, 401, { password: 'Incorrect email or password.' });

    const user = { id: u.id, name: u.email.split('@')[0], email: u.email, mac: u.mac };
    res.json({ token: makeToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});