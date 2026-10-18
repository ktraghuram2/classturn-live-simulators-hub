"""
Live Database-to-HTML Server
Renders `live_panel.html` and all 2,123 simulators dynamically from `classturn_simulators.db` on the fly!
  - Open http://localhost:8090/ or http://localhost:8090/live_panel.html for the Live Simulators Hub (2,123 Simulators)
  - Clicking "Launch Sim" on any simulator loads it directly from `classturn_simulators.db` + `universal_simulator.html`!
"""
import json
import re
import sqlite3
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import build_html_from_database as builder

ROOT = Path(__file__).resolve().parent


class DatabaseSimulatorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        # Serve live_panel.html at root / or /index.html or /live_panel.html
        if parsed.path in ("/", "/index.html", "/live_panel.html") and "id" not in qs:
            lp = ROOT / "live_panel.html"
            if lp.exists():
                data = lp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

        # Serve /builds/<sid>/classturn-lab-kit.js or /classturn-lab-kit.js
        if parsed.path.endswith("/classturn-lab-kit.js"):
            js_data = (ROOT / "classturn-lab-kit.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(js_data)))
            self.end_headers()
            self.wfile.write(js_data)
            return

        # Match /builds/<sid>/index.html or /universal_simulator.html?id=<sid>
        m_build = re.match(r"^/builds/([^/]+)/index\.html$", parsed.path)
        sid = None
        if m_build:
            sid = urllib.parse.unquote(m_build.group(1))
        elif parsed.path in ("/universal_simulator.html", "/sim", "/") and "id" in qs:
            sid = qs["id"][0]

        if sid:
            builder.ensure_database()
            conn = sqlite3.connect(str(builder.DB_PATH))
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT id, title, canvas_js, compiled_slots_json FROM simulators WHERE id = ?", (sid,)).fetchone()
            conn.close()
            if not row:
                self.send_error(404, f"Simulator {sid} not found in database")
                return
            tpl = builder.UNIVERSAL_HTML_PATH.read_text(encoding="utf-8")
            rendered = builder.render_simulator_html(dict(row), tpl, asset_prefix="/")
            data = rendered.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        return super().do_GET()


if __name__ == "__main__":
    port = 8090
    print(f"Serving Live Panel & all 2,123 simulators directly from classturn_simulators.db at http://localhost:{port}/live_panel.html")
    HTTPServer(("0.0.0.0", port), DatabaseSimulatorHandler).serve_forever()
