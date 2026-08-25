/* =============================================================================
   charts.js — hand-rolled SVG chart primitives.

   No chart library: the dashboard is a static page that must work offline and
   from file://, so every mark is emitted as SVG here.

   House rules, applied by every renderer below:
     * One y-axis per chart. Two measures of different scale get two charts —
       never a second axis.
     * Colour follows the entity, never its rank.
     * Two or more series always carry a legend, and are direct-labelled.
     * Grid and axes are recessive hairlines; values wear text tokens, not the
       series colour.
     * Every chart has a hover layer — per-mark tooltips on bars and cells, a
       crosshair on lines.
   =========================================================================== */

/* Theme tokens. Dark is a selected palette, not an inverted one. */
const THEME = {
  light: { surface:'#fcfcfb', grid:'#e1e0d9', axis:'#c3c2b7', ink:'#0b0b0b',
           ink2:'#52514e', muted:'#898781', ring:'#fcfcfb' },
  dark:  { surface:'#1a1a19', grid:'#2c2c2a', axis:'#383835', ink:'#ffffff',
           ink2:'#c3c2b7', muted:'#898781', ring:'#1a1a19' }
};
const isDark = () => document.body.classList.contains('dark');
const T = () => isDark() ? THEME.dark : THEME.light;

/* Ordinal ramp for sky conditions: one hue, monotone lightness, sun → cloud. */
const SKY_RAMP = {
  light: ['#eda100', '#b06f00', '#6b4300'],
  dark:  ['#fbbf24', '#d18b06', '#9c6a12']
};
/* Diverging poles for the temperature range chart. */
const TEMP_POLES = {
  light: { high:'#e34948', low:'#2a78d6' },
  dark:  { high:'#e66767', low:'#3987e5' }
};

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const nn  = v => typeof v === 'number' && Number.isFinite(v);

/* --- shared tooltip ------------------------------------------------------ */
let _tipEl = null;
function tipEl() { return _tipEl || (_tipEl = document.getElementById('tip')); }
function showTip(evt, html) {
  const t = tipEl(); if (!t) return;
  t.innerHTML = html; t.style.display = 'block'; moveTip(evt);
}
function moveTip(evt) {
  const t = tipEl(); if (!t || t.style.display === 'none') return;
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY - h - 10;
  if (x + w > window.innerWidth - 8)  x = evt.clientX - w - pad;
  if (y < 8) y = evt.clientY + pad;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
function hideTip() { const t = tipEl(); if (t) t.style.display = 'none'; }

/* --- scales and axis helpers -------------------------------------------- */
/* "Nice" tick steps so axis labels land on round numbers. */
function niceTicks(min, max, count = 5) {
  if (!nn(min) || !nn(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(10));
  return { min: lo, max: hi, ticks, step };
}

function fmtVal(v, dec = 1, unit = '') {
  if (!nn(v)) return '—';
  const s = dec === 0 ? Math.round(v).toLocaleString()
                      : v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return unit === '°F' || unit === '%' || unit === '' ? s + unit : `${s} ${unit}`;
}

/* Width available to a chart, from its container. */
function chartWidth(el, fallback = 640) {
  const w = (el.parentElement && el.parentElement.clientWidth) || fallback;
  return Math.max(260, w - 4);
}

/* Grid + y-axis ticks + baseline, drawn behind the data. */
function gridLayer(x0, x1, yOf, scale, dec, W, H, fmt) {
  const t = T();
  /* Enough decimals to keep every tick label distinct at this step. */
  if (!fmt && scale.step) {
    const needed = Math.max(0, Math.ceil(-Math.log10(scale.step) - 1e-9));
    dec = Math.min(3, Math.max(dec || 0, needed));
  }
  let g = '';
  for (const v of scale.ticks) {
    const y = yOf(v);
    if (y < -1 || y > H + 1) continue;
    const label = fmt ? fmt(v) : (dec === 0 ? Math.round(v) : v.toFixed(dec));
    g += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${t.grid}" stroke-width="1" shape-rendering="crispEdges"/>`
      +  `<text x="${x0 - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${t.muted}" style="font-variant-numeric:tabular-nums">${esc(label)}</text>`;
  }
  return g;
}

/* Month labels along the x-axis. */
function monthAxis(labels, xCenter, y, highlight = -1) {
  const t = T();
  return labels.map((lb, i) =>
    `<text x="${xCenter(i).toFixed(1)}" y="${y}" text-anchor="middle" font-size="10"
       font-weight="${i === highlight ? 700 : 400}"
       fill="${i === highlight ? t.ink : t.muted}">${esc(lb)}</text>`).join('');
}

/* -----------------------------------------------------------------------------
   barChart — one series of 12 monthly values.
   `onClick(i)` fires on a bar; the selected bar is emphasised, never recoloured
   into another series' identity.
   --------------------------------------------------------------------------- */
function barChart(svg, opts) {
  const { values, labels, color, unit = '', dec = 1, selected = -1,
          onClick = null, tipFmt = null, height = 230, zeroBase = true } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 42, r: 12, t: 20, b: 26 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;

  const nums = values.filter(nn);
  if (!nums.length) { svg.innerHTML = emptyNote(W, H); svg.setAttribute('width', W); svg.setAttribute('height', H); return; }
  const lo = zeroBase ? Math.min(0, ...nums) : Math.min(...nums);
  const scale = niceTicks(lo, Math.max(...nums), 5);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const step = plotW / values.length, gap = Math.min(10, step * 0.24), barW = step - gap;
  const xCenter = i => PAD.l + step * i + step / 2;
  const y0 = yOf(Math.max(scale.min, 0));

  let bars = '', labelsSvg = '';
  values.forEach((v, i) => {
    if (!nn(v)) return;
    const y = yOf(v), x = PAD.l + step * i + gap / 2;
    const rawH = Math.abs(y - y0), top = Math.min(y, y0);
    /* Zero gets no mark at all; a 1.5px stub would read as a small value.
       Anything non-zero gets at least 1.5px so it stays visible. */
    const h = v === 0 ? 0 : Math.max(1.5, rawH);
    const sel = i === selected;
    const tip = tipFmt ? tipFmt(i) : `<b>${esc(labels[i])}</b><br>${fmtVal(v, dec, unit)}`;
    bars += h > 0
      ? `<rect class="mark" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}"
          height="${h.toFixed(1)}" rx="4" fill="${color}"
          opacity="${selected >= 0 && !sel ? 0.45 : 0.92}"
          stroke="${sel ? t.ink : 'none'}" stroke-width="${sel ? 1.5 : 0}"
          ${onClick ? `style="cursor:pointer"` : ''}
          data-i="${i}" data-tip="${esc(tip)}"/>`
      /* Still hoverable and clickable at zero — an invisible hit target. */
      : `<rect class="mark" x="${x.toFixed(1)}" y="${(y0 - 10).toFixed(1)}" width="${barW.toFixed(1)}"
          height="10" fill="transparent" ${onClick ? `style="cursor:pointer"` : ''}
          data-i="${i}" data-tip="${esc(tip)}"/>`;
    /* Direct labels: the relief that low-contrast fills require. */
    const labelY = v === 0 ? y0 - 5 : top - 5;
    labelsSvg += `<text x="${xCenter(i).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle"
      font-size="9.5" font-weight="600" fill="${v === 0 ? t.muted : t.ink2}"
      style="pointer-events:none;font-variant-numeric:tabular-nums"
      >${dec === 0 ? Math.round(v) : v.toFixed(dec)}</text>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML =
      gridLayer(PAD.l, W - PAD.r, yOf, scale, dec >= 2 ? 1 : dec, W, H)
    + `<line x1="${PAD.l}" y1="${y0.toFixed(1)}" x2="${W - PAD.r}" y2="${y0.toFixed(1)}" stroke="${t.axis}" stroke-width="1"/>`
    + bars + labelsSvg
    + monthAxis(labels, xCenter, H - 8, selected);
  wireMarks(svg, onClick);
}

/* -----------------------------------------------------------------------------
   rangeChart — average high and average low with the band between them.
   Two series, diverging poles, legend + direct end labels.
   --------------------------------------------------------------------------- */
function rangeChart(svg, opts) {
  const { high, low, labels, unit = '°F', dec = 0, selected = -1,
          onClick = null, height = 260, extra = null,
          highLabel = 'Avg High', lowLabel = 'Avg Low', swingLabel = 'Swing',
          yFmt = null, valFmt = null, padAxis = 46 } = opts;
  const t = T(), poles = isDark() ? TEMP_POLES.dark : TEMP_POLES.light;
  const W = chartWidth(svg), H = height;
  const PAD = { l: padAxis, r: 14, t: 34, b: 26 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const all = [...high, ...low, ...(extra ? extra.values : [])].filter(nn);
  /* Sized like every other empty chart: without width and height the SVG
     collapses to nothing and the "No data available" note is invisible, so a
     missing series looks like a missing chart. */
  if (!all.length) {
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = emptyNote(W, H);
    return;
  }
  const scale = niceTicks(Math.min(...all), Math.max(...all), 5);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const step = plotW / labels.length, xCenter = i => PAD.l + step * i + step / 2;

  /* Band between the two lines — the "typical day" envelope. */
  let band = '';
  const top = [], bot = [];
  labels.forEach((_, i) => { if (nn(high[i]) && nn(low[i])) { top.push([xCenter(i), yOf(high[i])]); bot.push([xCenter(i), yOf(low[i])]); } });
  if (top.length > 1) {
    band = `<path d="M${top.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}L${bot.reverse().map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z"
      fill="${poles.high}" opacity="0.10"/>`;
  }

  const line = (vals, color, dash = '') => {
    const pts = [];
    vals.forEach((v, i) => { if (nn(v)) pts.push(`${xCenter(i).toFixed(1)},${yOf(v).toFixed(1)}`); });
    if (pts.length < 2) return '';
    return `<path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  };
  const dots = (vals, color) => vals.map((v, i) => nn(v)
    ? `<circle cx="${xCenter(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${i === selected ? 5.5 : 4}"
        fill="${color}" stroke="${t.ring}" stroke-width="2"/>` : '').join('');

  /* Direct labels on the extremes only — never a number on every point. */
  const extremeLabels = (vals, color, dy) => {
    const idx = vals.map((v, i) => [v, i]).filter(p => nn(p[0]));
    if (!idx.length) return '';
    const hi = idx.reduce((a, b) => b[0] > a[0] ? b : a);
    const lo2 = idx.reduce((a, b) => b[0] < a[0] ? b : a);
    return [hi, lo2].map(([v, i]) =>
      `<text x="${xCenter(i).toFixed(1)}" y="${(yOf(v) + dy).toFixed(1)}" text-anchor="middle"
        font-size="10" font-weight="700" fill="${t.ink2}" style="font-variant-numeric:tabular-nums"
        >${esc(valFmt ? valFmt(v) : v.toFixed(dec) + (unit === '°F' ? '°' : ''))}</text>`).join('');
  };

  const legendItems = [{ c: poles.high, l: highLabel }, { c: poles.low, l: lowLabel }];
  if (extra) legendItems.push({ c: extra.color, l: extra.label, dash: true });

  let hover = '';
  labels.forEach((_, i) => {
    const show = v => valFmt ? valFmt(v) : fmtVal(v, 1, unit);
    const tip = `<b>${esc(labels[i])}</b><br>${esc(highLabel)} ${esc(show(high[i]))}<br>${esc(lowLabel)} ${esc(show(low[i]))}`
      + (swingLabel && nn(high[i]) && nn(low[i])
          ? `<br>${esc(swingLabel)} ${esc(valFmt ? fmtDuration(high[i] - low[i]) : (high[i] - low[i]).toFixed(1) + '°')}` : '')
      + (extra && nn(extra.values[i]) ? `<br>${esc(extra.label)} ${esc(show(extra.values[i]))}` : '');
    hover += `<rect class="mark" x="${(PAD.l + step * i).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}"
      height="${plotH}" fill="transparent" data-i="${i}" data-tip="${esc(tip)}" ${onClick ? 'style="cursor:pointer"' : ''}/>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML =
      legend(legendItems, PAD.l, 12)
    + gridLayer(PAD.l, W - PAD.r, yOf, scale, 0, W, H, yFmt)
    + (selected >= 0 ? `<rect x="${(PAD.l + step * selected).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}" height="${plotH}" fill="${t.ink}" opacity="0.05"/>` : '')
    + band
    + (extra ? line(extra.values, extra.color, '5,3') : '')
    + line(high, poles.high) + line(low, poles.low)
    + dots(high, poles.high) + dots(low, poles.low)
    + extremeLabels(high, poles.high, -9) + extremeLabels(low, poles.low, 15)
    + monthAxis(labels, xCenter, H - 8, selected)
    + hover;
  wireMarks(svg, onClick);
}

/* -----------------------------------------------------------------------------
   multiLine — the location-comparison chart. One measure, up to three homes.
   --------------------------------------------------------------------------- */
function multiLine(svg, opts) {
  /* valFmt renders a value wherever one is shown — the axis and the tooltip.
     Without it a clock-time measure plotted its raw minutes-after-midnight, so
     the axis read 400/800/1200 and the tooltip read "437". The comment at the
     call site claimed these were "plotted but labelled as times"; nothing had
     ever been passed to do the labelling. */
  const { series, labels, unit = '', dec = 1, height = 300, selected = -1,
          onClick = null, valFmt = null } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 46, r: 74, t: 34, b: 26 };   // right pad holds the end labels
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const all = series.flatMap(s => s.values).filter(nn);
  if (!all.length) { svg.setAttribute('width', W); svg.setAttribute('height', H); svg.innerHTML = emptyNote(W, H); return; }
  const scale = niceTicks(Math.min(...all), Math.max(...all), 5);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const step = plotW / labels.length, xCenter = i => PAD.l + step * i + step / 2;

  let paths = '', dots = '', endLabels = '';
  series.forEach(s => {
    const pts = [];
    s.values.forEach((v, i) => { if (nn(v)) pts.push([xCenter(i), yOf(v), i]); });
    if (pts.length > 1) paths += `<path d="M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}"
      fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(p => { dots += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${p[2] === selected ? 5.5 : 3.5}"
      fill="${s.color}" stroke="${t.ring}" stroke-width="1.8"/>`; });
    /* Direct end label — identity without relying on colour alone. */
    const last = pts[pts.length - 1];
    if (last) endLabels += `<text x="${(W - PAD.r + 6).toFixed(1)}" y="${(last[1] + 3.5).toFixed(1)}"
      font-size="10" font-weight="700" fill="${t.ink2}">${esc(s.shortLabel || s.label)}</text>`;
  });

  let hover = '';
  labels.forEach((_, i) => {
    const show = v => valFmt ? valFmt(v) : fmtVal(v, dec, unit);
    const rows = series.map(s => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:5px"></span>${esc(s.label)}: <b>${show(s.values[i])}</b>`).join('<br>');
    hover += `<rect class="mark" x="${(PAD.l + step * i).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}" height="${plotH}"
      fill="transparent" data-i="${i}" data-tip="${esc(`<b>${labels[i]}</b><br>${rows}`)}" ${onClick ? 'style="cursor:pointer"' : ''}/>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML =
      legend(series.map(s => ({ c: s.color, l: s.label })), PAD.l, 12)
    + gridLayer(PAD.l, W - PAD.r, yOf, scale, dec >= 2 ? 1 : dec, W, H, valFmt)
    + (selected >= 0 ? `<rect x="${(PAD.l + step * selected).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}" height="${plotH}" fill="${t.ink}" opacity="0.05"/>` : '')
    + paths + dots + endLabels
    + monthAxis(labels, xCenter, H - 8, selected)
    + hover;
  wireMarks(svg, onClick);
}

/* -----------------------------------------------------------------------------
   stackedBar — ordinal categories (sunny / partly / cloudy) summing to a month.
   2px surface gap between segments, per the mark spec.
   --------------------------------------------------------------------------- */
function stackedBar(svg, opts) {
  const { stacks, labels, seriesLabels, ramp, unit = 'days', dec = 1,
          selected = -1, onClick = null, height = 250 } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 42, r: 12, t: 34, b: 26 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const totals = stacks.map(s => s.reduce((a, v) => a + (nn(v) ? v : 0), 0));
  if (!totals.some(v => v > 0)) { svg.setAttribute('width', W); svg.setAttribute('height', H); svg.innerHTML = emptyNote(W, H); return; }
  const scale = niceTicks(0, Math.max(...totals), 5);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const step = plotW / labels.length, gap = Math.min(10, step * 0.24), barW = step - gap;
  const xCenter = i => PAD.l + step * i + step / 2;

  let bars = '';
  stacks.forEach((seg, i) => {
    let acc = 0;
    const x = PAD.l + step * i + gap / 2;
    const tipRows = seg.map((v, k) =>
      `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${ramp[k]};margin-right:5px"></span>${esc(seriesLabels[k])}: <b>${fmtVal(v, dec, unit)}</b>`).join('<br>');
    const tip = `<b>${esc(labels[i])}</b><br>${tipRows}<br>Total ${fmtVal(totals[i], dec, unit)}`;
    seg.forEach((v, k) => {
      if (!nn(v) || v <= 0) return;
      const yTop = yOf(acc + v), yBot = yOf(acc);
      const h = Math.max(1, yBot - yTop - (k < seg.length - 1 ? 2 : 0));   // 2px surface gap
      const isTop = k === seg.length - 1;
      bars += `<rect class="mark" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        fill="${ramp[k]}" opacity="${selected >= 0 && i !== selected ? 0.45 : 1}"
        rx="${isTop ? 4 : 0}" data-i="${i}" data-tip="${esc(tip)}" ${onClick ? 'style="cursor:pointer"' : ''}/>`;
      acc += v;
    });
    bars += `<text x="${xCenter(i).toFixed(1)}" y="${(yOf(totals[i]) - 5).toFixed(1)}" text-anchor="middle"
      font-size="9.5" font-weight="600" fill="${t.ink2}" style="pointer-events:none;font-variant-numeric:tabular-nums">${totals[i].toFixed(0)}</text>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML =
      legend(seriesLabels.map((l, k) => ({ c: ramp[k], l })), PAD.l, 12)
    + gridLayer(PAD.l, W - PAD.r, yOf, scale, 0, W, H)
    + `<line x1="${PAD.l}" y1="${yOf(0).toFixed(1)}" x2="${W - PAD.r}" y2="${yOf(0).toFixed(1)}" stroke="${t.axis}" stroke-width="1"/>`
    + bars + monthAxis(labels, xCenter, H - 8, selected);
  wireMarks(svg, onClick);
}

/* -----------------------------------------------------------------------------
   daylightRibbon — sunrise/sunset across a whole year.
   Night is the surface; the lit ribbon between the curves is the daylight.
   y runs 0–24 h local clock time, so DST steps show up as real discontinuities.
   --------------------------------------------------------------------------- */
function daylightRibbon(svg, opts) {
  const { curve, height = 300, tz = '' } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 50, r: 14, t: 26, b: 28 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  if (!curve || !curve.length) { svg.setAttribute('width', W); svg.setAttribute('height', H); svg.innerHTML = emptyNote(W, H); return; }
  const xOf = i => PAD.l + (i / (curve.length - 1)) * plotW;
  const yOf = mins => PAD.t + (mins / 1440) * plotH;      // midnight top → midnight bottom

  const rise = curve.map((d, i) => [xOf(i), yOf(d.rise)]);
  const set  = curve.map((d, i) => [xOf(i), yOf(d.set)]);
  const ribbon = `<path d="M${rise.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}L${[...set].reverse().map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z"
    fill="${isDark() ? '#fbbf24' : '#eda100'}" opacity="${isDark() ? 0.22 : 0.28}"/>`;
  const lineOf = pts => `<path d="M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}" fill="none"
    stroke="${isDark() ? '#d18b06' : '#b06f00'}" stroke-width="2" stroke-linejoin="round"/>`;

  /* Hour gridlines every 3 h. */
  let grid = '';
  for (let h = 0; h <= 24; h += 3) {
    const y = yOf(h * 60);
    const lbl = h === 0 ? '12 AM' : h === 12 ? '12 PM' : h === 24 ? '12 AM' : (h < 12 ? `${h} AM` : `${h - 12} PM`);
    grid += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" stroke="${t.grid}" stroke-width="1" shape-rendering="crispEdges"/>`
         +  `<text x="${PAD.l - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="${t.muted}">${lbl}</text>`;
  }
  /* Month boundaries + labels. */
  let months = '';
  MONTHS.forEach((m, mo) => {
    const first = curve.findIndex(d => d.month === mo);
    if (first < 0) return;
    const x = xOf(first);
    if (mo > 0) months += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + plotH}" stroke="${t.grid}" stroke-width="1" shape-rendering="crispEdges"/>`;
    const next = curve.findIndex(d => d.month === mo + 1);
    const mid = xOf(first + ((next < 0 ? curve.length : next) - first) / 2);
    months += `<text x="${mid.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="${t.muted}">${m}</text>`;
  });

  /* Solstice / equinox markers — the anchors people actually look for. */
  let marks = '';
  const solstices = [[171, 'Summer solstice'], [355, 'Winter solstice'], [79, 'Spring equinox'], [265, 'Fall equinox']];
  for (const [doy, label] of solstices) {
    const i = curve.findIndex(d => d.doy === doy);
    if (i < 0) continue;
    marks += `<line x1="${xOf(i).toFixed(1)}" y1="${PAD.t}" x2="${xOf(i).toFixed(1)}" y2="${PAD.t + plotH}"
      stroke="${t.ink2}" stroke-width="1" stroke-dasharray="3,3" opacity="0.55"><title>${label}</title></line>`;
  }

  let hover = '';
  curve.forEach((d, i) => {
    const w = plotW / curve.length;
    const tip = `<b>${MONTHS[d.month]} ${d.day}</b><br>Sunrise ${fmtMinutes(d.rise)}<br>Sunset ${fmtMinutes(d.set)}<br>Daylight ${fmtDuration(d.daylight * 60)}`;
    hover += `<rect class="mark" x="${(PAD.l + (i / curve.length) * plotW).toFixed(1)}" y="${PAD.t}" width="${Math.max(1, w).toFixed(2)}"
      height="${plotH}" fill="transparent" data-tip="${esc(tip)}"/>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML = grid + months + ribbon + lineOf(rise) + lineOf(set) + marks
    + `<text x="${PAD.l + 6}" y="${PAD.t + 14}" font-size="10" font-weight="700" fill="${t.ink2}">Daylight${tz ? ' — ' + esc(tz) : ''}</text>`
    + hover;
  wireMarks(svg, null);
}

/* -----------------------------------------------------------------------------
   trendChart — one value per year, with a least-squares fit through it.

   The point is the slope, so the fit line is the emphasis and the yearly dots
   are secondary. r² is printed alongside because a slope through scattered
   points is not the same claim as a slope through a tight line, and the chart
   should not let those look identical.
   --------------------------------------------------------------------------- */
function trendChart(svg, opts) {
  const { years, values, trend, color, unit = '', dec = 1, height = 260, label = '' } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 48, r: 14, t: 34, b: 30 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const nums = values.filter(nn);
  if (nums.length < 2) { svg.setAttribute('width', W); svg.setAttribute('height', H); svg.innerHTML = emptyNote(W, H); return; }

  const scale = niceTicks(Math.min(...nums), Math.max(...nums), 5);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const xOf = i => PAD.l + (years.length === 1 ? plotW / 2 : (i / (years.length - 1)) * plotW);

  let dots = '', hover = '';
  values.forEach((v, i) => {
    if (!nn(v)) return;
    dots += `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4" fill="${color}"
      opacity="0.55" stroke="${t.ring}" stroke-width="1.5"/>`;
  });
  const step = plotW / Math.max(1, years.length);
  years.forEach((y, i) => {
    hover += `<rect class="mark" x="${(xOf(i) - step / 2).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}"
      height="${plotH}" fill="transparent"
      data-tip="${esc(`<b>${y}</b><br>${label} ${fmtVal(values[i], dec, unit)}`)}"/>`;
  });

  /* The fit, drawn across the full span. */
  let fit = '', note = '';
  if (trend && nn(trend.perDecade)) {
    const idx = values.map((v, i) => [v, i]).filter(p => nn(p[0]));
    const xs = idx.map(p => years[p[1]]), ys = idx.map(p => p[0]);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    const slope = trend.perDecade / 10;
    const yAt = yr => my + slope * (yr - mx);
    const x0 = xOf(0), x1 = xOf(years.length - 1);
    const y0 = yOf(yAt(years[0])), y1 = yOf(yAt(years[years.length - 1]));
    fit = `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"
      stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
    const sign = trend.perDecade > 0 ? '+' : '';
    const flat = nums.every(v => v === nums[0]);
    /* Three different things a reader could be told, and they are not the same
       claim: nothing moved at all, it moved but the years scatter around the
       line, or it moved and the years follow it. */
    const caveat = flat ? ' — unchanged across the whole record'
      : trend.r2 == null ? ''
      : trend.r2 < 0.15 ? ` · r² ${trend.r2.toFixed(2)} — scattered, treat as weak`
      : trend.r2 < 0.4  ? ` · r² ${trend.r2.toFixed(2)} — a loose trend`
      : ` · r² ${trend.r2.toFixed(2)} — the years follow it closely`;
    note = `<text x="${PAD.l}" y="${PAD.t - 14}" font-size="11" font-weight="700" fill="${t.ink2}">`
      + `${esc(flat ? 'No change' : sign + trend.perDecade + ' ' + (unit || '') + ' per decade')}`
      + `<tspan font-weight="400" fill="${t.muted}">${esc(caveat)}</tspan></text>`;
  }

  /* Year ticks: first, last and a couple between, never all of them. */
  let ticks = '';
  const every = Math.max(1, Math.round(years.length / 6));
  years.forEach((y, i) => {
    if (i % every && i !== years.length - 1) return;
    ticks += `<text x="${xOf(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="9.5" fill="${t.muted}">${y}</text>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML = gridLayer(PAD.l, W - PAD.r, yOf, scale, dec >= 2 ? 1 : dec, W, H)
    + note + dots + fit + ticks + hover;
  wireMarks(svg, null);
}

/* -----------------------------------------------------------------------------
   sparkLine — a small trend mark for KPI cards.
   --------------------------------------------------------------------------- */
function sparkLine(values, color, w = 88, h = 26) {
  const v = values.filter(nn);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = values.map((val, i) => nn(val)
    ? `${(i / (values.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((val - min) / span) * (h - 6)).toFixed(1)}`
    : null).filter(Boolean);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:block">
    <path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* -----------------------------------------------------------------------------
   hourlyChart — 48 hours of temperature with a shaded night band.
   Precipitation probability gets its own chart rather than a second axis.
   --------------------------------------------------------------------------- */
function hourlyChart(svg, opts) {
  const { times, values, isDayFlags, color, unit = '°F', dec = 0, height = 200, label = '' } = opts;
  const t = T();
  const W = chartWidth(svg), H = height;
  const PAD = { l: 40, r: 12, t: 24, b: 26 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const nums = values.filter(nn);
  if (!nums.length) { svg.setAttribute('width', W); svg.setAttribute('height', H); svg.innerHTML = emptyNote(W, H); return; }
  const scale = niceTicks(Math.min(...nums), Math.max(...nums), 4);
  const yOf = v => PAD.t + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const xOf = i => PAD.l + (i / Math.max(1, values.length - 1)) * plotW;

  /* Night shading, drawn as contiguous runs. */
  let night = '';
  if (isDayFlags) {
    let start = null;
    isDayFlags.forEach((d, i) => {
      if (!d && start === null) start = i;
      if ((d || i === isDayFlags.length - 1) && start !== null) {
        night += `<rect x="${xOf(start).toFixed(1)}" y="${PAD.t}" width="${Math.max(1, xOf(i) - xOf(start)).toFixed(1)}"
          height="${plotH}" fill="${t.ink}" opacity="0.055"/>`;
        start = null;
      }
    });
  }

  const pts = [];
  values.forEach((v, i) => { if (nn(v)) pts.push(`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`); });
  const area = pts.length > 1
    ? `<path d="M${pts.join('L')}L${xOf(values.length - 1).toFixed(1)},${yOf(scale.min).toFixed(1)}L${xOf(0).toFixed(1)},${yOf(scale.min).toFixed(1)}Z" fill="${color}" opacity="0.12"/>` : '';
  const line = pts.length > 1 ? `<path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  /* Time ticks every 6 hours. */
  let ticks = '';
  times.forEach((tm, i) => {
    if (i % 6) return;
    const hh = +String(tm).slice(11, 13);
    const lb = hh === 0 ? '12a' : hh === 12 ? '12p' : hh < 12 ? `${hh}a` : `${hh - 12}p`;
    ticks += `<text x="${xOf(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${t.muted}">${lb}</text>`;
  });

  let hover = '';
  values.forEach((v, i) => {
    const w = plotW / Math.max(1, values.length);
    const d = new Date(times[i]);
    const when = Number.isNaN(+d) ? String(times[i]) : d.toLocaleString(undefined, { weekday:'short', hour:'numeric' });
    hover += `<rect class="mark" x="${(xOf(i) - w / 2).toFixed(1)}" y="${PAD.t}" width="${w.toFixed(2)}" height="${plotH}"
      fill="transparent" data-tip="${esc(`<b>${when}</b><br>${label} ${fmtVal(v, dec, unit)}`)}"/>`;
  });

  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML = night + gridLayer(PAD.l, W - PAD.r, yOf, scale, 0, W, H) + area + line + ticks + hover;
  wireMarks(svg, null);
}

/* --- shared chrome ------------------------------------------------------- */
function legend(items, x, y) {
  const t = T();
  let out = `<g transform="translate(${x},${y})">`, dx = 0;
  for (const it of items) {
    out += `<rect x="${dx}" y="0" width="10" height="10" rx="2" fill="${it.c}"/>`
        +  `<text x="${dx + 15}" y="5.5" dominant-baseline="middle" font-size="10.5" fill="${t.ink2}">${esc(it.l)}</text>`;
    dx += 15 + String(it.l).length * 6.1 + 18;
  }
  return out + '</g>';
}

function emptyNote(W, H) {
  const t = T();
  return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="${t.muted}">No data available</text>`;
}

/* Attaches hover tooltips and click handling to every `.mark` in a chart. */
function wireMarks(svg, onClick) {
  svg.querySelectorAll('.mark').forEach(el => {
    el.addEventListener('mouseenter', e => showTip(e, el.getAttribute('data-tip') || ''));
    el.addEventListener('mousemove', moveTip);
    el.addEventListener('mouseleave', hideTip);
    if (onClick) el.addEventListener('click', () => onClick(+el.getAttribute('data-i')));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { niceTicks, fmtVal, barChart, rangeChart, multiLine, stackedBar,
                     daylightRibbon, trendChart, sparkLine, hourlyChart,
                     SKY_RAMP, TEMP_POLES, THEME };
}
