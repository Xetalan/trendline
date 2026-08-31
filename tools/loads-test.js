'use strict';

/* Pure-logic tests for the load engine. Plain node, no Electron.
   Run: npm run loads

   The numbers here are the real setup: a Bowflex with two bars, 105 lb of
   plates per side (50/30/10/10/5), and 20/30/40/50 lb cables that run through
   the back and clip to both sides. */

const L = require('../lib/loads');

const EQ = L.DEFAULT_EQUIPMENT;
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// ---- per-side ladder -------------------------------------------------------
const ladder = L.perSideLadder(EQ);
eq('per-side ladder is every 5 lb to 105', ladder,
  Array.from({ length: 22 }, (_, i) => i * 5));

// ---- the two lifts actually performed --------------------------------------
check('bench 205 total loads with the bar',
  L.isLoadable(205, EQ, 5), 'not loadable');
eq('bench 205 uses plates only', L.howToLoad(205, EQ, 5).plates, [50, 30, 10, 10]);
eq('bench 205 needs no cable', L.howToLoad(205, EQ, 5).cables, []);

check('flies 80 per side loads', L.isLoadable(80, EQ, 0, true), 'not loadable');
eq('flies 80 per side is 50 + 30', L.perSideLoad(80, EQ).plates, [50, 30]);

// ---- cables span both sides, so they count once ----------------------------
// 235 total with a 5 lb bar = 5 + 2x90 + 50 cable.
const l235 = L.howToLoad(235, EQ, 5);
eq('235 total uses a cable once', l235.cables, [50]);
eq('235 total plates per side', l235.plates, [50, 30, 10]);
check('a cable counted twice would be wrong',
  5 + 2 * l235.perSide + l235.cables.reduce((a, b) => a + b, 0) === 235,
  'arithmetic does not close');

// ---- plates beat cables ----------------------------------------------------
const l105 = L.howToLoad(105, EQ, 5);
eq('105 prefers plates over a cable', l105.cables, []);
eq('105 is 50 per side', l105.plates, [50]);

// ---- unreachable weights are reported, not fudged --------------------------
check('210 is not reachable with a 5 lb bar', !L.isLoadable(210, EQ, 5), 'claimed loadable');
check('210 IS reachable with no bar', L.isLoadable(210, EQ, 0), 'claimed unloadable');
eq('base can be inferred from a known lift', L.inferBase(205, EQ), 5);

// ---- double progression ----------------------------------------------------
const midRange = L.suggestProgression({ sets: 3, reps: 10, weight: 205, base: 5 }, EQ);
eq('mid-range adds a rep before weight', [midRange.kind, midRange.reps], ['reps', 11]);

// Top of the rep range adds a SET before it touches the weight: the smallest
// jump available is 5 lb a side, which is a lot on a small lift.
const topReps = L.suggestProgression({ sets: 3, reps: 12, weight: 205, base: 5 }, EQ);
eq('top of the rep range adds a set first', [topReps.kind, topReps.sets, topReps.reps],
  ['sets', 4, 8]);

const topSets = L.suggestProgression({ sets: 4, reps: 12, weight: 205, base: 5 }, EQ);
eq('only at max sets does the weight move',
  [topSets.kind, topSets.weight, topSets.reps, topSets.sets], ['weight', 215, 8, 3]);
check('the step tells you how to load it', /50 \+ 30 \+ 10 \+ 10 \+ 5 per side/.test(topSets.text),
  topSets.text);

const perSideStep = L.suggestProgression({ sets: 4, reps: 12, weight: 80, perSide: true }, EQ);
eq('per-side exercise steps 5 lb a side', [perSideStep.weight, perSideStep.perSide], [85, true]);
check('per-side wording says "a side"', / a side/.test(perSideStep.text), perSideStep.text);

// The whole cycle, which is the part that has to feel gradual.
const cycle = L.progressionLadder({ sets: 3, reps: 10, weight: 100, perSide: true, base: 5 }, EQ, 8);
eq('the cycle runs reps, then a set, then weight', cycle.map((x) => x.kind),
  ['reps', 'reps', 'sets', 'reps', 'reps', 'reps', 'reps', 'weight']);
eq('and lands one rung heavier at the bottom of the range',
  [cycle[7].weight, cycle[7].sets, cycle[7].reps], [105, 3, 8]);

// 'reps-weight' skips the added-set stage for anyone wanting to move faster.
const fast = L.suggestProgression({ sets: 3, reps: 12, weight: 205, base: 5 },
  EQ, { strategy: 'reps-weight' });
eq('reps-weight strategy goes straight to weight', [fast.kind, fast.weight], ['weight', 215]);

// Band work has no plate ladder: reps, then another band.
const bandStep = L.suggestProgression({ sets: 3, reps: 12, weight: 0, bands: ['50-125', '35-85'] }, EQ);
eq('band work adds a band at the top of the range', bandStep.kind, 'band');

// ---- ceiling ---------------------------------------------------------------
const maxTotal = L.achievableLoads(EQ, 5).pop();
const capped = L.suggestProgression({ sets: 4, reps: 12, weight: maxTotal, base: 5 }, EQ);
eq('at the ceiling it adds a set instead', [capped.kind, capped.sets], ['capped', 5]);

// ---- equipment changes flow through ----------------------------------------
const noCables = { ...EQ, cablesEnabled: false };
check('disabling cables shrinks the ladder',
  L.achievableLoads(noCables, 5).length < L.achievableLoads(EQ, 5).length, 'no change');
check('a heavier plate set reaches further',
  L.achievableLoads({ ...EQ, platesPerSide: [50, 50, 30, 10, 10, 5] }, 5).pop() > maxTotal,
  'ceiling did not rise');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
