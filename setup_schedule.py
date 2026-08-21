"""
Registers the Windows scheduled tasks that keep the dashboard current.

Three jobs: one to serve the dashboard, two to keep its data current.

  Sector Rotation - Morning   09:16 on weekdays, a minute after the open. A full
                              rebuild: NSE archives,
                              constituent lists, 52-week levels, corporate
                              actions and price history. Takes a few minutes.

  Sector Rotation - Live      every 5 minutes from 09:25 to 15:45 on weekdays.
                              Reuses what the morning job cached and re-reads
                              only what moves -- index levels and prices. Also
                              carries the Telegram digest and alerts, so they
                              describe the session rather than yesterday.

  Sector Rotation - Server    a Startup-folder shortcut, so the web server comes
                              back at logon. Without it the dashboard is only up
                              while someone remembers to start it, which takes
                              the phone down with it.

The refresh jobs are registered with StartWhenAvailable, so a laptop that was off at 08:15
runs the missed job shortly after it comes back rather than skipping the day.
That is the setting schtasks cannot express, which is why this goes through
PowerShell's ScheduledTasks module instead.

None of them replace the Update Data button.

    python setup_schedule.py            create or update the tasks
    python setup_schedule.py --show     what is registered, and when it next runs
    python setup_schedule.py --remove   delete them
"""
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent

# pythonw has no console, so a refresh firing every five minutes doesn't throw a
# black window over whatever you were doing.
PYW = Path(sys.executable).with_name("pythonw.exe")
if not PYW.exists():
    PYW = Path(sys.executable)

RUNNER = BASE_DIR / "run_refresh.py"

MORNING = "Sector Rotation - Morning"
LIVE = "Sector Rotation - Live"
SERVER = "Sector Rotation - Server"

# Just after the 09:15 open, not before it.
#
# Run at 08:15 the rebuild could only ever describe yesterday's close, since
# nothing has traded yet -- so the board opened the day showing the previous
# session and waited for the live runs to correct it. A minute after the bell
# every index has a live level, and the day's figures are right from the first
# build rather than the fifth.
MORNING_AT = "09:16"

# After the rebuild has finished rather than alongside it. Both firing at once
# had them fetching the same prices in parallel and racing to write the same
# file, which is how a rebuild got silently clobbered once before.
LIVE_START = "09:25"
LIVE_EVERY_MIN = 5
# 09:25 -> 15:45, past the 15:30 close. Given in minutes because New-TimeSpan
# truncates fractional -Hours, which quietly cut the last half hour off.
LIVE_MINUTES = 380


def powershell(script):
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True,
    )


def cleanup_old_runners():
    """The .cmd wrappers this used to create are what flashed a console window."""
    for stale in ("run_morning.cmd", "run_live.cmd"):
        path = BASE_DIR / stale
        if path.exists():
            path.unlink()


def install_server_autostart():
    """
    Start the web server at logon, via a Startup-folder shortcut.

    A scheduled task with a logon trigger would be tidier, but registering one
    needs elevation, and a dashboard that only comes back when you remember to
    run something as administrator is not much of an improvement. A shortcut in
    the user's own Startup folder needs no such thing.
    """
    script = f"""
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'Sector Rotation Server.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = '{PYW}'
$s.Arguments = '"{BASE_DIR / "app.py"}" --lan'
$s.WorkingDirectory = '{BASE_DIR}'
$s.Description = 'Sector Rotation Analysis - local web server'
$s.WindowStyle = 7
$s.Save()
Write-Output $link
"""
    result = powershell(script)
    if result.returncode == 0 and result.stdout.strip():
        print(f"  created  {SERVER}\n           starts at logon via "
              f"{result.stdout.strip()}")
    else:
        print(f"  FAILED   {SERVER}\n           "
              f"{(result.stderr or result.stdout).strip()[:200]}", file=sys.stderr)


def remove_server_autostart():
    result = powershell(
        "$p = Join-Path ([Environment]::GetFolderPath('Startup')) "
        "'Sector Rotation Server.lnk'; "
        "if (Test-Path $p) { Remove-Item $p -Force; Write-Output 'removed' } "
        "else { Write-Output 'absent' }"
    )
    print(f"  {'removed ' if 'removed' in result.stdout else 'absent  '} {SERVER}")


def register(name, argument, trigger_script, minutes_limit):
    # 0 minutes means no limit, which is what a server that should stay up needs.
    limit = ("(New-TimeSpan -Minutes 0)" if minutes_limit == 0
             else f"(New-TimeSpan -Minutes {minutes_limit})")
    script = f"""
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '{PYW}' `
    -Argument '{argument}' -WorkingDirectory '{BASE_DIR}'
{trigger_script}
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit {limit}
Register-ScheduledTask -TaskName '{name}' -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
Write-Output 'ok'
"""
    result = powershell(script)
    if result.returncode == 0 and "ok" in result.stdout:
        return True, ""
    return False, (result.stderr or result.stdout).strip()[:220]


def create():
    cleanup_old_runners()

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

    install_server_autostart()

    jobs = [
        (MORNING, f'"{RUNNER}" --morning', morning_trigger, 30,
         f"weekdays at {MORNING_AT}, plus a catch-up run if the machine was off"),
        (LIVE, f'"{RUNNER}" --live', live_trigger, 10,
         f"weekdays every {LIVE_EVERY_MIN} min from {LIVE_START}, "
         f"through the {LIVE_MINUTES // 60}h{LIVE_MINUTES % 60}m session"),
    ]

    for name, argument, trigger, limit, description in jobs:
        ok, error = register(name, argument, trigger, limit)
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

    present = powershell(
        "$p = Join-Path ([Environment]::GetFolderPath('Startup')) "
        "'Sector Rotation Server.lnk'; "
        "if (Test-Path $p) { Write-Output 'installed' } else { Write-Output 'missing' }"
    )
    state = "installed at logon" if "installed" in present.stdout else "not installed"
    print(f"  {SERVER} | {state}")
    if result.returncode != 0 and result.stderr:
        print("  " + result.stderr.strip()[:200], file=sys.stderr)


def remove():
    remove_server_autostart()
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
