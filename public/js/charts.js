// Dependency-free SVG trend chart: thin line, soft area, light grid, hover readout.
function drawTrend(svg, points, onHover) {
  const W = 640, H = 240, p = { l: 40, r: 12, t: 12, b: 28 };
  const n = points.length;
  const max = (Math.max(...points.map(d => d.value)) || 1) * 1.15;
  const x = i => p.l + i * (W - p.l - p.r) / Math.max(n - 1, 1);
  const y = v => p.t + (1 - v / max) * (H - p.t - p.b);
  const line = points.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1)},${H - p.b}L${x(0)},${H - p.b}Z`;
  const step = Math.ceil(n / 6);

  let g = '';
  for (let k = 0; k <= 3; k++) {
    const v = max * k / 3, yy = y(v);
    g += `<line class="grid" x1="${p.l}" x2="${W - p.r}" y1="${yy}" y2="${yy}"/><text class="tick" x="${p.l - 6}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }
  points.forEach((d, i) => { if (i % step === 0 || i === n - 1) g += `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${d.label}</text>`; });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${g}<path d="${area}" fill="url(#fill)"/><path class="line" d="${line}"/>
    <line class="cursor" y1="${p.t}" y2="${H - p.b}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>`;

  const cur = svg.querySelector('.cursor'), dot = svg.querySelector('.dot');
  svg.onpointermove = e => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - p.l) / ((W - p.l - p.r) / Math.max(n - 1, 1)))));
    cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(points[i].value));
    cur.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    onHover(points[i]);
  };
  svg.onpointerleave = () => { cur.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); onHover(null); };
}
