"""
Live Database-to-HTML Server + Live Cloud Shell QA Monitor API
  - http://localhost:8090/live_panel.html       -> Live Simulators Hub (2,123 Simulators)
  - http://localhost:8765/live_panel.html       -> Live Simulators Hub (2,123 Simulators)
"""
import json
import re
import sqlite3
import subprocess
import threading
import time
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import build_html_from_database as builder

ROOT = Path(__file__).resolve().parent
_LAST_GIT_FETCH = 0.0


def get_live_qa_status() -> dict:
    global _LAST_GIT_FETCH
    now = time.time()
    if now - _LAST_GIT_FETCH > 5.0:
        _LAST_GIT_FETCH = now
        try:
            subprocess.run(["git", "fetch", "origin", "main"], cwd=str(ROOT), capture_output=True, timeout=6)
        except Exception:
            pass

    commits = []
    try:
        r_log = subprocess.run(
            ["git", "log", "origin/main", "-n", "8", "--pretty=format:%h · %cr · %s"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=4
        )
        if r_log.returncode == 0:
            commits = [line.strip() for line in r_log.stdout.splitlines() if line.strip()]
    except Exception:
        pass

    progress_data = {}
    try:
        r_show = subprocess.run(
            ["git", "show", "origin/main:gemini_brain_qa_progress.json"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=4
        )
        if r_show.returncode == 0 and r_show.stdout.strip():
            progress_data = json.loads(r_show.stdout)
            progress_data["source"] = "GitHub Remote (origin/main)"
    except Exception:
        pass

    local_prog = ROOT / "gemini_brain_qa_progress.json"
    if local_prog.exists():
        try:
            loc = json.loads(local_prog.read_text(encoding="utf-8"))
            if loc.get("completed_count", 0) >= progress_data.get("completed_count", 0):
                progress_data = loc
                progress_data["source"] = "Local + GitHub Synced"
        except Exception:
            pass

    completed_ids = progress_data.get("completed_ids", [])
    return {
        "runner_state": progress_data.get("runner_state", "ACTIVE" if completed_ids else "WAITING FOR CLOUD SHELL"),
        "completed_count": progress_data.get("completed_count", len(completed_ids)),
        "fixed_count": progress_data.get("fixed_count", 0),
        "latest_sim_id": progress_data.get("latest_sim_id", completed_ids[-1] if completed_ids else "—"),
        "recent_events": progress_data.get("recent_events", []),
        "recent_commits": commits,
        "source": progress_data.get("source", "GitHub Remote (origin/main)"),
        "cloud_shell_hint": (
            "Connected to GitHub repo ktraghuram2/classturn-live-simulators-hub. "
            "As Cloud Shell finishes each simulator batch, live PASS/FIXED updates stream here automatically."
        ),
    }


class DatabaseSimulatorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        clean_path = re.sub(r"^/classturn-live-simulators-hub", "", parsed.path) or "/"

        if clean_path == "/api/qa-status":
            payload = json.dumps(get_live_qa_status(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if clean_path in ("/", "/index.html", "/live_panel.html") and "id" not in qs:
            lp = ROOT / "live_panel.html"
            if lp.exists():
                data = lp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

        if clean_path.endswith("/classturn-lab-kit.js"):
            js_data = (ROOT / "classturn-lab-kit.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(js_data)))
            self.end_headers()
            self.wfile.write(js_data)
            return

        m_build = re.match(r"^/builds/([^/]+)(?:/index\.html|/)?$", clean_path)
        sid = None
        if m_build:
            sid = urllib.parse.unquote(m_build.group(1))
        elif clean_path in ("/universal_simulator.html", "/sim", "/") and "id" in qs:
            sid = qs["id"][0]
        elif clean_path == "/universal_simulator.html":
            sid = "u01427"

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
    ports = [8090, 8765]
    servers = []
    for p in ports:
        try:
            srv = ThreadingHTTPServer(("0.0.0.0", p), DatabaseSimulatorHandler)
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            servers.append(srv)
            print(f"Serving Live Panel & 2,123 Simulators at http://127.0.0.1:{p}/live_panel.html")
        except Exception as e:
            print(f"Port {p} bind error: {e}")
    while True:
        time.sleep(3600)
