# Sector Rotation Analysis — by Pradip

An interactive dashboard for tracking sector rotation in the Indian stock market (NSE).
Every sector is colour-coded by momentum: **green = bullish**, **red = bearish**, **yellow = moderate**.
Click into any sector to see its constituent stocks with the same colour coding.

## Features

- Complete coverage — 97 sectors across four groups, kept in separate sections
- Banded colour scale with a selectable step, not a fixed set of buckets
- Compare any number of sectors, indices or themes side by side
- Today / 30-day / 1-year momentum on every card — rank by any of them
- Advance–decline breadth bar on every sector card
- Drill into a sector to see all its stocks with prev-close, close, and % change
- Overlap warnings so related indices aren't read as independent signals
- **Update Data** button inside the site — triggers a live fetch from NSE, no terminal needed
- Dark / light theme, remembered between visits

## Coverage

Everything is pulled from NSE's own index taxonomy, so new indices appear automatically.
Four groups, switchable with the group filter:

**Broad** — the standard benchmarks to compare everything against: NIFTY 50, Next 50,
100, 200, 500, Midcap 50/100/150, Smallcap 50/100/250, Midsmallcap 400, Microcap 250,
LargeMidcap 250, Total Market.

**Sectoral** — every sectoral index NSE publishes: Auto, Bank, IT, Pharma, FMCG, Metal,
Realty, Media, PSU Bank, Private Bank, Oil & Gas, Healthcare, Consumer Durables, Cement,
Chemicals and the rest.

**Thematic** — India Defence, Railways PSU, EV & New Age Automotive, Infrastructure,
Transportation & Logistics, Manufacturing, Energy, Digital, Tourism, Commodities,
Consumption, CPSE, PSE, MNC and more.

**Industry** — derived from the NIFTY 500 industry classification, so every industry in
the investable universe gets a bucket even when no index exists for it:
**Telecommunication, Power, Metals & Mining, Capital Goods, Construction, Construction
Materials, Textiles, Services, Diversified** and the others. Their % change is the
equal-weighted average of the constituent stocks.

## Overlap awareness

NSE indices deliberately overlap — NIFTY BANK, NIFTY PRIVATE BANK and NIFTY PSU BANK
hold many of the same banks, and every index overlaps its industry group. Read naively,
that looks like several independent signals when it is really one.

Each sector's detail view therefore lists the sectors it shares constituents with, how
many stocks are shared, and what share of *this* sector that represents. A sector whose
constituents sit entirely inside another is flagged **fully inside**. Click any of them
to jump straight across.

## Setup

Only one third-party package is needed:

```bash
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Then open http://127.0.0.1:5000 and click **Update Data**.

You can also refresh the data from the command line:

```bash
python fetch_data.py
```

## Standalone snapshot

To get a copy that opens by double-clicking — no server, no Python, no internet —
build a self-contained HTML file with the CSS, JS and current data all inlined:

```bash
python build_snapshot.py
```

It writes `sector_rotation_snapshot.html`. Everything works in it except **Update
Data**, since there is no server behind it: the figures are frozen at whatever the
last refresh fetched. Handy for sharing a view or checking it on a machine without
Python.

## Colour scale

Colour is banded, not bucketed: every *step* percent gets its own shade, sweeping
dark red → light red → yellow → light green → dark green. Nothing is hard-coded to a
fixed number of levels — change the step and the whole scale re-bands itself, legend
included.

The step is selectable at the top of the page (0.25% up to 10%) and is remembered
between visits. Pick it to match what you're reading:

| Looking at        | Useful step |
|-------------------|-------------|
| Today's move      | 0.25% – 0.5% |
| 30-day momentum   | 2% – 5%      |
| 1-year momentum   | 5% – 10%     |

A single day rarely moves a sector more than ±2%, so a 5% step will paint most of the
daily column yellow — that is the scale working, not a bug. Drop to 0.5% for the daily
view.

## Comparing

Every card has a **+** button that adds it to the comparison tray at the bottom of the
screen. Pick as many as you like — two, five, a dozen — across any groups, then hit
**Compare**. You get:

- a metric table: index level, today / 30-day / 1-year change, advances, declines,
  constituent count, best and worst stock
- a **shared-constituents matrix** showing how many stocks each pair holds in common,
  which is the fastest way to see that two "different" sectors are really the same bet

## Data sources

All data comes from public NSE India endpoints — no API key or login:

| Data | Source |
|------|--------|
| Index level & % change (today, 30d, 1y) | `nseindia.com/api/allIndices` |
| Which indices are Sectoral / Thematic | `nseindia.com/api/equity-master` |
| Constituent stock lists | `nsearchives.nseindia.com/content/indices/*.csv` |
| Industry classification | `nsearchives.nseindia.com/content/indices/ind_nifty500list.csv` |
| Per-stock close / prev close | `nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv` (daily bhavcopy) |

Stock prices come from the daily bhavcopy, so stock-level figures reflect the **last completed
trading session**. Sector index figures are live during market hours.

NSE's per-symbol quote API is blocked to scripted clients, which is why the bhavcopy
is used for stock-level prices instead.

## Project structure

```
app.py                local web server + /api/sectors and /api/refresh
fetch_data.py         NSE fetcher, writes data/sectors_data.json
discover_indices.py   maintenance: resolves index -> constituent CSV, writes index_map.json
index_map.json        generated mapping used by fetch_data.py
index.html            dashboard markup
css/style.css         styling and theming
js/app.js             rendering, filtering, drill-down, refresh
data/                 cached JSON (regenerated on every update)
```

If NSE adds or renames an index, re-run the discovery step:

```bash
python discover_indices.py
```

## Disclaimer

For research and educational purposes only. Not investment advice.
