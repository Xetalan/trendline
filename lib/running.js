/* Couch to 5K, then on to 10K. 15 weeks, three sessions a week.

   Weeks 1-9 are the NHS Couch to 5K plan, which finishes at 30 minutes of
   continuous running (about 5K). Weeks 10-15 are a bridge to 10K, built on
   run/walk blocks that lengthen until the last week runs an hour.

   Every interval is in seconds so the runner never has to interpret anything
   mid-session. Warm-up and cool-down walks are 5 minutes throughout; the
   bridge plan does not specify them, but starting cold on a 30-minute run
   after nine weeks of warming up would be an odd thing to change.

   Sources:
     nhs.uk/better-health/get-active/get-running-with-couch-to-5k
     runaerix.com/plans/10k  */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Running = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WARM = 300;   // 5 minute warm-up walk
  const COOL = 300;   // 5 minute cool-down walk

  const run = (s) => ({ type: 'run', seconds: s });
  const walk = (s) => ({ type: 'walk', seconds: s });

  // Alternating run/walk, ending on a run: (run, walk) x n, then a final run.
  function alternate(runSec, walkSec, runCount) {
    const out = [];
    for (let i = 0; i < runCount; i++) {
      out.push(run(runSec));
      if (i < runCount - 1) out.push(walk(walkSec));
    }
    return out;
  }

  // (run, walk) x reps, with the trailing walk kept - the bridge plan's blocks
  // are written that way and the last walk runs into the cool-down.
  function blocks(runSec, walkSec, reps) {
    const out = [];
    for (let i = 0; i < reps; i++) {
      out.push(run(runSec));
      if (i < reps - 1) out.push(walk(walkSec));
    }
    return out;
  }

  const session = (label, middle) => ({
    label,
    steps: [{ type: 'warmup', seconds: WARM }, ...middle, { type: 'cooldown', seconds: COOL }],
  });

  const same = (label, middle) => [session(label, middle), session(label, middle), session(label, middle)];

  const WEEKS = [
    // ---- Couch to 5K -------------------------------------------------------
    { week: 1, note: 'Sixty seconds at a time', sessions: same('Run 1 min · walk 90 sec × 8', alternate(60, 90, 8)) },
    { week: 2, note: 'A little longer', sessions: same('Run 90 sec · walk 2 min × 6', alternate(90, 120, 6)) },
    { week: 3, note: 'Two blocks', sessions: same('90 sec and 3 min blocks',
      [run(90), walk(90), run(180), walk(180), run(90), walk(90), run(180)]) },
    { week: 4, note: 'Up to five minutes', sessions: same('3 and 5 min blocks',
      [run(180), walk(90), run(300), walk(150), run(180), walk(90), run(300)]) },
    { week: 5, note: 'Each run is different this week', sessions: [
      session('5 min × 3', [run(300), walk(180), run(300), walk(180), run(300)]),
      session('8 min × 2', [run(480), walk(300), run(480)]),
      session('20 minutes non-stop', [run(1200)]),
    ] },
    { week: 6, note: 'Each run is different this week', sessions: [
      session('5, 8, 5 min', [run(300), walk(180), run(480), walk(180), run(300)]),
      session('10 min × 2', [run(600), walk(180), run(600)]),
      session('25 minutes non-stop', [run(1500)]),
    ] },
    { week: 7, note: 'Settling in', sessions: same('25 minutes non-stop', [run(1500)]) },
    { week: 8, note: 'Nearly there', sessions: same('28 minutes non-stop', [run(1680)]) },
    { week: 9, note: 'This is 5K', sessions: same('30 minutes non-stop', [run(1800)]) },

    // ---- Bridge to 10K -----------------------------------------------------
    { week: 10, note: 'Bridge to 10K starts here', sessions: same('Run 10 min · walk 1 min × 4', blocks(600, 60, 4)) },
    { week: 11, note: 'Longer blocks', sessions: same('Run 15 min · walk 1 min × 3', blocks(900, 60, 3)) },
    { week: 12, note: 'Building', sessions: same('Run 17 min · walk 1 min × 3', blocks(1020, 60, 3)) },
    { week: 13, note: 'Building', sessions: same('Run 18 min · walk 1 min × 3', blocks(1080, 60, 3)) },
    { week: 14, note: 'Long blocks now', sessions: same('Run 22 min · walk 1 min × 2', blocks(1320, 60, 2)) },
    { week: 15, note: 'Race week', sessions: [
      session('Run 30 min · walk 1 min × 2', blocks(1800, 60, 2)),
      session('60 minutes non-stop', [run(3600)]),
      session('Run 30 min · walk 1 min × 2', blocks(1800, 60, 2)),
    ] },
  ];

  const STEP_LABEL = { warmup: 'Warm up', run: 'Run', walk: 'Walk', cooldown: 'Cool down' };

  const key = (week, day) => `${week}:${day}`;

  const sessionAt = (week, day) => {
    const w = WEEKS.find((x) => x.week === week);
    return w ? w.sessions[day - 1] || null : null;
  };

  const totalSeconds = (s) => s.steps.reduce((a, x) => a + x.seconds, 0);
  const runCount = (s) => s.steps.filter((x) => x.type === 'run').length;

  // Every session in order, so "the next one" is just the first not completed.
  function allSessions() {
    const out = [];
    WEEKS.forEach((w) => w.sessions.forEach((s, i) => {
      out.push({ week: w.week, day: i + 1, note: w.note, key: key(w.week, i + 1), ...s });
    }));
    return out;
  }

  function nextSession(completed) {
    const done = new Set(completed || []);
    return allSessions().find((s) => !done.has(s.key)) || null;
  }

  const fmtClock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const fmtMins = (sec) => `${Math.round(sec / 60)} min`;

  return {
    WEEKS, STEP_LABEL, WARM, COOL,
    allSessions, nextSession, sessionAt, totalSeconds, runCount, key,
    fmtClock, fmtMins,
  };
}));
