"""
Does the data still look like data?

Three times in this project the pipeline kept running while quietly producing
something wrong -- a live refresh overwriting a rebuild, sectors losing their
constituent lists, the standalone snapshot shipping as an empty shell. Every one
was found by hand, days later. Nothing was watching.

This watches. It reads what the last refresh produced and complains when the
shape of it changes: sectors that lost their stocks, prices that stopped
arriving, a universe that shrank. It knows nothing about whether the numbers are
*right* -- only whether they are there, and whether there are as many as last
time.

    python health_check.py              report to stdout
    python health_check.py --json       machine-readable

run_refresh calls check() directly and forwards anything it finds to Telegram.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
STOCKS_FILE = BASE_DIR / "data" / "stocks.json"
STATE_FILE = BASE_DIR / "data" / "health_state.json"
REPORTED_FILE = BASE_DIR / "data" / "health_reported.json"

# A universe this much smaller than last time is a failure, not a delisting.
SHRINK_PCT = 10.0

# How stale the data may be before it is worth saying so. Generous, because a
# laptop that was shut over the weekend is not a fault.
STALE_HOURS = 30


def plural(n, noun):
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _load(path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def _shrank(label, now, before, problems):
    """Flag a count that fell materially since the last good run."""
    if before is None or before <= 0 or now >= before:
        return
    drop = 100 * (before - now) / before
    if drop >= SHRINK_PCT:
        problems.append(f"{label} fell from {before} to {now} ({drop:.0f}% down)")


def check():
    """A list of problems, empty when everything looks right."""
    problems = []

    data = _load(DATA_FILE)
    if data is None:
        return ["sectors_data.json is missing or unreadable"], {}

    sectors = data.get("sectors") or []
    stocks = (_load(STOCKS_FILE) or {}).get("stocks") or {}

    # --- is any of it stale? -------------------------------------------------
    try:
        age = (datetime.now() - datetime.fromisoformat(data["updatedAt"])).total_seconds() / 3600
        if age > STALE_HOURS:
            problems.append(f"data is {age:.0f} hours old")
    except (KeyError, ValueError):
        problems.append("no readable updatedAt on the data")

    # --- did anything come back empty? --------------------------------------
    if not sectors:
        problems.append("no sectors at all")
        return problems, {}

    empty = [s["name"] for s in sectors if not s.get("stocks")]
    if empty:
        problems.append(f"{plural(len(empty), 'sector')} with no constituents: "
                        + ", ".join(sorted(empty)[:6]))

    # Only the ones backed by a real NSE index: the synthesised industry groups
    # are equal-weighted baskets of stocks and never had a level to lose.
    priceless = [s["name"] for s in sectors
                 if s.get("source") == "index" and s.get("last") in (None, 0)]
    if priceless:
        problems.append(f"{plural(len(priceless), 'sector')} with no index level: "
                        + ", ".join(sorted(priceless)[:6]))

    no_close = [k for k, v in stocks.items() if v.get("close") in (None, 0)]
    if stocks and len(no_close) > 0.02 * len(stocks):
        problems.append(f"{len(no_close)} of {len(stocks)} stocks have no close")

    if len(data.get("ticker") or []) < 4:
        problems.append("the ticker strip is short of its four instruments")

    # --- has anything shrunk since the last good run? ------------------------
    previous = _load(STATE_FILE) or {}
    counts = {
        "sectors": len(sectors),
        "stocks": len(stocks),
        "constituents": sum(len(s.get("stocks") or []) for s in sectors),
        "priced": sum(1 for v in stocks.values() if v.get("close")),
    }
    for key, label in (("sectors", "Sector count"), ("stocks", "Stock universe"),
                       ("constituents", "Total constituents"), ("priced", "Priced stocks")):
        _shrank(label, counts[key], previous.get(key), problems)

    return problems, counts


def remember(counts):
    """Record this run's counts as the baseline for the next comparison."""
    if counts:
        STATE_FILE.parent.mkdir(exist_ok=True)
        counts = dict(counts, checkedAt=datetime.now().isoformat(timespec="seconds"))
        STATE_FILE.write_text(json.dumps(counts, indent=2), encoding="utf-8")


def since_last(problems):
    """
    (problems worth sending, recovered).

    A fault that is still exactly the fault reported last time is not news, so
    an unchanged list sends nothing. A list that empties out is worth one line,
    otherwise a warning simply stops arriving and nobody knows whether it was
    fixed or the checker died.
    """
    before = set((_load(REPORTED_FILE) or {}).get("problems") or [])
    now = set(problems)
    if now == before:
        return [], False

    REPORTED_FILE.parent.mkdir(exist_ok=True)
    REPORTED_FILE.write_text(json.dumps({
        "problems": sorted(now),
        "at": datetime.now().isoformat(timespec="seconds"),
    }, indent=2), encoding="utf-8")

    return problems, bool(before and not now)


def main():
    problems, counts = check()

    if "--json" in sys.argv:
        print(json.dumps({"problems": problems, "counts": counts}, indent=2))
    elif problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
    else:
        print("Healthy: " + ", ".join(f"{v} {k}" for k, v in counts.items()))

    # A baseline is only worth keeping from a run that looked sane, or one bad
    # day would become the yardstick everything after it is measured against.
    if not problems:
        remember(counts)

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
