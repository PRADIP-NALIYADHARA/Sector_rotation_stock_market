"""
What moved in the rankings, and when.

The board is a still photograph. It says who leads today and says nothing about
who led last week, which is a strange gap in a tool whose whole subject is
rotation -- the interesting moment is rarely "X is ahead", it is "X was
fourteenth a fortnight ago and is now third".

Nothing had to be recorded from here on to fix that. The cached index history
already holds five years of closes, so past rankings can simply be recomputed:
take the same relative-strength calculation, run it as of an earlier date, and
compare the order that comes out.

Broad indices are left out of the ranking. They largely are the market, so they
crowd a leaderboard meant to say which part of it is winning.
"""

from datetime import date, timedelta

# Being in the top this many is what counts as "leading" for the purposes of
# entering and leaving.
TOP_N = 10

# How far back to look, and what to call it.
SINCE = [(7, "week"), (30, "month")]

# A rank change smaller than this is shuffling, not rotation.
NOTABLE_RANK_MOVE = 5


def _as_of(dates, target):
    """Index of the last date on or before `target`, or None."""
    found = None
    for i, d in enumerate(dates):
        if d <= target:
            found = i
        else:
            break
    return found


def _return_at(series, now_i, then_i):
    now, then = series[now_i], series[then_i]
    if now is None or then in (None, 0):
        return None
    return 100 * (now / then - 1)


def ranking(history, names, benchmark, at_i, window_days):
    """
    {index: (rank, rs)} as of `at_i`, strongest first.

    The same arithmetic the live board uses -- return over the window, less the
    benchmark's return over the same window -- just anchored to an older date.
    """
    dates = history["dates"]
    series = history["series"]

    target = date.fromisoformat(dates[at_i]) - timedelta(days=window_days)
    then_i = _as_of(dates, target.isoformat())
    if then_i is None or then_i == at_i:
        return {}

    bm = _return_at(series.get(benchmark, []), at_i, then_i)
    if bm is None:
        return {}

    scored = []
    for name in names:
        r = _return_at(series.get(name, []), at_i, then_i)
        if r is not None:
            scored.append((name, r - bm))

    scored.sort(key=lambda x: -x[1])
    return {name: (i + 1, rs) for i, (name, rs) in enumerate(scored)}


def build(history, sectors, benchmark, window_days=30, window_label="1M"):
    """The movers, versus a week ago and versus a month ago."""
    dates = history.get("dates") or []
    if len(dates) < 2:
        return None

    label_of = {s["indexName"]: s["name"] for s in sectors}
    names = [s["indexName"] for s in sectors
             if s.get("source") == "index" and s["group"] != "Broad"
             and s["indexName"] != benchmark]

    now_i = len(dates) - 1
    now = ranking(history, names, benchmark, now_i, window_days)
    if not now:
        return None

    out = {"window": window_label, "asOf": dates[now_i], "since": {}}

    for days, key in SINCE:
        then_i = _as_of(dates, (date.fromisoformat(dates[now_i]) - timedelta(days=days)).isoformat())
        if then_i is None or then_i >= now_i:
            continue
        before = ranking(history, names, benchmark, then_i, window_days)
        if not before:
            continue

        shared = [n for n in now if n in before]
        top_now = {n for n in shared if now[n][0] <= TOP_N}
        top_before = {n for n in shared if before[n][0] <= TOP_N}

        def described(keys):
            return [{"name": label_of.get(n, n), "indexName": n,
                     "from": before[n][0], "to": now[n][0],
                     "rs": round(now[n][1], 2)}
                    for n in sorted(keys, key=lambda x: now[x][0])]

        climbed = [n for n in shared
                   if before[n][0] - now[n][0] >= NOTABLE_RANK_MOVE and n not in top_now]
        slipped = [n for n in shared
                   if now[n][0] - before[n][0] >= NOTABLE_RANK_MOVE and n not in top_before]

        out["since"][key] = {
            "date": dates[then_i],
            "days": days,
            "entered": described(top_now - top_before),
            "left": described(top_before - top_now),
            # Crossing the benchmark is the moment a sector stops lagging it,
            # which the rank alone does not show.
            "crossedUp": described({n for n in shared
                                    if now[n][1] > 0 >= before[n][1]}),
            "crossedDown": described({n for n in shared
                                      if now[n][1] <= 0 < before[n][1]}),
            "climbed": described(sorted(climbed, key=lambda n: now[n][0] - before[n][0])[:5]),
            "slipped": described(sorted(slipped, key=lambda n: before[n][0] - now[n][0])[:5]),
        }

    return out if out["since"] else None
