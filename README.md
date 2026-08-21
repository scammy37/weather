# 🏡 Three Homes Weather Dashboard

Live weather and monthly climate normals for three homes, on one page.

| | | |
|---|---|---|
| 🏖️ **North Myrtle Beach, SC** | Atlantic coast | humid subtropical (Köppen Cfa) |
| 🌴 **Bonita Springs, FL** | Gulf coast | tropical savanna (Köppen Aw) |
| 🍂 **Rockaway, NJ** | Morris County highlands | humid continental (Köppen Dfa) |

Live site: **https://scammy37.github.io/weather**

---

## What's on the page

**⚡ Live conditions** — current temperature, feels-like, humidity, dew point, wind
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

**📊 Monthly climate normals** — 20 KPI cards and **33 charts** across eight
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
| ⚡ Energy & growing | heating degree days · cooling degree days · growing degree days · evapotranspiration |

**🔀 Compare all three homes** — pick any of the 48 measures and see all three
homes on one axis, plus a side-by-side table with annual totals.

**🗂️ Monthly data table** — all 48 measures in 49 columns, sortable by any
column, click a row to open that month. Exports to CSV with full provenance in
the header.

**🔌 Data sources & diagnostics** — every API request the page made, with status
and timing, so a missing chart is never a mystery.

---

## Where the numbers come from

Nothing on this page is hand-entered. Everything is fetched live in your browser
from [Open-Meteo](https://open-meteo.com/) — free, no API key, no account.

| Feed | Source |
|---|---|
| Current conditions, hourly and 7-day forecast | Open-Meteo Forecast API |
| Monthly normals | Open-Meteo Historical Weather API (ECMWF **ERA5** reanalysis) |
| Ocean temperature and waves | Open-Meteo Marine API |
| Air quality | Open-Meteo Air Quality API (CAMS), US AQI scale |
| Sunrise, sunset, solar noon, daylight | computed locally — NOAA solar equations |

The normals are built by pulling 15–30 years of **daily** ERA5 records for a
location and aggregating them in the browser. That takes a few seconds the first
time; the result is cached in `localStorage` for 30 days, so every later visit is
instant. **↻ Rebuild normals** forces a fresh pull.

Sunrise and sunset are calculated rather than fetched, using the NOAA solar
position equations, then converted to local wall-clock time with the browser's
IANA time-zone database — so daylight-saving transitions are exact. They were
verified against published times (New York, 21 Jun: 5:25 AM / 8:30 PM; London,
21 Jun: 4:43 AM / 9:21 PM).

### Normals periods

Pick one from the header of the climate section:

- **1991–2020** — the WMO standard 30-year normals period
- **1996–2025** — the latest full 30 years *(default)*
- **2011–2025** — the recent 15 years, useful for seeing how the climate has shifted

### Definitions used

| Term | Definition |
|---|---|
| Wet day | ≥ 0.04 in (1 mm) of precipitation — the WMO "rain day" threshold |
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
| `js/config.js` | Locations, the 48-measure catalogue, WMO weather codes |
| `js/solar.js` | NOAA sunrise / sunset / solar-noon / daylight equations |
| `js/api.js` | Open-Meteo access — retries, chunking, diagnostics, caching |
| `js/climate.js` | Turns raw daily records into monthly normals |
| `js/charts.js` | Hand-rolled SVG charts (no chart library) |
| `js/app.js` | State, rendering and wiring |
| `sw.js` | Service worker — PWA install and offline shell |
| `manifest.json`, `icon.svg` | PWA metadata and icon |
| `serve.py` | Local static server |
| `test/unit.mjs` | 71 assertions on the aggregation maths |
| `test/e2e.mjs` | 89 browser assertions across 20 groups, against a mocked Open-Meteo |
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
node test/unit.mjs                       # aggregation maths, no network
npm install --no-save playwright         # first time only
node test/e2e.mjs                        # full UI, mocked APIs
node test/e2e.mjs --headed               # watch it run
```

`test/e2e.mjs` intercepts every Open-Meteo request and serves synthetic data, so
the suite is deterministic and needs no internet. It covers boot, the live feed,
the forecast drill-down, the normals build, chart rendering and hover, month
selection, table sorting, the comparison view, caching, CSV export, dark mode,
mobile layout, foreign time zones, and three failure modes (everything down,
marine down, archive down).

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
