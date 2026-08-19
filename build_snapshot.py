"""
Builds a single self-contained HTML file with the CSS, JS and current data all
inlined, so the dashboard can be opened by double-clicking it -- no server, no
Python, no internet.

The snapshot is frozen at whatever data/sectors_data.json held when it was built;
the Update Data button won't work in it. Run app.py for the live version.

    python build_snapshot.py [output.html]
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent
DEFAULT_OUT = BASE_DIR / "sector_rotation_snapshot.html"


def main():
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT

    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
    css = (BASE_DIR / "css" / "style.css").read_text(encoding="utf-8")
    js = (BASE_DIR / "js" / "app.js").read_text(encoding="utf-8")

    data_file = BASE_DIR / "data" / "sectors_data.json"
    if not data_file.exists():
        sys.exit("No data/sectors_data.json yet -- run fetch_data.py first.")
    data = json.loads(data_file.read_text(encoding="utf-8"))

    # The comparison chart reads its series over /api/history, which a file on
    # disk has no way to call, so it travels inside the page too.
    history_file = BASE_DIR / "data" / "index_history.json"
    history = None
    if history_file.exists():
        history = json.loads(history_file.read_text(encoding="utf-8"))
        history.pop("byDate", None)     # incremental-fetch scratch, not needed here
    else:
        print("No index history cached - the comparison chart will be unavailable "
              "in this snapshot. Run build_history.py first.", file=sys.stderr)

    # The tags carry a cache-busting ?v=N, so match them by pattern rather than
    # by an exact string that goes stale every time the version is bumped.
    html, n = re.subn(r'<link rel="stylesheet" href="css/style\.css[^"]*">',
                      lambda _: f"<style>\n{css}\n</style>", html, count=1)
    if not n:
        sys.exit("Could not find the stylesheet tag in index.html")
    # </script> inside the JSON would end the tag early.
    def embed(obj):
        return json.dumps(obj).replace("</", "<\\/")

    preamble = f"window.EMBEDDED_DATA = {embed(data)};"
    if history:
        preamble += f"\nwindow.EMBEDDED_HISTORY = {embed(history)};"

    html, n = re.subn(r'<script src="js/app\.js[^"]*"></script>',
                      lambda _: f"<script>{preamble}</script>\n<script>\n{js}\n</script>",
                      html, count=1)
    if not n:
        sys.exit("Could not find the app script tag in index.html")

    built = datetime.now().strftime("%d %b %Y %H:%M")
    html = html.replace(
        "<title>Sector Rotation Analysis</title>",
        f"<title>Sector Rotation Analysis</title>\n<!-- standalone snapshot built {built} -->",
    )

    out_path.write_text(html, encoding="utf-8")
    size_mb = out_path.stat().st_size / 1_048_576
    print(f"Wrote {out_path} ({size_mb:.1f} MB, {len(data['sectors'])} sectors, "
          f"data from {data['bhavDate']})")


if __name__ == "__main__":
    main()
