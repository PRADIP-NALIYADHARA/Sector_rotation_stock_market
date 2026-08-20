"""
Maintenance script: works out which constituent-list CSV belongs to each NSE
index (broad market, sectoral and thematic), and writes index_map.json.

NSE's CSV filenames don't follow one consistent rule, so this brute-forces a set
of plausible names per index and keeps whichever one actually returns a CSV.

Run this only when NSE adds or renames an index -- fetch_data.py just reads the
generated index_map.json, so the normal refresh stays fast.

    python discover_indices.py
"""
import json
import html
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

BASE_DIR = Path(__file__).parent
MAP_FILE = BASE_DIR / "index_map.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

ARCHIVE = "https://nsearchives.nseindia.com/content/indices/{}"

GROUPS = {
    "Broad Market Indices": "Broad",
    "Sectoral Market Indices": "Sectoral",
    "Thematic Market Indices": "Thematic",
}

# equity-master files these under "Indices Eligible In Derivatives" rather than
# Broad or Sectoral, but NIFTY 50 is the benchmark and NIFTY BANK / FINANCIAL
# SERVICES are two of the most-watched sector indices in the market.
EXTRA_INDICES = [
    ("NIFTY 50", "Broad"),
    ("NIFTY NEXT 50", "Broad"),
    ("NIFTY MIDCAP SELECT", "Broad"),
    ("NIFTY INDIA FPI 150", "Broad"),
    ("NIFTY BANK", "Sectoral"),
    ("NIFTY FINANCIAL SERVICES", "Sectoral"),
]

# NSE abbreviates a few filenames in ways no rule predicts.
FILENAME_OVERRIDES = {
    "NIFTY INFRASTRUCTURE": "ind_niftyinfralist.csv",
    "NIFTY SERVICES SECTOR": "ind_niftyservicelist.csv",
    "NIFTY INDIA CONSUMPTION": "ind_niftyconsumptionlist.csv",
    "NIFTY FINANCIAL SERVICES": "ind_niftyfinancelist.csv",
}


def compact(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def candidates(name):
    """Plausible CSV filenames for an index, most likely first."""
    n = name.upper()
    variants = [n]
    if n.endswith(" INDEX"):
        variants.append(n[: -len(" INDEX")])
    if "INDIA" in n:
        variants.append(n.replace("INDIA", ""))
    if "&" in n:
        variants.append(n.replace("&", "AND"))

    out = []
    for v in variants:
        c = compact(v)
        if not c:
            continue
        out.append(f"ind_{c}list.csv")
        out.append(f"ind_{c}_list.csv")
        if c.startswith("nifty"):
            rest = c[len("nifty"):]
            out.append(f"ind_nifty_{rest}list.csv")
            out.append(f"ind_nifty{rest}_list.csv")

    seen, uniq = set(), []
    for o in out:
        if o not in seen:
            seen.add(o)
            uniq.append(o)
    return uniq


def resolve(item):
    name, group = item
    override = FILENAME_OVERRIDES.get(name)
    for fn in ([override] if override else []) + candidates(name):
        try:
            r = requests.get(ARCHIVE.format(fn), headers=HEADERS, timeout=10)
        except requests.RequestException:
            continue
        if r.status_code == 200 and "Symbol" in r.text[:300]:
            return name, group, fn
    return name, group, None


# --------------------------------------------------- NSE Indices (the provider)
# NSE's archive misses a good many thematic indices. NSE Indices Ltd -- the body
# that actually computes them -- publishes those on its own site, under two
# different directories, linked from each index's page. Two pages exist per
# index (the slug varies in case and hyphenation) and only one carries the link,
# so every candidate page is tried before giving up.

NIFTYINDICES = "https://www.niftyindices.com"
LISTING_PAGES = ["broad-market-indices", "sectoral-indices",
                 "thematic-indices", "strategy-indices"]
CONSTITUENT_CSV = re.compile(
    r'https://www\.niftyindices\.com/[A-Za-z_]+/[\w\-.]+_list\.csv', re.I)


def provider_pages(session):
    """Every index page NSE Indices links to, keyed by upper-cased index name."""
    pages = {}
    for listing in LISTING_PAGES:
        try:
            r = session.get(f"{NIFTYINDICES}/indices/equity/{listing}", timeout=30)
        except requests.RequestException:
            continue
        if r.status_code != 200:
            continue
        for href, label in re.findall(
                r'href="(/indices/equity/[^"]+)"[^>]*>([^<]{2,80})', r.text):
            name = html.unescape(label).strip().upper()
            if name:
                pages.setdefault(name, []).append(NIFTYINDICES + href)
    return pages


def provider_csv(session, name, pages):
    """The constituent CSV URL for `name`, or None."""
    for url in pages.get(name, []) or pages.get(name.replace("&", "AND"), []):
        try:
            r = session.get(url, timeout=30)
        except requests.RequestException:
            continue
        for csv_url in CONSTITUENT_CSV.findall(r.text):
            try:
                c = session.get(csv_url, timeout=30, headers={"Referer": url})
            except requests.RequestException:
                continue
            if c.status_code == 200 and "Symbol" in c.text[:300]:
                return csv_url
    return None


def main():
    session = requests.Session()
    session.headers.update(HEADERS)
    session.get("https://www.nseindia.com/", timeout=15)

    master = session.get(
        "https://www.nseindia.com/api/equity-master",
        timeout=15,
        headers={"Referer": "https://www.nseindia.com/market-data/live-equity-market"},
    ).json()

    targets = []
    seen = set()
    for index_name, label in EXTRA_INDICES:
        seen.add(index_name)
        targets.append((index_name, label))
    for group_key, label in GROUPS.items():
        for index_name in master.get(group_key, []):
            if index_name in seen:
                continue
            seen.add(index_name)
            targets.append((index_name, label))

    print(f"Resolving {len(targets)} indices...", file=sys.stderr)

    # Indices whose CSV can't be found are still kept: NSE publishes their level
    # and % change, so the card is useful even without a constituent list.
    indices, without_csv = {}, 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, group, fn in pool.map(resolve, targets):
            entry = {"group": group}
            if fn:
                entry["csv"] = fn
                print(f"  OK   {name:48s} {fn}", file=sys.stderr)
            else:
                without_csv += 1
                print(f"  ---  {name:48s} (index level only)", file=sys.stderr)
            indices[name] = entry

    # Second pass: ask the index provider about whatever NSE's archive lacked.
    gaps = [n for n, e in indices.items() if not e.get("csv")]
    if gaps:
        print("", file=sys.stderr)
        print(f"Asking NSE Indices about {len(gaps)} indices without a list...",
              file=sys.stderr)
        provider = requests.Session()
        provider.headers.update({"User-Agent": HEADERS["User-Agent"]})
        pages = provider_pages(provider)
        recovered = 0
        for name in gaps:
            url = provider_csv(provider, name, pages)
            if url:
                indices[name]["altCsv"] = url
                without_csv -= 1
                recovered += 1
                print(f"  OK   {name:48s} {url.rsplit('/', 1)[1]}", file=sys.stderr)
        print(f"  recovered {recovered} of {len(gaps)}", file=sys.stderr)

    MAP_FILE.write_text(json.dumps({"indices": indices}, indent=2), encoding="utf-8")
    print(f"\nWrote {len(indices)} indices ({without_csv} without a constituent list) "
          f"to {MAP_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
