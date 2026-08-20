"""
The strip that runs under the header: Nifty, Sensex, gold and silver.

Gold and silver are taken from the NSE-traded ETFs rather than international
spot. Spot is quoted in dollars per troy ounce, and converting it lands a good
way from what metal actually costs here once duty and GST are in -- so the
number would look authoritative and be wrong. The ETFs are the domestic price,
in rupees, on the same exchange as everything else on this board.

Their drawdown from the 52-week high is carried too, since a metal well off its
high is the thing worth being told about without opening a chart.
"""

import sys

try:
    import yfinance as yf
    AVAILABLE = True
except ImportError:                                          # pragma: no cover
    AVAILABLE = False

# (label, Yahoo ticker, kind). Only metals get a drawdown flag: an index sitting
# below its high is the ordinary state of a market, not news.
SYMBOLS = [
    ("Nifty 50", "^NSEI", "index"),
    ("Sensex", "^BSESN", "index"),
    ("Gold", "GOLDBEES.NS", "metal"),
    ("Silver", "SILVERBEES.NS", "metal"),
]

# How far below the 52-week high before it is worth saying so, deepest first.
DRAWDOWN_LEVELS = [
    (20.0, "deep correction"),
    (10.0, "correction"),
    (5.0, "dip"),
]


def _level(from_high):
    """The label for a drawdown, or None if it is not far enough to matter."""
    if from_high is None:
        return None
    for depth, label in DRAWDOWN_LEVELS:
        if from_high <= -depth:
            return label
    return None


def build(quiet=False):
    """One row per instrument, ready to hand to the browser."""
    if not AVAILABLE:
        return []

    tickers = [t for _, t, _ in SYMBOLS]
    try:
        frame = yf.download(tickers, period="1y", interval="1d",
                            progress=False, auto_adjust=False, threads=True)
    except Exception as e:
        if not quiet:
            print(f"  ticker strip unavailable: {e}", file=sys.stderr)
        return []

    if frame is None or frame.empty:
        return []
    close = frame["Close"] if "Close" in frame else frame

    rows = []
    for label, symbol, kind in SYMBOLS:
        if symbol not in close.columns:
            continue
        series = close[symbol].dropna()
        if len(series) < 2:
            continue

        last, prev = float(series.iloc[-1]), float(series.iloc[-2])
        high52, low52 = float(series.max()), float(series.min())
        from_high = round(100 * (last / high52 - 1), 2) if high52 else None

        row = {
            "name": label,
            "symbol": symbol,
            "kind": kind,
            "last": round(last, 2),
            "pChange": round(100 * (last / prev - 1), 2) if prev else None,
            "high52": round(high52, 2),
            "low52": round(low52, 2),
            "fromHigh": from_high,
            "asOf": series.index[-1].date().isoformat(),
        }
        if kind == "metal":
            row["drawdown"] = _level(from_high)
        rows.append(row)

    if not quiet:
        print(f"  ticker strip: {len(rows)} instruments", file=sys.stderr)
    return rows


if __name__ == "__main__":
    for r in build():
        flag = f"  [{r['drawdown']}]" if r.get("drawdown") else ""
        print(f"{r['name']:<10} {r['last']:>12,.2f}  {r['pChange']:+6.2f}%  "
              f"from 52w high {r['fromHigh']:+7.2f}%{flag}")
