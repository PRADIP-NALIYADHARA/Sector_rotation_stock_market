"""
Fetches live NSE sector and stock data and writes it to data/sectors_data.json.

Sectors come from two complementary sources so that nothing is missed:

  1. Official NSE indices (Sectoral + Thematic) -- authoritative index level and
     % change straight from NSE, e.g. NIFTY AUTO, NIFTY INDIA DEFENCE.
  2. Industry groups derived from the NIFTY 500 industry classification --
     covers areas that have no dedicated tradeable index, e.g. Telecommunication,
     Power, Metals & Mining, Capital Goods.

Data sources (all public, no login required):
  /api/allIndices                          -> live index level and % change
  /api/equity-master                       -> which indices are Sectoral / Thematic
  /content/indices/*.csv                   -> constituent stock lists
  /products/content/sec_bhavdata_full_*.csv -> per-stock close / prev close

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

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
MAP_FILE = BASE_DIR / "index_map.json"

# Five-level classification on % change, strongest first. Tune to taste.
#   strong-bullish  dark green
#   bullish         light green
#   neutral         yellow
#   bearish         light red
#   strong-bearish  dark red
STRONG_BULLISH = 1.50
BULLISH_THRESHOLD = 0.40
BEARISH_THRESHOLD = -0.40
STRONG_BEARISH = -1.50

# Universe used for the industry-group sectors, tried in order.
UNIVERSE_CSVS = ["ind_nifty500list.csv", "ind_niftytotalmarketlist.csv"]

# A few official indices publish no constituent CSV. Where an industry bucket is
# an honest stand-in, borrow its members so the card is still drillable.
INDUSTRY_FALLBACK = {
    "NIFTY CEMENT": ["Construction Materials"],
    "NIFTY CHEMICALS": ["Chemicals"],
}

# Indices that are strategy/screening baskets rather than sectors or themes.
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


def classify(pct_change):
    """Five-level signal: strong-bullish .. strong-bearish."""
    if pct_change is None:
        return "neutral"
    if pct_change >= STRONG_BULLISH:
        return "strong-bullish"
    if pct_change >= BULLISH_THRESHOLD:
        return "bullish"
    if pct_change <= STRONG_BEARISH:
        return "strong-bearish"
    if pct_change <= BEARISH_THRESHOLD:
        return "bearish"
    return "neutral"


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


def fetch_all_indices(session):
    r = session.get("https://www.nseindia.com/api/allIndices", timeout=20, headers=NSE_REFERER)
    r.raise_for_status()
    return {d["index"]: d for d in r.json()["data"]}


def fetch_csv_rows(filename):
    r = requests.get(ARCHIVE.format(filename), headers=HEADERS, timeout=20)
    if r.status_code != 200 or "Symbol" not in r.text[:300]:
        raise RuntimeError(f"{filename} unavailable (HTTP {r.status_code})")
    return list(csv.DictReader(io.StringIO(r.text)))


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
    raise RuntimeError("Could not fetch any universe CSV for industry classification")


def fetch_bhavcopy():
    """Latest daily bhavcopy; steps back to skip weekends and holidays."""
    for days_back in range(0, 8):
        day = datetime.now() - timedelta(days=days_back)
        url = (
            "https://nsearchives.nseindia.com/products/content/"
            f"sec_bhavdata_full_{day.strftime('%d%m%Y')}.csv"
        )
        r = requests.get(url, headers=HEADERS, timeout=30)
        if r.status_code != 200 or "SYMBOL" not in r.text[:200]:
            continue

        reader = csv.DictReader(io.StringIO(r.text))
        prices = {}
        for raw in reader:
            row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in raw.items()}
            if row.get("SERIES") != "EQ":
                continue
            try:
                prev_close = float(row["PREV_CLOSE"])
                close = float(row["CLOSE_PRICE"])
                pchange = ((close - prev_close) / prev_close * 100) if prev_close else None
            except (ValueError, KeyError, ZeroDivisionError):
                prev_close = close = pchange = None
            prices[row["SYMBOL"]] = {
                "close": close,
                "prevClose": prev_close,
                "pChange": round(pchange, 2) if pchange is not None else None,
            }
        return prices, day.strftime("%d-%b-%Y")
    raise RuntimeError("No NSE bhavcopy found in the last 8 days")


def build_stocks(members, prices):
    """Attach prices and a signal to a list of {symbol, company, industry}."""
    stocks = []
    for m in members:
        price = prices.get(m["symbol"], {})
        pchange = price.get("pChange")
        stocks.append({
            "symbol": m["symbol"],
            "company": m["company"],
            "industry": m.get("industry", ""),
            "close": price.get("close"),
            "prevClose": price.get("prevClose"),
            "pChange": pchange,
            "status": classify(pchange),
        })
    stocks.sort(key=lambda s: (s["pChange"] is None, -(s["pChange"] or 0)))
    return stocks


def breadth(stocks):
    adv = sum(1 for s in stocks if (s["pChange"] or 0) > 0)
    dec = sum(1 for s in stocks if (s["pChange"] or 0) < 0)
    return adv, dec, len(stocks) - adv - dec


def annotate_overlaps(sectors, max_related=4, min_share=0.30):
    """
    Many NSE indices deliberately overlap -- NIFTY BANK, NIFTY PRIVATE BANK and
    NIFTY PSU BANK share constituents, and every index overlaps its industry
    group. Record that on each sector so the UI can warn instead of the reader
    mistaking three views of the same banks for three independent signals.
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
            # so broad benchmarks say nothing about genuine sector duplication.
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

    print("Fetching daily bhavcopy...", file=sys.stderr)
    prices, bhav_date = fetch_bhavcopy()

    index_map = {}
    if MAP_FILE.exists():
        index_map = json.loads(MAP_FILE.read_text(encoding="utf-8")).get("indices", {})
    else:
        print("  note: index_map.json missing - run discover_indices.py for constituents",
              file=sys.stderr)

    sectors = []

    # --- 1. Official NSE broad / sectoral / thematic indices -----------------
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
        stocks = build_stocks(members_by_index.get(index_name, []), prices)
        adv, dec, unch = breadth(stocks)
        pchange = idx.get("percentChange")

        sectors.append({
            "name": pretty_name(index_name),
            "indexName": index_name,
            "group": entry.get("group", "Sectoral"),
            "source": "index",
            "last": idx.get("last"),
            "pChange": pchange,
            "pChange30d": idx.get("perChange30d"),
            "pChange365d": idx.get("perChange365d"),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "status": classify(pchange),
            "stocks": stocks,
        })

    # Indices with no constituent CSV but a sensible industry stand-in.
    covered = {s["indexName"] for s in sectors}
    for index_name, industries in INDUSTRY_FALLBACK.items():
        if index_name in covered or index_name not in indices:
            continue
        idx = indices[index_name]
        members = [m for ind in industries for m in by_industry.get(ind, [])]
        stocks = build_stocks(members, prices)
        adv, dec, unch = breadth(stocks)
        pchange = idx.get("percentChange")
        sectors.append({
            "name": pretty_name(index_name),
            "indexName": index_name,
            "group": "Sectoral",
            "source": "index",
            "last": idx.get("last"),
            "pChange": pchange,
            "pChange30d": idx.get("perChange30d"),
            "pChange365d": idx.get("perChange365d"),
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "status": classify(pchange),
            "stocks": stocks,
            "note": f"Constituents shown are the {'/'.join(industries)} industry group.",
        })

    # --- 2. Industry groups (complete coverage of the universe) -------------
    for industry, members in sorted(by_industry.items()):
        stocks = build_stocks(members, prices)
        rated = [s["pChange"] for s in stocks if s["pChange"] is not None]
        avg = round(sum(rated) / len(rated), 2) if rated else None
        adv, dec, unch = breadth(stocks)

        sectors.append({
            "name": industry,
            "indexName": f"Industry group - {len(stocks)} stocks, equal-weighted",
            "group": "Industry",
            "source": "industry",
            "last": None,
            "pChange": avg,
            "pChange30d": None,
            "pChange365d": None,
            "advances": adv,
            "declines": dec,
            "unchanged": unch,
            "status": classify(avg),
            "stocks": stocks,
        })

    print("Computing constituent overlaps...", file=sys.stderr)
    annotate_overlaps(sectors)

    sectors.sort(key=lambda s: -(s["pChange"] if s["pChange"] is not None else -999))

    output = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "bhavDate": bhav_date,
        "thresholds": {
            "strongBullish": STRONG_BULLISH,
            "bullish": BULLISH_THRESHOLD,
            "bearish": BEARISH_THRESHOLD,
            "strongBearish": STRONG_BEARISH,
        },
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
