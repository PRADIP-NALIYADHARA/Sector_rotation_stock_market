"""
Does the signal this board is built on actually work?

Everything here rests on one claim: a sector beating the benchmark over the
recent past is more likely to keep doing it. The board asserts that on every
card and has never once been asked to prove it.

This asks. It replays the cached index history, and at each rebalance ranks
sectors exactly as the live board does -- return over a lookback window, less
the benchmark's return over the same window -- buys the top few, holds to the
next rebalance, and compares the result with simply having held the benchmark.
Nothing is ranked on data that had not happened yet.

The point is not the headline number. It is the sweep: running every lookback
window against every basket size says which window carries information and
which is noise, and that is a question the dashboard's default period setting
currently answers by assumption.

    python backtest.py                 the sweep
    python backtest.py --years 3       over a shorter history
    python backtest.py --core          long-established indices only
    python backtest.py --json          machine-readable

What this is not: it holds price indices, not tradeable instruments, and counts
no brokerage, spread, tracking error or tax. Treat a margin of a point or two
as noise, not as an edge.
"""

import json
import statistics
import sys
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent
HISTORY_FILE = BASE_DIR / "data" / "index_history.json"
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
OUT_FILE = BASE_DIR / "data" / "backtest.json"

BENCHMARK = "NIFTY 50"

# The windows the board itself offers, so the sweep answers a question about
# this dashboard rather than about momentum in the abstract.
LOOKBACKS = [(30, "1M"), (91, "3M"), (182, "6M"), (365, "1Y")]
BASKETS = [1, 3, 5, 10]
REBALANCE_DAYS = 30
DEFAULT_YEARS = 5

# Sectoral indices that were live and quoted long before this history begins.
#
# The full board is not a fair universe to test on. NSE keeps launching thematic
# indices and back-computing their history, and a theme gets launched precisely
# because it has been working -- so a replay that ranks EV or India Internet in
# 2022 is ranking something nobody could have bought, chosen with hindsight. On
# the full board every configuration beats the benchmark, which is the shape a
# result takes when the universe is picked after the fact. Restricting to these
# is the closest thing to an honest test available here.
CORE = [
    "NIFTY AUTO", "NIFTY BANK", "NIFTY FMCG", "NIFTY IT", "NIFTY MEDIA",
    "NIFTY METAL", "NIFTY PHARMA", "NIFTY PSU BANK", "NIFTY PRIVATE BANK",
    "NIFTY REALTY", "NIFTY FINANCIAL SERVICES", "NIFTY HEALTHCARE INDEX",
    "NIFTY CONSUMER DURABLES", "NIFTY OIL & GAS", "NIFTY INFRASTRUCTURE",
    "NIFTY ENERGY", "NIFTY COMMODITIES", "NIFTY INDIA CONSUMPTION",
    "NIFTY SERVICES SECTOR", "NIFTY MNC", "NIFTY PSE",
]


def _as_of(dates, target):
    """Position of the last date on or before `target`, or None."""
    found = None
    for i, d in enumerate(dates):
        if d <= target:
            found = i
        else:
            break
    return found


def _ret(series, a, b):
    """Return from position `a` to position `b`, or None if either is missing."""
    start, end = series[a], series[b]
    if start in (None, 0) or end is None:
        return None
    return end / start - 1


def rebalance_points(dates, every_days, first_i):
    """
    Positions to rebalance on, walking forward by calendar spacing.

    The history is sampled daily near the present and monthly at the far end, so
    a step of a month can land back on the sample it started from. Where that
    happens the walk takes the next sample instead of stopping, which is the
    honest reading: rebalance as often as the data allows, no oftener.
    """
    points = [first_i]
    last = len(dates) - 1
    while points[-1] < last:
        nxt = date.fromisoformat(dates[points[-1]]) + timedelta(days=every_days)
        i = _as_of(dates, nxt.isoformat())
        i = max(i if i is not None else 0, points[-1] + 1)
        points.append(min(i, last))
    return points


def run(history, names, lookback_days, top_k, every_days, years):
    """One strategy: rank, hold the best `top_k`, repeat."""
    dates, series = history["dates"], history["series"]
    bench = series.get(BENCHMARK)
    if not bench:
        return None

    start = _as_of(dates, (date.fromisoformat(dates[-1]) - timedelta(days=365 * years)).isoformat())
    # The first ranking needs a full lookback behind it, so the test cannot
    # begin at the very start of the history.
    earliest = _as_of(dates, (date.fromisoformat(dates[0]) + timedelta(days=lookback_days)).isoformat())
    start = max(start or 0, earliest or 0)
    points = rebalance_points(dates, every_days, start)
    if len(points) < 4:
        return None

    equity, bench_equity = 1.0, 1.0
    curve, wins, periods = [1.0], 0, 0

    for held_from, held_to in zip(points, points[1:]):
        # Rank on what was knowable at held_from, and not a day more.
        past = _as_of(dates, (date.fromisoformat(dates[held_from])
                              - timedelta(days=lookback_days)).isoformat())
        if past is None or past >= held_from:
            continue
        bm_past = _ret(bench, past, held_from)
        if bm_past is None:
            continue

        scored = []
        for name in names:
            s = series.get(name)
            if not s:
                continue
            r = _ret(s, past, held_from)
            if r is not None:
                scored.append((r - bm_past, name))
        if len(scored) < top_k:
            continue
        scored.sort(reverse=True)
        picks = [name for _, name in scored[:top_k]]

        # Equal weight, and a pick with no price for the period simply sits out.
        held = [_ret(series[p], held_from, held_to) for p in picks]
        held = [h for h in held if h is not None]
        if not held:
            continue
        gain = statistics.fmean(held)
        bm_gain = _ret(bench, held_from, held_to)
        if bm_gain is None:
            continue

        equity *= 1 + gain
        bench_equity *= 1 + bm_gain
        curve.append(equity)
        periods += 1
        wins += gain > bm_gain

    if periods < 4:
        return None

    peak, drawdown = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        drawdown = min(drawdown, v / peak - 1)

    span = (date.fromisoformat(dates[points[-1]])
            - date.fromisoformat(dates[points[0]])).days / 365.25

    return {
        "lookbackDays": lookback_days,
        "topK": top_k,
        "periods": periods,
        "years": round(span, 1),
        "total": round(100 * (equity - 1), 1),
        "benchTotal": round(100 * (bench_equity - 1), 1),
        "cagr": round(100 * (equity ** (1 / span) - 1), 1) if span > 0 else None,
        "benchCagr": round(100 * (bench_equity ** (1 / span) - 1), 1) if span > 0 else None,
        "maxDrawdown": round(100 * drawdown, 1),
        "hitRate": round(100 * wins / periods),
        "from": dates[points[0]],
        "to": dates[points[-1]],
    }


def sweep(years=DEFAULT_YEARS, core_only=False):
    if not HISTORY_FILE.exists():
        sys.exit("No index history yet - run build_history.py first.")
    history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))

    # Rank the same universe the board ranks: real indices, sectors and themes,
    # never the broad market, which largely is the benchmark.
    if core_only:
        return ([n for n in CORE if n in history["series"]],
                _sweep_over([n for n in CORE if n in history["series"]], history, years))

    names = None
    if DATA_FILE.exists():
        board = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        names = [s["indexName"] for s in board.get("sectors", [])
                 if s.get("source") == "index" and s.get("group") != "Broad"
                 and s["indexName"] != BENCHMARK
                 and s["indexName"] in history["series"]]
    if not names:
        names = [n for n in history["series"] if n != BENCHMARK]

    return names, _sweep_over(names, history, years)


def _sweep_over(names, history, years):
    results = []
    for lookback, label in LOOKBACKS:
        for k in BASKETS:
            r = run(history, names, lookback, k, REBALANCE_DAYS, years)
            if r:
                r["lookback"] = label
                results.append(r)
    return results


def main():
    years = DEFAULT_YEARS
    if "--years" in sys.argv:
        years = int(sys.argv[sys.argv.index("--years") + 1])
    core_only = "--core" in sys.argv

    names, results = sweep(years, core_only)
    if not results:
        sys.exit("Not enough history to test.")

    OUT_FILE.parent.mkdir(exist_ok=True)
    OUT_FILE.write_text(json.dumps({"universe": len(names), "results": results}, indent=2),
                        encoding="utf-8")

    if "--json" in sys.argv:
        print(json.dumps(results, indent=2))
        return

    top = results[0]
    print(f"\nRanking {len(names)} sectors and themes, rebalanced every "
          f"{REBALANCE_DAYS} days, {top['from']} to {top['to']} "
          f"({top['years']} years).")
    print(f"Holding {BENCHMARK} instead returned {top['benchTotal']:+.1f}% "
          f"({top['benchCagr']:+.1f}% a year).\n")

    head = f"{'window':>7}{'hold':>6}{'total':>9}{'a year':>9}{'vs bench':>10}{'worst dip':>11}{'beat bench':>12}"
    print(head)
    print("-" * len(head))
    for r in sorted(results, key=lambda x: -(x["cagr"] or -99)):
        edge = r["cagr"] - r["benchCagr"]
        print(f"{r['lookback']:>7}{r['topK']:>6}{r['total']:>8.1f}%{r['cagr']:>8.1f}%"
              f"{edge:>+9.1f}%{r['maxDrawdown']:>10.1f}%{r['hitRate']:>11}%")

    print("\nPrice indices, equally weighted, no costs, no slippage, no tax.")
    print("A point or two of difference is noise, not an edge.")
    if core_only:
        print("Universe: long-established sectoral indices only.")
    else:
        print("Universe: the whole board. Several of these indices were launched")
        print("recently and their earlier history was back-computed, so a theme")
        print("appears in the ranking years before anyone could have bought it.")
        print("Run with --core for a universe without that problem; the edge")
        print("there is roughly half the size.")


if __name__ == "__main__":
    main()
