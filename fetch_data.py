"""
Fetches live NSE sector and stock data and writes it to data/sectors_data.json.

Data sources (all public NSE endpoints, no login required):
  - /api/allIndices          -> live sectoral index % change (for sector-level color)
  - /content/indices/*.csv   -> constituent stock list per sector index
  - /products/content/sec_bhavdata_full_DDMMYYYY.csv -> per-stock close/prev-close (for stock-level color)

Run directly: python fetch_data.py
"""
import csv
import io
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import requests

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"

# Thresholds for classification (% change). Tune these as needed.
BULLISH_THRESHOLD = 0.75
BEARISH_THRESHOLD = -0.75

# Sector display name -> (NSE index name, constituent-list CSV filename)
SECTORS = {
    "Auto":               ("NIFTY AUTO", "ind_niftyautolist.csv"),
    "Bank":                ("NIFTY BANK", "ind_niftybanklist.csv"),
    "Financial Services":  ("NIFTY FINANCIAL SERVICES", "ind_niftyfinancelist.csv"),
    "FMCG":                ("NIFTY FMCG", "ind_niftyfmcglist.csv"),
    "IT":                  ("NIFTY IT", "ind_niftyitlist.csv"),
    "Media":               ("NIFTY MEDIA", "ind_niftymedialist.csv"),
    "Metal":               ("NIFTY METAL", "ind_niftymetallist.csv"),
    "Pharma":              ("NIFTY PHARMA", "ind_niftypharmalist.csv"),
    "PSU Bank":            ("NIFTY PSU BANK", "ind_niftypsubanklist.csv"),
    "Private Bank":        ("NIFTY PRIVATE BANK", "ind_nifty_privatebanklist.csv"),
    "Realty":              ("NIFTY REALTY", "ind_niftyrealtylist.csv"),
    "Healthcare":          ("NIFTY HEALTHCARE INDEX", "ind_niftyhealthcarelist.csv"),
    "Consumer Durables":   ("NIFTY CONSUMER DURABLES", "ind_niftyconsumerdurableslist.csv"),
    "Oil & Gas":           ("NIFTY OIL & GAS", "ind_niftyoilgaslist.csv"),
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}


def classify(pct_change):
    if pct_change is None:
        return "neutral"
    if pct_change >= BULLISH_THRESHOLD:
        return "bullish"
    if pct_change <= BEARISH_THRESHOLD:
        return "bearish"
    return "neutral"


def make_session():
    session = requests.Session()
    session.headers.update(HEADERS)
    session.get("https://www.nseindia.com/", timeout=10)
    return session


def fetch_all_indices(session):
    r = session.get(
        "https://www.nseindia.com/api/allIndices",
        timeout=15,
        headers={"Referer": "https://www.nseindia.com/market-data/live-equity-market"},
    )
    r.raise_for_status()
    data = r.json()["data"]
    return {d["index"]: d for d in data}


def fetch_constituents(csv_filename):
    url = f"https://nsearchives.nseindia.com/content/indices/{csv_filename}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    return [
        {"symbol": row["Symbol"].strip(), "company": row["Company Name"].strip(), "industry": row["Industry"].strip()}
        for row in reader
    ]


def fetch_bhavcopy():
    """Try today, stepping back a few days to skip weekends/holidays."""
    for days_back in range(0, 6):
        d = datetime.now() - timedelta(days=days_back)
        ds = d.strftime("%d%m%Y")
        url = f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{ds}.csv"
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code == 200 and "SYMBOL" in r.text:
            reader = csv.DictReader(io.StringIO(r.text))
            reader.fieldnames = [f.strip() for f in reader.fieldnames]
            by_symbol = {}
            for row in reader:
                row = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
                if row.get("SERIES") != "EQ":
                    continue
                try:
                    prev_close = float(row["PREV_CLOSE"])
                    close = float(row["CLOSE_PRICE"])
                    pchange = ((close - prev_close) / prev_close) * 100 if prev_close else None
                except (ValueError, ZeroDivisionError):
                    prev_close = close = pchange = None
                by_symbol[row["SYMBOL"]] = {
                    "close": close,
                    "prevClose": prev_close,
                    "pChange": round(pchange, 2) if pchange is not None else None,
                }
            return by_symbol, d.strftime("%d-%b-%Y")
    raise RuntimeError("Could not find a recent NSE bhavcopy file (last 6 days all missing)")


def main():
    print("Connecting to NSE...", file=sys.stderr)
    session = make_session()

    print("Fetching sector index data...", file=sys.stderr)
    indices = fetch_all_indices(session)

    print("Fetching daily bhavcopy (stock prices)...", file=sys.stderr)
    bhav, bhav_date = fetch_bhavcopy()

    sectors_out = []
    for display_name, (index_name, csv_file) in SECTORS.items():
        idx = indices.get(index_name)
        if idx is None:
            print(f"  WARNING: index '{index_name}' not found in allIndices response", file=sys.stderr)
            continue

        pct_change = idx.get("percentChange")
        try:
            constituents = fetch_constituents(csv_file)
        except Exception as e:
            print(f"  WARNING: could not fetch constituents for {display_name}: {e}", file=sys.stderr)
            constituents = []

        stocks = []
        for c in constituents:
            price_data = bhav.get(c["symbol"], {})
            stock_pchange = price_data.get("pChange")
            stocks.append({
                "symbol": c["symbol"],
                "company": c["company"],
                "industry": c["industry"],
                "close": price_data.get("close"),
                "prevClose": price_data.get("prevClose"),
                "pChange": stock_pchange,
                "status": classify(stock_pchange),
            })
        stocks.sort(key=lambda s: (s["pChange"] is None, -(s["pChange"] or 0)))

        sectors_out.append({
            "name": display_name,
            "indexName": index_name,
            "last": idx.get("last"),
            "pChange": pct_change,
            "advances": idx.get("advances"),
            "declines": idx.get("declines"),
            "unchanged": idx.get("unchanged"),
            "status": classify(pct_change),
            "stocks": stocks,
        })

    sectors_out.sort(key=lambda s: -(s["pChange"] or 0))

    output = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "bhavDate": bhav_date,
        "thresholds": {"bullish": BULLISH_THRESHOLD, "bearish": BEARISH_THRESHOLD},
        "sectors": sectors_out,
    }

    DATA_FILE.parent.mkdir(exist_ok=True)
    DATA_FILE.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Saved {len(sectors_out)} sectors to {DATA_FILE}", file=sys.stderr)
    return output


if __name__ == "__main__":
    main()
