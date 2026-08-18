# Sector Rotation Analysis — by Pradip

An interactive dashboard for tracking sector rotation in the Indian stock market (NSE).
Every sector is colour-coded by momentum: **green = bullish**, **red = bearish**, **yellow = moderate**.
Click into any sector to see its constituent stocks with the same colour coding.

## Features

- 14 NSE sectoral indices at a glance, sorted strongest → weakest
- Bullish / Moderate / Bearish classification with configurable thresholds
- Advance–decline breadth bar on every sector card
- Drill into a sector to see all its stocks with prev-close, close, and % change
- Search + filter on both the sector grid and the stock table
- **Update Data** button inside the site — triggers a live fetch from NSE, no terminal needed
- Dark / light theme, remembered between visits

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

## How the classification works

A sector or stock is classified on its daily percentage change:

| Signal   | Condition        |
|----------|------------------|
| Bullish  | `≥ +0.75%`       |
| Moderate | between the two  |
| Bearish  | `≤ -0.75%`       |

Thresholds live at the top of `fetch_data.py` (`BULLISH_THRESHOLD` / `BEARISH_THRESHOLD`) — change them there to tune sensitivity.

## Data sources

All data comes from public NSE India endpoints — no API key or login:

| Data | Source |
|------|--------|
| Sector index level & % change | `nseindia.com/api/allIndices` |
| Sector constituent stock lists | `nsearchives.nseindia.com/content/indices/*.csv` |
| Per-stock close / prev close | `nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv` (daily bhavcopy) |

Stock prices come from the daily bhavcopy, so stock-level figures reflect the **last completed
trading session**. Sector index figures are live during market hours.

## Project structure

```
app.py            local web server + /api/sectors and /api/refresh
fetch_data.py     NSE fetcher, writes data/sectors_data.json
index.html        dashboard markup
css/style.css     styling and theming
js/app.js         rendering, filtering, drill-down, refresh
data/             cached JSON (regenerated on every update)
```

## Disclaimer

For research and educational purposes only. Not investment advice.
