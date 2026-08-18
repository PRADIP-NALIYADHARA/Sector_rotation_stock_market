"""
Sector Rotation Analysis - local web server (Python standard library only).

    python app.py            serve on this machine only
    python app.py --lan      also serve to phones/tablets on the same Wi-Fi
"""
import json
import socket
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "sectors_data.json"
PORT = 5000


def lan_ip():
    """This machine's address on the local network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))       # no packets sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()

refresh_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/sectors":
            if not DATA_FILE.exists():
                self.send_json(
                    {"error": "no_data", "message": "No data yet. Click 'Update Data' to fetch from NSE."},
                    404,
                )
                return
            self.send_json(json.loads(DATA_FILE.read_text(encoding="utf-8")))
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/refresh":
            self.send_json({"error": "not_found"}, 404)
            return

        if not refresh_lock.acquire(blocking=False):
            self.send_json({"error": "busy", "message": "A refresh is already running."}, 409)
            return

        try:
            result = subprocess.run(
                [sys.executable, str(BASE_DIR / "fetch_data.py")],
                capture_output=True,
                text=True,
                timeout=300,
                cwd=str(BASE_DIR),
            )
            if result.returncode != 0:
                self.send_json({"error": "fetch_failed", "message": result.stderr[-1500:]}, 500)
                return
            self.send_json({
                "ok": True,
                "log": result.stderr[-1500:],
                "data": json.loads(DATA_FILE.read_text(encoding="utf-8")),
            })
        except subprocess.TimeoutExpired:
            self.send_json({"error": "timeout", "message": "NSE fetch took too long (>5 min)."}, 504)
        finally:
            refresh_lock.release()


if __name__ == "__main__":
    share = "--lan" in sys.argv
    host = "0.0.0.0" if share else "127.0.0.1"

    print(f"Sector Rotation Analysis running at http://127.0.0.1:{PORT}", file=sys.stderr)
    if share:
        ip = lan_ip()
        if ip:
            print(f"On your phone (same Wi-Fi):     http://{ip}:{PORT}", file=sys.stderr)
        else:
            print("Could not work out this machine's LAN address.", file=sys.stderr)
        print("Windows may ask you to allow Python through the firewall - say yes "
              "for private networks.", file=sys.stderr)
    else:
        print("Run with --lan to open it on your phone too.", file=sys.stderr)

    ThreadingHTTPServer((host, PORT), Handler).serve_forever()
