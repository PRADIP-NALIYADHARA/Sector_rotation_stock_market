"""
Builds a price history for every NSE index and caches it in data/index_history.json.

Everything the dashboard could say until now was measured between two dates -- it
knew a sector was ahead of the benchmark, but not when it got ahead. Answering
"which line crossed which, and when" needs the actual series, not endpoints.

Resolution is deliberately uneven: daily for the recent past where crossings are
decided, weekly further out, monthly at the long end. That keeps a five-year view
to a few hundred small files instead of twelve hundred.

The cache is incremental. The first build takes a few minutes; after that only the
dates that are missing get fetched, so a daily refresh costs one request.

    python build_history.py           extend the cache up to today
    python build_history.py --rebuild discard it and start over
"""
import csv
import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import requests

from fetch_data import EXCLUDED_INDICES

BASE_DIR = Path(__file__).parent
HISTORY_FILE = BASE_DIR / "data" / "index_history.json"
VALUATION_FILE = BASE_DIR / "data" / "valuation_history.json"

# (days back from today, spacing in days)
# The daily stretch has to be long enough to carry a 30-day moving average with
# some history behind it, not just the 30 points themselves.
RESOLUTION = [
    (400, 1),      # past a full year: daily
    (3 * 365, 7),  # out to 3 years: weekly
    (5 * 365, 30), # out to 5 years: monthly
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/plain, */*",
}

URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{}.csv"


def wanted_dates(today):
    """Sample dates, densest near the present."""
    dates, previous_span = set(), 0
    for span, step in RESOLUTION:
        for days in range(previous_span, span + 1, step):
            dates.add((today - timedelta(days=days)).date())
        previous_span = span
    return sorted(dates, reverse=True)


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_day(day):
    """
    Closes and valuation for every index on `day`; None if the market was shut.

    The same file carries P/E, P/B and dividend yield, which is what makes a
    sector's valuation history free: it is already being downloaded for the
    closes, and NSE publishes no separate archive of it.
    """
    url = URL.format(day.strftime("%d%m%Y"))
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
    except requests.RequestException:
        return day, None
    if r.status_code != 200 or "Index Name" not in r.text[:100]:
        return day, None

    closes = {}
    for row in csv.DictReader(io.StringIO(r.text)):
        name = row.get("Index Name", "").strip().upper()
        close = _number(row.get("Closing Index Value"))
        if not name or close is None:
            continue
        # [close, pe, pb, dy] -- a list rather than a dict, because this is
        # written once per index per day and the key names would outweigh it.
        closes[name] = [close, _number(row.get("P/E")),
                        _number(row.get("P/B")), _number(row.get("Div Yield"))]
    return day, closes


def load_cache():
    if not HISTORY_FILE.exists():
        return {}
    raw = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    return raw.get("byDate", {})


def main():
    rebuild = "--rebuild" in sys.argv
    by_date = {} if rebuild else load_cache()

    # Days cached before valuation was captured hold a bare close. They cannot be
    # upgraded in place, so they are dropped and refetched once.
    stale = [d for d, row in by_date.items()
             if row and not isinstance(next(iter(row.values())), list)]
    if stale:
        print(f"{len(stale)} cached days predate the valuation columns - refetching",
              file=sys.stderr)
        for d in stale:
            del by_date[d]

    today = datetime.now()
    targets = wanted_dates(today)

    # A date already in the cache is settled -- index closes never get revised.
    missing = [d for d in targets if d.isoformat() not in by_date]
    print(f"{len(targets)} sample dates, {len(missing)} to fetch "
          f"({len(by_date)} already cached)", file=sys.stderr)

    if missing:
        done = 0
        with ThreadPoolExecutor(max_workers=12) as pool:
            for day, closes in pool.map(fetch_day, missing):
                done += 1
                if closes:
                    by_date[day.isoformat()] = closes
                if done % 25 == 0:
                    print(f"  {done}/{len(missing)}...", file=sys.stderr)

    # Holidays and weekends leave gaps; drop dates that returned nothing.
    dates = sorted(d for d, closes in by_date.items() if closes)

    # Pivot to one series per index so the browser doesn't have to. Indices the
    # dashboard retired are dropped here rather than shipped and never drawn;
    # by_date keeps them so the incremental cache never has to refetch a day.
    names = sorted({name for d in dates for name in by_date[d]} - EXCLUDED_INDICES)

    def field(day, name, i):
        row = by_date[day].get(name)
        return row[i] if row else None

    series = {name: [field(d, name, 0) for d in dates] for name in names}

    HISTORY_FILE.parent.mkdir(exist_ok=True)
    HISTORY_FILE.write_text(json.dumps({
        "builtAt": datetime.now().isoformat(timespec="seconds"),
        "dates": dates,
        "series": series,
        "byDate": by_date,
    }), encoding="utf-8")

    # Valuation goes to its own file. The browser is never handed the whole
    # thing -- fetch_data reads it and ships one line per sector -- so keeping it
    # out of the served payload costs nothing and saves a megabyte on the wire.
    valuation = {
        name: {"pe": [field(d, name, 1) for d in dates],
               "pb": [field(d, name, 2) for d in dates],
               "dy": [field(d, name, 3) for d in dates]}
        for name in names
    }
    rated = sum(1 for v in valuation.values() if any(x is not None for x in v["pe"]))
    VALUATION_FILE.write_text(json.dumps({
        "builtAt": datetime.now().isoformat(timespec="seconds"),
        "dates": dates,
        "indices": valuation,
    }), encoding="utf-8")

    size = HISTORY_FILE.stat().st_size / 1_048_576
    print(f"Cached {len(dates)} trading days for {len(names)} indices "
          f"({dates[0]} to {dates[-1]}, {size:.1f} MB)", file=sys.stderr)
    print(f"Valuation history for {rated} indices -> {VALUATION_FILE.name} "
          f"({VALUATION_FILE.stat().st_size / 1_048_576:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
