'use strict';

/* =============================================================
   Trendline - renderer
   Data shape:
     settings { startWeight, startDate, goalWeight, medication }
     days     { 'YYYY-MM-DD': { weight, steps, notes } }
     activities [ { id, date, type, minutes, distance, label, notes,
                    exercises:[{ name, sets:[{reps, weight}] }] } ]
   ============================================================= */

let DATA = null;
const charts = {};

const TYPES = {
  run:   { label: 'Run',   color: '--series-1' },
  walk:  { label: 'Walk',  color: '--series-2' },
  hike:  { label: 'Hike',  color: '--series-3' },
  lift:  { label: 'Lift',  color: '--series-4' },
  other: { label: 'Other', color: '--series-5' },
};

// The activity types that cover ground, in chart order.
const DISTANCE_TYPES = ['run', 'walk', 'hike'];

/* ------------------------------------------------------------ dates */
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const todayISO = () => iso(new Date());
// Weeks run Monday -> Sunday.
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtShort = (s) => { const d = parseISO(s); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const fmtFull = (s) => { const d = parseISO(s); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };

/* ------------------------------------------------------------ format */
const n1 = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1));
const n2 = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(2));
const int = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString());
const signed = (v, dp = 1) => (v == null || Number.isNaN(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(dp));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function deltaClass(v) { return v == null ? 'flat' : v < -0.05 ? 'down' : v > 0.05 ? 'up' : 'flat'; }

// Accepts "9:30", "9:30 /mi", "9.5" or "9" and returns minutes per mile.
function parsePace(str) {
  const s = String(str ?? '').trim().replace(/\/\s*mi\.?$/i, '').trim();
  if (!s) return null;
  const clock = s.match(/^(\d+):([0-5]?\d)$/);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  const f = Number(s);
  return Number.isFinite(f) && f > 0 ? f : null;
}

function paceOf(minutes, distance) {
  if (!minutes || !distance) return null;
  const p = minutes / distance;
  const m = Math.floor(p);
  const s = Math.round((p - m) * 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${pad(s)}`;
}

/* ------------------------------------------------------------ storage */
let saveTimer = null;
function save(quiet) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.api.save(DATA); }, 200);
  if (!quiet) toast('Saved');
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

/* ------------------------------------------------------------ derived */
function weighins() {
  return Object.entries(DATA.days)
    .filter(([, v]) => typeof v.weight === 'number' && v.weight > 0)
    .map(([date, v]) => ({ date, weight: v.weight }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The span that holds every piece of logged data - weigh-ins AND workouts.
// History must use this: a workout logged on a day with no weigh-in, or dated
// before the first weigh-in, still has to appear somewhere it can be corrected.
function dataRange() {
  const dates = weighins().map((w) => w.date);
  DATA.activities.forEach((a) => { if (a.date) dates.push(a.date); });
  if (DATA.settings.startDate) dates.push(DATA.settings.startDate);
  if (!dates.length) return null;
  dates.sort();
  const last = dates[dates.length - 1];
  return { first: dates[0], last: last > todayISO() ? last : todayISO() };
}

// A row per calendar day across the span, so the x-axis is real time rather
// than "entries". Days with no weigh-in stay null.
function dailySeries(range) {
  const ws = weighins();
  const span = range || (ws.length
    ? { first: ws[0].date,
        last: ws[ws.length - 1].date > todayISO() ? ws[ws.length - 1].date : todayISO() }
    : null);
  if (!span) return [];
  const byDate = new Map(ws.map((w) => [w.date, w.weight]));
  const start = parseISO(span.first);
  const end = parseISO(span.last);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const key = iso(d);
    const weight = byDate.has(key) ? byDate.get(key) : null;
    // 7-day window over the calendar, not over the last 7 entries.
    let sum = 0, count = 0;
    for (let k = 0; k < 7; k++) {
      const v = byDate.get(iso(addDays(d, -k)));
      if (typeof v === 'number') { sum += v; count++; }
    }
    out.push({ date: key, weight, avg: count ? sum / count : null, count });
  }
  return out;
}

function latest() {
  const ws = weighins();
  return ws.length ? ws[ws.length - 1] : null;
}

function latestAvg() {
  const s = dailySeries();
  for (let i = s.length - 1; i >= 0; i--) if (s[i].avg != null) return s[i];
  return null;
}

// Every Monday-anchored week from the start date through the current week.
function weekBuckets() {
  const ws = weighins();
  const startISO = DATA.settings.startDate || (ws[0] && ws[0].date) || todayISO();
  // Anchor week 1 to the first Monday on or after the start date. A baseline
  // reading taken mid-week (the doctor's-office weigh-in) is the number the
  // weeks get measured against, not a one-reading week of its own.
  const s = parseISO(startISO);
  const anchor = mondayOf(s);
  const first = anchor < s ? addDays(anchor, 7) : anchor;
  const lastAct = DATA.activities.reduce((m, a) => (a.date > m ? a.date : m), '');
  const lastSeen = [todayISO(), ws.length ? ws[ws.length - 1].date : '', lastAct].sort().pop();
  const last = mondayOf(parseISO(lastSeen));
  const out = [];
  for (let d = first, i = 1; d <= last; d = addDays(d, 7), i++) {
    out.push({ index: i, start: iso(d), end: iso(addDays(d, 6)) });
  }
  return out;
}

function weeklyWeight() {
  const byDate = new Map(weighins().map((w) => [w.date, w.weight]));
  let prev = null;
  return weekBuckets().map((b) => {
    const vals = [];
    for (let k = 0; k < 7; k++) {
      const v = byDate.get(iso(addDays(parseISO(b.start), k)));
      if (typeof v === 'number') vals.push(v);
    }
    const avg = vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
    const row = {
      ...b,
      days: vals.length,
      avg,
      low: vals.length ? Math.min(...vals) : null,
      change: avg != null && prev != null ? avg - prev : null,
      lost: avg != null ? DATA.settings.startWeight - avg : null,
    };
    if (avg != null) prev = avg;
    return row;
  });
}

// Cumulative miles per ground-covering type. Pass `from` (an ISO date) to
// limit it to a window, e.g. the current week.
function distanceTotals(from) {
  const out = { run: 0, walk: 0, hike: 0, total: 0 };
  DATA.activities.forEach((a) => {
    if (!DISTANCE_TYPES.includes(a.type)) return;
    if (from && a.date < from) return;
    const d = Number(a.distance) || 0;
    if (!d) return;
    out[a.type] += d;
    out.total += d;
  });
  return out;
}

function tonnageOf(a) {
  if (a.type !== 'lift' || !Array.isArray(a.exercises)) return 0;
  return a.exercises.reduce((sum, ex) => sum +
    (ex.sets || []).reduce((s, st) => s + (Number(st.reps) || 0) * (Number(st.weight) || 0), 0), 0);
}

function weeklyActivity() {
  return weekBuckets().map((b) => {
    const inWeek = DATA.activities.filter((a) => a.date >= b.start && a.date <= b.end);
    const sum = (f) => inWeek.reduce((s, a) => s + (f(a) || 0), 0);
    const byType = (t) => inWeek.filter((a) => a.type === t);
    const mins = (t) => byType(t).reduce((s, a) => s + (Number(a.minutes) || 0), 0);
    const dist = (t) => byType(t).reduce((s, a) => s + (Number(a.distance) || 0), 0);
    return {
      ...b,
      sessions: inWeek.length,
      runMin: mins('run'), walkMin: mins('walk'), hikeMin: mins('hike'),
      liftMin: mins('lift'), otherMin: mins('other'),
      runMi: dist('run'), walkMi: dist('walk'), hikeMi: dist('hike'),
      groundMi: dist('run') + dist('walk') + dist('hike'),
      liftSessions: byType('lift').length,
      tonnage: sum(tonnageOf),
      minutes: sum((a) => Number(a.minutes) || 0),
      steps: (() => {
        let s = 0;
        for (let k = 0; k < 7; k++) {
          const day = DATA.days[iso(addDays(parseISO(b.start), k))];
          if (day && day.steps) s += Number(day.steps);
        }
        return s;
      })(),
    };
  });
}

/* ------------------------------------------------------------ theme */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// The theme lives in the data file, not localStorage: under file:// the origin
// is opaque and localStorage does not reliably survive a restart.
function applyTheme() {
  const mode = (DATA && DATA.settings.theme) || 'auto';
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  document.getElementById('themeToggle').textContent =
    'Theme: ' + mode.charAt(0).toUpperCase() + mode.slice(1);
}

/* ------------------------------------------------------------ charts */
// Snap axis bounds to a round step so the first tick isn't an arbitrary value
// like 273, and so the plotted range doesn't hug the data.
function niceBounds(lo, hi) {
  const span = Math.max(hi - lo, 0.5);
  const pad = Math.max(1, span * 0.18);
  const step = span > 30 ? 10 : span > 12 ? 5 : span > 5 ? 2 : 1;
  return {
    min: Math.floor((lo - pad) / step) * step,
    max: Math.ceil((hi + pad) / step) * step,
  };
}

function baseOptions() {
  const muted = css('--text-muted');
  const grid = css('--gridline');
  const base = css('--baseline');
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css('--text-primary'),
        titleColor: css('--surface'),
        bodyColor: css('--surface'),
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4,
        titleFont: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, weight: '600' },
        bodyFont: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12 },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: base },
        ticks: { color: muted, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
      },
      y: {
        grid: { color: grid, drawTicks: false },
        border: { display: false },
        ticks: { color: muted, font: { size: 11 }, padding: 8 },
      },
    },
  };
}

function draw(key, canvasId, config) {
  if (charts[key]) charts[key].destroy();
  const el = document.getElementById(canvasId);
  if (!el) return;
  charts[key] = new Chart(el.getContext('2d'), config);
}

function drawWeightChart() {
  const s = dailySeries();
  const opts = baseOptions();
  if (!s.length) { if (charts.weight) { charts.weight.destroy(); delete charts.weight; } return; }

  const vals = s.flatMap((r) => [r.weight, r.avg]).filter((v) => v != null);
  const b = niceBounds(Math.min(...vals), Math.max(...vals));
  opts.scales.y.min = b.min;
  opts.scales.y.max = b.max;
  opts.scales.y.ticks.callback = (v) => v.toFixed(0);
  opts.plugins.tooltip.callbacks = {
    title: (items) => fmtFull(s[items[0].dataIndex].date),
    label: (ctx) => ctx.parsed.y == null ? null
      : `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(ctx.datasetIndex === 1 ? 2 : 1)} lbs`,
  };

  draw('weight', 'chartWeight', {
    type: 'line',
    data: {
      labels: s.map((r) => fmtShort(r.date)),
      datasets: [
        {
          label: 'Daily reading',
          data: s.map((r) => r.weight),
          borderColor: css('--series-faint'),
          backgroundColor: css('--series-faint'),
          borderWidth: 1,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          pointBorderWidth: 0,
          spanGaps: true,
          tension: 0,
        },
        {
          label: '7-day average',
          data: s.map((r) => r.avg),
          borderColor: css('--series-1'),
          backgroundColor: css('--series-1'),
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBorderColor: css('--surface'),
          pointHoverBorderWidth: 2,
          spanGaps: true,
          tension: 0.25,
        },
      ],
    },
    options: opts,
  });
}

function drawWeeklyCharts() {
  const rows = weeklyWeight();
  const labelled = rows.filter((r) => r.avg != null);
  const opts = baseOptions();

  if (labelled.length) {
    const vals = labelled.map((r) => r.avg);
    const b = niceBounds(Math.min(...vals), Math.max(...vals));
    opts.scales.y.min = b.min;
    opts.scales.y.max = b.max;
  }
  opts.plugins.tooltip.callbacks = {
    title: (i) => `Week ${labelled[i[0].dataIndex].index} · ${fmtShort(labelled[i[0].dataIndex].start)}`,
    label: (ctx) => `Average: ${ctx.parsed.y.toFixed(2)} lbs`,
  };

  draw('weekly', 'chartWeekly', {
    type: 'line',
    data: {
      labels: labelled.map((r) => fmtShort(r.start)),
      datasets: [{
        label: 'Weekly average',
        data: labelled.map((r) => r.avg),
        borderColor: css('--series-1'),
        backgroundColor: css('--series-1'),
        borderWidth: 2.5,
        pointRadius: 4,
        pointHoverRadius: 7,
        pointBorderColor: css('--surface'),
        pointBorderWidth: 2,
        tension: 0.25,
      }],
    },
    options: opts,
  });

  // Diverging bars: cool pole = losing, warm pole = gaining.
  const ch = rows.filter((r) => r.change != null);
  const o2 = baseOptions();
  o2.plugins.tooltip.callbacks = {
    title: (i) => `Week ${ch[i[0].dataIndex].index} · ${fmtShort(ch[i[0].dataIndex].start)}`,
    label: (ctx) => {
      const v = ctx.parsed.y;
      return `${v < 0 ? 'Down' : 'Up'} ${Math.abs(v).toFixed(2)} lbs vs prior week`;
    },
  };
  o2.scales.y.ticks.callback = (v) => (v > 0 ? '+' : '') + v;

  draw('change', 'chartChange', {
    type: 'bar',
    data: {
      labels: ch.map((r) => fmtShort(r.start)),
      datasets: [{
        label: 'Change',
        data: ch.map((r) => r.change),
        backgroundColor: ch.map((r) => (r.change <= 0 ? css('--pole-down') : css('--pole-up'))),
        borderColor: css('--surface'),
        borderWidth: 2,
        borderRadius: 4,
        borderSkipped: false,
        categoryPercentage: 0.7,
        barPercentage: 0.85,
      }],
    },
    options: o2,
  });
}

function drawTrainingCharts() {
  const rows = weeklyActivity();
  const labels = rows.map((r) => fmtShort(r.start));
  const surface = css('--surface');

  const stack = {
    ...baseOptions(),
    scales: {
      x: { ...baseOptions().scales.x, stacked: true },
      y: { ...baseOptions().scales.y, stacked: true, beginAtZero: true },
    },
  };
  stack.plugins.tooltip.callbacks = {
    title: (i) => `Week ${rows[i[0].dataIndex].index} · ${fmtShort(rows[i[0].dataIndex].start)}`,
    label: (ctx) => (ctx.parsed.y ? `${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} min` : null),
    footer: (i) => `Total: ${Math.round(rows[i[0].dataIndex].minutes)} min`,
  };

  const minuteSets = [
    ['Run', 'runMin', '--series-1'],
    ['Walk', 'walkMin', '--series-2'],
    ['Hike', 'hikeMin', '--series-3'],
    ['Lift', 'liftMin', '--series-4'],
    ['Other', 'otherMin', '--series-5'],
  ].filter(([, key]) => rows.some((r) => r[key] > 0));

  document.getElementById('minutesLegend').innerHTML = minuteSets.length
    ? minuteSets.map(([label, , c]) =>
        `<span class="legend-item"><span class="swatch" style="background:var(${c})"></span>${label}</span>`).join('')
    : '<span class="legend-item">No workouts logged yet</span>';

  draw('minutes', 'chartMinutes', {
    type: 'bar',
    data: {
      labels,
      datasets: minuteSets.map(([label, key, c]) => ({
        label,
        data: rows.map((r) => r[key]),
        backgroundColor: css(c),
        borderColor: surface,
        borderWidth: 2,
        borderRadius: 3,
        borderSkipped: false,
        categoryPercentage: 0.7,
        barPercentage: 0.85,
      })),
    },
    options: stack,
  });

  const distOpts = { ...baseOptions(), scales: { x: baseOptions().scales.x, y: { ...baseOptions().scales.y, beginAtZero: true } } };
  distOpts.plugins.tooltip.callbacks = {
    title: (i) => `Week ${rows[i[0].dataIndex].index} · ${fmtShort(rows[i[0].dataIndex].start)}`,
    label: (ctx) => (ctx.parsed.y ? `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} mi` : null),
  };
  draw('distance', 'chartDistance', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Run', data: rows.map((r) => r.runMi), backgroundColor: css('--series-1') },
        { label: 'Walk', data: rows.map((r) => r.walkMi), backgroundColor: css('--series-2') },
        { label: 'Hike', data: rows.map((r) => r.hikeMi), backgroundColor: css('--series-3') },
      ].map((d) => ({
        ...d, borderColor: surface, borderWidth: 2, borderRadius: 4,
        borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.9,
      })),
    },
    options: distOpts,
  });

  const tonOpts = { ...baseOptions(), scales: { x: baseOptions().scales.x, y: { ...baseOptions().scales.y, beginAtZero: true } } };
  tonOpts.scales.y.ticks.callback = (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v);
  tonOpts.plugins.tooltip.callbacks = {
    title: (i) => `Week ${rows[i[0].dataIndex].index} · ${fmtShort(rows[i[0].dataIndex].start)}`,
    label: (ctx) => `Volume: ${Math.round(ctx.parsed.y).toLocaleString()} lbs · ${rows[ctx.dataIndex].liftSessions} session(s)`,
  };
  draw('tonnage', 'chartTonnage', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Volume',
        data: rows.map((r) => r.tonnage),
        backgroundColor: css('--series-4'),
        borderColor: surface,
        borderWidth: 2,
        borderRadius: 4,
        borderSkipped: false,
        categoryPercentage: 0.7,
        barPercentage: 0.85,
      }],
    },
    options: tonOpts,
  });
}

/* ------------------------------------------------------------ dashboard */
function renderDashboard() {
  const cur = latest();
  const avgRow = latestAvg();
  const start = DATA.settings.startWeight;
  const weeks = weeklyWeight().filter((r) => r.avg != null);
  const thisWeek = weeks[weeks.length - 1] || null;
  const prevWeek = weeks[weeks.length - 2] || null;

  document.getElementById('dashSub').textContent = cur
    ? `Last weigh-in ${fmtFull(cur.date)}${DATA.settings.medication ? ' · ' + DATA.settings.medication : ''}`
    : 'No weigh-ins yet — log one to get started.';

  const lost = cur && start != null ? start - cur.weight : null;
  const elapsedWeeks = cur ? Math.max(1, daysBetween(DATA.settings.startDate, cur.date) / 7) : null;
  const rate = lost != null ? lost / elapsedWeeks : null;
  const wowDelta = thisWeek && prevWeek ? thisWeek.avg - prevWeek.avg : null;

  const tiles = [
    { label: 'Current weight', value: cur ? n1(cur.weight) : '—', unit: 'lbs',
      sub: cur ? fmtShort(cur.date) : 'awaiting first entry', hero: true },
    { label: '7-day average', value: avgRow ? n2(avgRow.avg) : '—', unit: 'lbs',
      sub: avgRow ? `${avgRow.count} of last 7 days logged` : '—' },
    { label: 'Total lost', value: lost != null ? n1(lost) : '—', unit: 'lbs',
      sub: lost != null ? `${((lost / start) * 100).toFixed(1)}% of starting weight`
         : start != null ? `from ${n1(start)} lbs` : 'log a weigh-in to set your baseline' },
    { label: 'This week vs last',
      value: wowDelta != null ? `<span class="delta ${deltaClass(wowDelta)}">${signed(wowDelta, 2)}</span>` : '—',
      unit: 'lbs',
      sub: prevWeek
        ? `week ${thisWeek.index}, ${thisWeek.days} day${thisWeek.days === 1 ? '' : 's'} in`
        : 'needs two weeks of data',
      raw: true },
    { label: 'Average pace', value: rate != null ? n2(rate) : '—', unit: 'lbs/wk',
      sub: rate != null ? `${weighins().length} days logged` : '—' },
  ];

  document.getElementById('dashTiles').innerHTML = tiles.map((t) => `
    <div class="tile${t.hero ? ' hero' : ''}">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value">${t.raw ? t.value : esc(t.value)}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="tile-sub">${esc(t.sub)}</div>
    </div>`).join('');

  // Goal progress, only when a goal is set.
  const goal = DATA.settings.goalWeight;
  const goalEl = document.getElementById('goalCard');
  if (goal && cur && start > goal) {
    const pct = Math.max(0, Math.min(100, ((start - cur.weight) / (start - goal)) * 100));
    goalEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Progress to goal</span>
          <span class="card-note">${n1(cur.weight - goal)} lbs to go</span>
        </div>
        <div class="goal-wrap">
          <div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div>
          <div class="goal-legend"><span>${n1(start)} lbs start</span><span><strong>${pct.toFixed(0)}%</strong></span><span>${n1(goal)} lbs goal</span></div>
        </div>
      </div>`;
  } else {
    goalEl.innerHTML = '';
  }

  // Running distance totals, with this week's contribution alongside.
  const buckets = weekBuckets();
  const thisWeekStart = buckets.length ? buckets[buckets.length - 1].start : todayISO();
  const allTime = distanceTotals();
  const thisWk = distanceTotals(thisWeekStart);
  const distEl = document.getElementById('distanceCard');
  if (allTime.total > 0) {
    const item = (key, label) => `
      <div class="dist-item${key === 'total' ? ' total' : ''}">
        ${key === 'total' ? '' : `<span class="dist-dot" style="background:var(${TYPES[key].color})"></span>`}
        <div>
          <div class="dist-value">${n2(allTime[key])}<span class="unit">mi</span></div>
          <div class="dist-label">${label}</div>
          <div class="dist-sub">${thisWk[key] > 0 ? `+${n2(thisWk[key])} this week` : 'none this week'}</div>
        </div>
      </div>`;
    distEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Distance covered</span>
          <span class="card-note">Running total since ${fmtShort(DATA.settings.startDate)}</span>
        </div>
        <div class="dist-grid">
          ${item('run', 'Run')}${item('walk', 'Walk')}${item('hike', 'Hike')}${item('total', 'Total')}
        </div>
      </div>`;
  } else {
    distEl.innerHTML = '';
  }

  const wr = weeklyWeight();
  document.getElementById('weeklyTable').innerHTML = `
    <thead><tr>
      <th class="l">Week</th><th class="l">Dates</th><th>Days</th>
      <th>Avg weight</th><th>Change</th><th>Total lost</th><th>Lowest</th>
    </tr></thead>
    <tbody>${wr.slice().reverse().map((r) => `
      <tr>
        <td class="l strong">${r.index}</td>
        <td class="l">${fmtShort(r.start)} – ${fmtShort(r.end)}</td>
        <td>${r.days || '—'}</td>
        <td class="strong">${n2(r.avg)}</td>
        <td class="delta ${deltaClass(r.change)}">${r.change == null ? '—' : signed(r.change, 2)}</td>
        <td>${r.lost == null ? '—' : n1(r.lost)}</td>
        <td>${n1(r.low)}</td>
      </tr>`).join('')}</tbody>`;

  drawWeightChart();
  drawWeeklyCharts();
}

/* ------------------------------------------------------------ training */
function renderTraining() {
  const rows = weeklyActivity();
  const w = rows[rows.length - 1] || { sessions: 0, minutes: 0, runMi: 0, walkMi: 0, tonnage: 0, steps: 0 };
  const prev = rows[rows.length - 2];
  // The current week is usually only part-run, so a delta against a finished
  // week reads as a loss when it is really just an unfinished week. Show last
  // week's number as a target instead until this one is over.
  const inProgress = w.end >= todayISO();
  // `prev` may legitimately hold zeroes, so test for the week itself, not the value.
  const sub = (cur, key) => {
    if (!prev) return 'first week';
    const was = prev[key] || 0;
    return inProgress ? `last week: ${int(was)}` : `${signed(cur - was, 0)} vs last week`;
  };

  document.getElementById('trainTiles').innerHTML = [
    { label: 'Sessions this week', value: int(w.sessions), unit: '', sub: sub(w.sessions, 'sessions') },
    { label: 'Active minutes', value: int(w.minutes), unit: 'min', sub: sub(w.minutes, 'minutes') },
    { label: 'Miles covered', value: n2(w.groundMi), unit: 'mi',
      sub: `${n2(w.runMi)} run · ${n2(w.walkMi)} walk · ${n2(w.hikeMi)} hike` },
    { label: 'Lifting volume', value: int(w.tonnage), unit: 'lbs', sub: sub(w.tonnage, 'tonnage') },
    { label: 'Steps this week', value: int(w.steps), unit: '', sub: w.steps ? `${int(w.steps / 7)} / day` : 'not tracked' },
  ].map((t) => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value">${esc(t.value)}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      <div class="tile-sub">${esc(t.sub)}</div>
    </div>`).join('');

  drawTrainingCharts();
  renderStrength();
  // The full workout list lives on its own Workouts view now.
}

function renderStrength() {
  const byEx = new Map();
  DATA.activities.filter((a) => a.type === 'lift').forEach((a) => {
    (a.exercises || []).forEach((ex) => {
      const name = (ex.name || '').trim();
      if (!name) return;
      const best = (ex.sets || []).reduce((b, s) => {
        const wgt = Number(s.weight) || 0, reps = Number(s.reps) || 0;
        if (!wgt && !reps) return b;
        if (!b || wgt > b.weight || (wgt === b.weight && reps > b.reps)) return { weight: wgt, reps };
        return b;
      }, null);
      if (!best) return;
      const key = name.toLowerCase();
      if (!byEx.has(key)) byEx.set(key, { name, entries: [] });
      byEx.get(key).entries.push({ date: a.date, ...best });
    });
  });

  const rows = [...byEx.values()].map((e) => {
    e.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
    const first = e.entries[0], last = e.entries[e.entries.length - 1];
    return { name: e.name, sessions: e.entries.length, first, last, gain: last.weight - first.weight };
  }).sort((a, b) => b.sessions - a.sessions);

  const el = document.getElementById('strengthTable');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Log a lifting session with exercises and your best sets will show up here.</div>';
    return;
  }
  el.innerHTML = `
    <table><thead><tr>
      <th class="l">Exercise</th><th>Sessions</th><th>First best</th><th>Latest best</th><th>Change</th>
    </tr></thead><tbody>${rows.map((r) => `
      <tr>
        <td class="l strong">${esc(r.name)}</td>
        <td>${r.sessions}</td>
        <td>${r.first.weight} × ${r.first.reps}</td>
        <td class="strong">${r.last.weight} × ${r.last.reps}</td>
        <td class="delta ${r.gain > 0 ? 'down' : r.gain < 0 ? 'up' : 'flat'}">${r.gain === 0 ? '—' : signed(r.gain, 0) + ' lbs'}</td>
      </tr>`).join('')}</tbody></table>`;
}

function summarize(a) {
  const bits = [];
  if (a.distance) bits.push(`${n2(a.distance)} mi`);
  if (a.minutes) bits.push(`${Math.round(a.minutes)} min`);
  // Walks and hikes are set (and talked about) in mph; runs in pace.
  const p = paceOf(a.minutes, a.distance);
  if (p) bits.push(a.type === 'run'
    ? `${p} /mi`
    : `${(60 * a.distance / a.minutes).toFixed(1)} mph`);
  if (a.type === 'lift') {
    const t = tonnageOf(a);
    const exCount = (a.exercises || []).filter((e) => (e.name || '').trim()).length;
    if (exCount) bits.push(`${exCount} exercise${exCount > 1 ? 's' : ''}`);
    if (t) bits.push(`${int(t)} lbs volume`);
  }
  if (a.label) bits.unshift(a.label);
  return bits.join(' · ') || '—';
}

function activityRows(list) {
  return list.map((a) => {
    const t = TYPES[a.type] || TYPES.other;
    return `<tr>
      <td class="l">${fmtShort(a.date)}</td>
      <td class="l"><span class="chip"><span class="dot" style="background:var(${t.color})"></span>${t.label}</span></td>
      <td class="l">${esc(summarize(a))}</td>
      <td class="l" style="color:var(--text-muted)">${esc(a.notes || '')}</td>
      <td><button class="btn icon" data-del="${a.id}" title="Delete">×</button></td>
    </tr>`;
  }).join('');
}

const fmtDuration = (mins) => {
  if (!mins) return '—';
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/* ------------------------------------------------------------ workouts */
let workoutFilter = 'all';
let openEditor = null;   // id of the workout whose editor is expanded

// Same type, same day, same numbers: almost certainly one session entered twice.
function duplicateIds() {
  const seen = new Map();
  DATA.activities.forEach((a) => {
    const key = [a.date, a.type, Number(a.distance) || 0, Number(a.minutes) || 0,
                 tonnageOf(a), (a.label || '').trim()].join('|');
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(a.id);
  });
  const dupes = new Set();
  seen.forEach((ids) => { if (ids.length > 1) ids.forEach((id) => dupes.add(id)); });
  return dupes;
}

// A workout dated outside the Monday-anchored week grid never reaches the
// weekly charts. Silently dropping it is how an entry appears to vanish, so
// these get called out instead.
function outOfRangeIds(buckets) {
  const out = new Set();
  if (!buckets.length) return out;
  const first = buckets[0].start, last = buckets[buckets.length - 1].end;
  DATA.activities.forEach((a) => {
    if (a.date < first || a.date > last) out.add(a.id);
  });
  return out;
}

function workoutStats(list) {
  return {
    sessions: list.length,
    dist: list.reduce((s, a) => s + (Number(a.distance) || 0), 0),
    mins: list.reduce((s, a) => s + (Number(a.minutes) || 0), 0),
    vol: list.reduce((s, a) => s + tonnageOf(a), 0),
    longest: list.reduce((m, a) => Math.max(m, Number(a.distance) || 0), 0),
  };
}

function renderWorkouts() {
  const all = DATA.activities.slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const counts = { all: all.length };
  Object.keys(TYPES).forEach((t) => { counts[t] = all.filter((a) => a.type === t).length; });

  document.getElementById('typeFilter').innerHTML =
    ['all', ...Object.keys(TYPES)].map((f) => {
      const dot = f === 'all' ? '' : `<span class="dot" style="background:var(${TYPES[f].color})"></span>`;
      const label = f === 'all' ? 'All' : TYPES[f].label;
      return `<button type="button" data-filter="${f}" aria-pressed="${f === workoutFilter}">`
           + `${dot}${label}<span class="seg-count">${counts[f]}</span></button>`;
    }).join('');

  const list = workoutFilter === 'all' ? all : all.filter((a) => a.type === workoutFilter);
  const buckets = weekBuckets();
  const dupes = duplicateIds();
  const oor = outOfRangeIds(buckets);

  const st = workoutStats(list);
  const avgSpeed = st.mins > 0 && st.dist > 0 ? (60 * st.dist) / st.mins : null;
  let tiles;
  if (DISTANCE_TYPES.includes(workoutFilter)) {
    tiles = [
      { label: 'Sessions', value: int(st.sessions) },
      { label: 'Total distance', value: n2(st.dist), unit: 'mi' },
      { label: 'Total time', value: fmtDuration(st.mins) },
      { label: 'Average speed', value: avgSpeed ? avgSpeed.toFixed(1) : '—', unit: 'mph',
        sub: avgSpeed ? `${paceOf(st.mins, st.dist)} /mi` : 'needs distance and time' },
      { label: 'Longest', value: n2(st.longest), unit: 'mi' },
    ];
  } else if (workoutFilter === 'lift') {
    const names = new Set();
    list.forEach((a) => (a.exercises || []).forEach((e) => {
      const n = (e.name || '').trim().toLowerCase();
      if (n) names.add(n);
    }));
    tiles = [
      { label: 'Sessions', value: int(st.sessions) },
      { label: 'Total volume', value: int(st.vol), unit: 'lbs' },
      { label: 'Total time', value: fmtDuration(st.mins) },
      { label: 'Exercises tracked', value: int(names.size) },
    ];
  } else {
    tiles = [
      { label: 'Sessions', value: int(st.sessions) },
      { label: 'Total distance', value: n2(st.dist), unit: 'mi' },
      { label: 'Total time', value: fmtDuration(st.mins) },
      { label: 'Lifting volume', value: int(st.vol), unit: 'lbs' },
    ];
  }
  document.getElementById('workoutTiles').innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value">${esc(t.value)}${t.unit ? `<span class="unit">${t.unit}</span>` : ''}</div>
      ${t.sub ? `<div class="tile-sub">${esc(t.sub)}</div>` : ''}
    </div>`).join('');

  const flags = [];
  if (dupes.size) {
    flags.push(`<strong>${dupes.size} entries look like duplicates</strong> — same type, date and numbers. `
      + `They are tagged in the table; open one and delete it if it was logged twice.`);
  }
  if (oor.size && buckets.length) {
    flags.push(`<strong>${oor.size} workout${oor.size === 1 ? '' : 's'} sit outside your tracked weeks</strong> `
      + `(${fmtShort(buckets[0].start)} – ${fmtShort(buckets[buckets.length - 1].end)}), so `
      + `${oor.size === 1 ? 'it is' : 'they are'} missing from the weekly charts. Open the row and fix the date to pull `
      + `${oor.size === 1 ? 'it' : 'them'} in.`);
  }
  document.getElementById('workoutFlags').innerHTML = flags.length
    ? `<div class="card flag-card"><ul>${flags.map((f) => `<li>${f}</li>`).join('')}</ul></div>`
    : '';

  document.getElementById('workoutTableTitle').textContent =
    workoutFilter === 'all' ? 'All workouts' : `${TYPES[workoutFilter].label} sessions`;
  document.getElementById('workoutTableNote').textContent =
    list.length ? `${list.length} logged · click a row to edit` : '';

  const el = document.getElementById('workoutTable');
  if (!list.length) {
    el.innerHTML = `<div class="empty">No ${workoutFilter === 'all' ? '' : TYPES[workoutFilter].label.toLowerCase() + ' '}workouts logged yet.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="table-scroll full"><table><thead><tr>
      <th class="l">Date</th><th class="l">Type</th><th class="l">Details</th><th class="l">Notes</th><th></th>
    </tr></thead><tbody>${list.map((a) => {
      const t = TYPES[a.type] || TYPES.other;
      const tags = (dupes.has(a.id) ? '<span class="chip warn">possible duplicate</span>' : '')
                 + (oor.has(a.id) ? '<span class="chip warn">outside tracked weeks</span>' : '');
      return `<tr class="w-row${openEditor === a.id ? ' open' : ''}" data-open="${a.id}">
          <td class="l">${fmtFull(a.date)}</td>
          <td class="l"><span class="chip"><span class="dot" style="background:var(${t.color})"></span>${t.label}</span></td>
          <td class="l">${esc(summarize(a))} ${tags}</td>
          <td class="l muted">${esc(a.notes || '')}</td>
          <td><button type="button" class="btn ghost sm" data-open="${a.id}">${openEditor === a.id ? 'Close' : 'Edit'}</button></td>
        </tr>
        <tr class="w-editor" data-editor="${a.id}"${openEditor === a.id ? '' : ' hidden'}><td colspan="5"></td></tr>`;
    }).join('')}</tbody></table></div>`;

  if (openEditor) {
    const row = el.querySelector(`[data-editor="${openEditor}"]`);
    const activity = DATA.activities.find((a) => a.id === openEditor);
    if (row && activity) buildEditor(activity, row.querySelector('td'));
  }
}

// The per-workout editor. Cardio and lifting need different fields, so the
// form is rebuilt when the type changes, carrying the in-progress edits over.
function buildEditor(a, cell) {
  const isLift = a.type === 'lift';
  cell.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'w-edit';
  const f = (label, inner) => `<label class="field">${label}${inner}</label>`;

  wrap.innerHTML = `
    <div class="w-edit-grid">
      ${f('Date', `<input type="date" class="e-date" value="${esc(a.date)}">`)}
      ${f('Type', `<select class="e-type">${Object.entries(TYPES)
          .map(([k, v]) => `<option value="${k}"${k === a.type ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`)}
      ${isLift ? '' : f('Distance (mi)', `<input type="number" step="0.01" min="0" class="e-dist" value="${a.distance || ''}">`)}
      ${f('Duration (min)', `<input type="number" step="1" min="0" class="e-min" value="${a.minutes || ''}">`)}
      ${isLift ? '' : f('Speed (mph)', '<input type="number" step="0.1" min="0" class="e-speed">')}
      ${isLift ? '' : f('Pace (min/mi)', '<input type="text" class="e-pace">')}
      ${a.type === 'other' ? f('What was it?', `<input type="text" class="e-label" value="${esc(a.label || '')}">`) : ''}
    </div>
    ${isLift ? `<div class="e-exercises"></div>
      <div class="row" style="margin-bottom:12px">
        <button type="button" class="btn ghost sm e-addex">+ Add exercise</button>
        <span class="spacer"></span>
        <span class="card-note">Session volume: <strong class="e-vol">0 lbs</strong></span>
      </div>` : ''}
    <label class="field" style="margin-bottom:14px">Notes<input type="text" class="e-notes" value="${esc(a.notes || '')}"></label>
    <div class="row">
      <button type="button" class="btn e-save">Save changes</button>
      <button type="button" class="btn ghost e-cancel">Cancel</button>
      <span class="spacer"></span>
      <button type="button" class="btn danger e-delete">Delete workout</button>
    </div>`;
  cell.appendChild(wrap);

  if (isLift) {
    const host = wrap.querySelector('.e-exercises');
    const refresh = () => {
      wrap.querySelector('.e-vol').textContent = `${int(volumeOf(readExercises(host)))} lbs`;
    };
    const seeds = a.exercises && a.exercises.length ? a.exercises : [null];
    seeds.forEach((ex) => host.appendChild(exerciseBlock(refresh, ex)));
    wrap.querySelector('.e-addex').addEventListener('click', () => {
      host.appendChild(exerciseBlock(refresh)); refresh();
    });
    refresh();
  } else {
    linkCardio({
      dist: wrap.querySelector('.e-dist'),
      min: wrap.querySelector('.e-min'),
      speed: wrap.querySelector('.e-speed'),
      pace: wrap.querySelector('.e-pace'),
    }).prime(Number(a.distance) || 0, Number(a.minutes) || 0);
  }

  const draftFrom = (type) => ({
    ...a,
    type,
    date: wrap.querySelector('.e-date').value || a.date,
    minutes: Number(wrap.querySelector('.e-min').value) || 0,
    notes: wrap.querySelector('.e-notes').value,
    label: wrap.querySelector('.e-label') ? wrap.querySelector('.e-label').value : (a.label || ''),
    distance: wrap.querySelector('.e-dist') ? Number(wrap.querySelector('.e-dist').value) || 0 : (a.distance || 0),
    exercises: wrap.querySelector('.e-exercises')
      ? readExercises(wrap.querySelector('.e-exercises')) : (a.exercises || []),
  });

  wrap.querySelector('.e-type').addEventListener('change', (e) =>
    buildEditor(draftFrom(e.target.value), cell));

  wrap.querySelector('.e-cancel').addEventListener('click', () => {
    openEditor = null;
    renderWorkouts();
  });

  wrap.querySelector('.e-delete').addEventListener('click', () => {
    DATA.activities = DATA.activities.filter((x) => x.id !== a.id);
    openEditor = null;
    save(true);
    renderAll();
    toast('Workout deleted');
  });

  wrap.querySelector('.e-save').addEventListener('click', () => {
    const target = DATA.activities.find((x) => x.id === a.id);
    if (!target) return;
    const d = draftFrom(wrap.querySelector('.e-type').value);
    target.date = d.date;
    target.type = d.type;
    target.minutes = d.minutes;
    target.notes = (d.notes || '').trim();
    target.distance = d.type === 'lift' ? 0 : d.distance;
    target.exercises = d.type === 'lift' ? d.exercises : [];
    target.label = d.type === 'other' ? (d.label || '').trim() : '';
    openEditor = null;
    save(true);
    renderAll();
    toast('Workout updated');
  });
}

function renderRecent() {
  const list = DATA.activities.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  const el = document.getElementById('recentActivities');
  el.innerHTML = list.length
    ? `<table><tbody>${activityRows(list)}</tbody></table>`
    : '<div class="empty">Nothing logged yet.</div>';
}

/* ------------------------------------------------------------ history */
function renderHistory() {
  const s = dailySeries(dataRange()).slice().reverse();
  const el = document.getElementById('historyTable');
  if (!s.length) {
    el.innerHTML = '<div class="empty">No entries yet.</div>';
    return;
  }
  el.innerHTML = `
    <table><thead><tr>
      <th class="l">Date</th><th>Weight</th><th>7-day avg</th><th>Steps</th>
      <th class="l">Workouts</th><th class="l">Notes</th><th></th>
    </tr></thead><tbody>${s.map((r) => {
      const day = DATA.days[r.date] || {};
      const acts = DATA.activities.filter((a) => a.date === r.date);
      const chips = acts.map((a) => {
        const t = TYPES[a.type] || TYPES.other;
        return `<span class="chip"><span class="dot" style="background:var(${t.color})"></span>${t.label}</span>`;
      }).join(' ');
      return `<tr>
        <td class="l ${r.date === todayISO() ? 'strong' : ''}">${fmtFull(r.date)}</td>
        <td><input type="number" step="0.1" min="50" max="800" value="${r.weight ?? ''}"
             data-weight-date="${r.date}" style="width:78px;text-align:right;padding:3px 6px" /></td>
        <td>${n2(r.avg)}</td>
        <td><input type="number" step="1" min="0" value="${day.steps ?? ''}"
             data-steps-date="${r.date}" style="width:78px;text-align:right;padding:3px 6px" /></td>
        <td class="l">${chips || '<span style="color:var(--text-muted)">—</span>'}</td>
        <td class="l" style="color:var(--text-muted)">${esc(day.notes || '')}</td>
        <td><button class="btn icon" data-clear-day="${r.date}" title="Clear this day">×</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

/* ------------------------------------------------------------ settings */
function renderSettings() {
  document.getElementById('sStart').value = DATA.settings.startWeight ?? '';
  document.getElementById('sDate').value = DATA.settings.startDate ?? '';
  document.getElementById('sGoal').value = DATA.settings.goalWeight ?? '';
  document.getElementById('sMed').value = DATA.settings.medication ?? '';
}

/* ------------------------------------------------------------ exercise builder */
// `onChange` lets each host refresh its own volume readout; `seed` prefills an
// existing exercise so the same builder serves both adding and editing.
function exerciseBlock(onChange, seed) {
  const div = document.createElement('div');
  div.className = 'exercise';
  div.innerHTML = `
    <div class="exercise-head">
      <input type="text" class="ex-name" placeholder="Exercise (e.g. Goblet squat)" list="exNames" />
      <button type="button" class="btn icon ex-remove" title="Remove exercise">×</button>
    </div>
    <div class="sets"></div>
    <div style="margin-top:9px"><button type="button" class="btn ghost sm ex-addset">+ Set</button></div>`;
  div.querySelector('.ex-remove').addEventListener('click', () => { div.remove(); onChange(); });
  div.querySelector('.ex-addset').addEventListener('click', () => addSet(div, onChange));
  if (seed) {
    div.querySelector('.ex-name').value = seed.name || '';
    const sets = seed.sets && seed.sets.length ? seed.sets : [null];
    sets.forEach((s) => addSet(div, onChange, s));
  } else {
    addSet(div, onChange); addSet(div, onChange); addSet(div, onChange);
  }
  return div;
}

function addSet(block, onChange, seed) {
  const wrap = block.querySelector('.sets');
  const chip = document.createElement('span');
  chip.className = 'set-chip';
  chip.innerHTML = `
    <input type="number" class="s-reps" min="0" step="1" placeholder="reps" />
    <span class="x">×</span>
    <input type="number" class="s-weight" min="0" step="2.5" placeholder="lbs" />
    <button type="button" class="btn icon s-del" title="Remove set">×</button>`;
  if (seed) {
    chip.querySelector('.s-reps').value = seed.reps ?? '';
    chip.querySelector('.s-weight').value = seed.weight ?? '';
  }
  chip.querySelector('.s-del').addEventListener('click', () => { chip.remove(); onChange(); });
  chip.querySelectorAll('input').forEach((i) => i.addEventListener('input', onChange));
  wrap.appendChild(chip);
}

function readExercises(container) {
  return [...container.querySelectorAll('.exercise')].map((block) => ({
    name: block.querySelector('.ex-name').value.trim(),
    sets: [...block.querySelectorAll('.set-chip')].map((c) => ({
      reps: Number(c.querySelector('.s-reps').value) || 0,
      weight: Number(c.querySelector('.s-weight').value) || 0,
    })).filter((s) => s.reps || s.weight),
  })).filter((e) => e.name || e.sets.length);
}

function volumeOf(exercises) {
  return (exercises || []).reduce((sum, ex) =>
    sum + (ex.sets || []).reduce((s, st) => s + st.reps * st.weight, 0), 0);
}

function updateTonnage() {
  const total = volumeOf(readExercises(document.getElementById('exerciseList')));
  document.getElementById('tonnage').textContent = `${int(total)} lbs`;
}

function refreshExerciseNames() {
  const names = new Set();
  DATA.activities.forEach((a) => (a.exercises || []).forEach((e) => e.name && names.add(e.name.trim())));
  let dl = document.getElementById('exNames');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'exNames'; document.body.appendChild(dl); }
  dl.innerHTML = [...names].sort().map((n) => `<option value="${esc(n)}"></option>`).join('');
}

/* ------------------------------------------------------------ activity form */
let activeType = 'run';
let cardioLink = null;

// Distance, duration and rate are three views of two facts: enter whichever two
// you know and the third is computed. Rate is a single slot with two faces -
// treadmill speed (mph) and pace (min/mi) - kept in sync, so setting the belt
// to 3.5 is a first-class way to log a walk. Used by both the add form and the
// per-workout editor, each with its own independent "recently typed" memory.
function linkCardio(els) {
  let touched = [];

  const currentPace = () => {
    const p = parsePace(els.pace.value);
    if (p) return p;
    const s = Number(els.speed.value);
    return s > 0 ? 60 / s : null;
  };
  const showRate = (p) => {
    els.pace.value = p ? paceOf(p, 1) : '';
    els.speed.value = p ? +(60 / p).toFixed(1) : '';
  };

  const derive = (target) => {
    const d = Number(els.dist.value) || 0;
    const m = Number(els.min.value) || 0;
    const p = currentPace();
    if (target === 'rate') showRate(d > 0 && m > 0 ? m / d : null);
    else if (target === 'min') els.min.value = p && d > 0 ? Math.round(p * d) : '';
    else if (target === 'dist') els.dist.value = p && m > 0 ? +(m / p).toFixed(2) : '';
  };

  const SLOTS = ['dist', 'min', 'rate'];
  const onEdit = (slot, sync) => () => {
    if (sync) sync();
    const i = touched.indexOf(slot);
    if (i >= 0) touched.splice(i, 1);
    touched.unshift(slot);
    // One slot alone gives nothing to compute from, and guessing at this point
    // would wipe a value the user had already put in.
    if (touched.length < 2) return;
    const held = touched.slice(0, 2);
    derive(SLOTS.find((s) => !held.includes(s)));
  };

  // The rate fields resolve on commit rather than per keystroke: "9:3" is a
  // valid-looking fragment of "9:30" and would make duration jump mid-typing.
  const syncFromSpeed = () => {
    const s = Number(els.speed.value);
    els.pace.value = s > 0 ? paceOf(60 / s, 1) : '';
  };
  const syncFromPace = () => {
    const p = parsePace(els.pace.value);
    els.speed.value = p ? +(60 / p).toFixed(1) : '';
  };

  els.dist.addEventListener('input', onEdit('dist'));
  els.min.addEventListener('input', onEdit('min'));
  ['change', 'blur'].forEach((ev) => {
    els.speed.addEventListener(ev, onEdit('rate', syncFromSpeed));
    els.pace.addEventListener(ev, onEdit('rate', syncFromPace));
  });

  return {
    reset: () => { touched = []; },
    // Fill both rate faces from a stored workout, treating distance and
    // duration as the pair the user already committed to.
    prime: (dist, min) => {
      touched = ['dist', 'min'];
      showRate(dist > 0 && min > 0 ? min / dist : null);
    },
  };
}

function setType(t) {
  activeType = t;
  document.querySelectorAll('#typeSeg button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.type === t)));
  document.getElementById('cardioFields').hidden = t === 'lift';
  document.getElementById('liftFields').hidden = t !== 'lift';
  document.getElementById('aLabelField').hidden = t !== 'other';
  if (t === 'lift' && !document.querySelector('#exerciseList .exercise')) {
    document.getElementById('exerciseList').appendChild(exerciseBlock(updateTonnage));
  }
}

function clearActivityForm() {
  ['aDist', 'aMin', 'aSpeed', 'aPace', 'aNotesCardio', 'aLiftMin', 'aNotesLift', 'aLabel']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('exerciseList').innerHTML = '';
  if (activeType === 'lift') document.getElementById('exerciseList').appendChild(exerciseBlock(updateTonnage));
  if (cardioLink) cardioLink.reset();
  updateTonnage();
}

/* ------------------------------------------------------------ CSV */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

function daysCsv() {
  const rows = [['Date', 'Day', 'Week', 'Weight (lbs)', '7-day average', 'Lost so far', 'Steps', 'Notes']];
  const weeks = weekBuckets();
  dailySeries().forEach((r) => {
    const day = DATA.days[r.date] || {};
    const wk = weeks.find((b) => r.date >= b.start && r.date <= b.end);
    rows.push([r.date, DOW[parseISO(r.date).getDay()], wk ? wk.index : '',
      r.weight ?? '', r.avg != null ? r.avg.toFixed(2) : '',
      r.weight != null ? (DATA.settings.startWeight - r.weight).toFixed(1) : '',
      day.steps ?? '', day.notes ?? '']);
  });
  rows.push([]);
  rows.push(['Week', 'Start', 'End', 'Days logged', 'Avg weight', 'Change vs prior', 'Total lost', 'Lowest']);
  weeklyWeight().forEach((r) => rows.push([r.index, r.start, r.end, r.days,
    r.avg != null ? r.avg.toFixed(2) : '', r.change != null ? r.change.toFixed(2) : '',
    r.lost != null ? r.lost.toFixed(1) : '', r.low ?? '']));
  return toCsv(rows);
}

function activitiesCsv() {
  const rows = [['Date', 'Type', 'Label', 'Distance (mi)', 'Minutes', 'Pace /mi', 'Speed (mph)', 'Volume (lbs)', 'Exercises', 'Notes']];
  DATA.activities.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((a) => {
    const ex = (a.exercises || []).filter((e) => e.name)
      .map((e) => `${e.name}: ${(e.sets || []).map((s) => `${s.reps}x${s.weight}`).join(', ')}`).join(' | ');
    rows.push([a.date, TYPES[a.type] ? TYPES[a.type].label : a.type, a.label ?? '',
      a.distance ?? '', a.minutes ?? '', paceOf(a.minutes, a.distance) ?? '',
      a.distance && a.minutes ? (60 * a.distance / a.minutes).toFixed(1) : '',
      tonnageOf(a) || '', ex, a.notes ?? '']);
  });
  return toCsv(rows);
}

async function exportCsv(name, contents) {
  const res = await window.api.exportFile(name, contents);
  if (res && res.ok) toast('Exported');
}

/* ------------------------------------------------------------ render all */
function renderAll() {
  renderDashboard();
  renderTraining();
  renderWorkouts();
  renderHistory();
  renderRecent();
  refreshExerciseNames();
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  // Charts size themselves against a visible container.
  Object.values(charts).forEach((c) => c.resize());
}

/* ------------------------------------------------------------ weigh-in */
function saveWeighin(date, weight, steps, notes) {
  if (!date) return false;
  // A fresh install has no baseline. The first weigh-in logged becomes it,
  // so the app is useful immediately without a trip to Settings.
  if (DATA.settings.startWeight == null && typeof weight === 'number' && weight > 0) {
    DATA.settings.startWeight = weight;
    DATA.settings.startDate = date;
  }
  const day = DATA.days[date] || {};
  if (weight !== undefined) day.weight = weight;
  if (steps !== undefined) day.steps = steps;
  if (notes !== undefined) day.notes = notes;
  if (day.weight == null && day.steps == null && !day.notes) delete DATA.days[date];
  else DATA.days[date] = day;
  save(true);
  return true;
}

/* ------------------------------------------------------------ wiring */
function wire() {
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.nav)));

  document.getElementById('themeToggle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = DATA.settings.theme || 'auto';
    DATA.settings.theme = order[(order.indexOf(cur) + 1) % order.length];
    save(true);
    applyTheme();
    requestAnimationFrame(renderAll);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((DATA.settings.theme || 'auto') === 'auto') requestAnimationFrame(renderAll);
  });

  // --- dashboard quick weigh-in
  const quick = document.getElementById('quickWeight');
  const doQuick = () => {
    const v = Number(quick.value);
    if (!v) { toast('Enter a weight first'); return; }
    saveWeighin(todayISO(), v);
    quick.value = '';
    renderAll();
    toast(`Logged ${n1(v)} lbs for today`);
  };
  document.getElementById('quickSave').addEventListener('click', doQuick);
  quick.addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuick(); });

  // --- log tab weigh-in
  const wDate = document.getElementById('wDate');
  const fillWeighinForm = () => {
    const d = wDate.value || todayISO();
    const day = DATA.days[d] || {};
    document.getElementById('wWeight').value = day.weight ?? '';
    document.getElementById('wSteps').value = day.steps ?? '';
    document.getElementById('wNotes').value = day.notes ?? '';
    document.getElementById('wHint').textContent = day.weight
      ? `Already logged ${n1(day.weight)} lbs on ${fmtFull(d)} — saving will overwrite it.`
      : `Nothing logged for ${fmtFull(d)} yet.`;
  };
  wDate.addEventListener('change', fillWeighinForm);
  document.getElementById('wSave').addEventListener('click', () => {
    const d = wDate.value || todayISO();
    const weight = document.getElementById('wWeight').value;
    const steps = document.getElementById('wSteps').value;
    saveWeighin(d,
      weight === '' ? null : Number(weight),
      steps === '' ? null : Number(steps),
      document.getElementById('wNotes').value.trim());
    renderAll();
    fillWeighinForm();
    toast('Weigh-in saved');
  });

  // --- activity type + pace
  document.querySelectorAll('#typeSeg button').forEach((b) =>
    b.addEventListener('click', () => setType(b.dataset.type)));

  cardioLink = linkCardio({
    dist: document.getElementById('aDist'),
    min: document.getElementById('aMin'),
    speed: document.getElementById('aSpeed'),
    pace: document.getElementById('aPace'),
  });

  document.getElementById('addExercise').addEventListener('click', () =>
    document.getElementById('exerciseList').appendChild(exerciseBlock(updateTonnage)));

  document.getElementById('aClear').addEventListener('click', clearActivityForm);

  document.getElementById('aSave').addEventListener('click', () => {
    const date = document.getElementById('aDate').value || todayISO();
    const isLift = activeType === 'lift';
    const minutes = Number(isLift ? document.getElementById('aLiftMin').value
                                  : document.getElementById('aMin').value) || 0;
    const distance = isLift ? 0 : Number(document.getElementById('aDist').value) || 0;
    const exercises = isLift ? readExercises(document.getElementById("exerciseList")) : [];

    if (!minutes && !distance && !exercises.length) {
      toast('Add a duration, distance, or some sets first');
      return;
    }
    DATA.activities.push({
      id: `a${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      date,
      type: activeType,
      minutes,
      distance,
      label: activeType === 'other' ? document.getElementById('aLabel').value.trim() : '',
      notes: (isLift ? document.getElementById('aNotesLift') : document.getElementById('aNotesCardio')).value.trim(),
      exercises,
    });
    save(true);
    clearActivityForm();
    renderAll();
    toast(`${TYPES[activeType].label} logged`);
  });

  // --- delete an activity (recent list or full table)
  document.body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    DATA.activities = DATA.activities.filter((a) => a.id !== del.dataset.del);
    save(true);
    renderAll();
    toast('Workout removed');
  });

  // --- inline edits in History
  document.getElementById('historyTable').addEventListener('change', (e) => {
    const wEl = e.target.closest('[data-weight-date]');
    if (wEl) {
      saveWeighin(wEl.dataset.weightDate, wEl.value === '' ? null : Number(wEl.value));
      renderAll();
      return;
    }
    const sEl = e.target.closest('[data-steps-date]');
    if (sEl) {
      saveWeighin(sEl.dataset.stepsDate, undefined, sEl.value === '' ? null : Number(sEl.value));
      renderAll();
    }
  });
  document.getElementById('historyTable').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear-day]');
    if (!btn) return;
    delete DATA.days[btn.dataset.clearDay];
    save(true);
    renderAll();
    toast('Day cleared');
  });

  // --- settings
  document.getElementById('sSave').addEventListener('click', () => {
    const g = document.getElementById('sGoal').value;
    DATA.settings.startWeight = Number(document.getElementById('sStart').value) || DATA.settings.startWeight;
    DATA.settings.startDate = document.getElementById('sDate').value || DATA.settings.startDate;
    DATA.settings.goalWeight = g === '' ? null : Number(g);
    DATA.settings.medication = document.getElementById('sMed').value.trim();
    save(true);
    renderAll();
    toast('Settings saved');
  });

  // --- Workouts view: type filter and the per-row editor
  document.getElementById('typeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    workoutFilter = b.dataset.filter;
    openEditor = null;
    renderWorkouts();
  });

  document.getElementById('workoutTable').addEventListener('click', (e) => {
    const t = e.target.closest('[data-open]');
    if (!t) return;
    openEditor = openEditor === t.dataset.open ? null : t.dataset.open;
    renderWorkouts();
  });

  document.getElementById('exportWorkouts').addEventListener('click', () =>
    exportCsv('trendline-workouts.csv', activitiesCsv()));

  // No filesystem on the web build - the same button hands over the JSON.
  if (window.api.platform === 'web') {
    document.getElementById('revealData').hidden = true;
  }
  document.getElementById('revealData').addEventListener('click', () => window.api.reveal());

  document.getElementById('backupJson').addEventListener('click', () => {
    const stamp = todayISO();
    const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(),
      settings: DATA.settings, days: DATA.days, activities: DATA.activities }, null, 2);
    window.api.exportFile(`trendline-backup-${stamp}.json`, json);
    toast('Backup saved');
  });

  document.getElementById('importJson').addEventListener('click', () =>
    document.getElementById('importFile').click());

  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';   // let the same file be picked again later
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const days = parsed.days && typeof parsed.days === 'object' ? parsed.days : null;
      const acts = Array.isArray(parsed.activities) ? parsed.activities : null;
      if (!days && !acts) { toast('That file has no Trendline data in it'); return; }

      const counts = { days: Object.keys(days || {}).length, acts: (acts || []).length };
      const ok = window.confirm(
        `Restore ${counts.days} logged day${counts.days === 1 ? '' : 's'} and `
        + `${counts.acts} workout${counts.acts === 1 ? '' : 's'}?\n\n`
        + 'This replaces everything currently in the app.');
      if (!ok) return;

      DATA.days = days || {};
      DATA.activities = acts || [];
      if (parsed.settings && typeof parsed.settings === 'object') {
        DATA.settings = { ...DATA.settings, ...parsed.settings };
      }
      // Re-key anything missing an id so the editor can address every row.
      DATA.activities.forEach((a, i) => {
        if (!a.id) a.id = `i${Date.now()}${i}`;
      });
      openEditor = null;
      save(true);
      applyTheme();
      renderSettings();
      renderAll();
      toast(`Restored ${counts.days} days and ${counts.acts} workouts`);
    } catch (err) {
      toast('Could not read that file');
      console.error('import failed', err);
    }
  });
  document.getElementById('exportDays').addEventListener('click', () => exportCsv('trendline-weight.csv', daysCsv()));
  document.getElementById('exportActivities').addEventListener('click', () => exportCsv('trendline-workouts.csv', activitiesCsv()));
  document.getElementById('exportAll').addEventListener('click', () =>
    exportCsv('trendline-export.csv', `${daysCsv()}\r\n\r\n${activitiesCsv()}`));

  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
}

/* ------------------------------------------------------------ init */
(async function init() {
  DATA = await window.api.load();
  applyTheme();
  window.api.backup(DATA);

  const t = todayISO();
  document.getElementById('wDate').value = t;
  document.getElementById('aDate').value = t;

  wire();
  setType('run');
  renderSettings();
  renderAll();

  const day = DATA.days[t] || {};
  document.getElementById('wWeight').value = day.weight ?? '';
  document.getElementById('wSteps').value = day.steps ?? '';
  document.getElementById('wNotes').value = day.notes ?? '';
  document.getElementById('wHint').textContent = day.weight
    ? `Already logged ${n1(day.weight)} lbs for today — saving will overwrite it.`
    : 'Nothing logged for today yet.';
})();
