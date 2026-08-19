"""
Registers the Windows scheduled tasks that keep the dashboard current.

Two jobs, because the data has two speeds:

  Sector Rotation - Morning   08:15 on weekdays. A full rebuild: NSE archives,
                              constituent lists, 52-week levels, corporate
                              actions and price history, then the Telegram
                              digest. Takes a few minutes.

  Sector Rotation - Live      every 5 minutes from 09:15 to 15:45 on weekdays.
                              Reuses what the morning job cached and re-reads
                              only what moves -- index levels and prices.

Both are registered with StartWhenAvailable, so a laptop that was off at 08:15
runs the missed job shortly after it comes back rather than skipping the day.
That is the setting schtasks cannot express, which is why this goes through
PowerShell's ScheduledTasks module instead.

Neither replaces the Update Data button.

    python setup_schedule.py            create or update the tasks
    python setup_schedule.py --show     what is registered, and when it next runs
    python setup_schedule.py --remove   delete them
"""
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
PY = sys.executable

MORNING = "Sector Rotation - Morning"
LIVE = "Sector Rotation - Live"

MORNING_AT = "08:15"
LIVE_START = "09:15"
LIVE_EVERY_MIN = 5
# 09:15 -> 15:45, past the 15:30 close. Given in minutes because New-TimeSpan
# truncates fractional -Hours, which quietly cut the last half hour off.
LIVE_MINUTES = 390


def powershell(script):
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True,
    )


def write_runners():
    """
    Small .cmd wrappers. The morning job is two steps, and quoting a chain of
    Python calls through the scheduler is a reliable way to get it subtly wrong.
    """
    morning = BASE_DIR / "run_morning.cmd"
    morning.write_text(
        "@echo off\r\n"
        f'cd /d "{BASE_DIR}"\r\n'
        f'"{PY}" fetch_data.py\r\n'
        f'"{PY}" telegram_alerts.py\r\n',
        encoding="utf-8",
    )

    live = BASE_DIR / "run_live.cmd"
    live.write_text(
        "@echo off\r\n"
        f'cd /d "{BASE_DIR}"\r\n'
        f'"{PY}" fetch_data.py --live\r\n',
        encoding="utf-8",
    )
    return morning, live


def register(name, runner, trigger_script, minutes_limit):
    script = f"""
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '{runner}' -WorkingDirectory '{BASE_DIR}'
{trigger_script}
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes {minutes_limit})
Register-ScheduledTask -TaskName '{name}' -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
Write-Output 'ok'
"""
    result = powershell(script)
    if result.returncode == 0 and "ok" in result.stdout:
        return True, ""
    return False, (result.stderr or result.stdout).strip()[:220]


def create():
    morning_cmd, live_cmd = write_runners()

    weekdays = "Monday,Tuesday,Wednesday,Thursday,Friday"

    morning_trigger = (
        f"$trigger = New-ScheduledTaskTrigger -Weekly "
        f"-DaysOfWeek {weekdays} -At {MORNING_AT}"
    )

    # A repeating trigger is built by borrowing the Repetition block from a
    # one-off trigger; the weekly trigger has no way to express it directly.
    live_trigger = (
        f"$trigger = New-ScheduledTaskTrigger -Weekly "
        f"-DaysOfWeek {weekdays} -At {LIVE_START}\n"
        f"$repeat = New-ScheduledTaskTrigger -Once -At {LIVE_START} "
        f"-RepetitionInterval (New-TimeSpan -Minutes {LIVE_EVERY_MIN}) "
        f"-RepetitionDuration (New-TimeSpan -Minutes {LIVE_MINUTES})\n"
        f"$trigger.Repetition = $repeat.Repetition"
    )

    jobs = [
        (MORNING, morning_cmd, morning_trigger, 30,
         f"weekdays at {MORNING_AT}, plus a catch-up run if the machine was off"),
        (LIVE, live_cmd, live_trigger, 10,
         f"weekdays every {LIVE_EVERY_MIN} min from {LIVE_START}, through the {LIVE_MINUTES // 60}h{LIVE_MINUTES % 60}m session"),
    ]

    for name, runner, trigger, limit, description in jobs:
        ok, error = register(name, runner, trigger, limit)
        if ok:
            print(f"  created  {name}\n           {description}")
        else:
            print(f"  FAILED   {name}\n           {error}", file=sys.stderr)


def show():
    script = f"""
foreach ($n in @('{MORNING}','{LIVE}')) {{
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if ($t) {{
    $i = Get-ScheduledTaskInfo -TaskName $n
    Write-Output ("{{0}} | state {{1}} | next {{2}} | last {{3}}" -f `
      $n, $t.State, $i.NextRunTime, $i.LastRunTime)
  }} else {{ Write-Output ("{{0}} | not registered" -f $n) }}
}}
"""
    result = powershell(script)
    for line in (result.stdout or "").splitlines():
        if line.strip():
            print("  " + line.strip())
    if result.returncode != 0 and result.stderr:
        print("  " + result.stderr.strip()[:200], file=sys.stderr)


def remove():
    for name in (MORNING, LIVE):
        result = powershell(
            f"Unregister-ScheduledTask -TaskName '{name}' -Confirm:$false "
            f"-ErrorAction SilentlyContinue; Write-Output 'done'"
        )
        print(f"  removed  {name}" if result.returncode == 0 else f"  failed   {name}")


def main():
    if "--show" in sys.argv:
        show()
    elif "--remove" in sys.argv:
        remove()
    else:
        print("Registering scheduled tasks...\n")
        create()
        print("\nRegistered:\n")
        show()
        print("\nUndo with: python setup_schedule.py --remove")


if __name__ == "__main__":
    main()
