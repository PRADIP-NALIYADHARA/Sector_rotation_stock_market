# Sector Rotation Analysis — by Pradip

An interactive dashboard for tracking sector rotation in the Indian stock market (NSE).
Every sector is colour-coded by momentum: **green = bullish**, **red = bearish**, **yellow = moderate**.
Click into any sector to see its constituent stocks with the same colour coding.

## Features

- Market regime indicator in the header — risk-on or risk-off at a glance
- Complete coverage — 99 sectors across four groups, kept in separate sections
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

## Market regime — the header reading

The panel at the top of every page answers one question before you look at anything
else: is the market itself risk-on or risk-off?

It tracks **NIFTY Composite G-Sec ÷ NIFTY 50** against that ratio's own 30-day average.
Government bonds are where money goes when it leaves equities, so the ratio runs
roughly inverse to the market:

| Ratio vs its 30-day average | Reading  | Colour     |
|-----------------------------|----------|------------|
| well below                  | bullish  | dark green |
| near it                     | undecided| yellow     |
| well above                  | bearish  | dark red   |

Colour runs backwards to the number on purpose — a *low* ratio is the bullish one. Each
0.5% away from the average is another band, and the panel also shows how many days the
current side has held.

This is the same series you would get from `NSE:NIFTYGSCOMPOSITE/NSE:NIFTY` with an SMA
30 on TradingView.

## How bullish / bearish is decided

Put a sector and NIFTY 50 on one chart at the same percentage scale and see which
line ends up higher. That is the whole idea, and subtracting the two returns is the
same measurement:

```
relative strength = sector's return over the window − NIFTY 50's return over the same window
```

Above the benchmark → bullish. Below it → bearish. The size of the gap sets how deep
the colour is.

This matters because direction alone lies. On the data shipped here NIFTY IT was
**down 1.93% on the day** but **3.95% ahead of NIFTY 50 over a month** — a naive
"is it green today" reading calls that bearish when money has in fact been rotating
into it.

Pick the window from the **Over** dropdown: `1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y`. Every
card, the colours, the ranking and the filters all follow that choice, and it is
remembered between visits. A sector's detail page shows all eight windows at once —
its return, the benchmark's, and the gap — so you can see whether the lead is recent
or long-standing.

Returns are computed from NSE's own daily archives: `ind_close_all_DDMMYYYY.csv` for
index levels and the bhavcopy for stocks, pulled once per window. Industry groups have
no index, so their return is the equal-weighted average of the constituents' returns.

The benchmark is set by `BENCHMARK` in `fetch_data.py`, and the windows by `LOOKBACKS`.

## Spotting strength before the index confirms it

A sector often turns up while the index is still going sideways. To catch that, every
sector and stock carries its position in its own 52-week range — 0% at the low, 100%
at the high — and the benchmark's position is drawn on the same bar. The gap between
them is the leadership.

A sector is flagged **⚡ Leading breakout** when it sits at or above 90% of its own
52-week range while the benchmark is still below 80% of its. In other words: this one
is making new highs and the market is not.

Two things guard against being fooled by a single heavyweight dragging an index up:

- **Breadth of strength** — the share of a sector's constituents that are themselves
  within 5% of their own 52-week high.
- **Freshness** — the stock table shows the date each 52-week high was set, highlighted
  when it was set in the last ten days. A high from eleven months ago is not a breakout.

On the data shipped here NIFTY 50 sits at **47% of its 52-week range**, 8.4% below its
high — a textbook sideways market. Meanwhile India Defence is at **99.7%**, Auto at
**90.5%** with 40% of its stocks near their own highs, and Pharma at **92.2%**. Inside
Auto, BOSCHLTD is trading *above* its 52-week high with the high set days ago.

Use the **⚡ Leading breakout** filter to see only those. Thresholds live at the top of
`fetch_data.py` (`NEAR_HIGH_PCT`, `BREAKOUT_RANGE_POS`, `BENCHMARK_RANGEBOUND_POS`).

## Colour scale

Colour is banded, not bucketed: every *step* percent gets its own shade, sweeping
dark red → light red → yellow → light green → dark green. Nothing is hard-coded to a
fixed number of levels — change the step and the whole scale re-bands itself, legend
included.

The step is selectable at the top of the page (0.25% up to 10%) and is remembered
between visits. It applies to the **gap against the benchmark**, so match it to the
window you're looking at:

| Window        | Useful step |
|---------------|-------------|
| 1D            | 0.25% – 0.5% |
| 1W – 1M       | 0.5% – 2%    |
| 3M – 1Y       | 2% – 5%      |
| 3Y – 5Y       | 5% – 10%     |

Gaps over a single day are tiny, so a 5% step will paint the 1D view yellow — that is
the scale working, not a bug.

## Comparing — the same-% chart

Every card has a **+** button that adds it to the comparison tray at the bottom of the
screen. Pick as many as you like — two, five, a dozen — across any groups, then hit
**Compare**.

The comparison opens with the chart the rest of the app is a summary of: every series
rebased to 0% at the left edge, so the vertical distance between two lines *is* their
relative performance. Window runs from 1M to 5Y.

Two things it gives you that endpoint numbers cannot:

**Any baseline, not just NIFTY 50.** Comparing everything to the index tells you who is
beating the market, but the rotation decision is usually *old leader vs challenger*.
Set the baseline to NIFTY AUTO and the chart re-centres on it — now you can see who is
closing on the current leader.

**When the lines crossed.** Under the chart, each selection is listed with the date it
last crossed the baseline and how long ago that was, freshest first, with anything
inside 45 days flagged as a recent change. An old crossing means the lead is already
established; a fresh one means leadership is changing hands right now.

Below that sit the metric table (index level, every window's return and gap, breadth,
constituent count, best/worst stock) and a **shared-constituents matrix** showing how
many stocks each pair holds in common — the fastest way to see that two "different"
sectors are really the same bet.

Industry groups have no index of their own, so they can be compared in the tables but
not plotted on the chart.

## Splits and bonuses

The bhavcopy records the price actually traded that day, so a 10:2 split shows up as
an 80% overnight fall with nothing in the file to say why. Compare a pre-split close
against today's and a routine split reads as a collapse: ADANIPOWER split in September
2025 and its raw one-year "return" was **−66%** when the stock had in fact *risen*.

`corporate_actions.py` pulls NSE's corporate-actions feed and turns each split and
bonus into a price factor — `Face Value Split From Rs 10 To Rs 2` becomes 5, `Bonus 1:1`
becomes 2. Historical prices are divided by every factor that has gone ex since, which
puts them on today's scale.

This runs by itself. Every data refresh re-pulls the recent window and folds anything
new into the cache, so a split that goes ex this morning is known before any return
spanning it is computed — and if there is no cache at all, the multi-year backfill
happens automatically on the first run. Forthcoming actions are published ahead of
their ex-date, so upcoming ones land in the cache early too.

The script is still there for a manual rebuild or a deeper backfill:

```bash
python corporate_actions.py            # rebuild, last 6 years
python corporate_actions.py --years 8
```

Two things this does **not** silently paper over:

- **Rights issues** cannot be adjusted from their description — the correct factor needs
  the theoretical ex-rights price. Affected stocks are withheld from period returns
  rather than reported wrong.
- **Actions older than the cached window** are unknown, so a split from seven years ago
  will still distort a raw comparison against that date.

What was never affected: index levels, and therefore every chart, relative-strength
number and crossing in the app. NSE adjusts an index's divisor when a constituent
splits, so index series are continuous by construction. The 52-week highs and lows also
arrive pre-adjusted from NSE. Only stock-level multi-period returns ever needed this.

## Price history

The chart and crossings need a real series, not endpoints, so `build_history.py` caches
one from NSE's `ind_close_all` archives:

```bash
python build_history.py
```

Resolution is deliberately uneven — daily for the last seven months, which is where
crossings are decided and what the header's 30-day average needs, weekly out to three
years, monthly out to five. That keeps a five-year view of
every index to roughly 1.3 MB. The cache is incremental: the first build takes a few
minutes, after which only missing dates are fetched. Add `--rebuild` to start over.

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
app.py                local web server + /api/sectors, /api/history, /api/refresh
fetch_data.py         NSE fetcher, writes data/sectors_data.json
build_history.py      caches the index price series, writes data/index_history.json
corporate_actions.py  caches split/bonus factors, writes data/corporate_actions.json
discover_indices.py   maintenance: resolves index -> constituent CSV, writes index_map.json
build_snapshot.py     bundles everything into one standalone HTML file
index_map.json        generated mapping used by fetch_data.py
index.html            dashboard markup
css/style.css         styling and theming
js/app.js             rendering, filtering, drill-down, chart, refresh
data/                 cached JSON (regenerated on every update)
```

If NSE adds or renames an index, re-run the discovery step:

```bash
python discover_indices.py
```

## Disclaimer

For research and educational purposes only. Not investment advice.
