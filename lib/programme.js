/* The default training week.

   Weights are recorded PER SIDE, because that is how the machine is loaded:
   discs go on both arms and every movement uses both. Total is simply
   2 x per side - there is no bar with a weight of its own.

   Arm-wrestling work uses stretch bands whose resistance depends on how far
   they are pulled, so there is no plate ladder to climb. Those progress by
   reps and then by adding the third band. */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Programme = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ex = (name, sets, reps, weight, opts) => ({
    name, sets, reps, weight,
    perSide: true,
    base: 0,
    ...(opts || {}),
  });

  // Three lifting days across chest, shoulders, back, arms and triceps.
  const TEMPLATES = [
    {
      id: 'tpl-push',
      name: 'Chest & Triceps',
      exercises: [
        ex('Bench press', 3, 10, 100),   // 200 total
        ex('Chest flies', 3, 8, 80),
        ex('Triceps pushdowns', 3, 10, 80),
      ],
    },
    {
      id: 'tpl-pull',
      name: 'Back & Biceps',
      exercises: [
        ex('Lat pulldowns', 3, 8, 105),
        ex('Reverse flies', 3, 8, 25),
        ex('Behind-the-back curls', 3, 10, 50),
        ex('Standing curls', 3, 10, 30),
      ],
    },
    {
      id: 'tpl-shoulders',
      name: 'Shoulders & Arms',
      exercises: [
        ex('Overhead press', 3, 10, 50),
        ex('Shoulder raises', 3, 8, 35),
        ex('Behind-the-back curls', 3, 10, 50),
        ex('Standing curls', 3, 10, 30),
      ],
    },
    {
      id: 'tpl-armwrestle',
      name: 'Arm wrestling',
      daily: true,
      bandWork: true,
      exercises: [
        ex('Rise', 3, 10, 0, { bands: ['50-125', '35-85'], perSide: false }),
        ex('Curl', 3, 10, 0, { bands: ['50-125', '35-85'], perSide: false }),
        ex('Pronation', 3, 10, 0, { bands: ['50-125', '35-85'], perSide: false }),
      ],
    },
  ];

  // 0 = Sunday. Lift Tue/Thu/Sat, run Mon/Wed/Fri, rest Sunday.
  const WEEK = {
    0: { type: 'rest' },
    1: { type: 'run' },
    2: { type: 'lift', templateId: 'tpl-push' },
    3: { type: 'run' },
    4: { type: 'lift', templateId: 'tpl-pull' },
    5: { type: 'run' },
    6: { type: 'lift', templateId: 'tpl-shoulders' },
  };

  // Bands available for arm-wrestling work, lightest first. Progression there
  // means adding the third band rather than changing a plate.
  const BANDS = ['25-65', '35-85', '50-125'];

  const defaultPlan = () => ({
    templates: JSON.parse(JSON.stringify(TEMPLATES)),
    week: JSON.parse(JSON.stringify(WEEK)),
    bands: BANDS.slice(),
  });

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return { TEMPLATES, WEEK, BANDS, defaultPlan, DAY_NAMES };
}));
