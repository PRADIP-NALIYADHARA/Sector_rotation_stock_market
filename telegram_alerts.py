"""
Telegram digest and alerts for the sector dashboard.

The dashboard only tells you something when you go and look at it. Rotation
rarely announces itself on the day you happen to open a browser, so this watches
the things worth being interrupted for:

  - the market regime flipping between risk-on and risk-off
  - a sector clearing its own 52-week high while the index is still range-bound
  - a sector crossing above or below the benchmark

State is kept in data/alert_state.json so the same event isn't sent twice. The
first run has nothing to compare against, so it sends the digest and records the
baseline rather than firing an alert for everything at once.

Setup, once:

  1. Message @BotFather on Telegram, /newbot, and copy the token it gives you.
  2. Message your new bot anything, then open
     https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat id.
  3. Put both in telegram_config.json next to this file:

         {"token": "123456:ABC...", "chatId": "987654321"}

     or set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in the environment.

The config file is gitignored. Never commit the token -- anyone holding it can
post as your bot.

    python telegram_alerts.py            send alerts if anything changed
    python telegram_alerts.py --digest   send the full digest regardless
    python telegram_alerts.py --dry-run  print what would be sent
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
STATE_FILE = BASE_DIR / "data" / "alert_state.json"
CONFIG_FILE = BASE_DIR / "telegram_config.json"

API = "https://api.telegram.org/bot{token}/sendMessage"

TOP_N = 6
DIGEST_PERIOD = "1M"


def load_config():
    token = os.environ.get("TELEGRAM_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat:
        return token, chat

    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return cfg.get("token"), str(cfg.get("chatId", ""))

    return None, None


def send(text, dry_run=False):
    if dry_run:
        print("--- would send ---\n" + text + "\n------------------")
        return True

    token, chat = load_config()
    if not token or not chat:
        print("No Telegram credentials. See the setup notes at the top of this file.",
              file=sys.stderr)
        return False

    r = requests.post(API.format(token=token), timeout=30, json={
        "chat_id": chat,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    })
    if r.status_code != 200:
        print(f"Telegram rejected the message: {r.status_code} {r.text[:200]}", file=sys.stderr)
        return False
    return True


def pct(v):
    return "—" if v is None else f"{'+' if v > 0 else ''}{v:.2f}%"


def load_state():
    if not STATE_FILE.exists():
        return {}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state):
    STATE_FILE.parent.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def snapshot(data):
    """The few facts an alert can be raised against."""
    return {
        "breakouts": sorted(s["indexName"] for s in data["sectors"]
                            if s.get("lead", {}).get("breakingOut")),
        "above": sorted(s["indexName"] for s in data["sectors"]
                        if (s.get("rs") or {}).get(DIGEST_PERIOD) is not None
                        and s["rs"][DIGEST_PERIOD] > 0),
        "bhavDate": data.get("bhavDate"),
    }


def build_digest(data):
    sectors = [s for s in data["sectors"] if s["group"] != "Broad"]
    ranked = sorted(
        (s for s in sectors if (s.get("rs") or {}).get(DIGEST_PERIOD) is not None),
        key=lambda s: -s["rs"][DIGEST_PERIOD],
    )
    bm = data.get("benchmark", {})

    lines = [
        "<b>Sector Rotation — daily digest</b>",
        f"<i>{data.get('bhavDate', '')} · vs {bm.get('name', 'benchmark')} over {DIGEST_PERIOD}</i>",
        "",
    ]

    if ranked:
        lines.append("<b>Leading</b>")
        for s in ranked[:TOP_N]:
            flag = " ⚡" if s.get("lead", {}).get("breakingOut") else ""
            lines.append(f"  {s['name']}  {pct(s['rs'][DIGEST_PERIOD])}{flag}")
        lines.append("")
        lines.append("<b>Lagging</b>")
        for s in ranked[-3:]:
            lines.append(f"  {s['name']}  {pct(s['rs'][DIGEST_PERIOD])}")

    breakouts = [s for s in sectors if s.get("lead", {}).get("breakingOut")]
    if breakouts:
        lines += ["", f"<b>⚡ At their own 52-week high</b> ({len(breakouts)})",
                  "  " + ", ".join(s["name"] for s in breakouts[:8])]

    return "\n".join(lines)


def build_alerts(data, previous):
    """Only what changed since the last run."""
    now = snapshot(data)
    alerts = []

    new_breakouts = set(now["breakouts"]) - set(previous.get("breakouts", []))
    if new_breakouts:
        names = [s["name"] for s in data["sectors"] if s["indexName"] in new_breakouts]
        alerts.append("⚡ <b>New breakout</b>: " + ", ".join(sorted(names))
                      + "\nAt its own 52-week high while the index is not.")

    crossed_up = set(now["above"]) - set(previous.get("above", []))
    crossed_down = set(previous.get("above", [])) - set(now["above"])

    def named(keys):
        return sorted(s["name"] for s in data["sectors"] if s["indexName"] in keys)

    # Broad indices crossing the benchmark is noise -- they largely are the market.
    interesting = {s["indexName"] for s in data["sectors"] if s["group"] != "Broad"}
    crossed_up &= interesting
    crossed_down &= interesting

    if crossed_up:
        alerts.append("📈 <b>Now beating the benchmark</b>: " + ", ".join(named(crossed_up)))
    if crossed_down:
        alerts.append("📉 <b>Fallen behind the benchmark</b>: " + ", ".join(named(crossed_down)))

    return alerts, now


def main():
    dry_run = "--dry-run" in sys.argv
    force_digest = "--digest" in sys.argv

    if not DATA_FILE.exists():
        sys.exit("No data yet - run fetch_data.py first.")
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))

    state = load_state()
    previous = state.get("snapshot", {})

    alerts, current = build_alerts(data, previous)
    first_run = not previous

    if first_run:
        print("First run - sending the digest and recording a baseline.", file=sys.stderr)
        sent = send(build_digest(data), dry_run)
    elif force_digest:
        sent = send(build_digest(data), dry_run)
    elif alerts:
        header = f"<b>Sector Rotation</b> · {data.get('bhavDate', '')}\n\n"
        sent = send(header + "\n\n".join(alerts), dry_run)
    else:
        print("Nothing changed since the last run.", file=sys.stderr)
        sent = True

    if sent and not dry_run:
        state["snapshot"] = current
        state["lastRun"] = datetime.now().isoformat(timespec="seconds")
        save_state(state)


if __name__ == "__main__":
    main()
