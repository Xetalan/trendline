'use strict';

/* Pure mapping from an Oura v2 workout to a Trendline activity. Kept free of
   Electron so both the main process and the test harness can require it
   without starting an app. */

// Oura's activity names are free-form; anything unrecognised lands in "other"
// keeping its original name rather than being silently mislabelled.
const OURA_TYPE = {
  running: 'run', jogging: 'run', treadmill: 'run',
  walking: 'walk',
  hiking: 'hike',
  weightlifting: 'lift', strength_training: 'lift', resistance_training: 'lift',
};

const METERS_PER_MILE = 1609.344;

function mapWorkout(w) {
  const start = w.start_datetime ? new Date(w.start_datetime) : null;
  const end = w.end_datetime ? new Date(w.end_datetime) : null;
  const minutes = start && end ? Math.round((end - start) / 60000) : 0;
  const raw = String(w.activity || '').toLowerCase();
  const type = OURA_TYPE[raw] || 'other';
  return {
    sourceId: String(w.id),
    date: w.day,
    type,
    minutes,
    // Oura only knows distance when the phone was along for GPS; treadmill
    // sessions come back with none, which is expected.
    distance: typeof w.distance === 'number' && w.distance > 0
      ? +(w.distance / METERS_PER_MILE).toFixed(2) : 0,
    label: type === 'other' ? raw.replace(/_/g, ' ') : '',
    calories: w.calories ?? null,
    intensity: w.intensity || '',
  };
}

module.exports = { OURA_TYPE, METERS_PER_MILE, mapWorkout };
