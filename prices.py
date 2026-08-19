"""
Stock prices from Yahoo, with NSE's bhavcopy as the fallback.

NSE is the better source for index breadth -- it publishes all 84 sectoral and
thematic indices, most of which Yahoo has never heard of -- but it is the worse
source for stock prices. Its bhavcopy only reaches back six years, carries raw
traded prices that a split turns into a fake collapse, and is only published once
the session has closed.

Yahoo answers all three: adjusted closes going back decades (RELIANCE to 1996),
and today's price while the market is still open.

It is unofficial, though, so nothing here is allowed to be load-bearing. Every
lookup can come back empty and the caller falls back to the bhavcopy it already
has. What must not happen is double-adjustment: Yahoo's closes are already
corrected for splits, so `source` records where each price came from and the
corporate-action factors are applied only to NSE's.

    python prices.py            fetch a sample and report coverage
"""
import sys
import warnings
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

try:
    import yfinance as yf
    AVAILABLE = True
except ImportError:                                   # optional dependency
    AVAILABLE = False

BATCH = 120

# Daily for the recent stretch, weekly further out.
#
# The daily window deliberately reaches past a year, matching the index history.
# Weekly sampling put the start of a one-year window up to a week off, which had
# TVSMOTOR reading +33% against TradingView's +47% for the same period.
DAILY_PERIOD = "2y"
WEEKLY_PERIOD = "6y"


def ticker(symbol):
    """NSE symbol to Yahoo ticker. '&' and '-' pass through unchanged."""
    return f"{symbol.strip().upper()}.NS"


def _download(tickers, period, interval):
    frame = yf.download(tickers, period=period, interval=interval,
                        progress=False, auto_adjust=True, threads=True)
    if frame is None or frame.empty:
        return {}
    close = frame["Close"] if "Close" in frame else frame
    # A single ticker comes back as a Series rather than a frame.
    if hasattr(close, "to_frame") and close.ndim == 1:
        close = close.to_frame(name=tickers[0])
    return close


def _series_by_symbol(close, out):
    for column in close.columns:
        symbol = column[:-3] if column.endswith(".NS") else column
        column_data = close[column].dropna()
        if column_data.empty:
            continue
        series = out.setdefault(symbol, {})
        for stamp, value in column_data.items():
            series[stamp.date().isoformat()] = float(value)


def fetch(symbols, quiet=False):
    """
    {symbol: {iso_date: adjusted_close}} for as many symbols as Yahoo knows.

    Returns an empty dict rather than raising if yfinance is missing or the
    request fails -- the caller is expected to have a fallback.
    """
    if not AVAILABLE:
        if not quiet:
            print("  yfinance not installed - using NSE prices only", file=sys.stderr)
        return {}

    symbols = sorted({s.strip().upper() for s in symbols if s})
    out = {}

    for start in range(0, len(symbols), BATCH):
        chunk = symbols[start:start + BATCH]
        tickers = [ticker(s) for s in chunk]
        for period, interval in ((WEEKLY_PERIOD, "1wk"), (DAILY_PERIOD, "1d")):
            try:
                close = _download(tickers, period, interval)
            except Exception as e:                     # network, rate limit, schema drift
                if not quiet:
                    print(f"  Yahoo {interval} batch failed: {e}", file=sys.stderr)
                continue
            if len(close):
                _series_by_symbol(close, out)
        if not quiet:
            print(f"  {min(start + BATCH, len(symbols))}/{len(symbols)} symbols...",
                  file=sys.stderr)

    return out


def fetch_live(symbols, quiet=False):
    """
    Just the last two closes per symbol -- enough for the current price and the
    day's move, and far cheaper than pulling six years of history.

    This is what an intraday refresh needs. The long series only changes when a
    new day closes, so it is fetched once in the morning and reused.
    """
    if not AVAILABLE:
        return {}

    symbols = sorted({s.strip().upper() for s in symbols if s})
    out = {}

    for start in range(0, len(symbols), BATCH):
        chunk = symbols[start:start + BATCH]
        try:
            close = _download([ticker(s) for s in chunk], "5d", "1d")
        except Exception as e:
            if not quiet:
                print(f"  Yahoo live batch failed: {e}", file=sys.stderr)
            continue
        if len(close):
            _series_by_symbol(close, out)

    return out


def close_on_or_before(series, target, tolerance_days=10):
    """
    Closing price at `target`, or the most recent one before it.

    Weekly sampling means an exact date usually isn't in the series, and a
    holiday can push it further, so a bounded search backwards is the honest
    reading rather than snapping to whatever happens to be nearest.
    """
    if not series:
        return None
    wanted = target.isoformat()
    best = None
    for day, value in series.items():
        if day <= wanted and (best is None or day > best):
            best = day
    if best is None:
        return None
    gap = (target - datetime.strptime(best, "%Y-%m-%d").date()).days
    return series[best] if gap <= tolerance_days + 7 else None


def latest_two(series):
    """Most recent close and the one before it, for the day's move."""
    if not series or len(series) < 2:
        return (None, None)
    days = sorted(series)
    return series[days[-1]], series[days[-2]]


def main():
    if not AVAILABLE:
        sys.exit("yfinance is not installed. pip install yfinance")

    sample = ["RELIANCE", "TCS", "M&M", "BAJAJ-AUTO", "ADANIPOWER", "J&KBANK"]
    print(f"Fetching {len(sample)} symbols...", file=sys.stderr)
    book = fetch(sample)

    today = datetime.now().date()
    print(f"\n{'symbol':14s} {'last':>10s} {'prev':>10s} {'1Y ago':>10s} {'1Y ret':>9s} points")
    for symbol in sample:
        series = book.get(symbol, {})
        last, prev = latest_two(series)
        year_ago = close_on_or_before(series, today - timedelta(days=365))
        ret = f"{(last / year_ago - 1) * 100:+.1f}%" if last and year_ago else "-"
        print(f"{symbol:14s} {last or 0:10.2f} {prev or 0:10.2f} "
              f"{year_ago or 0:10.2f} {ret:>9s} {len(series)}")


if __name__ == "__main__":
    main()
