"""
Silent entry point for the scheduled refreshes.

Run under pythonw.exe this opens no console window, which matters when it fires
every five minutes while someone is trying to work. The previous .cmd wrappers
went through cmd.exe and flashed a black window each time.

Nothing is shelled out to, either -- fetch_data and telegram_alerts are imported
and called in-process, so no child ever gets a console of its own. pythonw
discards stdout and stderr, so both are redirected to logs/refresh.log, which is
the only record of what these runs did.

    pythonw run_refresh.py --live       intraday refresh, and the Telegram alerts
    pythonw run_refresh.py --morning    full rebuild, before the bell
"""
import sys
import traceback
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
LOG_DIR = BASE_DIR / "logs"
LOG_FILE = LOG_DIR / "refresh.log"

# A few hundred KB of history is plenty to see what happened last week.
MAX_LOG_BYTES = 512 * 1024


def trim_log():
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_BYTES:
        text = LOG_FILE.read_text(encoding="utf-8", errors="replace")
        LOG_FILE.write_text(text[-MAX_LOG_BYTES // 2:], encoding="utf-8")


def main():
    live = "--live" in sys.argv
    morning = "--morning" in sys.argv

    LOG_DIR.mkdir(exist_ok=True)
    trim_log()

    with open(LOG_FILE, "a", encoding="utf-8", buffering=1) as log:
        sys.stdout = log
        sys.stderr = log

        started = datetime.now()
        mode = "live" if live else "morning" if morning else "full"
        log.write(f"\n===== {started:%Y-%m-%d %H:%M:%S} · {mode} refresh =====\n")

        try:
            import fetch_data
            fetch_data.main(live=live)

            # Whatever the mode, look at what was just produced. This is the
            # only thing standing between a broken pipeline and days of
            # confident-looking wrong numbers.
            try:
                import health_check
                problems, counts = health_check.check()
                if problems:
                    log.write("health: " + "; ".join(problems) + "\n")
                    fresh, _ = health_check.since_last(problems)
                    if fresh:
                        import telegram_alerts
                        telegram_alerts.send("<b>⚠️ Data health</b>\n"
                                             + "\n".join("• " + p for p in fresh))
                else:
                    health_check.remember(counts)
                    _, recovered = health_check.since_last([])
                    if recovered:
                        import telegram_alerts
                        telegram_alerts.send("<b>✅ Data health back to normal</b>")
            except Exception:
                log.write("health check failed:\n" + traceback.format_exc())

            if live:
                # Alerts ride the intraday runs rather than the 08:15 rebuild.
                # Sent pre-open they could only describe yesterday's close; sent
                # after the bell they carry the session that is actually
                # tradeable. The digest goes once per market date and the rest
                # of the session reports only what changed, so this is not five
                # minutes of noise.
                try:
                    import telegram_alerts
                    telegram_alerts.main(argv=[], daily=True)
                except SystemExit:
                    pass                       # no data or no credentials: already logged
                except Exception:
                    log.write("alerts failed:\n" + traceback.format_exc())

            took = (datetime.now() - started).total_seconds()
            log.write(f"----- done in {took:.0f}s -----\n")
            return 0

        except Exception:
            log.write("refresh failed:\n" + traceback.format_exc())
            return 1


if __name__ == "__main__":
    sys.exit(main())
