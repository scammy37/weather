# 🏡 Tri-State Weather

Live weather and monthly climate normals for three homes, on one page.

| | | |
|---|---|---|
| 🏖️ **North Myrtle Beach, SC** | Atlantic coast | humid subtropical (Köppen Cfa) |
| 🌴 **Bonita Springs, FL** | Gulf coast | tropical savanna (Köppen Aw) |
| 🍂 **Rockaway, NJ** | Morris County highlands | humid continental (Köppen Dfa) |

Live site: **https://scammy37.github.io/weather**

---

## What's on the page

**🏘️ Tri-State** — the default view. Every home's current conditions,
today's range, humidity, dew point, wind, water temperature, sun times and a
compact seven-day strip, all side by side without a click. Above them a summary
strip answers the cross-home questions: warmest and coolest right now, the
spread between them, whether it is raining anywhere, and which water is warmest.
Click any card to open that home in full.

**🚨 Severe weather alerts** — active National Weather Service watches and
warnings for each home's exact coordinates, sorted worst-first and shown above
everything else. An alert at a home you are *not* currently viewing still gets
flagged, because a hurricane watch on the Carolina house does not matter less
because you happen to be looking at New Jersey.

**📋 Quick reference** — one row per home: temperature now, feels-like, today's
high and low, rain chance, humidity, wind, water temperature, sunset and any
active alert. Click a row for that home's full dashboard.

This replaced a "best week ahead" ranking and a warmest/coolest summary. Both
were correct and useless: Bonita Springs is warmer and sunnier than New Jersey
every day of the year, so a ranking that crowns it carries no information. A
plain table lets you read the differences yourself.

**📡 Live radar** — the National Weather Service RIDGE II loop for the radar
station that actually covers each home, chosen from a table of every WSR-88D
site by which dish the house genuinely sits under
rather than hard-coded. Refresh pulls new sweeps; clicking opens the full radar
on weather.gov. The overview shows all three at once, side by side, rather
than making you switch between the
stations — north Jersey, coastal Carolina and southwest Florida are each served
by a different dish.

**⚡ Live conditions** (per home) — current temperature, feels-like, humidity, dew point, wind
and gusts, pressure, cloud cover, visibility, UV index, air quality, today's
precipitation, and a sunrise → now → sunset progress bar. Every tab shows its
home's current temperature, so all three are visible at a glance.

**🌊 Ocean right now** — water temperature, wave height, wave period and swell
direction at the offshore point for each home.

**📅 7-day forecast** — click any day for its full detail: feels-like range,
precipitation chance and total, rain/showers/snow split, precipitation hours,
peak UV, wind and gusts, sunrise, sunset, daylight and sunshine hours.

**🕘 Next 48 hours** — temperature, chance of precipitation, wind speed and
humidity, with night hours shaded.

**📊 Monthly climate normals** — 21 KPI cards and **46 charts** across ten
groups (35 for Rockaway, which gets the two snow charts), every one clickable and
cross-linked to a focus month:

| Group | Charts |
|---|---|
| 🌡️ Temperature | avg high/low with range band · record high/low · day-to-night swing · feels-like high |
| 🌧️ Rain & snow | total precipitation · wet days · dry days · heavy rain days · snowfall · snow days |
| ☀️ Sunshine | sky conditions (sunny/partly/cloudy stack) · sunny days · sun hours per day · % of possible sunshine · solar energy |
| 🌊 Ocean | sea-surface temperature range · swimmable water · wave height |
| 🌅 Sun & sky | year-long daylight ribbon · average sunrise/sunset/solar noon by month · average daylight |
| 💨 Air & wind | humidity · dew point · cloud cover · peak wind · peak gust · pressure |
| 📊 Threshold days | days ≥ 90°F · days ≤ 32°F · beach days · pleasant days |
| 🌀 Wind & storms | breezy days · gale-force (39 mph) days · damaging-wind (58 mph) days |
| 📈 Year-by-year trends | mean temperature, daily high, daily low, precipitation, days ≥ 90°F, days ≤ 32°F, sunny days, snowfall — each with a least-squares slope per decade and an r² |
| ⚡ Energy & growing | heating degree days · cooling degree days · growing degree days · evapotranspiration |

**🔀 Compare all three homes** — pick any of the 51 measures and see all three
homes on one axis, plus a side-by-side table with annual totals.

**🌱 Frost dates & growing season** — average last spring freeze, first fall
freeze, the length of the season between them, and the date by which nine years
in ten are frost-free. A home that never freezes says so instead of inventing a
date.

**🗂️ Monthly data table** — all 51 measures in 52 columns, sortable by any
column, click a row to open that month. Exports to CSV with full provenance in
the header.

**🔌 Data sources & diagnostics** — every API request the page made, with status
and timing, so a missing chart is never a mystery.

---

## Where the numbers come from

Nothing on this page is hand-entered. The live feed is fetched in your browser
from [Open-Meteo](https://open-meteo.com/) — free, no API key, no account. The
monthly normals are built ahead of time and committed, because building them per
visitor blew the free tier on a single page load.

**Temperature, rainfall and snowfall are measurements, not model output.** They
come from NOAA GHCN-Daily stations — and not one station per home, because
thermometers are rare and rain gauges are everywhere: Rockaway's nearest
thermometer is six miles off, its nearest rain gauge is 0.2 miles away in a
volunteer's garden. Each measurement is taken from the nearest station that
actually records it. Everything a station has no instrument for stays with the
reanalysis, which is the right tool for a field rather than a point.

Why this matters: a reanalysis is close on monthly averages and badly wrong on
threshold counts. Measured against the station records over 2016–2025, ERA5 put
Bonita Springs at **13 days a year at or above 90°F against a measured 80**, and
Rockaway at 14 against 30. A 3°F bias barely moves an average and destroys a day
count. See `scripts/stations.mjs` for the full argument and
`scripts/investigate-hotdays.mjs` for the measurements behind it.

| Feed | Source |
|---|---|
| Current conditions, hourly and 7-day forecast | Open-Meteo Forecast API |
| Monthly temperature, rainfall, snowfall | **NOAA GHCN-Daily station observations** (`scripts/stations.mjs`) |
| Everything else in the normals (cloud, sunshine, humidity, wind, radiation) | Open-Meteo Historical Weather API (ECMWF **ERA5** reanalysis) |
| Ocean temperature and waves | Open-Meteo Marine API |
| Air quality | Open-Meteo Air Quality API (CAMS), US AQI scale |
| Sunrise, sunset, solar noon, daylight | computed locally — NOAA solar equations |
| Severe weather alerts | US National Weather Service (api.weather.gov) |
| Radar | NWS RIDGE II loops, station chosen geometrically from the WSR-88D table |
| Water temperature | NOAA CO-OPS tide gauges — a physical sensor, preferred over the model |
| Backup for current conditions | Nearest National Weather Service station observation |
| Accuracy check | NOAA NCEI 1991–2020 station normals |

The normals are **precomputed and committed** to `data/climate.json`, so opening
the page makes no historical API requests at all — it loads one small file and
renders instantly.

That file is built by `scripts/build-climate.mjs`, which pulls 30 years of daily
ERA5 records for each home and aggregates them.
`.github/workflows/climate.yml` runs it on the 3rd of each month and commits the
result.

### Why it is precomputed

Open-Meteo weights an API call as roughly `(days ÷ 14) × (variables ÷ 10)`.
Building the normals in the browser meant every visitor paid:

| normals window | per home | all three homes | vs 5,000/hour cap |
|---|---|---|---|
| 30 years | 1,722 | 5,166 | **103% — over** |
| 15 years | 861 | 2,583 | 52% |
| **10 years (default)** | **574** | **1,722** | **34%** |

These come from `weightedCallsFor()` in `js/config.js`, which every estimate on
the page also uses. Three hand-written copies of this arithmetic had drifted
apart and quoted three different figures for the same request.

The free tier allows 10,000 calls/day and **5,000/hour**. At the original
30-year default a single page load blew the hourly cap and the dashboard
rate-limited itself. Precomputing drops a visitor's cost to the live feed
alone — about **5 weighted calls**.

The build script paces itself against both limits, enforced inside the fetch
layer so every request is covered. The per-minute cap (600) is usually the
binding one: a single 10-year, 17-variable chunk is worth ~444, so two cannot
share a minute. A 10-year build takes about half an hour; a 30-year one about
ninety minutes.

Only the default period is precomputed. Selecting another falls back to building
it live, and the page says so. Runs **merge** into `data/climate.json`, so
building one period leaves the others intact.

Rebuild manually with:

```bash
node scripts/build-climate.mjs                 # all homes, default period (~30 min)
node scripts/build-climate.mjs --period all    # every period (several hours)
node scripts/build-climate.mjs --period 1996-2025
node scripts/build-climate.mjs --home nmb
node scripts/build-climate.mjs --pause 0       # override the automatic pacing
```

or from the Actions tab → *Rebuild climate normals* → *Run workflow*.

Sunrise and sunset are calculated rather than fetched, using the NOAA solar
position equations, then converted to local wall-clock time with the browser's
IANA time-zone database — so daylight-saving transitions are exact. They were
verified against published times (New York, 21 Jun: 5:25 AM / 8:30 PM; London,
21 Jun: 4:43 AM / 9:21 PM).

### Normals periods

Pick one from the header of the climate section:

- **2016–2025** — the recent 10 years *(default)*
- **2011–2025** — the recent 15 years
- **1996–2025** — the latest full 30 years
- **1991–2020** — the WMO standard 30-year normals period

Ten years is the default on purpose. It costs a third of a 30-year pull, and it
describes the climate these homes have *now* rather than averaging in cooler
years from the late 1990s. The trade is precision:

| measure | 30 years | 10 years |
|---|---|---|
| Monthly avg high / low | ±0.9°F | ±1.6°F |
| Monthly rainfall | ±0.60 in | ±1.05 in |
| Days ≥ 90°F | ±1.2 days | ±2.1 days |

(the band the published figure lands in 90% of the time). Records suffer most —
a 10-year record high reads about **2.5°F milder** than a 30-year one, simply
because ten years offers fewer chances to catch an extreme. The longer windows
are one click away when the fuller record is what you want.

### How accurate is this, actually?

Temperature, rainfall and snowfall are station observations, so for those the
honest answer is: as accurate as a NOAA thermometer a few miles from the house.
The page names the station and its distance for each measurement.

That is not where the project started. It started on ERA5 alone, and the
reanalysis was fine on monthly averages and badly wrong on anything counted
against a threshold. Measured over 2016–2025 against the station records:

| days ≥ 90°F per year | ERA5 said | stations measured |
|---|---|---|
| Rockaway, NJ | 14 | **30** |
| North Myrtle Beach, SC | 24 | 19 |
| Bonita Springs, FL | 13 | **80** |

Two of three homes wrong, one by a factor of six — and Rockaway's 14 is the
more instructive case, because 14 hot days a year is a perfectly plausible
number for New Jersey and nothing about it invited a second look. The cause is
that a threshold turns a small bias into a large error whenever it sits inside
the bulk of the distribution: ERA5's ~17 mile cell mixes land and sea, damping
the daily maximum by a couple of degrees, which barely moves an average.

No other model fixes it. `era5_land`, `era5_ensemble` and `ecmwf_ifs` all read
colder still at every home. Moving the query point inland fixes Bonita
spectacularly and ruins North Myrtle Beach, so it is a coincidence rather than a
fix. `scripts/investigate-hotdays.mjs` has the measurements.

The reanalysis is still measured against ground truth on every rebuild.
`scripts/validate-climate.mjs` compares NOAA NCEI monthly normals, `era5` and
`era5_land` over the **identical** 1991–2020 window, so model bias is isolated
from the real warming between periods, and writes `data/validation.json`. The
dashboard shows that comparison as the reason the model is not used for
temperature — not as a warning about the figures on the page, which are
measured.

The check runs in CI after every rebuild and never fails the build; a NOAA
outage should not block a good climate refresh.

**What is still model output, and still carries model error:** cloud cover,
sunshine and therefore sunny-day counts, humidity, dew point, wind, solar
radiation, evapotranspiration and sea-surface temperature. ERA5's sunshine is
threshold-based and reads optimistically; the sunny-day counts here should be
treated as an upper bound rather than a measurement.

### Units

Everything is imperial: °F, inches, miles, feet, mph, inHg.

Nothing assumes a unit. Open-Meteo declares its units in every response
(`current_units`, `hourly_units`, `daily_units`) and NWS tags each field with a
`unitCode`; `js/units.js` converts from whatever the API actually said. An
unrecognised unit yields "—" and a diagnostic entry rather than a number in the
wrong scale — visibility alone differs by 3.28× between metres and feet, and
both produce a plausible-looking mileage.

The sources panel lists the units received in that session, so the conversion is
inspectable rather than trusted.

### Redundancy

| If this fails | This takes over |
|---|---|
| Open-Meteo forecast | Nearest NWS station observation (chained `/points` → `/stations` → `/observations/latest`) |
| Open-Meteo marine model | NOAA CO-OPS tide gauge — and where both work, the gauge wins and the model is shown beside it as a cross-check |
| Precomputed normals | Built live in the browser, with the cost stated |
| NOAA validation | Skipped; the build still completes |

### How this is verified

The curated suites test what someone thought to test, which is how defects kept
surviving. `test/crawl.mjs` is mechanical instead: it reads the interactive
elements out of the DOM and exercises **all** of them — every tab, every option
of every dropdown, every button, every sortable column, every KPI card, a sample
of every chart's hover marks — in light and dark mode, at three viewport widths.
After each interaction it asserts the page did not throw, did not render a
placeholder, did not blank, and did not overflow. About 3,400 checks.

Its detectors are themselves verified by planting defects and confirming each is
caught. That process found the crawl was **half blind** on its first pass:

- `/\bNaN\b/` never matched, because `innerText` concatenates a label onto its
  value — a broken tile reads `HumidityNaN%`, and `y`/`N` are both word
  characters, so there is no boundary. It reported 3,057 passing checks against
  a page visibly displaying NaN.
- The JS-error window opened *after* the interaction had already run, so a
  handler that threw was never counted as a new error.
- `textContent` includes `<script>` contents, so the page's own inline JS
  tripped the "unrendered code" detector.

A test suite that has not been shown to fail has not been shown to work.

### Definitions used

| Term | Definition |
|---|---|
| Wet day | ≥ 0.04 in of precipitation — the WMO "rain day" threshold |
| Heavy rain day | ≥ 1 in of precipitation |
| Snow day | ≥ 0.1 in of snowfall |
| Sunny day | sunshine ≥ 70% of that day's daylight |
| Partly sunny / cloudy | 35–70% / below 35% |
| Beach day | high 75–95°F, under 0.04 in rain, sunshine ≥ 50% of daylight |
| Pleasant day | high 65–85°F, low ≥ 45°F, dry |
| HDD / CDD | degree days above and below a 65°F base |
| GDD | growing degree days above a 50°F base |

A month is only counted toward a monthly total if it has at least 25 days of
data, so a truncated month can never drag an average down.

### About Rockaway and the ocean

Rockaway is in Morris County — about **55 miles inland**, 538 ft above sea level.
There is no ocean at that home. Its ocean readings come from the Atlantic off
**Point Pleasant Beach**, the nearest shore point, and the page labels them that
way everywhere rather than implying otherwise.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure and all styling |
| `js/config.js` | Locations, the 51-measure catalogue, WMO weather codes |
| `js/solar.js` | NOAA sunrise / sunset / solar-noon / daylight equations |
| `js/api.js` | Open-Meteo access — retries, rate-limit backoff, chunking, diagnostics |
| `scripts/build-climate.mjs` | Precomputes `data/climate.json` (run monthly by CI) |
| `scripts/stations.mjs` | NOAA station selection and the observation merge — where temperature, rain and snow actually come from |
| `scripts/pipeline-version.mjs` | Fingerprints the code that builds the data, so stale numbers can be detected |
| `scripts/stamp-assets.mjs` | Content-hashes script URLs so a deploy is not served from cache |
| `scripts/validate-climate.mjs` | Measures the reanalysis against NOAA normals → `data/validation.json` |
| `js/radar.js` | WSR-88D site table and the geometry that picks each home's dish |
| `data/climate.json` | The committed normals the dashboard actually reads |
| `js/climate.js` | Turns raw daily records into monthly normals |
| `js/charts.js` | Hand-rolled SVG charts (no chart library) |
| `js/app.js` | State, rendering and wiring |
| `sw.js` | Service worker — PWA install and offline shell |
| `manifest.json`, `icon.svg` | PWA metadata and icon |
| `serve.py` | Local static server |
| `test/globals.mjs` | Guards against two js/ files declaring the same global — they share one scope |
| `test/units.mjs` | 49 assertions on every conversion factor, against NIST exact values |
| `test/unit.mjs` | 140 assertions on the aggregation maths |
| `test/stations.mjs` | The observation merge: what a blank means, what a missing gauge means |
| `test/freshness.mjs` | Catches published data that predates the code that builds it |
| `test/audit.mjs` | Reads back every rendered value and checks its unit and plausible range |
| `test/spot-check.mjs` | The real committed data against published climate values for these three places |
| `test/crawl.mjs` | Exhaustive interaction crawl — every tab, every dropdown option, every button, every column, in light and dark, at three widths |
| `test/e2e.mjs` | 146 browser assertions across 27 groups, against mocked Open-Meteo and NWS |
| `test/build-script.mjs` | 41 assertions on the precompute script, its quota maths and merge behaviour |
| `test/validate-script.mjs` | 13 assertions on the bias maths, including that the verdict flips when the models swap places |
| `scripts/validate-climate.mjs` | Cross-checks the reanalysis against NOAA station normals |
| `test/mock.mjs` | Synthetic API responses shaped like the real ones |

---

## Running locally

```bash
python serve.py          # http://localhost:8080
PORT=3000 python serve.py
```

A server is required — browsers block `fetch()` from `file://` URLs.

## Running the tests

```bash
node test/crawl.mjs                      # exhaustive interaction crawl (slow; --fast to sample)
node test/unit.mjs                       # aggregation maths, no network
node test/build-script.mjs               # precompute script + quota maths, mocked API
node test/validate-script.mjs           # NOAA-comparison maths, mocked sources
npm install --no-save playwright         # first time only
node test/e2e.mjs                        # full UI, mocked APIs
node test/e2e.mjs --headed               # watch it run
```

`test/e2e.mjs` intercepts every Open-Meteo request and serves synthetic data, so
the suite is deterministic and needs no internet. It covers boot, the live feed,
the forecast drill-down, the normals build, chart rendering and hover, month
selection, table sorting, the all-homes overview and its drill-down, the
comparison view, caching, CSV export, dark mode,
mobile layout, foreign time zones, rate-limit handling, the precomputed
snapshot path (asserting **zero** archive requests), and three failure modes
(everything down, marine down, archive down).

## Publishing

The site is served by GitHub's built-in Pages builder, straight from the
repository root on `main` (Settings → Pages → **Deploy from a branch**).
Push to `main` and the change is live within a minute or two — there is no
deploy workflow to maintain, because the dashboard is static files with no
build step.

`.nojekyll` is what stops Pages from running the site through Jekyll.

`.github/workflows/ci.yml` runs the unit tests on every push and pull
request. It does not deploy.

`.github/workflows/climate.yml` refreshes `data/climate.json` monthly.

## PWA install

The dashboard installs as a Progressive Web App. In Chrome or Edge, use the
install icon in the address bar. Once installed the shell works offline and the
cached normals still render; live conditions need a connection.

---

## Design notes

- **No chart library.** Every mark is SVG emitted by `js/charts.js`, so the page
  is dependency-free, works offline, and has nothing to keep up to date.
- **No dual-axis charts.** Two measures on different scales get two charts.
- **Colour follows the home, never its rank** — North Myrtle Beach is always
  blue, Bonita Springs always orange, Rockaway always aqua, whichever are shown.
  The three-colour set is validated for colour-vision deficiency in both light
  and dark mode (worst-pair CVD ΔE 9.2 light / 9.4 dark).
- **Dark mode is a selected palette**, stepped for the dark surface, not an
  inversion.
- **Failures are explained, never silent.** If the marine model is unavailable
  the ocean charts are hidden and a banner says why; if the archive rejects the
  extended variables those four charts disappear and everything else still
  builds.
