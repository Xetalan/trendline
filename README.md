# Trendline

A local desktop app for tracking weight on a GLP-1 alongside running, walking,
hiking and lifting. Everything runs on this PC; nothing is uploaded anywhere.

## Launching it

- **Desktop shortcut** — `Trendline` on the Desktop.
- **Or** double-click `Trendline.cmd` in this folder.
- **Or** from a terminal here: `npm start`

## The five tabs

| Tab | What it is for |
|---|---|
| **Dashboard** | Current weight, 7-day average, total lost, pace, running distance totals, and the weight-trend charts |
| **Log Today** | The daily weigh-in, plus adding a run / walk / hike / lift / other workout |
| **Training** | Weekly volume — active minutes, distance, lifting tonnage, strength progress |
| **Workouts** | Every session, filtered by type, with per-type totals; click a row to edit or delete it |
| **History** | Every logged day, with weight and steps editable inline |
| **Settings** | Starting weight, start date, goal weight, medication; data file location |

## How the numbers work

- **Baseline** is whatever you set under Settings, or the first weigh-in you log. Every
  "total lost" figure is measured against it.
- **Weeks run Monday to Sunday.** Week 1 is anchored to the first Monday on or
  after the start date — Mon 31 Aug 2026. The 27 Aug reading is the baseline the
  weeks are measured against, not a one-reading week of its own.
- **Weekly average** is the mean of whatever weigh-ins that week actually holds;
  missed days are skipped, never counted as zero. The `Days` column shows how
  many readings the average rests on.
- **7-day average** is a rolling window over the *calendar* — the last 7 days,
  not the last 7 entries — so a gap does not silently stretch the window.
- **Change per week** compares this week's average with the previous week's.
  Negative and blue is progress. This is the number to watch: a single day's
  weight moves 2-4 lbs on water and food alone, and the average filters that out.
- While a week is still running, the Training tiles show *last week's* total as a
  target rather than a misleading part-week delta.
- **Lifting volume** (tonnage) is the sum of reps × weight across all sets.
- **Distance covered** on the Dashboard is a cumulative running total of run,
  walk and hike miles since the start date, with each week's contribution beside
  it. Lifting and Other carry no distance and are excluded.
- **History spans every logged day**, including days that hold only a workout and
  days before the first weigh-in. The weight chart still starts at the first
  weigh-in so a stray workout cannot drag its axis back.
- The Workouts view flags **possible duplicates** (same type, date and numbers)
  and workouts dated **outside the tracked weeks**, which would otherwise be
  missing from the weekly charts with no explanation.

## Logging a treadmill session

Distance, duration and rate are three views of two facts, so **enter whichever
two you know and the third computes itself**:

| You enter | You get |
|---|---|
| Speed 3.5 mph + duration 40 min | Distance 2.33 mi |
| Distance + duration | Speed and pace |
| Distance + pace | Duration |

Speed (mph) and pace (min/mi) are two faces of the same number and stay in sync —
type either one and the other fills in. Pace accepts `9:30`, `9:30 /mi` or `9.5`.

Whichever two fields you touched most recently are treated as your input, so the
third is the one that gets recomputed. Walks and hikes are summarised in mph and
runs in pace, matching how each is normally talked about; the CSV carries both.

## Oura ring (desktop only)

Settings → paste a personal access token from **cloud.ouraring.com → Personal
Access Tokens**, then **Sync now**. Pulls daily steps and workout sessions for
the last 30 days.

The token is encrypted with the OS keychain (Electron ), not stored
alongside the weigh-ins.

This cannot work in the PWA: the Oura API returns no 
header, so a browser blocks the request. The desktop app fetches from the main
process, where CORS does not apply.

Every imported session keeps its Oura id, so re-syncing an overlapping range
updates rather than duplicates. **Hand-entered distances are never overwritten** —
the ring has no distance for treadmill work, and your typed figure is better than
its guess. Unrecognised Oura activities become `Other` keeping their original name.

## Your data

- Stored at `%APPDATA%\Trendline\trendline-data.json` — plain JSON, readable and
  editable by hand. **Settings → Show data file** opens it in Explorer.
- A dated snapshot is written to `%APPDATA%\Trendline\backups\` on every launch;
  the most recent 14 are kept.
- If the file is ever unreadable, it is moved aside as `.broken-<timestamp>`
  rather than overwritten, and the app starts fresh.
- **Export CSV** on the Training and History tabs writes a spreadsheet-ready file
  (History exports the daily log *and* the week-by-week summary in one file).

## Phone (PWA)

**Live at https://xetalan.github.io/trendline/**

Open it in Chrome on Android, then menu (⋮) → **Add to Home screen** / **Install app**.
It gets its own launcher icon, opens without browser chrome, and runs offline —
the service worker caches the shell and everything you log lives in the phone's
own storage. The URL is only needed to install it and to pick up updates.


`npm run build:web` produces `docs/` — an installable Progressive Web App built
from the same `src/`, so the desktop and phone builds never drift. Storage swaps
from a JSON file to IndexedDB behind the identical `window.api` surface, and a
service worker caches the shell so it opens with no signal.

Below 820px the sidebar becomes a bottom tab bar, tiles go two-up, forms stack,
and tables drop their least-critical column.

**Moving your history over:** Settings → **Save backup (JSON)** on the desktop,
then Settings → **Restore from backup…** in the PWA. The phone is the source of
truth after that; the desktop copy will drift.

A fresh PWA install starts completely empty — no seeded weights or dates — and
the first weigh-in you log becomes your baseline.

## Development

```
npm start        # run the app
npm test         # all four suites (51 assertions)
npm run smoke    # drive the UI through its save paths and assert on the data
npm run pace     # the distance / duration / speed / pace conversions
npm run workouts # the Workouts report view, editing, and the History range
npm run oura     # Oura import mapping and dedup, against a stubbed API
npm run test:web # serves docs/ on localhost and drives the PWA at phone size
                 # TEST_URL=https://… points the same suite at the deployed build
npm run build:web# build the PWA into docs/
npm run icons    # regenerate the launcher icons
npm run shots    # render each view to shots/*.png
```

`npm run shots` accepts `SHOT_THEME=dark`, `SHOT_W`, `SHOT_H`, and `SHOT_DIR`.

All three dev suites use in-memory fixture data and never touch the real data file.

> If you ever run Electron from a shell that sets `ELECTRON_RUN_AS_NODE=1`
> (Claude Code does, for its own child processes), `require('electron')` returns
> undefined and the app exits immediately. `Trendline.cmd` clears the variable;
> from another shell use `env -u ELECTRON_RUN_AS_NODE`.

## Charts

Colors come from a colorblind-safe categorical palette validated in both light
and dark modes. Entity colors are consistent across every chart: **run** blue,
**walk** orange, **hike** aqua, **lift** yellow, **other** magenta.

Run, walk and hike hold the first three palette slots deliberately — they are the
only trio that clears the stricter *all-pairs* CVD gate in both modes, and the
distance chart puts all three side by side, so they have to stay tellable apart.
Lift and Other never appear in that chart, so they take the next slots. Swapping
hike to any warm hue or to violet fails: violet collapses against blue in dark
mode (ΔE 1.9), and magenta, green and red all collide with walk's orange.
