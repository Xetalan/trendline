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
const fmtLong = (s) => { const d = parseISO(s); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };

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

// Weekly rate from a least-squares fit over recent weekly averages. Reading
// "first vs last" instead would swing wildly on a single noisy week.
// Negative means losing.
function trendRate() {
  const pts = weeklyWeight().filter((w) => w.avg != null).slice(-6);
  if (pts.length < 2) return null;
  const n = pts.length;
  const my = pts.reduce((a, w) => a + w.avg, 0) / n;
  const mx = (n - 1) / 2;
  let num = 0, den = 0;
  pts.forEach((w, i) => { num += (i - mx) * (w.avg - my); den += (i - mx) ** 2; });
  return den ? num / den : null;
}

// Where the current trend lands you, and roughly when.
function projection() {
  const goal = DATA.settings.goalWeight;
  const cur = latestAvg();
  const rate = trendRate();
  if (!goal || !cur || rate == null) return null;
  const perWeek = -rate;                       // positive = losing
  if (perWeek < 0.05) return null;             // flat or gaining: no honest date
  const toGo = cur.avg - goal;
  if (toGo <= 0) return null;                  // already there
  const weeks = toGo / perWeek;
  if (weeks > 260) return null;                // too far out to mean anything
  return { perWeek, weeks, from: cur, date: iso(addDays(parseISO(cur.date), Math.round(weeks * 7))) };
}

// Consecutive days with a weigh-in. Not having logged *today* yet does not
// break a streak - it just has not been extended.
function loggingStreak() {
  const logged = new Set(weighins().map((w) => w.date));
  let d = new Date();
  if (!logged.has(iso(d))) d = addDays(d, -1);
  let n = 0;
  while (logged.has(iso(d))) { n++; d = addDays(d, -1); }
  return n;
}

function adherence(days) {
  const logged = new Set(weighins().map((w) => w.date));
  let hit = 0;
  for (let k = 0; k < days; k++) if (logged.has(iso(addDays(new Date(), -k)))) hit++;
  return hit;
}

// The most recent week that has actually finished - a part-week recap would
// always read as a bad week.
function lastCompleteWeek() {
  const ww = weeklyWeight();
  const wa = weeklyActivity();
  const t = todayISO();
  for (let i = ww.length - 1; i >= 0; i--) {
    if (ww[i].end < t) return { week: ww[i], act: wa[i] };
  }
  return null;
}

function personalRecords() {
  const out = [];
  const acts = DATA.activities;

  DISTANCE_TYPES.forEach((t) => {
    const list = acts.filter((a) => a.type === t && Number(a.distance) > 0);
    if (!list.length) return;
    const best = list.reduce((m, a) => (Number(a.distance) > Number(m.distance) ? a : m));
    out.push({ label: `Longest ${TYPES[t].label.toLowerCase()}`, value: `${n2(best.distance)} mi`, date: best.date });
  });

  const runs = acts.filter((a) => a.type === 'run' && a.distance > 0 && a.minutes > 0);
  if (runs.length) {
    const fast = runs.reduce((m, a) => (a.minutes / a.distance < m.minutes / m.distance ? a : m));
    out.push({ label: 'Fastest pace', value: `${paceOf(fast.minutes, fast.distance)} /mi`, date: fast.date });
  }

  let heaviest = null;
  acts.filter((a) => a.type === 'lift').forEach((a) =>
    (a.exercises || []).forEach((ex) => (ex.sets || []).forEach((s) => {
      if (Number(s.weight) > 0 && (!heaviest || s.weight > heaviest.weight)) {
        heaviest = { weight: s.weight, reps: s.reps, name: ex.name, date: a.date };
      }
    })));
  if (heaviest) {
    out.push({ label: 'Heaviest set', value: `${heaviest.weight} × ${heaviest.reps}`,
      sub: heaviest.name, date: heaviest.date });
  }

  const lifts = acts.filter((a) => a.type === 'lift');
  if (lifts.length) {
    const big = lifts.reduce((m, a) => (tonnageOf(a) > tonnageOf(m) ? a : m));
    if (tonnageOf(big) > 0) {
      out.push({ label: 'Biggest session', value: `${int(tonnageOf(big))} lbs`, date: big.date });
    }
  }

  const weeks = weeklyActivity().filter((w) => w.groundMi > 0);
  if (weeks.length) {
    const bw = weeks.reduce((m, w) => (w.groundMi > m.groundMi ? w : m));
    out.push({ label: 'Biggest week', value: `${n2(bw.groundMi)} mi`, date: bw.start });
  }
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

  // Extend the trend forward as a dashed line. Capped so the projection can
  // never dominate the real data - a six-month goal would otherwise leave the
  // actual readings squeezed into a corner.
  const labels = s.map((r) => fmtShort(r.date));
  const dailyVals = s.map((r) => r.weight);
  const avgVals = s.map((r) => r.avg);
  let projVals = null;
  const proj = projection();
  // Anchor to the last day that actually has an average, not the last row -
  // a gap in logging leaves trailing null rows, and anchoring there would
  // detach the projection from the line it is supposed to continue.
  let anchor = -1;
  for (let i = s.length - 1; i >= 0 && anchor < 0; i--) if (s[i].avg != null) anchor = i;

  if (proj && anchor >= 0) {
    const days = Math.min(Math.round(proj.weeks * 7), Math.max(28, Math.round(s.length * 0.5)), 84);
    if (days > 6) {
      const from = s[anchor].avg;
      const fromDate = parseISO(s[anchor].date);
      projVals = new Array(s.length).fill(null);
      projVals[anchor] = from;
      for (let k = 1; k <= days; k++) {
        const value = from - proj.perWeek * (k / 7);
        const idx = anchor + k;
        if (idx < s.length) {
          projVals[idx] = value;            // still within the existing axis
        } else {
          labels.push(fmtShort(iso(addDays(fromDate, k))));
          dailyVals.push(null);
          avgVals.push(null);
          projVals.push(value);
        }
      }
    }
  }

  const vals = [...dailyVals, ...avgVals, ...(projVals || [])].filter((v) => v != null);
  const b = niceBounds(Math.min(...vals), Math.max(...vals));
  opts.scales.y.min = b.min;
  opts.scales.y.max = b.max;
  opts.scales.y.ticks.callback = (v) => v.toFixed(0);
  opts.plugins.tooltip.callbacks = {
    title: (items) => {
      const i = items[0].dataIndex;
      return i < s.length ? fmtFull(s[i].date) : `${labels[i]} · projected`;
    },
    label: (ctx) => ctx.parsed.y == null ? null
      : `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(ctx.datasetIndex === 0 ? 1 : 2)} lbs`,
  };

  draw('weight', 'chartWeight', {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Daily reading',
          data: dailyVals,
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
          data: avgVals,
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
        ...(projVals ? [{
          label: 'Projected',
          data: projVals,
          borderColor: css('--series-1'),
          backgroundColor: css('--series-1'),
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          pointHoverRadius: 5,
          spanGaps: true,
          tension: 0,
        }] : []),
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
// The dashboard can focus on weight or on any one activity, so each discipline
// gets its own headline numbers instead of being averaged into one view.
let dashFocus = 'weight';

const FOCUS_FIELDS = {
  run:  { miles: 'runMi',  minutes: 'runMin' },
  walk: { miles: 'walkMi', minutes: 'walkMin' },
  hike: { miles: 'hikeMi', minutes: 'hikeMin' },
  lift: { miles: null,     minutes: 'liftMin' },
};

function renderActivityDashboard(type) {
  const el = document.getElementById('dashActivity');
  const t = TYPES[type];
  const all = DATA.activities.filter((a) => a.type === type)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (!all.length) {
    el.innerHTML = `<div class="card"><div class="empty">`
      + `No ${t.label.toLowerCase()} sessions logged yet. Add one from Log Today.</div></div>`;
    return;
  }

  const st = workoutStats(all);
  const weeks = weeklyActivity();
  const thisWeek = weeks[weeks.length - 1];
  const f = FOCUS_FIELDS[type];
  const isLift = type === 'lift';
  const avgSpeed = st.mins > 0 && st.dist > 0 ? (60 * st.dist) / st.mins : null;

  const tiles = isLift ? [
    { label: 'Sessions', value: int(st.sessions), sub: 'all time' },
    { label: 'Total volume', value: int(st.vol), unit: 'lbs' },
    { label: 'Total time', value: fmtDuration(st.mins) },
    { label: 'This week', value: int(thisWeek ? thisWeek.tonnage : 0), unit: 'lbs' },
  ] : [
    { label: 'Sessions', value: int(st.sessions), sub: 'all time' },
    { label: 'Total distance', value: n2(st.dist), unit: 'mi' },
    { label: 'Total time', value: fmtDuration(st.mins) },
    { label: 'Average speed', value: avgSpeed ? avgSpeed.toFixed(1) : '—', unit: 'mph',
      sub: avgSpeed ? `${paceOf(st.mins, st.dist)} /mi` : '' },
    { label: 'Longest', value: n2(st.longest), unit: 'mi' },
    { label: 'This week', value: n2(thisWeek ? thisWeek[f.miles] : 0), unit: 'mi' },
  ];

  el.innerHTML = `
    <div class="tiles">${tiles.map((x) => `
      <div class="tile">
        <div class="tile-label">${x.label}</div>
        <div class="tile-value">${esc(x.value)}${x.unit ? `<span class="unit">${x.unit}</span>` : ''}</div>
        ${x.sub ? `<div class="tile-sub">${esc(x.sub)}</div>` : ''}
      </div>`).join('')}</div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">${isLift ? 'Volume per week' : 'Distance per week'}</span>
        <span class="card-note">${t.label} only</span>
      </div>
      <div class="chart-box"><canvas id="chartFocusWeekly"></canvas></div>
    </div>

    ${isLift ? '' : `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Speed per session</span>
        <span class="card-note">Higher is faster</span>
      </div>
      <div class="chart-box"><canvas id="chartFocusPace"></canvas></div>
    </div>`}

    <div class="card">
      <div class="card-head">
        <span class="card-title">Recent ${t.label.toLowerCase()} sessions</span>
        <span class="card-note">Last 10 · edit them under Training</span>
      </div>
      <div class="table-scroll"><table><tbody>${activityRows(all.slice(0, 10))}</tbody></table></div>
    </div>`;

  // --- weekly bar
  const labels = weeks.map((w) => fmtShort(w.start));
  const values = weeks.map((w) => (isLift ? w.tonnage : w[f.miles]));
  const wOpts = { ...baseOptions(),
    scales: { x: baseOptions().scales.x, y: { ...baseOptions().scales.y, beginAtZero: true } } };
  wOpts.plugins.tooltip.callbacks = {
    title: (i) => `Week ${weeks[i[0].dataIndex].index} · ${fmtShort(weeks[i[0].dataIndex].start)}`,
    label: (ctx) => (isLift
      ? `${Math.round(ctx.parsed.y).toLocaleString()} lbs`
      : `${ctx.parsed.y.toFixed(2)} mi`),
  };
  draw('focusWeekly', 'chartFocusWeekly', {
    type: 'bar',
    data: { labels, datasets: [{
      label: t.label,
      data: values,
      backgroundColor: css(t.color),
      borderColor: css('--surface'),
      borderWidth: 2, borderRadius: 4, borderSkipped: false,
      categoryPercentage: 0.7, barPercentage: 0.85,
    }] },
    options: wOpts,
  });

  // --- speed per session
  if (!isLift) {
    const pts = all.filter((a) => a.distance > 0 && a.minutes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const pOpts = baseOptions();
    pOpts.plugins.tooltip.callbacks = {
      title: (i) => fmtFull(pts[i[0].dataIndex].date),
      label: (ctx) => {
        const a = pts[ctx.dataIndex];
        return `${ctx.parsed.y.toFixed(1)} mph · ${paceOf(a.minutes, a.distance)} /mi · ${n2(a.distance)} mi`;
      },
    };
    draw('focusPace', 'chartFocusPace', {
      type: 'line',
      data: {
        labels: pts.map((a) => fmtShort(a.date)),
        datasets: [{
          label: 'mph',
          data: pts.map((a) => (60 * a.distance) / a.minutes),
          borderColor: css(t.color),
          backgroundColor: css(t.color),
          borderWidth: 2.5,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBorderColor: css('--surface'),
          pointBorderWidth: 1.5,
          tension: 0.25,
        }],
      },
      options: pOpts,
    });
  }
}

function renderDashboard() {
  // Activity focus replaces the weight panel entirely.
  const weightPanel = document.getElementById('dashWeight');
  const activityPanel = document.getElementById('dashActivity');
  if (dashFocus !== 'weight') {
    weightPanel.hidden = true;
    activityPanel.hidden = false;
    document.getElementById('dashSub').textContent =
      `${TYPES[dashFocus].label} — every session you have logged`;
    renderActivityDashboard(dashFocus);
    return;
  }
  weightPanel.hidden = false;
  activityPanel.hidden = true;

  renderWeightDashboard();
}

function renderWeightDashboard() {
  const cur = latest();
  const avgRow = latestAvg();
  const start = DATA.settings.startWeight;
  const weeks = weeklyWeight().filter((r) => r.avg != null);
  const thisWeek = weeks[weeks.length - 1] || null;
  const prevWeek = weeks[weeks.length - 2] || null;

  const streak = loggingStreak();
  document.getElementById('dashSub').textContent = cur
    ? `Last weigh-in ${fmtFull(cur.date)}`
      + (streak > 1 ? ` · ${streak}-day streak` : '')
      + (DATA.settings.medication ? ` · ${DATA.settings.medication}` : '')
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
        ${(() => {
          const p = projection();
          if (!p) {
            return '<p class="proj muted">Not enough of a downward trend yet to project a date.</p>';
          }
          return `<p class="proj">At <strong>${n2(p.perWeek)} lbs a week</strong> you reach ${n1(goal)} lbs around `
               + `<strong>${fmtLong(p.date)}</strong> — about ${Math.round(p.weeks)} weeks out. `
               + '<span class="muted">Based on your last six weekly averages; it moves as they do.</span></p>';
        })()}
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

  // Recap of the last week that actually finished - a part-week always reads
  // as a bad week.
  const rec = lastCompleteWeek();
  const recapEl = document.getElementById('recapCard');
  if (rec && rec.week.avg != null) {
    const w = rec.week, a = rec.act;
    const items = [
      ['Average', `${n2(w.avg)} lbs`,
        w.change != null ? `<span class="delta ${deltaClass(w.change)}">${signed(w.change, 2)}</span>` : ''],
      ['Weigh-ins', `${w.days} of 7`, ''],
      ['Sessions', int(a.sessions), ''],
      ['Miles', n2(a.groundMi), ''],
      ['Lifting', `${int(a.tonnage)} lbs`, ''],
    ];
    recapEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Week ${w.index} recap</span>
          <span class="card-note">${fmtShort(w.start)} – ${fmtShort(w.end)} · last full week</span>
        </div>
        <div class="recap-row">${items.map(([l, v, extra]) => `
          <div class="recap-item">
            <div class="recap-label">${l}</div>
            <div class="recap-value">${v}${extra ? ` ${extra}` : ''}</div>
          </div>`).join('')}</div>
      </div>`;
  } else {
    recapEl.innerHTML = '';
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

  const prs = personalRecords();
  document.getElementById('prCard').innerHTML = prs.length ? `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Personal records</span>
        <span class="card-note">Your best so far</span>
      </div>
      <div class="pr-grid">${prs.map((p) => `
        <div class="pr">
          <div class="pr-label">${esc(p.label)}</div>
          <div class="pr-value">${esc(p.value)}</div>
          <div class="pr-sub">${p.sub ? `${esc(p.sub)} · ` : ''}${fmtShort(p.date)}</div>
        </div>`).join('')}</div>
    </div>` : '';

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

/* ------------------------------------------------------------ plan
   A weekly schedule of lifting templates, a session runner that times the
   workout and ticks off sets, and progression that only advances when you
   actually hit the target. */

function ensurePlan() {
  if (!DATA.plan) DATA.plan = Programme.defaultPlan();
  if (!DATA.settings.equipment) DATA.settings.equipment = { ...Loads.DEFAULT_EQUIPMENT };
  if (!DATA.plan.templates) DATA.plan.templates = Programme.defaultPlan().templates;
  if (!DATA.plan.week) DATA.plan.week = Programme.defaultPlan().week;
}

const templateById = (id) => (DATA.plan.templates || []).find((t) => t.id === id) || null;
const dailyTemplates = () => (DATA.plan.templates || []).filter((t) => t.daily);
const planFor = (dow) => (DATA.plan.week && DATA.plan.week[dow]) || { type: 'rest' };

// Target for one exercise, written the way it is performed.
function exerciseTarget(ex) {
  if (ex.bands) return `${ex.sets} × ${ex.reps} · ${ex.bands.join(' + ')} bands`;
  const unit = ex.perSide ? ' a side' : '';
  const total = ex.perSide ? ` (${(Number(ex.base) || 0) + 2 * ex.weight} total)` : '';
  return `${ex.sets} × ${ex.reps} at ${ex.weight}${unit}${total}`;
}

function exerciseLoading(ex) {
  if (ex.bands) return ex.bands.join(' + ');
  const load = ex.perSide
    ? Loads.perSideLoad(ex.weight, DATA.settings.equipment)
    : Loads.howToLoad(ex.weight, DATA.settings.equipment, ex.base);
  return load ? Loads.describeLoad(load) : 'not loadable with your current plates';
}

/* --- the running session ------------------------------------------------ */
let sessionTick = null;

function startSession(templateId) {
  const tpl = templateById(templateId);
  if (!tpl) return;
  DATA.session = {
    templateId,
    startedAt: new Date().toISOString(),
    done: {},          // exercise index -> array of { reps, weight }
  };
  save(true);
  renderPlan();
}

function cancelSession() {
  delete DATA.session;
  save(true);
  renderPlan();
}

function toggleSet(exIdx, setIdx) {
  const s = DATA.session;
  if (!s) return;
  const tpl = templateById(s.templateId);
  const ex = tpl.exercises[exIdx];
  const list = s.done[exIdx] || [];
  if (list[setIdx]) list[setIdx] = null;
  else list[setIdx] = { reps: ex.reps, weight: ex.weight };
  s.done[exIdx] = list;
  save(true);

  // Update in place. Re-rendering the card would detach every other button
  // mid-tap, so quick successive taps would land on dead elements and be lost.
  const btn = document.querySelector(`[data-set="${exIdx}:${setIdx}"]`);
  if (btn) {
    const isDone = !!list[setIdx];
    btn.classList.toggle('done', isDone);
    btn.textContent = isDone ? '✓' : ex.reps;
  }
  updateSessionProgress();
}

function updateSessionProgress() {
  const s = DATA.session;
  const tpl = s && templateById(s.templateId);
  if (!tpl) return;
  const total = tpl.exercises.reduce((a, e) => a + e.sets, 0);
  const done = Object.values(s.done).flat().filter(Boolean).length;
  const fill = document.querySelector('.session .goal-fill');
  if (fill) fill.style.width = `${total ? (done / total) * 100 : 0}%`;
  const counter = document.getElementById('sessCount');
  if (counter) counter.textContent = `${done} of ${total} sets`;
}

const sessionMinutes = () => {
  const s = DATA.session;
  if (!s) return 0;
  return Math.max(1, Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000));
};

/* Progression only advances an exercise when every target set was completed at
   the target reps. A session where you fell short leaves the numbers alone -
   otherwise the plan runs away from what you can actually lift. */
function finishSession() {
  const s = DATA.session;
  if (!s) return;
  const tpl = templateById(s.templateId);
  if (!tpl) { cancelSession(); return; }

  const exercises = [];
  const advanced = [];

  tpl.exercises.forEach((ex, i) => {
    const done = (s.done[i] || []).filter(Boolean);
    if (!done.length) return;
    exercises.push({
      name: ex.name,
      sets: done.map((d) => ({
        reps: Number(d.reps) || 0,
        // Stored as total load so volume maths stays consistent across the app.
        weight: ex.bands ? 0 : (ex.perSide ? (Number(ex.base) || 0) + 2 * ex.weight : ex.weight),
      })),
    });

    const hitTarget = done.length >= ex.sets && done.every((d) => d.reps >= ex.reps);
    if (!hitTarget) return;
    const step = Loads.suggestProgression(ex, DATA.settings.equipment);
    if (step.kind === 'band') { advanced.push(`${ex.name}: ${step.text}`); return; }
    ex.sets = step.sets;
    ex.reps = step.reps;
    if (step.weight != null && !ex.bands) ex.weight = step.weight;
    advanced.push(`${ex.name} → ${exerciseTarget(ex)}`);
  });

  if (exercises.length) {
    DATA.activities.push({
      id: `s${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
      date: todayISO(),
      type: 'lift',
      minutes: sessionMinutes(),
      distance: 0,
      label: '',
      notes: tpl.name,
      exercises,
    });
  }

  delete DATA.session;
  save(true);
  renderAll();
  toast(advanced.length
    ? `Logged. ${advanced.length} exercise${advanced.length === 1 ? '' : 's'} moved up.`
    : 'Workout logged.');
  if (advanced.length) {
    const box = document.getElementById('planToday');
    if (box) {
      box.insertAdjacentHTML('afterbegin', `
        <div class="card flag-card" style="border-color:var(--border)">
          <strong>Next time</strong>
          <ul>${advanced.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        </div>`);
    }
  }
}

function renderSessionRunner() {
  const s = DATA.session;
  const tpl = templateById(s.templateId);
  const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  const totalSets = tpl.exercises.reduce((a, e) => a + e.sets, 0);
  const doneSets = Object.values(s.done).flat().filter(Boolean).length;

  return `
    <div class="card session">
      <div class="card-head">
        <span class="card-title">${esc(tpl.name)} — in progress</span>
        <span class="session-clock">${mm}:${ss}</span>
      </div>
      <div class="goal-track" style="margin-bottom:16px">
        <div class="goal-fill" style="width:${totalSets ? (doneSets / totalSets) * 100 : 0}%"></div>
      </div>
      ${tpl.exercises.map((ex, i) => {
        const done = s.done[i] || [];
        return `
        <div class="sess-ex">
          <div class="sess-ex-head">
            <strong>${esc(ex.name)}</strong>
            <span class="card-note">${esc(exerciseTarget(ex))}</span>
          </div>
          <div class="hint" style="margin-bottom:7px">${esc(exerciseLoading(ex))}</div>
          <div class="sess-sets">
            ${Array.from({ length: ex.sets }, (_, k) => `
              <button type="button" class="set-btn${done[k] ? ' done' : ''}"
                      data-set="${i}:${k}">${done[k] ? '✓' : ex.reps}</button>`).join('')}
          </div>
        </div>`;
      }).join('')}
      <div class="row" style="margin-top:16px">
        <button class="btn" id="sessFinish">Finish &amp; log</button>
        <button class="btn ghost" id="sessCancel">Cancel</button>
        <span class="spacer"></span>
        <span class="card-note" id="sessCount">${doneSets} of ${totalSets} sets</span>
      </div>
    </div>`;
}

function renderPlan() {
  ensurePlan();
  const todayEl = document.getElementById('planToday');
  if (!todayEl) return;

  clearInterval(sessionTick);
  sessionTick = null;

  if (DATA.runFinish) {
    todayEl.innerHTML = renderRunConfirm();
  } else if (DATA.run) {
    todayEl.innerHTML = renderRunner();
    clearInterval(runTick);
    runTick = setInterval(() => {
      if (!DATA.run) { clearInterval(runTick); runTick = null; return; }
      const pos = runPosition();
      runCues(pos);
      if (!DATA.run || !pos || pos.done) return;
      const card = document.querySelector('.runner');
      if (!card) return;
      card.className = `card runner ${pos.step.type}`;
      card.querySelector('.runner-now').textContent = Running.STEP_LABEL[pos.step.type];
      card.querySelector('.runner-clock').textContent = Running.fmtClock(pos.left);
      // What is coming and how many runs remain change as the session moves,
      // so they have to be refreshed here too, not just on the first render.
      const upcoming = pos.session.steps[pos.index + 1];
      const runsLeft = pos.session.steps.slice(pos.index).filter((x) => x.type === 'run').length;
      card.querySelector('.runner-next').textContent =
        (upcoming ? `Next: ${Running.STEP_LABEL[upcoming.type]} ${Running.fmtClock(upcoming.seconds)}`
                  : 'Last stretch')
        + ` · ${runsLeft} run${runsLeft === 1 ? '' : 's'} left`;
      const pct = pos.total ? Math.min(100, (pos.elapsedTotal / pos.total) * 100) : 0;
      card.querySelector('.goal-fill').style.width = pct + '%';
      const legend = card.querySelectorAll('.goal-legend span');
      legend[0].textContent = Running.fmtClock(pos.elapsedTotal) + ' elapsed';
      legend[1].textContent = Running.fmtClock(pos.total - pos.elapsedTotal) + ' to go';
    }, 250);
  } else if (DATA.session) {
    todayEl.innerHTML = renderSessionRunner();
    // Only the clock needs to tick; re-rendering the whole card would fight
    // with taps on the set buttons.
    sessionTick = setInterval(() => {
      const el = document.querySelector('.session-clock');
      if (!el) { clearInterval(sessionTick); return; }
      const s = Math.floor((Date.now() - new Date(DATA.session.startedAt).getTime()) / 1000);
      el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  } else {
    const dow = new Date().getDay();
    const p = planFor(dow);
    const tpl = p.type === 'lift' ? templateById(p.templateId) : null;
    const label = p.type === 'lift' && tpl ? tpl.name
      : p.type === 'run' ? 'Run day'
      : 'Rest day';
    todayEl.innerHTML = `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Today — ${Programme.DAY_NAMES[dow]}</span>
          <span class="card-note">${esc(label)}</span>
        </div>
        ${tpl ? `
          <div class="hint" style="margin-bottom:12px">${tpl.exercises.length} exercises · `
            + `${tpl.exercises.reduce((a, e) => a + e.sets, 0)} sets</div>
          <button class="btn" data-start="${tpl.id}">Start workout</button>`
        : p.type === 'run' ? '<p class="hint">Scheduled run — your next programme run is below.</p>'
        : '<p class="hint">Nothing scheduled. Rest is part of the plan.</p>'}
        ${dailyTemplates().map((d) => `
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <div class="card-head" style="margin-bottom:8px">
              <span class="card-title">${esc(d.name)}</span>
              <span class="card-note">every day</span>
            </div>
            <button class="btn ghost sm" data-start="${d.id}">Start</button>
          </div>`).join('')}
      </div>`;
  }

  // --- the running programme
  let progHost = document.getElementById('planRun');
  if (!progHost) {
    progHost = document.createElement('div');
    progHost.id = 'planRun';
    document.getElementById('planWeek').before(progHost);
  }
  if (DATA.run || DATA.runFinish) progHost.innerHTML = '';
  else renderRunProgramme(progHost);

  // --- the week
  document.getElementById('planWeek').innerHTML = `
    <div class="card">
      <div class="card-head"><span class="card-title">Your week</span></div>
      <div class="week-grid">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const p = planFor(d);
          const tpl = p.type === 'lift' ? templateById(p.templateId) : null;
          const isToday = d === new Date().getDay();
          return `
            <div class="week-day${isToday ? ' today' : ''}">
              <div class="week-name">${Programme.DAY_NAMES[d].slice(0, 3)}</div>
              <div class="week-what ${p.type}">${p.type === 'lift' && tpl ? esc(tpl.name)
                : p.type === 'run' ? 'Run' : 'Rest'}</div>
            </div>`;
        }).join('')}
      </div>
    </div>`;

  // --- templates: start any of them, and correct the numbers in place
  document.getElementById('planTemplates').innerHTML = (DATA.plan.templates || []).map((tpl) => `
    <div class="card">
      <div class="card-head">
        <span class="card-title">${esc(tpl.name)}</span>
        <span class="row">
          <span class="card-note">${tpl.daily ? 'every day' : 'weekly'}</span>
          <button class="btn ghost sm" data-start="${tpl.id}">Start</button>
        </span>
      </div>
      <div class="table-scroll"><table><thead><tr>
        <th class="l">Exercise</th><th>Sets</th><th>Reps</th>
        <th>${tpl.bandWork ? 'Bands' : 'Per side'}</th>
        <th class="l">How to load it</th><th class="l">Next step</th>
      </tr></thead><tbody>
        ${tpl.exercises.map((ex, i) => {
          const step = Loads.suggestProgression(ex, DATA.settings.equipment);
          const num = (field, value, step2) =>
            `<input type="number" class="mini" min="0" step="${step2}" value="${value}"
                    data-edit="${tpl.id}:${i}:${field}" />`;
          return `<tr>
            <td class="l strong">${esc(ex.name)}</td>
            <td>${num('sets', ex.sets, 1)}</td>
            <td>${num('reps', ex.reps, 1)}</td>
            <td>${ex.bands ? `<span class="muted">${esc(ex.bands.join(' + '))}</span>`
                            : num('weight', ex.weight, 5)}</td>
            <td class="l muted">${esc(exerciseLoading(ex))}</td>
            <td class="l">${esc(step.text)}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>
      ${tpl.bandWork ? '' : `<p class="hint" style="margin-top:10px">Weights are per side —
        both arms loaded the same. Totals are double.</p>`}
    </div>`).join('');
}

/* ------------------------------------------------------------ run programme
   Couch to 5K through to 10K, with the interval cues spoken and beeped so the
   phone can stay in a pocket. Timing is read off the wall clock rather than
   counted down, because a backgrounded tab gets throttled and a drifting
   timer would quietly ruin the session. */

let runTick = null;
let audioCtx = null;
let wakeLock = null;
let lastCue = { step: -1, count: -1 };

// Every cue can be turned off independently: some people want the voice, some
// only the beeps, some just the countdown into a change.
const CUE_DEFAULTS = { cueVoice: true, cueBeep: true, cueCount: true, cueRemaining: true };
const cueOn = (k) => (DATA.settings[k] === undefined ? CUE_DEFAULTS[k] : !!DATA.settings[k]);

function ensureRunState() {
  if (!DATA.running) DATA.running = { completed: [] };
  if (!Array.isArray(DATA.running.completed)) DATA.running.completed = [];
}

// `force` is for the countdown ticks, which have their own setting and so must
// not be gated behind the transition-beep one.
function beep(freq, ms, delay, force) {
  if (!audioCtx || (!force && !cueOn('cueBeep'))) return;
  try {
    const t = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    // A short ramp instead of a hard stop; square edges click unpleasantly.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.05);
  } catch (_) { /* audio is a nicety, never a blocker */ }
}

/* Voice selection.

   The Web Speech API exposes no gender field, so the only signal is the voice
   name. Android's Google TTS marks them plainly - "en-us-x-sfg#female_1-local"
   - while desktop platforms use first names. Both are matched below.

   Quality varies enormously: a "Natural"/"Neural" voice is worlds better than
   the old compact ones. Local voices are still preferred over network ones,
   because a cue that needs a round trip is no use mid-run with no signal. */
const FEMALE_VOICE = /(#female|\bfemale\b|zira|aria|jenny|michelle|hazel|susan|linda|catherine|samantha|karen|moira|tessa|fiona|victoria|allison|\bava\b|zoe|emma|amber|sonia|libby|natasha|clara|joanna|salli|kendra|kimberly|\bivy\b|nicole|olivia|serena|heera|raveena|\beva\b)/i;
const MALE_VOICE = /(#male|\bmale\b|david|mark|george|james|ryan|\bguy\b|daniel|\balex\b|fred|\btom\b|oliver|william|brian|matthew|justin|joey|rishi|arthur)/i;

function scoreVoice(v) {
  const n = `${v.name || ''} ${v.voiceURI || ''}`;
  if (!/^en/i.test(v.lang || '')) return -1;          // English cues only
  let s = 0;
  if (FEMALE_VOICE.test(n)) s += 120;
  else if (MALE_VOICE.test(n)) s -= 120;
  if (/natural|neural/i.test(n)) s += 60;
  if (/google/i.test(n)) s += 35;
  if (/desktop|espeak|compact|-eloquence/i.test(n)) s -= 45;
  if (v.localService) s += 25;                        // works with no signal
  if (/^en[-_]us/i.test(v.lang)) s += 10;
  return s;
}

const voiceList = () => {
  try { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  catch (_) { return []; }
};

function pickVoice() {
  const voices = voiceList();
  if (!voices.length) return null;
  const chosen = DATA && DATA.settings.voiceURI;
  if (chosen) {
    const exact = voices.find((v) => v.voiceURI === chosen);
    if (exact) return exact;
  }
  return voices
    .map((v) => ({ v, s: scoreVoice(v) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)[0]?.v || voices[0];
}

function say(text) {
  try {
    if (!window.speechSynthesis || !cueOn('cueVoice')) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    // Assigning a voice can throw if the engine hands back something odd.
    // Losing the preferred voice is a nuisance; losing the cue entirely, mid
    // interval, is not acceptable - so this fails on its own.
    try {
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
    } catch (_) { /* fall back to the system default voice */ }
    u.rate = Number(DATA && DATA.settings.voiceRate) || 1;
    u.pitch = Number(DATA && DATA.settings.voicePitch) || 1;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch (_) { /* voice is optional */ }
}

// getVoices() is empty until the engine has loaded them, which on Android is
// after first paint, so the picker has to be rebuilt when they arrive.
function renderVoicePicker() {
  const sel = document.getElementById('voiceSel');
  if (!sel) return;
  const voices = voiceList().filter((v) => /^en/i.test(v.lang || ''));
  const best = pickVoice();
  if (!voices.length) {
    sel.innerHTML = '<option value="">No voices installed</option>';
    return;
  }
  sel.innerHTML = voices
    .map((v) => ({ v, s: scoreVoice(v) }))
    .sort((a, b) => b.s - a.s)
    .map(({ v }) => `<option value="${esc(v.voiceURI)}"${best && v.voiceURI === best.voiceURI ? ' selected' : ''}>`
      + `${esc(v.name)}${v.localService ? '' : ' · needs data'}</option>`)
    .join('');
  const rate = document.getElementById('voiceRate');
  if (rate) rate.value = Number(DATA.settings.voiceRate) || 1;
  const pitch = document.getElementById('voicePitch');
  if (pitch) pitch.value = Number(DATA.settings.voicePitch) || 1;
  ['cueVoice', 'cueBeep', 'cueCount', 'cueRemaining'].forEach((id) => {
    const box = document.getElementById(id);
    if (box) box.checked = cueOn(id);
  });
}

async function keepAwake(on) {
  try {
    if (on) {
      if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) { /* not supported everywhere */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && DATA && DATA.run) keepAwake(true);
});

const runSessionByKey = (k) => Running.allSessions().find((s) => s.key === k) || null;

function startRun(key) {
  ensureRunState();
  const s = runSessionByKey(key);
  if (!s) return;
  // Created inside the tap that starts the run, which is what unlocks audio.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { audioCtx = null; }

  DATA.run = { key, startedAt: new Date().toISOString(), pausedAt: null, pausedMs: 0 };
  lastCue = { step: -1, count: -1 };
  save(true);
  keepAwake(true);
  say(`Starting week ${s.week}, run ${s.day}. Warm up walk for five minutes.`);
  renderPlan();
}

function runElapsed() {
  const r = DATA.run;
  if (!r) return 0;
  const paused = r.pausedMs + (r.pausedAt ? Date.now() - new Date(r.pausedAt).getTime() : 0);
  return Math.max(0, (Date.now() - new Date(r.startedAt).getTime() - paused) / 1000);
}

// Which step we are in, and how far through it.
function runPosition() {
  const s = runSessionByKey(DATA.run.key);
  if (!s) return null;
  let elapsed = runElapsed();
  const total = Running.totalSeconds(s);
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    if (elapsed < step.seconds) {
      return { session: s, index: i, step, into: elapsed, left: step.seconds - elapsed, total,
        done: false, elapsedTotal: runElapsed() };
    }
    elapsed -= step.seconds;
  }
  return { session: s, index: s.steps.length, step: null, into: 0, left: 0, total,
    done: true, elapsedTotal: runElapsed() };
}

function togglePauseRun() {
  const r = DATA.run;
  if (!r) return;
  if (r.pausedAt) {
    r.pausedMs += Date.now() - new Date(r.pausedAt).getTime();
    r.pausedAt = null;
    say('Resuming');
    keepAwake(true);
  } else {
    r.pausedAt = new Date().toISOString();
    say('Paused');
    keepAwake(false);
  }
  save(true);
  renderPlan();
}

// A session is part running and part walking, and they happen at different
// speeds, so logging one blended activity would misreport both. Split the
// time and let the speeds be filled in before anything is written.
function sessionSplit(s) {
  let runSec = 0, walkSec = 0;
  s.steps.forEach((x) => { if (x.type === 'run') runSec += x.seconds; else walkSec += x.seconds; });
  return { runSec, walkSec };
}

function openRunConfirm(key, date) {
  const s = runSessionByKey(key);
  if (!s) return;
  const { runSec, walkSec } = sessionSplit(s);
  DATA.runFinish = {
    key,
    date: date || todayISO(),
    runMin: +(runSec / 60).toFixed(1),
    walkMin: +(walkSec / 60).toFixed(1),
    // Whatever you entered last time is nearly always right again.
    runSpeed: DATA.settings.lastRunSpeed ?? null,
    walkSpeed: DATA.settings.lastWalkSpeed ?? null,
  };
  save(true);
  renderPlan();
}

function stopRun(logIt) {
  const r = DATA.run;
  if (!r) return;
  const key = r.key;
  const finished = logIt === true;
  delete DATA.run;
  clearInterval(runTick);
  runTick = null;
  keepAwake(false);
  save(true);

  if (finished) {
    say('Workout complete. Well done.');
    beep(880, 160); beep(1175, 200, 0.2); beep(1568, 320, 0.42);
    openRunConfirm(key);
  } else {
    renderAll();
  }
}

function confirmRunSplit() {
  const f = DATA.runFinish;
  if (!f) return;
  const s = runSessionByKey(f.key);
  const mk = (type, minutes, speed) => {
    if (!minutes) return null;
    const mph = Number(speed) || 0;
    return {
      id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      date: f.date,
      type,
      minutes,
      distance: mph > 0 ? +((mph * minutes) / 60).toFixed(2) : 0,
      label: '',
      notes: s ? `Week ${s.week} run ${s.day} — ${s.label}` : '',
      exercises: [],
    };
  };
  [mk('run', f.runMin, f.runSpeed), mk('walk', f.walkMin, f.walkSpeed)]
    .filter(Boolean)
    .forEach((a) => DATA.activities.push(a));

  ensureRunState();
  if (!DATA.running.completed.includes(f.key)) DATA.running.completed.push(f.key);
  if (Number(f.runSpeed) > 0) DATA.settings.lastRunSpeed = Number(f.runSpeed);
  if (Number(f.walkSpeed) > 0) DATA.settings.lastWalkSpeed = Number(f.walkSpeed);

  delete DATA.runFinish;
  save(true);
  renderAll();
  toast('Logged as a run and a walk.');
}

function renderRunConfirm() {
  const f = DATA.runFinish;
  const s = runSessionByKey(f.key);
  const dist = (min, mph) => (Number(mph) > 0 ? `${((Number(mph) * min) / 60).toFixed(2)} mi` : '—');

  const row = (type, label, min, speed, colour) => `
    <div class="split-row">
      <span class="dist-dot" style="background:var(${colour})"></span>
      <div class="split-what">
        <div class="split-name">${label}</div>
        <div class="tile-sub">${min} min</div>
      </div>
      <label class="field">Speed (mph)
        <input type="number" step="0.1" min="0" value="${speed ?? ''}"
               data-split="${type}Speed" placeholder="${type === 'run' ? '5.0' : '3.0'}" /></label>
      <div class="split-dist">${dist(min, speed)}</div>
    </div>`;

  return `
    <div class="card" style="border-color:var(--accent)">
      <div class="card-head">
        <span class="card-title">Nice work — week ${s.week} run ${s.day}</span>
        <span class="card-note">${esc(s.label)}</span>
      </div>
      <p class="hint" style="margin-bottom:14px">Logged as two workouts, since you ran and walked at
        different speeds. Put in each speed and the distance works itself out.</p>
      ${row('run', 'Running', f.runMin, f.runSpeed, '--series-1')}
      ${row('walk', 'Walking', f.walkMin, f.walkSpeed, '--series-2')}
      <div class="row" style="margin-top:16px">
        <button class="btn" id="splitSave">Save both</button>
        <button class="btn ghost" id="splitSkip">Mark done without logging</button>
        <span class="spacer"></span>
        <button class="btn danger" id="splitCancel">Cancel</button>
      </div>
    </div>`;
}

// Fires the beeps and speech for whatever just changed.
function runCues(pos) {
  if (!pos || DATA.run.pausedAt) return;

  if (pos.done) {
    if (lastCue.step !== 999) { lastCue.step = 999; stopRun(true); }
    return;
  }

  if (pos.index !== lastCue.step) {
    lastCue = { step: pos.index, count: -1 };
    const s = pos.session;
    const label = Running.STEP_LABEL[pos.step.type];
    const runsLeft = s.steps.slice(pos.index).filter((x) => x.type === 'run').length;

    if (pos.step.type === 'run') {
      beep(988, 130); beep(1319, 200, 0.16);
      const mins = pos.step.seconds >= 60
        ? `${Math.round(pos.step.seconds / 60)} minute${pos.step.seconds >= 120 ? 's' : ''}`
        : `${pos.step.seconds} seconds`;
      const tail = !cueOn('cueRemaining') ? ''
        : runsLeft === 1 ? ' Last one.' : ` ${runsLeft - 1} more after this.`;
      say(`Run for ${mins}.${tail}`);
    } else if (pos.step.type === 'walk') {
      beep(587, 220);
      const mins = pos.step.seconds >= 60
        ? `${Math.round(pos.step.seconds / 60)} minute${pos.step.seconds >= 120 ? 's' : ''}`
        : `${pos.step.seconds} seconds`;
      const left = cueOn('cueRemaining')
        ? ` ${runsLeft} run${runsLeft === 1 ? '' : 's'} to go.` : '';
      say(`Walk for ${mins}.${left}`);
    } else if (pos.step.type === 'cooldown') {
      beep(587, 220); beep(440, 300, 0.24);
      say('Cool down. Walk it out for five minutes.');
    }
    return;
  }

  // Three, two, one into the next interval.
  const secsLeft = Math.ceil(pos.left);
  if (cueOn('cueCount') && secsLeft <= 3 && secsLeft > 0 && secsLeft !== lastCue.count) {
    lastCue.count = secsLeft;
    beep(660, 90, 0, true);
  }

  // Halfway through anything long enough for it to mean something.
  if (pos.step.seconds >= 480 && !lastCue.half
      && pos.into >= pos.step.seconds / 2 && pos.into < pos.step.seconds / 2 + 1) {
    lastCue.half = true;
    say('Halfway.');
  }
}

function renderRunner() {
  const pos = runPosition();
  if (!pos) return '';
  const s = pos.session;
  const paused = !!DATA.run.pausedAt;
  const pct = pos.total ? Math.min(100, (pos.elapsedTotal / pos.total) * 100) : 0;
  const step = pos.step || { type: 'cooldown', seconds: 0 };
  const runsLeft = s.steps.slice(pos.index).filter((x) => x.type === 'run').length;
  const upcoming = s.steps[pos.index + 1];

  return `
    <div class="card runner ${step.type}">
      <div class="card-head">
        <span class="card-title">Week ${s.week} · run ${s.day}</span>
        <span class="card-note">${esc(s.label)}</span>
      </div>

      <div class="runner-now">${Running.STEP_LABEL[step.type]}</div>
      <div class="runner-clock">${Running.fmtClock(pos.left)}</div>
      <div class="runner-next">
        ${upcoming ? `Next: ${Running.STEP_LABEL[upcoming.type]} ${Running.fmtClock(upcoming.seconds)}`
                   : 'Last stretch'}
        · ${runsLeft} run${runsLeft === 1 ? '' : 's'} left
      </div>

      <div class="goal-track" style="margin:16px 0 8px">
        <div class="goal-fill" style="width:${pct}%"></div>
      </div>
      <div class="goal-legend">
        <span>${Running.fmtClock(pos.elapsedTotal)} elapsed</span>
        <span>${Running.fmtClock(pos.total - pos.elapsedTotal)} to go</span>
      </div>

      <div class="row" style="margin-top:16px">
        <button class="btn" id="runPause">${paused ? 'Resume' : 'Pause'}</button>
        <button class="btn ghost" id="runFinish">Finish &amp; log</button>
        <span class="spacer"></span>
        <button class="btn danger" id="runAbandon">Discard</button>
      </div>
      ${paused ? '<p class="hint" style="margin-top:10px">Paused — the clock is stopped.</p>' : ''}
    </div>`;
}

function renderRunProgramme(host) {
  ensureRunState();
  const done = DATA.running.completed;
  const next = Running.nextSession(done);
  const all = Running.allSessions();
  const pct = (done.length / all.length) * 100;

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Couch to 10K</span>
        <span class="card-note">${done.length} of ${all.length} runs done</span>
      </div>
      <div class="goal-track"><div class="goal-fill" style="width:${pct}%"></div></div>
      <div class="goal-legend" style="margin-bottom:14px">
        <span>Week 1</span><span>5K at week 9</span><span>10K at week 15</span>
      </div>
      ${next ? `
        <div class="next-run">
          <div>
            <div class="tile-label">Next up</div>
            <div class="next-run-title">Week ${next.week} · run ${next.day}</div>
            <div class="tile-sub">${esc(next.label)} · ${Running.fmtMins(Running.totalSeconds(next))}
              · ${esc(next.note)}</div>
          </div>
          <span class="row">
            <button class="btn" data-run="${next.key}">Start run</button>
            <button class="btn ghost" data-mark="${next.key}">Mark done</button>
          </span>
        </div>`
        : '<p class="hint">Programme complete — that is a 10K. Pick any week to run again below.</p>'}
      <details style="margin-top:14px"${done.length ? '' : ' open'}>
        <summary class="card-note" style="cursor:pointer">All 45 runs — tap to tick off</summary>
        <p class="hint" style="margin:8px 0 0">Ticking a run off here records no workout, for
          sessions you already logged yourself. Whatever is left becomes your next run.</p>
        <div class="run-grid">
          ${all.map((r) => `
            <button type="button" class="run-chip${done.includes(r.key) ? ' done' : ''}${next && r.key === next.key ? ' next' : ''}"
                    data-toggle="${r.key}"
                    title="Week ${r.week} run ${r.day} — ${esc(r.label)}">${r.week}.${r.day}</button>`).join('')}
        </div>
      </details>
    </div>`;
}

/* ------------------------------------------------------------ food
   Deliberately not a calorie tracker: free text, one line per thing eaten,
   stored on the day alongside the weigh-in. */
function foodOf(date) {
  const day = DATA.days[date];
  return day && Array.isArray(day.food) ? day.food : [];
}

function addFood(date, text) {
  const t = String(text || '').trim();
  if (!date || !t) return false;
  const day = DATA.days[date] || {};
  if (!Array.isArray(day.food)) day.food = [];
  day.food.push({ id: `f${Date.now()}${Math.random().toString(36).slice(2, 5)}`, text: t });
  DATA.days[date] = day;
  save(true);
  return true;
}

function removeFood(date, id) {
  const day = DATA.days[date];
  if (!day || !Array.isArray(day.food)) return;
  day.food = day.food.filter((f) => f.id !== id);
  if (!day.food.length) delete day.food;
  // Drop the day entirely if nothing is left on it.
  if (day.weight == null && day.steps == null && !day.notes && !day.food) delete DATA.days[date];
  save(true);
}

function foodEntryList(date, entries) {
  return `<ul class="food-list">${entries.map((f) => `
    <li><span>${esc(f.text)}</span>
      <button type="button" class="btn icon" data-food-del="${f.id}" data-food-date="${date}" title="Remove">×</button>
    </li>`).join('')}</ul>`;
}

function renderFoodToday() {
  const d = todayISO();
  const entries = foodOf(d);
  document.getElementById('foodToday').innerHTML = entries.length
    ? foodEntryList(d, entries)
    : '<p class="hint">Nothing logged today yet.</p>';
}

function renderFood() {
  const q = (document.getElementById('fSearch').value || '').trim().toLowerCase();
  const days = Object.keys(DATA.days)
    .filter((d) => foodOf(d).length)
    .sort()
    .reverse();

  const rows = days.map((d) => {
    const entries = q ? foodOf(d).filter((f) => f.text.toLowerCase().includes(q)) : foodOf(d);
    return entries.length ? { date: d, entries } : null;
  }).filter(Boolean);

  const el = document.getElementById('foodList');
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${q ? 'Nothing matches that.' : 'No entries yet. Add one above.'}</div>`;
    return;
  }
  el.innerHTML = `<div class="food-days">${rows.map((r) => `
    <div class="food-day">
      <div class="food-date">${fmtFull(r.date)}${r.date === todayISO() ? ' · today' : ''}</div>
      ${foodEntryList(r.date, r.entries)}
    </div>`).join('')}</div>`;
}

function foodCsv() {
  const rows = [['Date', 'Day', 'Entry']];
  Object.keys(DATA.days).sort().forEach((d) => {
    foodOf(d).forEach((f) => rows.push([d, DOW[parseISO(d).getDay()], f.text]));
  });
  return toCsv(rows);
}

/* ------------------------------------------------------------ oura
   Ring-sourced data. Every imported workout keeps its Oura id, so re-syncing
   an overlapping range updates rather than duplicates. Anything you typed by
   hand is never overwritten - your treadmill distances are better than the
   ring's guess, and the ring has none for indoor work anyway. */
function mergeOura(payload) {
  let addedSteps = 0, addedWorkouts = 0, updatedWorkouts = 0;

  (payload.steps || []).forEach(({ date, steps }) => {
    if (!date || !steps) return;
    const day = DATA.days[date] || {};
    if (day.steps === steps) return;
    day.steps = steps;
    DATA.days[date] = day;
    addedSteps++;
  });

  const bySource = new Map();
  DATA.activities.forEach((a) => { if (a.sourceId) bySource.set(a.sourceId, a); });

  (payload.workouts || []).forEach((w) => {
    const existing = bySource.get(w.sourceId);
    if (existing) {
      // Refresh only what the ring owns; leave hand-entered distance alone.
      let touched = false;
      if (existing.minutes !== w.minutes) { existing.minutes = w.minutes; touched = true; }
      if (!existing.distance && w.distance) { existing.distance = w.distance; touched = true; }
      if (existing.date !== w.date) { existing.date = w.date; touched = true; }
      if (touched) updatedWorkouts++;
      return;
    }
    DATA.activities.push({
      id: `o${w.sourceId}`,
      source: 'oura',
      sourceId: w.sourceId,
      date: w.date,
      type: w.type,
      minutes: w.minutes,
      distance: w.distance,
      label: w.label,
      notes: w.intensity ? `Oura · ${w.intensity} intensity` : 'From Oura',
      exercises: [],
    });
    addedWorkouts++;
  });

  if (addedSteps || addedWorkouts || updatedWorkouts) save(true);
  return { addedSteps, addedWorkouts, updatedWorkouts };
}

async function syncOura(days) {
  const end = todayISO();
  const start = iso(addDays(new Date(), -(days || 30)));
  const btn = document.getElementById('ouraSync');
  const status = document.getElementById('ouraStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  if (status) status.textContent = `Fetching ${fmtShort(start)} – ${fmtShort(end)}…`;
  try {
    const res = await window.api.oura.sync({ startDate: start, endDate: end });
    if (!res.ok) {
      if (status) status.textContent = res.error;
      toast(res.error);
      return;
    }
    const merged = mergeOura(res);
    DATA.settings.ouraLastSync = new Date().toISOString();
    save(true);
    renderAll();
    const bits = [];
    if (merged.addedWorkouts) bits.push(`${merged.addedWorkouts} new workout${merged.addedWorkouts === 1 ? '' : 's'}`);
    if (merged.updatedWorkouts) bits.push(`${merged.updatedWorkouts} updated`);
    if (merged.addedSteps) bits.push(`step counts for ${merged.addedSteps} day${merged.addedSteps === 1 ? '' : 's'}`);
    const summary = bits.length ? `Imported ${bits.join(', ')}.` : 'Already up to date — nothing new.';
    if (status) status.textContent = summary;
    toast(summary);
  } catch (err) {
    if (status) status.textContent = String(err.message || err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync now'; }
  }
}

async function refreshOuraState() {
  const card = document.getElementById('ouraCard');
  if (!card) return;
  // Oura retired personal access tokens; until OAuth2 is built there is
  // nothing here that works, so the card stays hidden rather than asking
  // for a credential that can no longer be created.
  card.hidden = true;
  if (true) return;
  if (!window.api.oura) {                    // the PWA build has no Oura bridge
    card.hidden = true;
    return;
  }
  let has = false;
  try {
    has = await window.api.oura.hasToken();
  } catch (_) {
    // The bridge is present but the handler is not (a test harness, or an
    // older desktop build). Hide the card rather than reject unhandled.
    card.hidden = true;
    return;
  }
  document.getElementById('ouraSync').disabled = !has;
  document.getElementById('ouraToken').placeholder = has
    ? 'Token saved — paste a new one to replace it'
    : 'Paste your Oura personal access token';
  const last = DATA.settings.ouraLastSync;
  document.getElementById('ouraStatus').textContent = has
    ? (last ? `Last synced ${fmtFull(last.slice(0, 10))}.` : 'Connected. Run a sync to pull your data in.')
    : 'Not connected yet.';
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
  renderPlan();
  renderFood();
  renderFoodToday();
  renderHistory();
  renderRecent();
  refreshExerciseNames();
}

// Chart.js measures the container at resize() time, so a hidden view reports
// zero and a just-shown one has not been laid out yet. Deferring a frame gives
// it real numbers to work from.
function resizeCharts() {
  requestAnimationFrame(() => {
    Object.values(charts).forEach((c) => { try { c.resize(); } catch (_) { /* mid-teardown */ } });
  });
}

// Sub-tabs let two related views share one nav slot, which matters most on a
// phone where seven bottom-bar items were unreadably small.
function showSubtab(group, tab) {
  document.querySelectorAll(`.subtabs[data-tabgroup="${group}"] button`).forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  document.querySelectorAll(`.subview[data-tabgroup="${group}"]`).forEach((v) => {
    v.hidden = v.dataset.tab !== tab;
  });
  resizeCharts();
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  resizeCharts();
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

  // --- training plan / session runner
  document.body.addEventListener('click', (e) => {
    const start = e.target.closest('[data-start]');
    if (start) { startSession(start.dataset.start); return; }
    const set = e.target.closest('[data-set]');
    if (set) {
      const [i, k] = set.dataset.set.split(':').map(Number);
      toggleSet(i, k);
      return;
    }
    const runStart = e.target.closest('[data-run]');
    if (runStart) { startRun(runStart.dataset.run); return; }
    // Ticking a run off the grid records nothing - it is for sessions already
    // logged by hand. Next-up is derived from completion, so this is also how
    // you jump around the programme.
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      ensureRunState();
      const k = toggle.dataset.toggle;
      const at = DATA.running.completed.indexOf(k);
      if (at >= 0) DATA.running.completed.splice(at, 1);
      else DATA.running.completed.push(k);
      save(true);
      renderPlan();
      return;
    }
    const mark = e.target.closest('[data-mark]');
    if (mark) { openRunConfirm(mark.dataset.mark); return; }
    if (e.target.closest('#splitSave')) { confirmRunSplit(); return; }
    if (e.target.closest('#splitSkip')) {
      ensureRunState();
      if (!DATA.running.completed.includes(DATA.runFinish.key)) {
        DATA.running.completed.push(DATA.runFinish.key);
      }
      delete DATA.runFinish;
      save(true);
      renderAll();
      toast('Marked done.');
      return;
    }
    if (e.target.closest('#splitCancel')) {
      delete DATA.runFinish;
      save(true);
      renderAll();
      return;
    }
    if (e.target.closest('#runPause')) { togglePauseRun(); return; }
    if (e.target.closest('#runFinish')) { stopRun(true); return; }
    if (e.target.closest('#runAbandon')) { stopRun(false); return; }
    if (e.target.closest('#sessFinish')) { finishSession(); return; }
    if (e.target.closest('#sessCancel')) { cancelSession(); }
  });

  // Correcting a target in place: the numbers I seeded are a starting guess,
  // and the loading hint and next step have to follow whatever you change.
  document.body.addEventListener('input', (e) => {
    const sp = e.target.closest('[data-split]');
    if (!sp || !DATA.runFinish) return;
    const v = Number(sp.value);
    DATA.runFinish[sp.dataset.split] = Number.isFinite(v) && v > 0 ? v : null;
    // Update the distance beside it in place, so the field keeps focus.
    const row = sp.closest('.split-row');
    const mins = DATA.runFinish[sp.dataset.split === 'runSpeed' ? 'runMin' : 'walkMin'];
    row.querySelector('.split-dist').textContent =
      v > 0 ? `${((v * mins) / 60).toFixed(2)} mi` : '—';
  });

  document.body.addEventListener('change', (e) => {
    const el = e.target.closest('[data-edit]');
    if (!el) return;
    const [tplId, idx, field] = el.dataset.edit.split(':');
    const tpl = templateById(tplId);
    if (!tpl) return;
    const ex = tpl.exercises[Number(idx)];
    if (!ex) return;
    const v = Number(el.value);
    if (!Number.isFinite(v) || v < 0) return;
    ex[field] = v;
    save(true);
    renderPlan();
  });

  document.getElementById('dashFocus').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-focus]');
    if (!btn) return;
    dashFocus = btn.dataset.focus;
    document.querySelectorAll('#dashFocus button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.focus === dashFocus)));
    renderDashboard();
    resizeCharts();
  });

  document.querySelectorAll('.subtabs').forEach((bar) =>
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (btn) showSubtab(bar.dataset.tabgroup, btn.dataset.tab);
    }));

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

  // --- Food journal
  const fDate = document.getElementById('fDate');
  const fText = document.getElementById('fText');
  const submitFood = (dateEl, textEl) => {
    const date = dateEl ? (dateEl.value || todayISO()) : todayISO();
    if (!addFood(date, textEl.value)) { toast('Type something first'); return; }
    textEl.value = '';
    textEl.focus();
    renderAll();
  };
  document.getElementById('fAdd').addEventListener('click', () => submitFood(fDate, fText));
  fText.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitFood(fDate, fText); });

  const fQuick = document.getElementById('fQuick');
  const quickAdd = () => submitFood(null, fQuick);
  document.getElementById('fQuickAdd').addEventListener('click', quickAdd);
  fQuick.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });

  document.getElementById('fSearch').addEventListener('input', renderFood);
  document.getElementById('exportFood').addEventListener('click', () =>
    exportCsv('trendline-food.csv', foodCsv()));

  document.body.addEventListener('click', (e) => {
    const del = e.target.closest('[data-food-del]');
    if (!del) return;
    removeFood(del.dataset.foodDate, del.dataset.foodDel);
    renderAll();
  });

  // No filesystem on the web build - the same button hands over the JSON.
  if (window.api.platform === 'web') {
    document.getElementById('revealData').hidden = true;
  }
  // --- Oura (desktop only; the PWA has no bridge because of CORS)
  if (window.api.oura) {
    document.getElementById('ouraSave').addEventListener('click', async () => {
      const el = document.getElementById('ouraToken');
      const token = el.value.trim();
      if (!token) { toast('Paste a token first'); return; }
      await window.api.oura.setToken(token);
      el.value = '';
      await refreshOuraState();
      toast('Oura token saved');
    });
    document.getElementById('ouraSync').addEventListener('click', () => syncOura(30));
  } else {
    document.getElementById('ouraCard').hidden = true;
  }

  // --- coaching voice
  const voiceSel = document.getElementById('voiceSel');
  voiceSel.addEventListener('change', () => {
    DATA.settings.voiceURI = voiceSel.value || null;
    save(true);
    say('This is how your run cues will sound.');
  });
  document.getElementById('voiceRate').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    DATA.settings.voiceRate = Number.isFinite(v) && v > 0 ? v : 1;
    save(true);
    say('Run for 90 seconds. Three more after this.');
  });
  document.getElementById('voicePitch').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    DATA.settings.voicePitch = Number.isFinite(v) && v > 0 ? v : 1;
    save(true);
    say('Run for 90 seconds. Three more after this.');
  });
  document.getElementById('voiceTest').addEventListener('click', () => {
    beep(988, 130); beep(1319, 200, 0.16);
    say('Run for 90 seconds. Three more after this. Last one coming up.');
  });

  ['cueVoice', 'cueBeep', 'cueCount', 'cueRemaining'].forEach((id) => {
    const box = document.getElementById(id);
    box.addEventListener('change', () => {
      DATA.settings[id] = box.checked;
      save(true);
      if (id === 'cueVoice' && box.checked) say('Voice cues on.');
      if (id === 'cueBeep' && box.checked) { beep(988, 130); beep(1319, 200, 0.16); }
    });
  });

  renderVoicePicker();
  if (window.speechSynthesis) {
    // Android populates the voice list after first paint.
    window.speechSynthesis.onvoiceschanged = renderVoicePicker;
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
  document.getElementById('exportAll').addEventListener('click', () =>
    exportCsv('trendline-export.csv', `${daysCsv()}\r\n\r\n${activitiesCsv()}`));

  window.addEventListener('resize', resizeCharts);

  // Unfolding a foldable resizes the content area without necessarily firing a
  // window resize the page can rely on, so watch the container itself.
  if (window.ResizeObserver) {
    let lastWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w && w !== lastWidth) { lastWidth = w; resizeCharts(); }
    });
    ro.observe(document.querySelector('.main'));
  }
}

/* ------------------------------------------------------------ init */
(async function init() {
  DATA = await window.api.load();
  ensurePlan();
  ensureRunState();
  applyTheme();
  window.api.backup(DATA);

  const t = todayISO();
  document.getElementById('wDate').value = t;
  document.getElementById('fDate').value = t;
  document.getElementById('aDate').value = t;

  wire();
  setType('run');
  refreshOuraState();
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
