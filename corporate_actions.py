"""
Splits and bonuses, so historical stock prices can be put on today's scale.

The bhavcopy records the price actually traded that day. When a stock splits
10:2, the price genuinely drops 80% overnight and nothing in that file says why,
so comparing a pre-split close against today's makes a routine split look like a
collapse -- ADANIPOWER split in September 2025 and shows a fake -66% year.

NSE's corporate-actions feed carries the ratios, so the fix is to divide old
prices by every factor that has taken effect since. A price from before a 10:2
split is divided by 5 and becomes comparable.

Rights issues are deliberately left alone: adjusting them properly needs the
theoretical ex-rights price, which depends on the issue price and take-up. They
are recorded so affected stocks can be treated as unreliable rather than quietly
mis-stated.

    python corporate_actions.py            refresh the cache
    python corporate_actions.py --years 8  go further back
"""
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import requests

BASE_DIR = Path(__file__).parent
CACHE_FILE = BASE_DIR / "data" / "corporate_actions.json"

DEFAULT_YEARS = 6

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

REFERER = {"Referer": "https://www.nseindia.com/companies-listing/corporate-filings-actions"}
API = ("https://www.nseindia.com/api/corporates-corporateActions"
       "?index=equities&from_date={}&to_date={}")

# "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
SPLIT_RE = re.compile(
    r"from\s+rs?e?\.?\s*([\d.]+)\s*/?-?\s*per\s+share\s+to\s+rs?e?\.?\s*([\d.]+)",
    re.IGNORECASE,
)
# "Bonus 1:1", "Bonus 4:1"
BONUS_RE = re.compile(r"bonus\s+(\d+)\s*:\s*(\d+)", re.IGNORECASE)


def classify(subject):
    """
    Price factor for a corporate action, or None if it doesn't move the price.

    The factor is what an old price must be divided by: a 10:2 split returns 5,
    a 1:1 bonus returns 2.
    """
    text = (subject or "").strip()
    low = text.lower()

    if "split" in low or "sub-division" in low:
        m = SPLIT_RE.search(text)
        if m:
            old, new = float(m.group(1)), float(m.group(2))
            if new > 0 and old > new:
                return "split", round(old / new, 6)
        return "split", None            # recognised but unparseable

    if "bonus" in low:
        m = BONUS_RE.search(text)
        if m:
            new, held = int(m.group(1)), int(m.group(2))
            if held > 0:
                return "bonus", round((new + held) / held, 6)
        return "bonus", None

    if "right" in low:
        return "rights", None           # needs the ex-rights price; not attempted

    return None, None


def parse_date(raw):
    for fmt in ("%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime((raw or "").strip(), fmt).date()
        except ValueError:
            continue
    return None


def fetch_range(session, start, end):
    url = API.format(start.strftime("%d-%m-%Y"), end.strftime("%d-%m-%Y"))
    try:
        r = session.get(url, timeout=60, headers=REFERER)
        return r.json() if r.status_code == 200 else []
    except (requests.RequestException, ValueError):
        return []


def open_session():
    session = requests.Session()
    session.headers.update(HEADERS)
    session.get("https://www.nseindia.com/", timeout=20)
    return session


def fetch(years=DEFAULT_YEARS, session=None, quiet=False):
    session = session or open_session()

    today = datetime.now().date()
    records = []
    # The endpoint refuses very wide ranges, so walk it a year at a time.
    for back in range(years):
        end = today - timedelta(days=365 * back)
        start = end - timedelta(days=365)
        batch = fetch_range(session, start, end)
        if not quiet:
            print(f"  {start:%b-%Y} to {end:%b-%Y}: {len(batch)} records", file=sys.stderr)
        records += batch

    return summarise(records, years)


def summarise(records, years):
    actions = defaultdict(list)
    unreliable = defaultdict(list)
    counts = defaultdict(int)

    for rec in records:
        symbol = (rec.get("symbol") or "").strip()
        ex = parse_date(rec.get("exDate"))
        if not symbol or not ex:
            continue

        kind, factor = classify(rec.get("subject"))
        if kind is None:
            continue
        counts[kind] += 1

        if factor and factor > 1:
            entry = {"exDate": ex.isoformat(), "factor": factor, "kind": kind}
            if entry not in actions[symbol]:
                actions[symbol].append(entry)
        else:
            # Recognised as price-moving but not adjustable from the text alone.
            note = {"exDate": ex.isoformat(), "kind": kind}
            if note not in unreliable[symbol]:
                unreliable[symbol].append(note)

    for events in actions.values():
        events.sort(key=lambda e: e["exDate"])

    return {
        "builtAt": datetime.now().isoformat(timespec="seconds"),
        "years": years,
        "counts": dict(counts),
        "actions": dict(actions),
        "unreliable": dict(unreliable),
    }


def load():
    if not CACHE_FILE.exists():
        return {"actions": {}, "unreliable": {}}
    return json.loads(CACHE_FILE.read_text(encoding="utf-8"))


def save(payload):
    CACHE_FILE.parent.mkdir(exist_ok=True)
    CACHE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def merge(base, extra):
    """Fold newly seen events into the cache without duplicating them."""
    added = 0
    for key in ("actions", "unreliable"):
        target = base.setdefault(key, {})
        for symbol, events in extra.get(key, {}).items():
            existing = target.setdefault(symbol, [])
            for event in events:
                if event not in existing:
                    existing.append(event)
                    added += 1
            existing.sort(key=lambda e: e["exDate"])
    return added


def ensure_fresh(days=150, session=None):
    """
    Keep the cache current as part of a normal data refresh.

    A split that went ex this morning would otherwise sit unrecorded until someone
    remembered to rebuild, and every return spanning it would be wrong in the
    meantime. Recent actions are cheap to re-pull -- one request -- so this runs on
    every update; the multi-year backfill only happens when there is no cache yet.
    """
    cached = load()
    session = session or open_session()

    if not cached.get("actions"):
        print("No corporate-action cache yet - building the full history...", file=sys.stderr)
        payload = fetch(session=session, quiet=True)
        save(payload)
        return payload, len(payload.get("actions", {}))

    today = datetime.now().date()
    recent = summarise(
        fetch_range(session, today - timedelta(days=days), today + timedelta(days=30)),
        cached.get("years", DEFAULT_YEARS),
    )
    added = merge(cached, recent)
    cached["refreshedAt"] = datetime.now().isoformat(timespec="seconds")
    save(cached)
    return cached, added


def factor_since(actions_for_symbol, on_date):
    """
    Divide an old price by this to bring it onto today's scale.

    Only actions that went ex *after* the old price was recorded matter; earlier
    ones are already baked into it.
    """
    factor = 1.0
    for event in actions_for_symbol or []:
        if event["exDate"] > on_date.isoformat():
            factor *= event["factor"]
    return factor


def main():
    years = DEFAULT_YEARS
    if "--years" in sys.argv:
        years = int(sys.argv[sys.argv.index("--years") + 1])

    print(f"Fetching corporate actions for the last {years} years...", file=sys.stderr)
    payload = fetch(years)
    save(payload)

    adjustable = sum(len(v) for v in payload["actions"].values())
    print(f"\n{adjustable} adjustable events across {len(payload['actions'])} symbols "
          f"({payload['counts']})", file=sys.stderr)
    print(f"{len(payload['unreliable'])} symbols have actions that cannot be adjusted "
          f"from the description (rights issues and the like)", file=sys.stderr)
    print(f"Saved to {CACHE_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
