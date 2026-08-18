"""
Builds a single self-contained HTML file with the CSS, JS and current data all
inlined, so the dashboard can be opened by double-clicking it -- no server, no
Python, no internet.

The snapshot is frozen at whatever data/sectors_data.json held when it was built;
the Update Data button won't work in it. Run app.py for the live version.

    python build_snapshot.py [output.html]
"""
import json
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

    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        f"<style>\n{css}\n</style>",
    )
    # </script> inside the JSON would end the tag early.
    payload = json.dumps(data).replace("</", "<\\/")
    html = html.replace(
        '<script src="js/app.js"></script>',
        f"<script>window.EMBEDDED_DATA = {payload};</script>\n<script>\n{js}\n</script>",
    )

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
