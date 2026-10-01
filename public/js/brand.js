// Brand panel demo: animated sample chart + randomised "estimated this month".
// Sample data only. No API calls. Rate matches the dashboard placeholder (₱12/kWh).
(function () {
  const svg = document.getElementById('liveChart');
  const bill = document.getElementById('heroBill');
  const delta = document.getElementById('heroDelta');
  if (!svg || !bill || !delta) return;

  const RATE = 12, DAYS = 30, N = 22, TICK = 2600, ANIM = 1100;
  let W = 520, H = 220;
  const PAD = 14, LO = 4, HI = 15;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const line = svg.querySelector('.lc-line'), area = svg.querySelector('.lc-area');
  const dot = svg.querySelector('.lc-dot'), halo = svg.querySelector('.lc-halo');
  const arrow = delta.querySelector('i'), pct = delta.querySelector('b');

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = t => 1 - Math.pow(1 - t, 3);
  const estimate = pts => Math.round(pts.reduce((s, v) => s + v, 0) / pts.length * DAYS * RATE);
  const fmt = v => '₱' + Math.round(v).toLocaleString('en-PH');
  const X = i => i * (W - PAD) / (N - 1); // flush to the left edge, small gap on the right for the dot
  const Y = v => H - PAD - (clamp(v, LO, HI) - LO) / (HI - LO) * (H - PAD * 2);

  let pts = [], v = 9;
  for (let i = 0; i < N; i++) { v = clamp(v + rnd(-1.6, 1.6) + (9.5 - v) * 0.15, 5, 14); pts.push(v); }

  // Smooth curve through points (Catmull-Rom → cubic Bézier)
  function path(p) {
    const c = p.map((val, i) => [X(i), Y(val)]);
    let d = 'M' + c[0][0] + ' ' + c[0][1];
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = c[i - 1] || c[i], p1 = c[i], p2 = c[i + 1], p3 = c[i + 2] || p2;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
    }
    return d;
  }
  function draw(p) {
    const d = path(p);
    line.setAttribute('d', d);
    area.setAttribute('d', d + ` L${W} ${Y(p[N - 1])} L${W} ${H} L0 ${H}Z`);
    const x = X(N - 1), y = Y(p[N - 1]);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    halo.setAttribute('cx', x); halo.setAttribute('cy', y);
  }
  function setDelta(change) {
    const up = change >= 0;
    delta.dataset.dir = up ? 'up' : 'down';
    arrow.textContent = up ? '▲' : '▼';
    pct.textContent = Math.abs(change).toFixed(1) + '%';
    delta.classList.remove('bump'); void delta.offsetWidth; delta.classList.add('bump');
  }

  const grid = svg.querySelector('.lc-grid path');
  function fit() {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    W = r.width; H = r.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    grid.setAttribute('d', [0.25, 0.5, 0.75].map(f => `M0 ${H * f}H${W}`).join(''));
    draw(pts);
  }
  addEventListener('resize', fit);

  let shown = estimate(pts);
  fit(); bill.textContent = fmt(shown);
  if (reduce) return;

  function step() {
    if (document.hidden || svg.getBoundingClientRect().width === 0) return;
    const last = pts[N - 1];
    // Mean-reverting random walk with occasional bigger swings
    const swing = Math.random() < 0.3 ? 3 : 1.6;
    const next = clamp(last + rnd(-swing, swing) + (9.5 - last) * 0.12, 4.5, 14.5);
    const to = pts.slice(1).concat(next), from = pts.slice();
    const toEst = estimate(to), fromEst = shown;
    setDelta((toEst - fromEst) / fromEst * 100);
    const t0 = performance.now();
    (function frame(now) {
      const t = ease(clamp((now - t0) / ANIM, 0, 1));
      const cur = from.map((a, i) => a + (to[i] - a) * t);
      draw(cur);
      bill.textContent = fmt(fromEst + (toEst - fromEst) * t);
      if (t < 1) requestAnimationFrame(frame); else { pts = to; shown = toEst; }
    })(t0);
  }
  setInterval(step, TICK);
})();
