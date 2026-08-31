/* Which loads your equipment can actually make, and how to build them.

   A progression suggestion is worthless if the weight cannot be loaded, so
   everything here works from the real plate and band inventory rather than
   assuming a smooth 5 lb ladder.

   total = base + 2 x (plates on one side) + (cables selected)

   Plates are doubled because they hang on both sides. The cables are NOT:
   each is one length running through the back and clipping to both sides, so
   it contributes its rating once. Kept free of Electron and the DOM so the
   main process, the browser and the tests share one implementation. */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Loads = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_EQUIPMENT = {
    platesPerSide: [50, 30, 10, 10, 5],
    cables: [20, 30, 40, 50],   // span both sides, so counted once
    baseWeight: 5,              // the carriage/bar itself
    cablesEnabled: true,
  };

  // Every distinct subset total, with one representative combination each.
  // Smallest piece-count wins, so "50+30" is preferred over "30+10+10+5+..."
  function subsetTotals(items) {
    const best = new Map([[0, []]]);
    items.forEach((item, idx) => {
      [...best.entries()].forEach(([sum, combo]) => {
        if (combo.some((c) => c.idx === idx)) return;
        const next = sum + item;
        const withItem = combo.concat([{ idx, value: item }]);
        const existing = best.get(next);
        if (!existing || withItem.length < existing.length) best.set(next, withItem);
      });
    });
    return best;
  }

  function normalise(eq) {
    const e = { ...DEFAULT_EQUIPMENT, ...(eq || {}) };
    e.platesPerSide = (e.platesPerSide || []).map(Number).filter((n) => n > 0);
    e.cables = (e.cables || []).map(Number).filter((n) => n > 0);
    e.baseWeight = Number(e.baseWeight) || 0;
    return e;
  }

  /* Some exercises are recorded per side ("80 on each side") and some as a
     total ("205 on the bench"). Per-side numbers come straight off the plate
     ladder in 5 lb steps; totals double the plates and add the cable. Getting
     this wrong would make every suggestion wrong, so it is explicit. */
  function perSideLadder(eq) {
    return [...subsetTotals(normalise(eq).platesPerSide).keys()].sort((a, b) => a - b);
  }

  function perSideLoad(perSide, eq) {
    const combo = subsetTotals(normalise(eq).platesPerSide).get(perSide);
    if (!combo) return null;
    return { plates: combo.map((c) => c.value).sort((a, b) => b - a), cables: [], perSide };
  }

  // Sorted list of every reachable total.
  function achievableLoads(eq, base) {
    const e = normalise(eq);
    if (base != null) e.baseWeight = Number(base) || 0;
    const plates = subsetTotals(e.platesPerSide);
    const cables = e.cablesEnabled ? subsetTotals(e.cables) : new Map([[0, []]]);
    const totals = new Set();
    plates.forEach((_pc, p) => {
      cables.forEach((_cc, c) => { totals.add(e.baseWeight + 2 * p + c); });
    });
    return [...totals].sort((a, b) => a - b);
  }

  // How to build a given total, or null if it cannot be made.
  // Prefers plates over bands, and fewer pieces over more.
  // `base` overrides the equipment default: on a home gym the bench uses a bar
  // with its own weight while cable work hangs off handles that weigh nothing,
  // so the reachable ladder genuinely differs per exercise.
  function howToLoad(total, eq, base) {
    const e = normalise(eq);
    const baseWeight = base == null ? e.baseWeight : Number(base) || 0;
    if (total < baseWeight) return null;

    const plates = subsetTotals(e.platesPerSide);
    const cables = e.cablesEnabled ? subsetTotals(e.cables) : new Map([[0, []]]);

    let best = null;
    plates.forEach((pCombo, p) => {
      // Plates are per side; the cable total is whatever is left over.
      const need = total - baseWeight - 2 * p;
      const bCombo = cables.get(need);
      if (!bCombo) return;
      const candidate = {
        cableCount: bCombo.length,
        pieces: pCombo.length + bCombo.length,
        plates: pCombo.map((c) => c.value).sort((a, b) => b - a),
        cables: bCombo.map((c) => c.value).sort((a, b) => b - a),
        perSide: p,
      };
      // Cables are the fallback, not a shortcut: any plates-only loading beats
      // one that clips a cable on, even if that means hanging more plates.
      const better = !best
        || candidate.cableCount < best.cableCount
        || (candidate.cableCount === best.cableCount && candidate.pieces < best.pieces);
      if (better) best = candidate;
    });
    return best;
  }

  const describeLoad = (load) => {
    if (!load) return 'not loadable';
    const bits = [];
    if (load.plates.length) bits.push(`${load.plates.join(' + ')} per side`);
    if (load.cables.length) bits.push(`${load.cables.join(' + ')} lb cable`);
    if (!bits.length) return 'bar only';
    return bits.join(' + ');
  };

  // The next reachable weight above `current`.
  function nextLoad(current, eq, base, perSide) {
    const ladder = perSide ? perSideLadder(eq) : achievableLoads(eq, base);
    return ladder.find((w) => w > current + 0.001) ?? null;
  }

  /* Gradual progression across all three axes, easiest first.

     Weight is the blunt instrument here: the smallest jump is 5 lb a side,
     which on a 30 lb curl is a 17% increase. So reps climb first, then a set
     is added, and only then does the weight move - at which point reps and
     sets reset to the bottom and the cycle restarts one rung heavier.

       3x10 -> 3x11 -> 3x12 -> 4x8 -> ... -> 4x12 -> 3x8 at the next weight

     Set the strategy to 'reps-weight' to skip the added-set stage and reach
     heavier weights roughly twice as fast. */
  const PROGRESSION_DEFAULTS = { minReps: 8, maxReps: 12, minSets: 3, maxSets: 4, strategy: 'reps-sets-weight' };

  function suggestProgression(exercise, eq, opts) {
    const o = { ...PROGRESSION_DEFAULTS, ...(opts || {}), ...(exercise.progression || {}) };
    const base = exercise.base == null ? undefined : exercise.base;
    const perSide = !!exercise.perSide;
    const reps = Number(exercise.reps) || 0;
    const weight = Number(exercise.weight) || 0;
    const sets = Number(exercise.sets) || 0;
    const unit = perSide ? ' a side' : '';
    const useSets = o.strategy !== 'reps-weight';

    // Bands have no ladder to climb - reps, then another band.
    if (exercise.bands) {
      if (reps < o.maxReps) {
        return { kind: 'reps', sets, reps: reps + 1, weight,
          text: `Add a rep: ${sets} × ${reps + 1}` };
      }
      return { kind: 'band', sets, reps: o.minReps, weight,
        text: `Add the next band and drop back to ${o.minReps} reps` };
    }

    if (reps < o.maxReps) {
      return { kind: 'reps', sets, reps: reps + 1, weight,
        text: `Add a rep: ${sets} × ${reps + 1} at ${weight}${unit}` };
    }

    if (useSets && sets < o.maxSets) {
      return { kind: 'sets', sets: sets + 1, reps: o.minReps, weight,
        text: `Add a set: ${sets + 1} × ${o.minReps} at ${weight}${unit}` };
    }

    const nextWeight = nextLoad(weight, eq, base, perSide);
    if (nextWeight == null) {
      return { kind: 'capped', sets: sets + 1, reps, weight,
        text: `Top of what this equipment loads — add a set: ${sets + 1} × ${reps}` };
    }
    const load = perSide ? perSideLoad(nextWeight, eq) : howToLoad(nextWeight, eq, base);
    return {
      kind: 'weight',
      sets: o.minSets,
      reps: o.minReps,
      weight: nextWeight,
      load,
      perSide,
      text: `Go up to ${nextWeight}${unit} — back to ${o.minSets} × ${o.minReps} — ${describeLoad(load)}`,
    };
  }

  // The next few steps, so the pace of progression is visible rather than
  // something you discover months later.
  function progressionLadder(exercise, eq, count, opts) {
    const steps = [];
    let cur = { ...exercise };
    for (let i = 0; i < (count || 6); i++) {
      const s = suggestProgression(cur, eq, opts);
      steps.push(s);
      if (s.kind === 'capped' || s.kind === 'band') break;
      cur = { ...cur, sets: s.sets, reps: s.reps, weight: s.weight };
    }
    return steps;
  }

  // Is this weight actually loadable? Used to flag numbers that do not line up
  // with the declared equipment rather than quietly suggesting nonsense.
  function isLoadable(total, eq, base, perSide) {
    return (perSide ? perSideLoad(total, eq) : howToLoad(total, eq, base)) != null;
  }

  // The base weight, of those offered, that makes a given load reachable.
  function inferBase(total, eq, candidates) {
    const opts = candidates && candidates.length ? candidates : [0, 5, 10, 15, 20, 25, 45];
    return opts.find((b) => isLoadable(total, eq, b)) ?? null;
  }

  return {
    DEFAULT_EQUIPMENT,
    PROGRESSION_DEFAULTS,
    progressionLadder,
    perSideLadder,
    perSideLoad,
    isLoadable,
    inferBase,
    achievableLoads,
    howToLoad,
    describeLoad,
    nextLoad,
    suggestProgression,
    normalise,
  };
}));
