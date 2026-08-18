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
  /products/content/sec_bhavdata_full_*.csv -> every stock's close on a given day

Run: python fetch_data.py
"""
import csv
import io
import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import requests

import corporate_actions

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
MAP_FILE = BASE_DIR / "index_map.json"

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


def fetch_csv_rows(filename):
    r = requests.get(ARCHIVE.format(filename), headers=HEADERS, timeout=25)
    if r.status_code != 200 or "Symbol" not in r.text[:300]:
        raise RuntimeError(f"{filename} unavailable (HTTP {r.status_code})")
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

def build_stocks(members, closes, prev_closes, week52, today):
    stocks = []
    for m in members:
        close = closes.get(m["symbol"])
        prev = prev_closes.get(m["symbol"])
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

def main():
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

    print(f"Fetching price history for {len(LOOKBACKS)} lookbacks...", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=6) as pool:
        idx_now_future = pool.submit(index_closes_on, today)
        stk_now_future = pool.submit(stock_closes_on, today)
        wk52_future = pool.submit(week52_on, today)
        idx_hist_futures = {
            label: pool.submit(index_closes_on, today - timedelta(days=days))
            for label, days in LOOKBACKS
        }
        stk_hist_futures = {
            label: pool.submit(stock_closes_on, today - timedelta(days=days))
            for label, days in LOOKBACKS
        }

        index_now, index_date = idx_now_future.result()
        stock_now, stock_prev, bhav_date = stk_now_future.result()
        week52, wk52_date = wk52_future.result()
        index_hist = {label: f.result()[0] for label, f in idx_hist_futures.items()}
        stock_hist = {label: f.result()[0] for label, f in stk_hist_futures.items()}

    if not index_now or not stock_now:
        raise RuntimeError("Could not fetch current NSE archives")

    for label, _ in LOOKBACKS:
        if not index_hist[label]:
            print(f"  warning: no index archive for {label}", file=sys.stderr)

    def index_returns(index_name):
        now = index_now.get(index_name.upper())
        return {label: pct_change(now, index_hist[label].get(index_name.upper()))
                for label, _ in LOOKBACKS}

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
    hist_dates = {label: today - timedelta(days=days) for label, days in LOOKBACKS}

    def stock_returns(symbol):
        """Returns per window, on a split-adjusted basis."""
        now = stock_now.get(symbol)
        out = {}
        for label, _ in LOOKBACKS:
            raw = stock_hist[label].get(symbol)
            old = adjusted_price(symbol, raw, hist_dates[label].date(), actions)
            if raw is not None and old != raw:
                adjusted_count[label] += 1

            ret = pct_change(now, old)
            if not survives_sanity_check(symbol, ret, unreliable):
                out[label] = None
                dropped[label] += 1
                continue
            out[label] = ret
        return out

    benchmark_returns = index_returns(BENCHMARK)
    print(f"Benchmark {BENCHMARK}: "
          + ", ".join(f"{k} {v}%" for k, v in benchmark_returns.items() if v is not None),
          file=sys.stderr)

    bm_idx = indices.get(BENCHMARK, {})
    benchmark_range_pos = range_position(
        bm_idx.get("last"), bm_idx.get("yearHigh"), bm_idx.get("yearLow"))
    print(f"  52-week range position: {benchmark_range_pos}% "
          f"({len(week52)} stocks have 52-week levels)", file=sys.stderr)

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
        if not entry.get("csv"):
            return name, []
        try:
            rows = fetch_csv_rows(entry["csv"])
        except RuntimeError as e:
            print(f"  warning: {name}: {e}", file=sys.stderr)
            return name, []
        return name, [
            {"symbol": r["Symbol"].strip(),
             "company": r["Company Name"].strip(),
             "industry": r["Industry"].strip()}
            for r in rows
        ]

    with ThreadPoolExecutor(max_workers=8) as pool:
        members_by_index = dict(pool.map(load_members, wanted))

    for index_name, entry in wanted:
        idx = indices[index_name]
        stocks = build_stocks(members_by_index.get(index_name, []), stock_now, stock_prev,
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
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "stocks": stocks,
        }
        if not entry.get("csv"):
            sector["note"] = "NSE does not publish a constituent list for this index, " \
                             "so only index-level figures are available."
        sectors.append(sector)

    # Indices with no constituent CSV but a sensible industry stand-in.
    covered = {s["indexName"] for s in sectors}
    for index_name, industries in INDUSTRY_FALLBACK.items():
        if index_name in covered or index_name not in indices:
            continue
        idx = indices[index_name]
        members = [m for ind in industries for m in by_industry.get(ind, [])]
        stocks = build_stocks(members, stock_now, stock_prev, week52, today)
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
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "stocks": stocks,
            "note": f"Constituents shown are the {'/'.join(industries)} industry group.",
        })

    # --- 2. Industry groups -------------------------------------------------
    for industry, members in sorted(by_industry.items()):
        stocks = build_stocks(members, stock_now, stock_prev, week52, today)
        adv, dec, unch = breadth(stocks)

        per_stock = {m["symbol"]: stock_returns(m["symbol"]) for m in members}
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
            "lead": leadership(range_pos, stocks, benchmark_range_pos),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "stocks": stocks,
        })

    if adjusted_count:
        summary = ", ".join(f"{label} {n}" for label, n in sorted(adjusted_count.items()))
        print(f"Split/bonus adjusted prices: {summary}", file=sys.stderr)
    if dropped:
        summary = ", ".join(f"{label} {n}" for label, n in sorted(dropped.items()))
        print(f"Withheld (rights issue, not adjustable): {summary}", file=sys.stderr)

    print("Computing constituent overlaps...", file=sys.stderr)
    annotate_overlaps(sectors)

    sectors.sort(key=lambda s: -(s["rs"].get(DEFAULT_PERIOD) if s["rs"].get(DEFAULT_PERIOD) is not None else -9999))

    output = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "bhavDate": bhav_date.strftime("%d-%b-%Y") if bhav_date else None,
        "indexDate": index_date.strftime("%d-%b-%Y") if index_date else None,
        "week52Date": wk52_date.strftime("%d-%b-%Y") if wk52_date else None,
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
    main()
