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
**Status:** not started · **Effort:** medium · **Data:** already have it

The standard sector-rotation picture: a quadrant chart plotting relative strength
against the *momentum of* that strength. Sectors travel clockwise through
Leading → Weakening → Lagging → Improving.

Right now the dashboard tells you who is ahead. This tells you which direction
they are travelling, so you see a leader losing steam before it drops, and a
laggard turning before it leads. That is the single biggest gap in what exists.

Needs only the price history already cached.

### 1.2 Is the lead widening or narrowing?
**Status:** not started · **Effort:** small · **Data:** already have it

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
**Status:** not started · **Effort:** small · **Data:** Yahoo (`fiftyDayAverage`, `twoHundredDayAverage`)

The most commonly quoted trend check. Above both and the 50 above the 200 is the
classic uptrend structure. Cheap to add as two columns and a filter.

### 1.6 What changed since last week
**Status:** not started · **Effort:** medium · **Data:** needs snapshot history

Keep a weekly snapshot of the rankings and show the movers: who entered the top
ten, who fell out, which sectors crossed the benchmark. Rotation is a change
story, and nothing currently remembers last week.

---

## 2. Fundamentals — the numbers you look up anyway

All of the following are reachable from Yahoo per stock. **One caveat that shapes
the design:** these come one request per symbol, so pulling all 750 on every
refresh is not realistic. The sane approach is to fetch them for a watchlist and
for whatever sector you have open, and cache for a week — fundamentals do not move
daily.

### 2.1 Valuation
**Status:** not started · **Effort:** medium

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
**Status:** not started · **Effort:** medium · **Data:** NSE index P/E, needs history

The index feed carries P/E per sector. Storing it daily builds a picture of
whether a sector is expensive *for itself*, which is the context missing when a
sector has run 40%.

---

## 3. Workflow — making it yours

### 3.1 Watchlist
**Status:** not started · **Effort:** small

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

1. **1.2** (RS slope) and **1.5** (moving averages) — small, and immediately useful
2. **3.1** (watchlist) — unlocks the fundamentals and alerts below it
3. **1.1** (RRG) — the biggest single addition to the research
4. **2.1** and **2.4** (valuation, earnings dates) — scoped to the watchlist
5. **1.6** (weekly change log) — most valuable once there is history to look back on
