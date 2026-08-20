"""
Fetches NSE sector data and writes it to data/sectors_data.json.

The signal is relative strength, not raw direction. Putting a sector and NIFTY 50
on the same percentage scale over some lookback and asking which line sits higher
is the same as subtracting their returns, so every sector carries
`rs[period] = its return - the benchmark's return`. Positive means it is beating
the market over that window; negative means it is lagging. A sector that is up
1% on a day the market is up 2% is losing ground, and a raw "is it green today"
reading would miss that.

Sectors come from two complementary sources so nothing is missed:

  1. Official NSE indices (Broad + Sectoral + Thematic) -- index level and returns
     straight from NSE.
  2. Industry groups derived from the NIFTY 500 industry classification -- covers
     areas with no dedicated index, e.g. Telecommunication, Power, Capital Goods.
     Their returns are the equal-weighted average of the constituent stocks.

Data sources (all public, no login):
  /api/allIndices                          -> live index level, advances/declines
  /api/equity-master                       -> which indices are Sectoral / Thematic
  /content/indices/*.csv                   -> constituent stock lists
  /content/indices/ind_close_all_*.csv     -> every index's close on a given day
  /content/CM_52_wk_High_low_*.csv         -> adjusted 52-week highs and lows
  Yahoo (via prices.py)                    -> stock prices, adjusted and intraday
  /products/content/sec_bhavdata_full_*.csv -> stock prices when Yahoo is unavailable

NSE stays the source for indices because it publishes all 84 sectoral and thematic
ones, which Yahoo does not carry. Yahoo is the better source for stocks: adjusted
closes going back decades, and today's price while the session is still open.

Run: python fetch_data.py
"""
import csv
import io
import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

import change_log
import corporate_actions
import market_ticker
import prices

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
STOCKS_FILE = BASE_DIR / "data" / "stocks.json"
MAP_FILE = BASE_DIR / "index_map.json"
VALUATION_FILE = BASE_DIR / "data" / "valuation_history.json"
HISTORY_FILE = BASE_DIR / "data" / "index_history.json"

# Written by a full refresh, reused by the live one. Constituent lists change a
# few times a year and long price history only changes when a day closes, so an
# intraday refresh has no reason to pull either again.
CACHE_MEMBERS = BASE_DIR / "data" / "constituents.json"
CACHE_PRICES = BASE_DIR / "data" / "price_book.json"

# Today's closes, written by the live refresh and overlaid on the book above.
#
# The live job used to load the whole book, merge into it and write it back. Run
# every five minutes it would inevitably start before a full rebuild finished and
# save its stale copy afterwards, silently undoing the rebuild -- which is how the
# price book kept its weekly-only history through three full runs. Keeping the two
# in separate files means the live job can never clobber the long history.
LIVE_PRICES = BASE_DIR / "data" / "live_prices.json"

# The yardstick every sector is measured against.
BENCHMARK = "NIFTY 50"

# Lookback windows, in calendar days. Each costs two archive downloads.
LOOKBACKS = [
    ("1D", 1),
    ("1W", 7),
    ("1M", 30),
    ("3M", 91),
    ("6M", 182),
    ("1Y", 365),
    ("3Y", 1095),
    ("5Y", 1826),
]
DEFAULT_PERIOD = "1M"

# Widest list NSE publishes (~750 names) so industry groups cover small caps too.
UNIVERSE_CSVS = ["ind_niftytotalmarket_list.csv", "ind_nifty500list.csv"]

# "Near its 52-week high" tolerance, and how range-bound the benchmark must be
# for a sector clearing its own high to count as leading the market.
NEAR_HIGH_PCT = 5.0
BREAKOUT_RANGE_POS = 90.0
BENCHMARK_RANGEBOUND_POS = 80.0

# A few official indices publish no constituent CSV. Where an industry bucket is
# an honest stand-in, borrow its members so the card is still drillable.
INDUSTRY_FALLBACK = {
    "NIFTY CEMENT": ["Construction Materials"],
    "NIFTY CHEMICALS": ["Chemicals"],
}

# Strategy/screening baskets rather than sectors or themes.
EXCLUDED_INDICES = {
    "NIFTY100 LIQUID 15",
    "NIFTY MIDCAP LIQUID 15",
    "NIFTY IPO",
    "NIFTY SME EMERGE",
    "NIFTY SHARIAH 25",
    "NIFTY50 SHARIAH",
    "NIFTY500 SHARIAH",

    # A weighting rule or a corporate-group screen, not a sector. The same
    # stocks already appear elsewhere; only the weighting formula differs, so
    # these say nothing about rotation and NSE publishes no constituent list.
    "NIFTY INDIA CORPORATE GROUP INDEX - TATA GROUP 25% CAP",
    "NIFTY INDIA SELECT 5 CORPORATE GROUPS (MAATR)",
    "NIFTY CONGLOMERATE 50",
    "NIFTY500 MULTICAP INDIA MANUFACTURING 50:30:20",
    "NIFTY500 MULTICAP INFRASTRUCTURE 50:30:20",
    "NIFTY500 MULTICAP 50:25:25",
    "NIFTY500 LARGEMIDSMALL EQUAL-CAP WEIGHTED",
    "NIFTY MIDSMALLCAP400 50:50",
    "NIFTY INDIA FPI 150",
    "NIFTY100 ESG",
    "NIFTY100 ENHANCED ESG",

    # A narrower cut of an index whose constituents are already on the board,
    # named in the comment beside each.
    "NIFTY500 HEALTHCARE",              # NIFTY HEALTHCARE INDEX, NIFTY PHARMA
    "NIFTY MIDSMALL FINANCIAL SERVICES",  # NIFTY FINANCIAL SERVICES
    "NIFTY FINANCIAL SERVICES 25/50",   # NIFTY FINANCIAL SERVICES, capped
    "NIFTY MIDSMALL IT & TELECOM",      # NIFTY IT
    "NIFTY REITS & REALTY",             # NIFTY REALTY
    "NIFTY SMALLCAP 500",               # NIFTY SMALLCAP 250 / 100
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

NSE_REFERER = {"Referer": "https://www.nseindia.com/market-data/live-equity-market"}
ARCHIVE = "https://nsearchives.nseindia.com/content/indices/{}"
BHAV_URL = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{}.csv"
WK52_URL = "https://nsearchives.nseindia.com/content/CM_52_wk_High_low_{}.csv"


# --------------------------------------------------------------------- helpers

def pct_change(now, then):
    if now is None or then is None or not then:
        return None
    return round((now / then - 1) * 100, 2)


def pretty_name(index_name):
    """'NIFTY INDIA DEFENCE' -> 'India Defence'; 'NIFTY 50' stays 'Nifty 50'."""
    name = index_name
    for prefix in ("NIFTY500 ", "NIFTY50 ", "NIFTY100 ", "NIFTY200 ", "NIFTY "):
        if name.startswith(prefix):
            candidate = name[len(prefix):]
            # Dropping the prefix from "NIFTY 50" would leave a bare "50".
            name = name if candidate[:1].isdigit() else candidate
            break
    if name.endswith(" INDEX"):
        name = name[: -len(" INDEX")]
    return name.title().replace(" And ", " & ")


def make_session():
    session = requests.Session()
    session.headers.update(HEADERS)
    session.get("https://www.nseindia.com/", timeout=15)
    return session


def fetch_csv_rows(source):
    """Constituent rows from a bare NSE archive filename or a full URL.

    NSE's archive covers most indices, but a good many thematic ones are only
    published by NSE Indices themselves, on a different host under a different
    path -- hence the full-URL form.
    """
    url = source if source.startswith("http") else ARCHIVE.format(source)
    r = requests.get(url, headers=HEADERS, timeout=25)
    if r.status_code != 200 or "Symbol" not in r.text[:300]:
        raise RuntimeError(f"{source} unavailable (HTTP {r.status_code})")
    return list(csv.DictReader(io.StringIO(r.text)))


# ------------------------------------------------------------- archive lookups

def index_closes_on(day, max_back=8):
    """Every index's close on `day`, stepping back over weekends and holidays."""
    for back in range(max_back):
        d = day - timedelta(days=back)
        url = ARCHIVE.format(f"ind_close_all_{d.strftime('%d%m%Y')}.csv")
        try:
            r = requests.get(url, headers=HEADERS, timeout=25)
        except requests.RequestException:
            continue
        if r.status_code != 200 or "Index Name" not in r.text[:100]:
            continue
        closes = {}
        for row in csv.DictReader(io.StringIO(r.text)):
            try:
                closes[row["Index Name"].strip().upper()] = float(row["Closing Index Value"])
            except (ValueError, KeyError):
                pass
        return closes, d
    return {}, None


def stock_closes_on(day, max_back=8):
    """Every EQ stock's close on `day`, stepping back over non-trading days."""
    for back in range(max_back):
        d = day - timedelta(days=back)
        try:
            r = requests.get(BHAV_URL.format(d.strftime("%d%m%Y")), headers=HEADERS, timeout=35)
        except requests.RequestException:
            continue
        if r.status_code != 200 or "SYMBOL" not in r.text[:200]:
            continue
        closes, prev = {}, {}
        for raw in csv.DictReader(io.StringIO(r.text)):
            row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in raw.items()}
            if row.get("SERIES") != "EQ":
                continue
            try:
                closes[row["SYMBOL"]] = float(row["CLOSE_PRICE"])
                prev[row["SYMBOL"]] = float(row["PREV_CLOSE"])
            except (ValueError, KeyError):
                pass
        return closes, prev, d
    return {}, {}, None


def week52_on(day, max_back=8):
    """
    Adjusted 52-week high/low per stock, with the dates they were set.

    The date matters: a high set last week means the stock is breaking out now,
    while one from eleven months ago means it has been drifting since.
    """
    for back in range(max_back):
        d = day - timedelta(days=back)
        try:
            r = requests.get(WK52_URL.format(d.strftime("%d%m%Y")), headers=HEADERS, timeout=30)
        except requests.RequestException:
            continue
        if r.status_code != 200 or "SYMBOL" not in r.text[:2000]:
            continue

        text = r.text
        start = text.index('"SYMBOL"')          # skip the disclaimer preamble
        levels = {}
        for row in csv.DictReader(io.StringIO(text[start:])):
            if row.get("SERIES", "").strip() != "EQ":
                continue

            def num(key):
                raw = (row.get(key) or "").strip()
                try:
                    return float(raw)
                except ValueError:
                    return None

            def when(key):
                raw = (row.get(key) or "").strip()
                try:
                    return datetime.strptime(raw, "%d-%b-%Y")
                except ValueError:
                    return None

            high, low = num("Adjusted_52_Week_High"), num("Adjusted_52_Week_Low")
            if high is None or low is None:
                continue
            levels[row["SYMBOL"].strip()] = {
                "high": high,
                "low": low,
                "highDate": when("52_Week_High_Date"),
                "lowDate": when("52_Week_Low_DT"),
            }
        return levels, d
    return {}, None


def adjusted_price(symbol, old_price, on_date, actions):
    """
    An old bhavcopy close brought onto today's scale.

    Bhavcopy records the price actually traded, so a 10:2 split shows up as an
    80% overnight fall. Dividing by every split/bonus factor that has gone ex
    since makes the two prices comparable.
    """
    if old_price is None:
        return None
    factor = corporate_actions.factor_since(actions.get(symbol), on_date)
    return old_price / factor if factor != 1.0 else old_price


def survives_sanity_check(symbol, ret, unreliable):
    """
    Backstop for actions the feed can't express as a ratio.

    Rights issues move the price without a factor that can be derived from their
    description, so a stock that had one is not trusted for period returns rather
    than being quietly reported wrong.
    """
    if ret is None:
        return True
    if symbol in unreliable:
        return False
    return -95 < ret < 5000


def range_position(last, high, low):
    """Where price sits in its 52-week range: 0 = at the low, 100 = at the high."""
    if None in (last, high, low) or high <= low:
        return None
    return round((last - low) / (high - low) * 100, 1)


def pct_from_high(last, high):
    if None in (last, high) or not high:
        return None
    return round((last - high) / high * 100, 2)


def fetch_all_indices(session):
    r = session.get("https://www.nseindia.com/api/allIndices", timeout=20, headers=NSE_REFERER)
    r.raise_for_status()
    return {d["index"]: d for d in r.json()["data"]}


def fetch_universe():
    """Stock -> industry map used for the industry-group sectors."""
    for filename in UNIVERSE_CSVS:
        try:
            rows = fetch_csv_rows(filename)
        except RuntimeError:
            continue
        universe = {}
        for row in rows:
            symbol = row["Symbol"].strip()
            universe[symbol] = {
                "symbol": symbol,
                "company": row["Company Name"].strip(),
                "industry": row["Industry"].strip(),
            }
        print(f"Universe: {len(universe)} stocks from {filename}", file=sys.stderr)
        return universe
    raise RuntimeError("Could not fetch a universe CSV for industry classification")


# ------------------------------------------------------------------- assembly

def build_stocks(members, close_of, prev_of, week52, today):
    stocks = []
    for m in members:
        close = close_of(m["symbol"])
        prev = prev_of(m["symbol"])
        levels = week52.get(m["symbol"], {})
        high, low = levels.get("high"), levels.get("low")
        high_date = levels.get("highDate")
        from_high = pct_from_high(close, high)

        stocks.append({
            "symbol": m["symbol"],
            "company": m["company"],
            "industry": m.get("industry", ""),
            "close": close,
            "prevClose": prev,
            "pChange": pct_change(close, prev),
            "high52": high,
            "low52": low,
            "rangePos": range_position(close, high, low),
            "fromHigh": from_high,
            "highDate": high_date.strftime("%d-%b-%Y") if high_date else None,
            "daysSinceHigh": (today - high_date).days if high_date else None,
            "nearHigh": from_high is not None and from_high >= -NEAR_HIGH_PCT,
        })
    stocks.sort(key=lambda s: (s["pChange"] is None, -(s["pChange"] or 0)))
    return stocks


def load_valuation():
    """
    Index P/E, P/B and yield through time, keyed by index name, with the span
    the readings cover.

    The span is taken from the dates rather than counted off the readings: the
    history is sampled daily near the present and monthly at the far end, so
    the number of points says nothing about how far back they reach.
    """
    if not VALUATION_FILE.exists():
        print("  note: valuation_history.json missing - run build_history.py",
              file=sys.stderr)
        return {}, None
    raw = json.loads(VALUATION_FILE.read_text(encoding="utf-8"))
    dates = raw.get("dates") or []
    years = None
    if len(dates) >= 2:
        first = date.fromisoformat(dates[0])
        last = date.fromisoformat(dates[-1])
        years = round((last - first).days / 365.25, 1)
    return raw.get("indices", {}), years


def valuation(index_name, idx, history, span_years):
    """
    Today's multiples, and where the P/E sits in the index's own past.

    A sector leading on price at the top of its own valuation range is a very
    different proposition from one leading at the bottom of it, and that is a
    question no amount of price history can answer.
    """
    # The live feed hands these back as strings, the archive as numbers.
    def number(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    pe, pb, dy = number(idx.get("pe")), number(idx.get("pb")), number(idx.get("dy"))
    out = {"pe": pe, "pb": pb, "dy": dy,
           "pePercentile": None, "peMedian": None, "peLow": None, "peHigh": None,
           "years": None}

    past = [v for v in (history.get(index_name, {}).get("pe") or []) if v]
    if pe and len(past) >= 60:
        below = sum(1 for v in past if v < pe)
        out.update({
            "pePercentile": round(100 * below / len(past)),
            "peMedian": round(sorted(past)[len(past) // 2], 2),
            "peLow": round(min(past), 2),
            "peHigh": round(max(past), 2),
            "years": span_years,
        })
    return out


def trend_breadth(stocks, ma_of):
    """
    How much of a sector is actually in an uptrend.

    Advances and declines describe one session; the share of a sector trading
    above its 200-day average describes the trend the session sits inside.
    """
    above50 = above200 = rated50 = rated200 = 0
    for s in stocks:
        ma = ma_of(s["symbol"])
        if ma.get("fromMa50") is not None:
            rated50 += 1
            above50 += ma["fromMa50"] > 0
        if ma.get("fromMa200") is not None:
            rated200 += 1
            above200 += ma["fromMa200"] > 0
    return {
        "above50Pct": round(100 * above50 / rated50) if rated50 else None,
        "above200Pct": round(100 * above200 / rated200) if rated200 else None,
        "rated": rated200,
    }


def breadth(stocks):
    adv = sum(1 for s in stocks if (s["pChange"] or 0) > 0)
    dec = sum(1 for s in stocks if (s["pChange"] or 0) < 0)
    return adv, dec, len(stocks) - adv - dec


def average(values, digits=2):
    rated = [v for v in values if v is not None]
    return round(sum(rated) / len(rated), digits) if rated else None


def leadership(range_pos, stocks, benchmark_range_pos):
    """
    Is this sector clearing its own 52-week high while the market is still stuck
    in its range? That is the setup where a sector turns up before the index
    does -- strength showing before the benchmark confirms it.

    Breadth is the honest half of it: one heavyweight at a high can drag an index
    up on its own, so the share of constituents near their own highs matters.
    """
    near = [s for s in stocks if s["nearHigh"]]
    rated = [s for s in stocks if s["fromHigh"] is not None]
    near_pct = round(len(near) / len(rated) * 100) if rated else None

    fresh = [s["daysSinceHigh"] for s in near if s["daysSinceHigh"] is not None]
    breaking_out = (
        range_pos is not None
        and range_pos >= BREAKOUT_RANGE_POS
        and (benchmark_range_pos is None or benchmark_range_pos < BENCHMARK_RANGEBOUND_POS)
    )

    return {
        "rangePos": range_pos,
        "nearHighPct": near_pct,
        "nearHighCount": len(near),
        "ratedCount": len(rated),
        "medianDaysSinceHigh": min(fresh) if fresh else None,
        "leadGap": None if range_pos is None or benchmark_range_pos is None
                   else round(range_pos - benchmark_range_pos, 1),
        "breakingOut": breaking_out,
    }


# NSE's own market-cap ranking, which is what AMFI's classification rests on:
# NIFTY 100 is the top 100 by market cap, MIDCAP 150 the next 150, and so on.
# Membership is already downloaded, so the bands cost nothing extra.
CAP_BANDS = [
    ("Large", "NIFTY 100"),
    ("Mid", "NIFTY MIDCAP 150"),
    ("Small", "NIFTY SMALLCAP 250"),
    ("Micro", "NIFTY MICROCAP 250"),
]


def cap_bands(members_by_index):
    """symbol -> Large / Mid / Small / Micro, first band wins."""
    bands, seen = {}, set()
    for label, index_name in CAP_BANDS:
        for member in members_by_index.get(index_name, []):
            symbol = member["symbol"]
            if symbol not in seen:
                seen.add(symbol)
                bands[symbol] = label
    return bands


def moving_averages(series, today):
    """
    50 and 200-day averages, and how far price sits from each.

    Computed from the price history already cached rather than asked of Yahoo per
    symbol, which would be a quarter of an hour for the universe.
    """
    if not series:
        return {}
    closes = [series[day] for day in sorted(series)]
    last = closes[-1]

    out = {"ma50": None, "ma200": None, "fromMa50": None, "fromMa200": None}
    for window, key in ((50, "ma50"), (200, "ma200")):
        if len(closes) < window:
            continue
        avg = sum(closes[-window:]) / window
        out[key] = round(avg, 2)
        out["from" + key.capitalize()] = round((last / avg - 1) * 100, 2)
    return out


def rs_momentum(rs):
    """
    Is the lead widening or narrowing?

    The recent month's gap against the benchmark, minus the average monthly gap
    over three. Positive means the sector is pulling away faster than it has been;
    negative means it is still ahead but losing ground -- the difference between a
    leader worth holding and one worth leaving.
    """
    near, far = rs.get("1M"), rs.get("3M")
    if near is None or far is None:
        return None
    return round(near - far / 3, 2)


def relative_strength(returns, benchmark_returns):
    """How far a sector's line sits above the benchmark's on a same-% chart."""
    rs = {}
    for label, _ in LOOKBACKS:
        mine, theirs = returns.get(label), benchmark_returns.get(label)
        rs[label] = None if mine is None or theirs is None else round(mine - theirs, 2)
    return rs


def annotate_overlaps(sectors, max_related=4, min_share=0.30):
    """
    NSE indices overlap by design -- NIFTY BANK, PRIVATE BANK and PSU BANK share
    constituents, and every index overlaps its industry group. Record that so
    three views of the same banks aren't read as three independent signals.
    """
    symbol_sets = {s["indexName"]: {st["symbol"] for st in s["stocks"]} for s in sectors}

    for sector in sectors:
        mine = symbol_sets[sector["indexName"]]
        if not mine:
            sector["related"] = []
            continue

        related = []
        for other in sectors:
            if other["indexName"] == sector["indexName"]:
                continue
            # Every sector sits inside NIFTY 500 / Total Market by construction,
            # so broad benchmarks say nothing about genuine duplication.
            if other["group"] == "Broad" and sector["group"] != "Broad":
                continue
            theirs = symbol_sets[other["indexName"]]
            if not theirs:
                continue
            shared = len(mine & theirs)
            if not shared:
                continue
            share = shared / len(mine)
            if share < min_share:
                continue
            related.append({
                "name": other["name"],
                "indexName": other["indexName"],
                "group": other["group"],
                "shared": shared,
                "shareOfThis": round(share * 100),
                "subsetOfThat": shared == len(mine),
            })

        related.sort(key=lambda r: (-r["shareOfThis"], -r["shared"]))
        sector["related"] = related[:max_related]


# ----------------------------------------------------------------------- main

def main(live=False):
    """
    live=False rebuilds everything from NSE's archives -- the daily job.
    live=True reuses the cached constituent lists and price history and only
    re-reads what actually moves during a session: index levels and prices.
    """
    print("Connecting to NSE...", file=sys.stderr)
    session = make_session()

    print("Fetching index levels...", file=sys.stderr)
    indices = fetch_all_indices(session)

    print("Fetching industry universe...", file=sys.stderr)
    universe = fetch_universe()
    by_industry = defaultdict(list)
    for stock in universe.values():
        by_industry[stock["industry"]].append(stock)

    today = datetime.now()

    label = "live" if live else "full"
    print(f"Fetching price history for {len(LOOKBACKS)} lookbacks ({label} refresh)...",
          file=sys.stderr)
    with ThreadPoolExecutor(max_workers=6) as pool:
        idx_now_future = pool.submit(index_closes_on, today)
        wk52_future = pool.submit(week52_on, today)
        idx_hist_futures = {
            key: pool.submit(index_closes_on, today - timedelta(days=days))
            for key, days in LOOKBACKS
        }
        # The bhavcopy is only a fallback for Yahoo, and it is the slowest thing
        # here, so an intraday refresh skips it entirely.
        stk_now_future = None if live else pool.submit(stock_closes_on, today)
        stk_hist_futures = {} if live else {
            key: pool.submit(stock_closes_on, today - timedelta(days=days))
            for key, days in LOOKBACKS
        }

        index_now, index_date = idx_now_future.result()
        week52, wk52_date = wk52_future.result()
        index_hist = {key: f.result()[0] for key, f in idx_hist_futures.items()}

        if live:
            stock_now, stock_prev, bhav_date = {}, {}, None
            stock_hist = {key: {} for key, _ in LOOKBACKS}
        else:
            stock_now, stock_prev, bhav_date = stk_now_future.result()
            stock_hist = {key: f.result()[0] for key, f in stk_hist_futures.items()}

    if not index_now:
        raise RuntimeError("Could not fetch the current NSE index archive")

    for key, _ in LOOKBACKS:
        if not index_hist[key]:
            print(f"  warning: no index archive for {key}", file=sys.stderr)

    def index_level(index_name):
        """
        Live level where NSE gives one, the last published close otherwise.

        The ind_close_all archive for today only appears after the session ends,
        so during market hours it holds yesterday's close -- which would leave
        index returns a day behind the stock prices sitting next to them.
        """
        live_level = (indices.get(index_name) or {}).get("last")
        return live_level if live_level else index_now.get(index_name.upper())

    def index_returns(index_name):
        now = index_level(index_name)
        return {key: pct_change(now, index_hist[key].get(index_name.upper()))
                for key, _ in LOOKBACKS}

    # Pulled on every refresh: a split that goes ex today has to be known before
    # any return spanning it is computed, or the number is quietly wrong.
    print("Refreshing corporate actions...", file=sys.stderr)
    try:
        ca, added = corporate_actions.ensure_fresh(session=session)
        if added:
            print(f"  {added} new split/bonus events picked up", file=sys.stderr)
    except Exception as e:
        print(f"  warning: could not refresh corporate actions ({e}); using cache",
              file=sys.stderr)
        ca = corporate_actions.load()

    actions, unreliable = ca.get("actions", {}), ca.get("unreliable", {})
    if not actions:
        print("  note: no corporate actions available - split-affected stocks will "
              "read wrong", file=sys.stderr)
    else:
        print(f"Corporate actions: {sum(len(v) for v in actions.values())} adjustments "
              f"across {len(actions)} symbols", file=sys.stderr)

    adjusted_count = defaultdict(int)
    dropped = defaultdict(int)
    sourced = defaultdict(int)
    hist_dates = {label: today - timedelta(days=days) for label, days in LOOKBACKS}

    # Filled in once the constituent lists are known; empty means Yahoo is
    # unavailable and everything falls back to the bhavcopy.
    yahoo = {}

    def price_now(symbol):
        last, _ = prices.latest_two(yahoo.get(symbol, {}))
        return last if last is not None else stock_now.get(symbol)

    def price_prev(symbol):
        _, prev = prices.latest_two(yahoo.get(symbol, {}))
        return prev if prev is not None else stock_prev.get(symbol)

    def stock_returns(symbol):
        """
        Returns per window, always on a split-adjusted basis.

        Yahoo's closes arrive already adjusted, so they are used as they are.
        Only the bhavcopy fallback gets the corporate-action factors applied --
        adjusting Yahoo's numbers again would divide the split out twice.
        """
        series = yahoo.get(symbol, {})
        now = price_now(symbol)
        out = {}

        for label, _ in LOOKBACKS:
            old = prices.close_on_or_before(series, hist_dates[label].date()) if series else None
            from_yahoo = old is not None

            if from_yahoo:
                sourced["yahoo"] += 1
            else:
                raw = stock_hist[label].get(symbol)
                old = adjusted_price(symbol, raw, hist_dates[label].date(), actions)
                if raw is not None:
                    sourced["nse"] += 1
                    if old != raw:
                        adjusted_count[label] += 1

            ret = pct_change(now, old)
            # Rights issues are only unreadable in the raw bhavcopy; Yahoo's
            # series already accounts for them, so withholding those symbols
            # applies to the fallback alone.
            if not survives_sanity_check(symbol, ret, {} if from_yahoo else unreliable):
                out[label] = None
                dropped[label] += 1
                continue
            out[label] = ret
        return out

    # Worked out once per symbol and reused. Industry groups average these, and
    # the stock table needs them per name, so computing them twice would be silly.
    _returns_cache = {}

    def returns_for(symbol):
        if symbol not in _returns_cache:
            _returns_cache[symbol] = stock_returns(symbol)
        return _returns_cache[symbol]

    benchmark_returns = index_returns(BENCHMARK)
    print(f"Benchmark {BENCHMARK}: "
          + ", ".join(f"{k} {v}%" for k, v in benchmark_returns.items() if v is not None),
          file=sys.stderr)

    bm_idx = indices.get(BENCHMARK, {})
    benchmark_range_pos = range_position(
        bm_idx.get("last"), bm_idx.get("yearHigh"), bm_idx.get("yearLow"))
    print(f"  52-week range position: {benchmark_range_pos}% "
          f"({len(week52)} stocks have 52-week levels)", file=sys.stderr)

    valuation_history, valuation_years = load_valuation()

    index_map = {}
    if MAP_FILE.exists():
        index_map = json.loads(MAP_FILE.read_text(encoding="utf-8")).get("indices", {})
    else:
        print("  note: index_map.json missing - run discover_indices.py", file=sys.stderr)

    sectors = []

    # --- 1. Official NSE indices -------------------------------------------
    wanted = [
        (name, entry) for name, entry in index_map.items()
        if name not in EXCLUDED_INDICES and name in indices
    ]
    print(f"Fetching constituents for {len(wanted)} indices...", file=sys.stderr)

    def load_members(item):
        name, entry = item
        source = entry.get("csv") or entry.get("altCsv")
        if not source:
            return name, []
        try:
            rows = fetch_csv_rows(source)
        except RuntimeError as e:
            print(f"  warning: {name}: {e}", file=sys.stderr)
            return name, []
        # The provider's files head the name column "Company Name" -- except for
        # the odd one that just says "Company".
        return name, [
            {"symbol": r["Symbol"].strip(),
             "company": (r.get("Company Name") or r.get("Company") or "").strip(),
             "industry": (r.get("Industry") or "").strip()}
            for r in rows if r.get("Symbol")
        ]

    cached_members = {}
    if live and CACHE_MEMBERS.exists():
        cached_members = json.loads(CACHE_MEMBERS.read_text(encoding="utf-8"))

    if cached_members:
        members_by_index = cached_members
        print(f"Reusing cached constituents for {len(members_by_index)} indices",
              file=sys.stderr)
    else:
        with ThreadPoolExecutor(max_workers=8) as pool:
            members_by_index = dict(pool.map(load_members, wanted))
        CACHE_MEMBERS.parent.mkdir(exist_ok=True)
        CACHE_MEMBERS.write_text(json.dumps(members_by_index), encoding="utf-8")

    # Every symbol the dashboard will show, so Yahoo is asked once rather than
    # per sector -- constituent lists overlap heavily.
    needed = {s for members in members_by_index.values() for s in
              (m["symbol"] for m in members)}
    needed |= set(universe)

    if live and CACHE_PRICES.exists():
        # Long history is settled once a day has closed; only today moves.
        yahoo = json.loads(CACHE_PRICES.read_text(encoding="utf-8"))
        print(f"Refreshing today's prices for {len(needed)} symbols...", file=sys.stderr)

        recent_all = prices.fetch_live(needed)
        for symbol, recent in recent_all.items():
            yahoo.setdefault(symbol, {}).update(recent)
        print(f"  Yahoo covered {len(yahoo)}/{len(needed)} symbols", file=sys.stderr)

        # Only the few days just fetched are saved -- never the whole book.
        if recent_all:
            LIVE_PRICES.parent.mkdir(exist_ok=True)
            LIVE_PRICES.write_text(json.dumps(recent_all), encoding="utf-8")
    else:
        print(f"Fetching adjusted prices for {len(needed)} symbols from Yahoo...",
              file=sys.stderr)
        yahoo = prices.fetch(needed)
        if yahoo:
            print(f"  Yahoo covered {len(yahoo)}/{len(needed)} symbols", file=sys.stderr)
        else:
            print("  Yahoo unavailable - falling back to the NSE bhavcopy", file=sys.stderr)

        if yahoo:
            CACHE_PRICES.parent.mkdir(exist_ok=True)
            CACHE_PRICES.write_text(json.dumps(yahoo), encoding="utf-8")
            # The rebuild supersedes anything the live job had layered on top.
            LIVE_PRICES.unlink(missing_ok=True)

    # A full run that happened while this was assembling would have rewritten the
    # book; layering the live file on top keeps today's prices either way.
    if live and LIVE_PRICES.exists():
        for symbol, recent in json.loads(LIVE_PRICES.read_text(encoding="utf-8")).items():
            yahoo.setdefault(symbol, {}).update(recent)

    for index_name, entry in wanted:
        idx = indices[index_name]
        stocks = build_stocks(members_by_index.get(index_name, []), price_now, price_prev,
                              week52, today)
        adv, dec, unch = breadth(stocks)
        returns = index_returns(index_name)
        range_pos = range_position(idx.get("last"), idx.get("yearHigh"), idx.get("yearLow"))

        sector = {
            "name": pretty_name(index_name),
            "indexName": index_name,
            "group": entry.get("group", "Sectoral"),
            "source": "index",
            "isBenchmark": index_name == BENCHMARK,
            "last": idx.get("last"),
            "pChange": idx.get("percentChange"),
            "high52": idx.get("yearHigh"),
            "low52": idx.get("yearLow"),
            "fromHigh": pct_from_high(idx.get("last"), idx.get("yearHigh")),
            "returns": returns,
            "rs": relative_strength(returns, benchmark_returns),
            "rsMomentum": rs_momentum(relative_strength(returns, benchmark_returns)),
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "valuation": valuation(index_name, idx, valuation_history,
                                   valuation_years),
            "stocks": stocks,
        }
        if not stocks:
            sector["note"] = ("No constituent list is published for this "
                              "index, so only index-level figures are available.")
        sectors.append(sector)

    # Indices with no constituent CSV but a sensible industry stand-in.
    #
    # These are already in `sectors` -- carrying index-level figures and an empty
    # stock list -- so the fallback fills them in place. It used to skip anything
    # already present, which silently meant it never ran at all once indices
    # without a CSV started being included.
    existing = {s["indexName"]: s for s in sectors}
    for index_name, industries in INDUSTRY_FALLBACK.items():
        if index_name not in indices:
            continue

        current = existing.get(index_name)
        if current is not None and current["stocks"]:
            continue                      # a real constituent list turned up

        members = [m for ind in industries for m in by_industry.get(ind, [])]
        if not members:
            continue

        stocks = build_stocks(members, price_now, price_prev, week52, today)
        adv, dec, unch = breadth(stocks)
        note = f"Constituents shown are the {'/'.join(industries)} industry group."

        if current is not None:
            current.update({
                "stocks": stocks,
                "advances": adv, "declines": dec, "unchanged": unch,
                "lead": leadership(current["lead"]["rangePos"], stocks, benchmark_range_pos),
                "note": note,
            })
            continue
        idx = indices[index_name]
        members = [m for ind in industries for m in by_industry.get(ind, [])]
        stocks = build_stocks(members, price_now, price_prev, week52, today)
        adv, dec, unch = breadth(stocks)
        returns = index_returns(index_name)
        range_pos = range_position(idx.get("last"), idx.get("yearHigh"), idx.get("yearLow"))
        sectors.append({
            "name": pretty_name(index_name),
            "indexName": index_name,
            "group": "Sectoral",
            "source": "index",
            "isBenchmark": False,
            "last": idx.get("last"),
            "pChange": idx.get("percentChange"),
            "high52": idx.get("yearHigh"),
            "low52": idx.get("yearLow"),
            "fromHigh": pct_from_high(idx.get("last"), idx.get("yearHigh")),
            "returns": returns,
            "rs": relative_strength(returns, benchmark_returns),
            "rsMomentum": rs_momentum(relative_strength(returns, benchmark_returns)),
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "stocks": stocks,
            "note": f"Constituents shown are the {'/'.join(industries)} industry group.",
        })

    # --- 2. Industry groups -------------------------------------------------
    for industry, members in sorted(by_industry.items()):
        stocks = build_stocks(members, price_now, price_prev, week52, today)
        adv, dec, unch = breadth(stocks)

        per_stock = {m["symbol"]: returns_for(m["symbol"]) for m in members}
        returns = {
            label: average([r[label] for r in per_stock.values()])
            for label, _ in LOOKBACKS
        }
        # How much of the group actually made it into each average.
        coverage = {
            label: sum(1 for r in per_stock.values() if r[label] is not None)
            for label, _ in LOOKBACKS
        }
        # No index to read a level off, so the group's range position is the
        # average of where its constituents sit in their own ranges.
        range_pos = average([s["rangePos"] for s in stocks], digits=1)

        sectors.append({
            "name": industry,
            "indexName": f"Industry group - {len(stocks)} stocks, equal-weighted",
            "group": "Industry",
            "source": "industry",
            "isBenchmark": False,
            "last": None,
            "pChange": average([s["pChange"] for s in stocks]),
            "high52": None,
            "low52": None,
            "fromHigh": average([s["fromHigh"] for s in stocks]),
            "returns": returns,
            "coverage": coverage,
            "memberCount": len(members),
            "rs": relative_strength(returns, benchmark_returns),
            "rsMomentum": rs_momentum(relative_strength(returns, benchmark_returns)),
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "stocks": stocks,
        })

    if sourced:
        total = sum(sourced.values()) or 1
        print(f"Price lookups: {sourced['yahoo']} from Yahoo "
              f"({sourced['yahoo'] * 100 // total}%), {sourced['nse']} from NSE",
              file=sys.stderr)
    if adjusted_count:
        summary = ", ".join(f"{label} {n}" for label, n in sorted(adjusted_count.items()))
        print(f"Split/bonus adjusted (NSE fallback only): {summary}", file=sys.stderr)
    if dropped:
        summary = ", ".join(f"{label} {n}" for label, n in sorted(dropped.items()))
        print(f"Withheld (rights issue, not adjustable): {summary}", file=sys.stderr)

    # --- 3. Per-stock detail -------------------------------------------------
    # Kept in its own file rather than on the sector entries: a stock belongs to
    # six sectors on average, so returns and relative strength inlined there
    # would be stored six times over.
    print("Building per-stock strength...", file=sys.stderr)
    bands = cap_bands(members_by_index)
    stock_detail = {}
    for sector in sectors:
        for stock in sector["stocks"]:
            symbol = stock["symbol"]
            entry = stock_detail.get(symbol)
            if entry is None:
                returns = returns_for(symbol)
                entry = {
                    "symbol": symbol,
                    "company": stock["company"],
                    "industry": stock["industry"],
                    "close": stock["close"],
                    "prevClose": stock["prevClose"],
                    "pChange": stock["pChange"],
                    "high52": stock["high52"],
                    "low52": stock["low52"],
                    "rangePos": stock["rangePos"],
                    "fromHigh": stock["fromHigh"],
                    "highDate": stock["highDate"],
                    "daysSinceHigh": stock["daysSinceHigh"],
                    "nearHigh": stock["nearHigh"],
                    "returns": returns,
                    "rs": relative_strength(returns, benchmark_returns),
                    "rsMomentum": rs_momentum(relative_strength(returns, benchmark_returns)),
                    "capBand": bands.get(symbol),
                    **moving_averages(yahoo.get(symbol), today),
                    "sectors": [],
                    # Every index the stock belongs to, broad ones included, so a
                    # screener can be pointed at "NIFTY 500" rather than only at
                    # a sector.
                    "indices": [],
                }
                stock_detail[symbol] = entry
            # Which sectors a stock sits in is the quickest way to see whether a
            # name is a pure play or is being carried by a broader theme.
            entry["indices"].append(sector["indexName"])
            if sector["group"] != "Broad":
                entry["sectors"].append(sector["indexName"])

    # Trend breadth needs the moving averages, which only exist once the stock
    # detail above has been built -- hence the second pass over the sectors.
    def ma_of(symbol):
        return stock_detail.get(symbol, {})

    for sector in sectors:
        sector["trend"] = trend_breadth(sector["stocks"], ma_of)
        # The synthesised industry groups have no NSE index behind them, so no
        # multiples either. They still carry the key, so nothing downstream has
        # to ask whether it is there.
        sector.setdefault("valuation", {"pe": None, "pb": None, "dy": None,
                                        "pePercentile": None, "peMedian": None,
                                        "peLow": None, "peHigh": None, "years": None})

    STOCKS_FILE.parent.mkdir(exist_ok=True)
    STOCKS_FILE.write_text(json.dumps({
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "benchmark": {"indexName": BENCHMARK, "name": pretty_name(BENCHMARK),
                      "returns": benchmark_returns, "rangePos": benchmark_range_pos},
        "periods": [key for key, _ in LOOKBACKS],
        "stocks": stock_detail,
    }), encoding="utf-8")
    print(f"  {len(stock_detail)} stocks written to {STOCKS_FILE.name}", file=sys.stderr)

    print("Computing constituent overlaps...", file=sys.stderr)
    annotate_overlaps(sectors)

    sectors.sort(key=lambda s: -(s["rs"].get(DEFAULT_PERIOD) if s["rs"].get(DEFAULT_PERIOD) is not None else -9999))

    # Runs on live refreshes too: the strip is the one part of the page that is
    # meant to be current, and it is four symbols, not a universe.
    print("Building the ticker strip...", file=sys.stderr)
    # Hand the strip NSE's own figures for the benchmark, so the drawdown it
    # shows is the one the rest of the page shows rather than a close-basis
    # approximation of it.
    bm = indices.get(BENCHMARK, {})
    ticker_rows = market_ticker.build(official={
        "^NSEI": {"last": bm.get("last"),
                  "high52": bm.get("yearHigh"),
                  "low52": bm.get("yearLow")},
    })

    # What moved in the rankings. Recomputed from the cached history rather than
    # recorded as we go, so it works from the first run rather than after a
    # month of accumulating snapshots.
    changes = None
    if HISTORY_FILE.exists():
        try:
            changes = change_log.build(
                json.loads(HISTORY_FILE.read_text(encoding="utf-8")),
                sectors, BENCHMARK)
            if changes:
                moved = sum(len(period[k])
                            for scope in changes["scopes"].values()
                            for period in scope["since"].values()
                            for k in ("entered", "left"))
                print(f"  change log: {len(changes['scopes'])} groups, "
                      f"{moved} entries and exits", file=sys.stderr)
        except Exception as e:
            print(f"  change log unavailable: {e}", file=sys.stderr)

    output = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "bhavDate": (bhav_date.strftime("%d-%b-%Y") if bhav_date
                     else (index_date.strftime("%d-%b-%Y") if index_date else None)),
        "refreshMode": "live" if live else "full",
        "indexDate": index_date.strftime("%d-%b-%Y") if index_date else None,
        "week52Date": wk52_date.strftime("%d-%b-%Y") if wk52_date else None,
        "priceSource": "yahoo" if sourced.get("yahoo") else "nse",
        "priceCoverage": {"yahoo": sourced.get("yahoo", 0), "nse": sourced.get("nse", 0)},
        "benchmark": {
            "indexName": BENCHMARK,
            "name": pretty_name(BENCHMARK),
            "returns": benchmark_returns,
            "rangePos": benchmark_range_pos,
            "high52": bm_idx.get("yearHigh"),
            "low52": bm_idx.get("yearLow"),
            "fromHigh": pct_from_high(bm_idx.get("last"), bm_idx.get("yearHigh")),
        },
        "thresholds": {
            "nearHighPct": NEAR_HIGH_PCT,
            "breakoutRangePos": BREAKOUT_RANGE_POS,
            "benchmarkRangeboundPos": BENCHMARK_RANGEBOUND_POS,
        },
        "periods": [label for label, _ in LOOKBACKS],
        "defaultPeriod": DEFAULT_PERIOD,
        "ticker": ticker_rows,
        "changes": changes,
        "sectors": sectors,
    }

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(output, indent=2), encoding="utf-8")

    counts = defaultdict(int)
    for s in sectors:
        counts[s["group"]] += 1
    summary = ", ".join(f"{v} {k.lower()}" for k, v in sorted(counts.items()))
    print(f"Saved {len(sectors)} sectors ({summary}) to {DATA_FILE}", file=sys.stderr)
    return output


if __name__ == "__main__":
    main(live="--live" in sys.argv)
