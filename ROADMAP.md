# Roadmap

Ideas for where this could go next. Nothing here is committed — tick, reorder,
delete, or add your own. Each item says what it would give you, where the data
comes from, and roughly what it costs to build, so you can judge which are worth
it rather than taking my word for it.

Everything listed has been checked against data that is actually reachable for
free at this scale. Anything that isn't, is in **Not worth doing** at the bottom
with the reason.

---

## 1. Research depth — where the real edge is

### 1.1 Relative Rotation Graph (RRG)
**Status:** done · **Effort:** medium · **Data:** already have it

The standard sector-rotation picture: a quadrant chart plotting relative strength
against the *momentum of* that strength. Sectors travel clockwise through
Leading → Weakening → Lagging → Improving.

Right now the dashboard tells you who is ahead. This tells you which direction
they are travelling, so you see a leader losing steam before it drops, and a
laggard turning before it leads. That is the single biggest gap in what exists.

Needs only the price history already cached.

### 1.2 Is the lead widening or narrowing?
**Status:** done · **Effort:** small · **Data:** already have it

Every RS figure is a snapshot. A sector +8% ahead and slipping is a different
trade from one +8% ahead and pulling away. Adding the slope of RS over the last
few weeks — and an arrow on each card — answers that without opening a chart.

### 1.3 Volume confirmation on breakouts
**Status:** not started · **Effort:** small · **Data:** Yahoo volume, NSE bhavcopy

A 52-week high on thin volume is a different animal from one on twice the average.
Flagging breakouts where volume is meaningfully above its own average would cut
the false ones out of the ⚡ list.

### 1.4 Delivery percentage
**Status:** not started · **Effort:** small · **Data:** NSE bhavcopy (`DELIV_PER`)

Already sitting in a file being downloaded every day and thrown away. High
delivery means buyers are taking the shares, not day-trading them — a rising
delivery percentage alongside a breakout is a genuine confirmation, and it is
specific to Indian market data.

### 1.5 Distance from 50 / 200-day moving average
**Status:** done · **Effort:** small · **Data:** computed from the cached price history

The most commonly quoted trend check. Above both and the 50 above the 200 is the
classic uptrend structure. Cheap to add as two columns and a filter.

### 1.6 What changed since last week
**Status:** done · **Effort:** medium · **Data:** the cached index history

Who entered the top ten, who fell out, who crossed the benchmark, against a week
ago and a month ago.

No snapshots are kept. Past rankings are recomputed from the cached closes with
the same relative-strength arithmetic anchored to an older date, so it worked
from the first run instead of after a month of accumulating, and losing the
state file costs nothing.

### 1.7 Does the signal work?
**Status:** done · **Effort:** medium · **Data:** the cached index history

`backtest.py`. Replays the history, ranks sectors exactly as the board does,
holds the top few for a month, repeats -- and sweeps every lookback window
against every basket size, which is how you find out which window carries
information rather than assuming it.

The answer so far, on long-established indices only (`--core`): a 6-month
window holding three to five sectors beat the benchmark by roughly 8-13% a year
over five years, winning about two months in three. Holding a **single** sector
on a 1-month window -- closest to what the board's default view suggests --
**lost** to the benchmark, with a 35% drawdown.

Read the caveats in the file before trusting any of it. On the full board every
configuration wins, which is the shape a result takes when several of the
indices were launched recently and back-computed: the theme is in the ranking
years before anyone could have bought it.

### 1.8 Is the data still sane?
**Status:** done · **Effort:** small · **Data:** what the last refresh produced

`health_check.py`, run after every refresh. Three times this pipeline kept
running while quietly producing something wrong and it was found by hand days
later. It now flags sectors that lost their stocks, indices that lost their
level, stale data, and counts that shrank against the last good run -- once, to
Telegram.

---

## 2. Fundamentals — the numbers you look up anyway

All of the following are reachable from Yahoo per stock. **One caveat that shapes
the design:** these come one request per symbol, so pulling all 750 on every
refresh is not realistic. The sane approach is to fetch them for a watchlist and
for whatever sector you have open, and cache for a week — fundamentals do not move
daily.

### 2.0 Market-cap filter
**Status:** done · **Effort:** small · **Data:** NSE index membership

Large / Mid / Small / Micro per stock, so a list can be cut down to "the large caps
in NIFTY 500". This needs no extra fetching at all: NSE's own ranking is already
expressed by index membership -- NIFTY 100 is the top hundred by market cap,
MIDCAP 150 the next hundred and fifty, and so on down to MICROCAP 250. That is the
same basis AMFI's classification uses, and it covers 752 of the 755 names.

An exact rupee market cap is a separate matter: Yahoo has it, but one request per
symbol, about sixteen minutes for the universe. Worth doing weekly for a watchlist,
not on every refresh.

### 2.1 Valuation
**Status:** done (index level) · **Effort:** medium

P/E (trailing and forward), P/B, dividend yield, market cap. Index-level P/E, P/B
and yield also come free with the NSE index feed already in use, so a sector can
be shown against its own valuation rather than only its price.

### 2.2 Quality and leverage
**Status:** not started · **Effort:** medium

Return on equity, debt-to-equity, profit margin. Enough to separate a breakout in
a sound business from one in a leveraged story.

### 2.3 Growth
**Status:** not started · **Effort:** medium

Revenue and earnings growth, quarterly financials. Pairs naturally with momentum —
price leadership backed by earnings growth is a different conviction level from
price leadership alone.

### 2.4 Earnings calendar
**Status:** not started · **Effort:** small

Next earnings date per stock, plus the ex-dividend date. Knowing a name reports in
three days changes whether you take the breakout now or wait.

### 2.5 Sector valuation vs its own history
**Status:** done · **Effort:** medium · **Data:** NSE index P/E, five years of it

The index feed carries P/E per sector, and so does the daily archive file
`build_history.py` was already downloading -- so five years of it came free
rather than needing to be accumulated. Each sector now shows where its P/E sits
in its own range: Auto leads on price at the 95th percentile of its own history,
IT leads at the 10th.

---

## 3. Workflow — making it yours

### 3.1 Watchlists
**Status:** done · **Effort:** small

Several named lists rather than one, each editable.

Star stocks and sectors; a view showing only those, with the same strength and
breakout columns. Also the natural scope for fundamentals and alerts, given the
per-symbol cost above.

### 3.2 Notes
**Status:** not started · **Effort:** small

A free-text note per sector and per stock — why you flagged it, what you are
waiting for. Research is worth little if the reasoning is gone a month later.

### 3.3 Export
**Status:** not started · **Effort:** small

Any table to CSV, for when you want to work in Excel.

### 3.4 Alerts on what you actually hold
**Status:** not started · **Effort:** small

Telegram alerts currently cover sectors. Extending them to watchlist stocks —
crossing the benchmark, hitting a 52-week high, earnings due — is a small step
once the watchlist exists.

---

## 4. Not worth doing, and why

**All-time-high detection at stock level.** Dropped deliberately. Yahoo reaches
back decades, but the further back you go the more corporate actions are unaccounted
for, and a wrong ATH flag is worse than none. Sector-level multi-year highs are
safe, since index levels carry no split problem — that one is still open if wanted.

**Alpha Vantage or similar free APIs.** The free tier is roughly 25 requests a day
against a 750-stock universe. A single refresh would take a month.

**Intraday minute data.** Yahoo serves it for short windows only, and this is a
rotation tool — decisions here are made on daily and weekly closes, not ticks.

**Broker or order integration.** Out of scope: this is research, and it should stay
something that cannot place a trade.

---

## Suggested order

If it were me:

Everything above the line is done. What is left, in the order I would take it:

1. **3.1 server-side watchlist** — it lives in browser storage, so it is per-device
   and invisible to the alerting layer. Moving it unlocks watchlist stock alerts,
   including the 3% rule that is deliberately off for the full universe.
2. **1.4 delivery percentage** — India-specific, and the bhavcopy carrying it is
   already downloaded every morning and discarded.
3. **1.3 volume confirmation** — the same archive file carries index volume and
   turnover, so the sector-level version is nearly free.
4. **2.4 earnings dates** — cheap, and changes whether you take a breakout now.
