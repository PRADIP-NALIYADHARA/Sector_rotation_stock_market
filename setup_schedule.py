"""
Registers the two Windows scheduled tasks that keep the dashboard current.

Two jobs, because the data has two speeds:

  Sector Rotation - Morning     08:15 on weekdays, a full rebuild. Re-reads NSE's
                                archives, constituent lists, 52-week levels and
                                corporate actions, and refreshes the price
                                history. This is the slow one, a few minutes.

  Sector Rotation - Live        every 15 minutes between 09:15 and 15:30 on
                                weekdays. Reuses everything the morning job
                                cached and only re-reads what actually moves:
                                index levels and prices. Takes seconds.

The alert digest runs after the morning rebuild, so a notification arrives once a
day with whatever changed overnight.

Nothing here replaces the Update Data button -- that still forces a refresh
whenever you want one.

    python setup_schedule.py            create or update the tasks
    python setup_schedule.py --show     list what is currently registered
    python setup_schedule.py --remove   delete them
"""
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
PY = sys.executable

MORNING = "Sector Rotation - Morning"
LIVE = "Sector Rotation - Live"

# Indian market hours; the live job is pointless outside them.
LIVE_START = "09:15"
LIVE_MINUTES = 15
LIVE_DURATION = "06:30"      # 09:15 -> 15:45, covering the close
MORNING_AT = "08:15"


def run(args):
    return subprocess.run(args, capture_output=True, text=True)


def wrapper_script():
    """
    A .cmd wrapper, so the morning job can run the fetch and then the alerts.

    schtasks runs a single command, and quoting a two-step Python invocation
    through it is a reliable way to get something subtly wrong.
    """
    path = BASE_DIR / "run_morning.cmd"
    path.write_text(
        "@echo off\r\n"
        f'cd /d "{BASE_DIR}"\r\n'
        f'"{PY}" fetch_data.py\r\n'
        f'"{PY}" telegram_alerts.py\r\n',
        encoding="utf-8",
    )
    return path


def live_script():
    path = BASE_DIR / "run_live.cmd"
    path.write_text(
        "@echo off\r\n"
        f'cd /d "{BASE_DIR}"\r\n'
        f'"{PY}" fetch_data.py --live\r\n',
        encoding="utf-8",
    )
    return path


def create():
    morning = wrapper_script()
    live = live_script()

    jobs = [
        ([
            "schtasks", "/Create", "/TN", MORNING, "/TR", f'"{morning}"',
            "/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", MORNING_AT, "/F",
        ], f"{MORNING}: weekdays at {MORNING_AT}"),
        ([
            "schtasks", "/Create", "/TN", LIVE, "/TR", f'"{live}"',
            "/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", LIVE_START,
            "/RI", str(LIVE_MINUTES), "/DU", LIVE_DURATION, "/F",
        ], f"{LIVE}: weekdays every {LIVE_MINUTES} min from {LIVE_START}"),
    ]

    for args, description in jobs:
        result = run(args)
        if result.returncode == 0:
            print(f"  created  {description}")
        else:
            print(f"  FAILED   {description}\n           "
                  f"{(result.stderr or result.stdout).strip()[:160]}", file=sys.stderr)


def show():
    for name in (MORNING, LIVE):
        result = run(["schtasks", "/Query", "/TN", name, "/FO", "LIST"])
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if any(k in line for k in ("TaskName", "Next Run Time", "Status", "Last Run")):
                    print("  " + line.strip())
            print()
        else:
            print(f"  {name}: not registered\n")


def remove():
    for name in (MORNING, LIVE):
        result = run(["schtasks", "/Delete", "/TN", name, "/F"])
        print(f"  {'removed ' if result.returncode == 0 else 'not found'} {name}")


def main():
    if "--show" in sys.argv:
        show()
    elif "--remove" in sys.argv:
        remove()
    else:
        print("Registering scheduled tasks...")
        create()
        print("\nCurrently registered:\n")
        show()
        print("Run 'python setup_schedule.py --remove' to undo.")


if __name__ == "__main__":
    main()
