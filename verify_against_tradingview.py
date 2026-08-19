"""
Checks the chart's own arithmetic against figures read off TradingView.

The dashboard is only worth consulting if its numbers agree with the chart a
trader already trusts. This reproduces exactly what the comparison chart draws --
the same window start, the same as-of join onto the index calendar -- and prints
the gap against hand-entered TradingView readings.

Some difference is expected and not a fault: TradingView's weekly chart snaps its
window to a bar boundary while this measures exactly 365 days, and its last price
is live where this is as of the last refresh. A gap of a point or two is that. A
gap of ten is a bug.

Edit EXPECTED with whatever the chart currently shows, then:

    python verify_against_tradingview.py
"""
import json
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent

# Read off TradingView: NSE, 1Y, weekly, same-% scale, against NIFTY 50.
WINDOW_DAYS = 365
EXPECTED = {
    "SONACOMS": 84.40,
    "TVSMOTOR": 46.66,
    "EICHERMOT": 40.59,
    "BOSCHLTD": 26.44,
}
EXPECTED_BENCHMARK = -1.29

TOLERANCE = 3.0        # points; beyond this it is not just the start-bar choice


def monday_of(d):
    return d - timedelta(days=d.weekday())


def window_start(dates, days):
    """
    The chart's rule, which is TradingView's: step back from the start of the
    newest weekly bar and begin at the bar containing wherever that lands.
    """
    last = date.fromisoformat(dates[-1])
    target = monday_of(last) - timedelta(days=days)
    wanted = monday_of(target).isoformat()

    for i, d in enumerate(dates):
        if d >= wanted:
            return i
    return max(0, len(dates) - 2)


def as_of(series, upto):
    """Latest close at or before a date -- the join the chart uses."""
    best = None
    for day in series:
        if day <= upto and (best is None or day > best):
            best = day
    return (best, series[best]) if best else (None, None)


def main():
    hist = json.loads((BASE_DIR / "data" / "index_history.json").read_text(encoding="utf-8"))
    book = json.loads((BASE_DIR / "data" / "price_book.json").read_text(encoding="utf-8"))

    dates = hist["dates"]
    start = window_start(dates, WINDOW_DAYS)
    print(f"window: {dates[start]} -> {dates[-1]}  ({WINDOW_DAYS} days back)\n")

    print(f"{'symbol':11s} {'base date':>11s} {'base':>10s} {'last':>10s} "
          f"{'ours':>9s} {'TradingView':>12s} {'gap':>7s}")

    worst = 0.0
    for symbol, expected in EXPECTED.items():
        series = book.get(symbol)
        if not series:
            print(f"{symbol:11s} not in the price book")
            continue
        base_day, base = as_of(series, dates[start])
        last = series[max(series)]
        ours = (last / base - 1) * 100
        gap = ours - expected
        worst = max(worst, abs(gap))
        print(f"{symbol:11s} {base_day:>11s} {base:10.2f} {last:10.2f} "
              f"{ours:+8.2f}% {expected:+11.2f}% {gap:+6.2f}")

    nifty = hist["series"]["NIFTY 50"]
    bench = (nifty[-1] / nifty[start] - 1) * 100
    gap = bench - EXPECTED_BENCHMARK
    worst = max(worst, abs(gap))
    print(f"{'NIFTY 50':11s} {dates[start]:>11s} {nifty[start]:10.2f} {nifty[-1]:10.2f} "
          f"{bench:+8.2f}% {EXPECTED_BENCHMARK:+11.2f}% {gap:+6.2f}")

    print()
    if worst <= TOLERANCE:
        print(f"worst gap {worst:.2f} points - within what the start-bar choice explains")
    else:
        print(f"worst gap {worst:.2f} points - too large to be the window alone")


if __name__ == "__main__":
    main()
