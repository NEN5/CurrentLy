// Login / sign-up page logic. Backend is a placeholder (see routes/auth.js).
const form = document.getElementById('authForm');
const page = form.dataset.page; // 'login' | 'signup'
const btn = document.getElementById('submitBtn');
const formError = document.getElementById('formError');
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function setError(name, text) {
  const input = document.getElementById(name);
  const out = document.getElementById(name + '-err');
  if (!input || !out) return;
  out.textContent = text || '';
  if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}
function clearErrors() { ['mac', 'email', 'password'].forEach(n => setError(n, '')); formError.textContent = ''; }

// Auto-format MAC as AA:BB:CC:DD:EE:FF while typing.
const macInput = document.getElementById('mac');
if (macInput) {
  macInput.addEventListener('input', () => {
    const hex = macInput.value.replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 12);
    macInput.value = hex.match(/.{1,2}/g)?.join(':') || '';
    setError('mac', '');
  });
}
['email', 'password'].forEach(n => document.getElementById(n).addEventListener('input', () => setError(n, '')));

// Show / hide password
const toggle = document.querySelector('.pw-toggle');
toggle.addEventListener('click', () => {
  const pw = document.getElementById('password');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  toggle.textContent = show ? 'Hide' : 'Show';
  toggle.setAttribute('aria-pressed', show);
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

function validate(v) {
  const f = {};
  if (page === 'signup' && !MAC_RE.test(v.mac)) f.mac = 'Enter a valid MAC address (AA:BB:CC:DD:EE:FF).';
  if (!EMAIL_RE.test(v.email)) f.email = 'Enter a valid email address.';
  if (!v.password) f.password = 'Enter your password.';
  else if (page === 'signup' && v.password.length < 6) f.password = 'Password must be at least 6 characters.';
  return f;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  clearErrors();
  const v = Object.fromEntries(new FormData(form));
  v.email = (v.email || '').trim();
  const f = validate(v);
  if (Object.keys(f).length) {
    Object.entries(f).forEach(([k, m]) => setError(k, m));
    document.getElementById(Object.keys(f)[0]).focus();
    return;
  }
  btn.disabled = true; btn.classList.add('loading');
  const label = btn.textContent; btn.textContent = page === 'login' ? 'Logging in…' : 'Creating account…';
  try {
    const res = await fetch('/api/auth/' + page, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.fields) Object.entries(data.fields).forEach(([k, m]) => setError(k, m));
      else formError.textContent = data.error || 'Something went wrong. Try again.';
      return;
    }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', data.user.name);
    location.href = 'index.html';
  } catch (err) {
    formError.textContent = 'Cannot reach the server. Run "npm start" and open http://localhost:3000.';
  } finally {
    btn.disabled = false; btn.classList.remove('loading'); btn.textContent = label;
  }
});

// Guest: href goes straight to index.html; just set the guest session first.
document.getElementById('guest').addEventListener('click', () => {
  localStorage.setItem('token', 'guest'); localStorage.setItem('user', 'Guest');
});
