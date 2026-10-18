"""
Cloud Shell Multi-Agent Gemini Brain QA & Auto-Rectifier
========================================================
- Picks each simulator from classturn_simulators.db
- Sends the simulator + questions from simulator_qa_master_questions.json
  DIRECTLY to a real Gemini AI model (100% in Gemini's brain, zero Python regex checking)
- Supports:
    1) GEMINI_API_KEY / GOOGLE_API_KEY
    2) Google Cloud Shell Vertex AI ADC (gcloud auth print-access-token)
    3) agy CLI / gemini CLI (Google AI Ultra subscription)
- Automatically updates classturn_simulators.db, updates gemini_brain_qa_progress.json,
  repacks db_chunks/, and pushes live status + database updates to GitHub!
"""
import argparse
import concurrent.futures
import datetime
import gzip
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
DB_PATH = ROOT / "classturn_simulators.db"
CHUNKS_DIR = ROOT / "db_chunks"
QUESTIONS_PATH = ROOT / "simulator_qa_master_questions.json"
PROGRESS_PATH = ROOT / "gemini_brain_qa_progress.json"


def ensure_git_identity():
    subprocess.run(["git", "config", "user.name", "ClassTurn Cloud Agent"], cwd=ROOT, check=False)
    subprocess.run(["git", "config", "user.email", "ktraghuram2@users.noreply.github.com"], cwd=ROOT, check=False)


def ensure_database():
    if DB_PATH.exists() and DB_PATH.stat().st_size > 10_000_000:
        return DB_PATH
    parts = sorted(CHUNKS_DIR.glob("classturn_simulators.db.part*.gz"))
    if not parts:
        raise FileNotFoundError("Neither classturn_simulators.db nor db_chunks/ found!")
    print(f"[DB] Reassembling classturn_simulators.db from {len(parts)} chunks...")
    with open(DB_PATH, "wb") as out_f:
        for part in parts:
            with gzip.open(part, "rb") as in_f:
                shutil.copyfileobj(in_f, out_f)
    print(f"[DB] Reassembled {DB_PATH.name} ({DB_PATH.stat().st_size / (1024*1024):.1f} MB)")
    return DB_PATH


def repack_db_chunks():
    """Splits updated classturn_simulators.db back into GitHub-safe <=35MB .gz chunks."""
    CHUNKS_DIR.mkdir(exist_ok=True)
    for old in CHUNKS_DIR.glob("classturn_simulators.db.part*.gz"):
        old.unlink()
    chunk_raw_size = 42 * 1024 * 1024
    idx = 1
    with open(DB_PATH, "rb") as f:
        while True:
            buf = f.read(chunk_raw_size)
            if not buf:
                break
            out_part = CHUNKS_DIR / f"classturn_simulators.db.part{idx:02d}.gz"
            with gzip.open(out_part, "wb", compresslevel=6) as gz:
                gz.write(buf)
            idx += 1
    print(f"[DB] Repacked {idx - 1} compressed chunks in db_chunks/")


def get_gcloud_access_token():
    try:
        res = subprocess.run(
            ["gcloud", "auth", "print-access-token"],
            capture_output=True, text=True, timeout=10
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


_CACHED_GCP_PROJECT = None


def get_gcloud_project():
    global _CACHED_GCP_PROJECT
    if _CACHED_GCP_PROJECT:
        return _CACHED_GCP_PROJECT
    proj = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("DEVSHELL_PROJECT_ID")
    if proj and proj != "(unset)":
        _CACHED_GCP_PROJECT = proj
        return proj
    try:
        res = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True, text=True, timeout=10
        )
        if res.returncode == 0 and res.stdout.strip() and res.stdout.strip() != "(unset)":
            _CACHED_GCP_PROJECT = res.stdout.strip()
            return _CACHED_GCP_PROJECT
        res2 = subprocess.run(
            ["gcloud", "projects", "list", "--format=value(projectId)", "--limit=1"],
            capture_output=True, text=True, timeout=15
        )
        if res2.returncode == 0 and res2.stdout.strip():
            _CACHED_GCP_PROJECT = res2.stdout.strip().splitlines()[0]
            subprocess.run(["gcloud", "config", "set", "project", _CACHED_GCP_PROJECT], capture_output=True, timeout=10)
            subprocess.run(["gcloud", "services", "enable", "aiplatform.googleapis.com", "--project", _CACHED_GCP_PROJECT], capture_output=True, timeout=30)
            return _CACHED_GCP_PROJECT
    except Exception:
        pass
    return None


def parse_json_safely(text: str) -> dict:
    text = (text or "").strip()
    m = re.search(r"```(?:json)?\s*\n?(.*?)\s*```", text, flags=re.S | re.I)
    cand = m.group(1).strip() if m else text
    try:
        return json.loads(cand)
    except Exception:
        s = cand.find("{")
        e = cand.rfind("}")
        if s != -1 and e != -1 and e > s:
            return json.loads(cand[s : e + 1])
        raise


def call_gemini_brain(prompt_text: str, model_name: str = "gemini-2.5-flash") -> dict:
    """
    Calls Gemini directly in its brain (via GEMINI_API_KEY, Cloud Shell Vertex AI ADC, or agy/gemini CLI).
    """
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt_text}]}],
        "generationConfig": {
            "temperature": 0.15,
            "responseMimeType": "application/json",
        },
    }
    data_bytes = json.dumps(payload).encode("utf-8")

    if api_key:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        req = urllib.request.Request(url, data=data_bytes, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp_json = json.loads(resp.read().decode("utf-8"))
        return parse_json_safely(resp_json["candidates"][0]["content"]["parts"][0]["text"])

    # Try agy CLI if available (uses Google AI Ultra subscription directly)
    agy_bin = shutil.which("agy")
    if not agy_bin and os.path.exists(r"C:\Users\ktrag\AppData\Local\agy\bin\agy.exe"):
        agy_bin = r"C:\Users\ktrag\AppData\Local\agy\bin\agy.exe"
    if agy_bin:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
            tf.write(prompt_text)
            tf_path = tf.name
        try:
            cmd = [
                agy_bin, "--dangerously-skip-permissions", "--mode", "plan",
                "--disable-slash-commands", "--print",
                f"Read {tf_path} and return ONLY the requested valid JSON object. Do not run any Python scripts."
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240)
            if r.returncode == 0 and r.stdout.strip():
                return parse_json_safely(r.stdout)
        finally:
            try:
                os.unlink(tf_path)
            except OSError:
                pass

    # Try Cloud Shell Vertex AI ADC
    token = get_gcloud_access_token()
    project = get_gcloud_project()
    if token and project:
        url = (
            f"https://us-central1-aiplatform.googleapis.com/v1/projects/{project}"
            f"/locations/us-central1/publishers/google/models/{model_name}:generateContent"
        )
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            resp_json = json.loads(resp.read().decode("utf-8"))
        return parse_json_safely(resp_json["candidates"][0]["content"]["parts"][0]["text"])

    raise RuntimeError("No Gemini credentials found. Set GEMINI_API_KEY, sign into agy, or set a GCP project.")


def build_agent_prompt(sim_row: dict, qa_questions: dict) -> str:
    slots = json.loads(sim_row["compiled_slots_json"] or "{}")
    eyebrow = slots.get("eyebrow_html", "VIRTUAL LABORATORY")
    return f"""You are a dedicated Gemini Scientific & Visual QA Agent for the ClassTurn Virtual Laboratory.
Your job is to inspect Simulator `{sim_row['id']}` ("{sim_row['title']}") IN YOUR OWN BRAIN against the attached Master QA Questions.
Do NOT write Python test scripts. Read the simulator's HTML slots and `canvas_js` directly below, evaluate every QA question in your mind, and if ANY problem exists (e.g., raw LaTeX in prose/units, missing 3D shading or low-contrast outlines on dark #090d16 canvas, broken control responsiveness, or inaccurate physics/equations), rectify it directly.

### MASTER QA QUESTIONS TO CHECK IN YOUR BRAIN:
{json.dumps(qa_questions.get('categories', []), indent=2, ensure_ascii=False)}

### SIMULATOR RECORD TO INSPECT (`{sim_row['id']}`):
- Title: {sim_row['title']}
- Subject Eyebrow: {eyebrow}
- Compiled Slots JSON:
{json.dumps(slots, ensure_ascii=False)}

- Canvas 2D Simulation JS (`canvas_js`):
```javascript
{sim_row['canvas_js']}
```

### REQUIRED JSON OUTPUT FORMAT:
Return a single valid JSON object with these keys:
{{
  "sim_id": "{sim_row['id']}",
  "status": "PASS" or "FIXED",
  "issues_found": ["short description of any issue found and fixed"],
  "updated_slots": null or <complete corrected compiled_slots_json object if modified>,
  "updated_canvas_js": null or "<complete corrected canvas_js string if modified>"
}}
"""


def review_one_simulator(sim_row: dict, qa_questions: dict, model_name: str) -> dict:
    prompt = build_agent_prompt(sim_row, qa_questions)
    for attempt in range(3):
        try:
            res = call_gemini_brain(prompt, model_name=model_name)
            res["sim_id"] = sim_row["id"]
            return res
        except Exception as e:
            if attempt == 2:
                return {"sim_id": sim_row["id"], "status": "ERROR", "error": str(e)}
            time.sleep(2 * (attempt + 1))


def save_and_push_progress(done_ids, fixed_count, latest_sim_id, recent_events, runner_state="ACTIVE", push_db=False):
    ensure_git_identity()
    PROGRESS_PATH.write_text(
        json.dumps(
            {
                "runner_state": runner_state,
                "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "completed_count": len(done_ids),
                "fixed_count": fixed_count,
                "latest_sim_id": latest_sim_id,
                "recent_events": recent_events[-40:],
                "completed_ids": sorted(done_ids),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    if push_db:
        repack_db_chunks()
        subprocess.run(["git", "add", "db_chunks", "gemini_brain_qa_progress.json"], cwd=ROOT, check=False)
    else:
        subprocess.run(["git", "add", "gemini_brain_qa_progress.json"], cwd=ROOT, check=False)
    subprocess.run(
        ["git", "commit", "-m", f"Live QA Status: {len(done_ids)}/2123 checked, {fixed_count} fixed (latest: {latest_sim_id})"],
        cwd=ROOT, capture_output=True, check=False
    )
    subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=ROOT, capture_output=True, check=False)
    subprocess.run(["git", "push", "origin", "main"], cwd=ROOT, capture_output=True, check=False)


def main():
    parser = argparse.ArgumentParser(description="Multi-Agent Gemini Brain QA & Database Auto-Updater")
    parser.add_argument("--agents", type=int, default=8, help="Number of parallel Gemini AI agents")
    parser.add_argument("--batch-size", type=int, default=5, help="Push live status every N simulators")
    parser.add_argument("--model", type=str, default="gemini-2.5-flash", help="Gemini model name")
    parser.add_argument("--start-id", type=str, default="u00001", help="Simulator ID to start from")
    parser.add_argument("--limit", type=int, default=2123, help="Max simulators to process")
    args = parser.parse_args()

    ensure_database()
    qa_questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))

    done_ids = set()
    recent_events = []
    fixed_count = 0
    if PROGRESS_PATH.exists():
        try:
            prev = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
            done_ids = set(prev.get("completed_ids", []))
            recent_events = prev.get("recent_events", [])
            fixed_count = prev.get("fixed_count", 0)
        except Exception:
            pass

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        "SELECT id, title, compiled_slots_json, canvas_js "
        "FROM simulators WHERE id >= ? ORDER BY id ASC LIMIT ?",
        (args.start_id, args.limit),
    )
    rows = [dict(r) for r in cur.fetchall() if r["id"] not in done_ids]
    print(f"[QA] Starting {args.agents} parallel Gemini Brain Agents on {len(rows)} simulators...")

    # Send immediate startup heartbeat so live_qa_monitor.html shows RUNNING IN CLOUD SHELL
    save_and_push_progress(done_ids, fixed_count, rows[0]["id"] if rows else "DONE", recent_events, runner_state="ACTIVE (GEMINI BRAIN AGENTS RUNNING)", push_db=False)

    batches_since_db_push = 0
    for i in range(0, len(rows), args.batch_size):
        batch = rows[i : i + args.batch_size]
        latest_sid = batch[0]["id"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.agents) as pool:
            futures = {
                pool.submit(review_one_simulator, row, qa_questions, args.model): row
                for row in batch
            }
            for fut in concurrent.futures.as_completed(futures):
                orig_row = futures[fut]
                sid = orig_row["id"]
                latest_sid = sid
                res = fut.result()
                status = res.get("status", "ERROR")
                now_str = datetime.datetime.now().strftime("%H:%M:%S")
                if status == "FIXED":
                    new_slots = res.get("updated_slots")
                    new_js = res.get("updated_canvas_js")
                    slots_str = json.dumps(new_slots, ensure_ascii=False) if isinstance(new_slots, dict) else orig_row["compiled_slots_json"]
                    js_str = new_js if isinstance(new_js, str) and len(new_js) > 100 else orig_row["canvas_js"]
                    cur.execute(
                        "UPDATE simulators SET compiled_slots_json = ?, canvas_js = ? WHERE id = ?",
                        (slots_str, js_str, sid),
                    )
                    fixed_count += 1
                    issues = res.get("issues_found", ["Updated in Gemini brain"])
                    recent_events.append({"sim_id": sid, "status": "FIXED", "time": now_str, "issues": issues})
                    print(f"  [FIXED] {sid}: {issues}")
                elif status == "PASS":
                    recent_events.append({"sim_id": sid, "status": "PASS", "time": now_str, "issues": []})
                    print(f"  [PASS]  {sid}")
                else:
                    err_msg = str(res.get("error", "Unknown error"))[:160]
                    recent_events.append({"sim_id": sid, "status": "ERROR", "time": now_str, "issues": [err_msg]})
                    print(f"  [ERR]   {sid}: {err_msg}")

                if status in ("PASS", "FIXED"):
                    done_ids.add(sid)

                PROGRESS_PATH.write_text(
                    json.dumps(
                        {
                            "runner_state": "ACTIVE (GEMINI BRAIN AGENTS RUNNING)",
                            "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            "completed_count": len(done_ids),
                            "fixed_count": fixed_count,
                            "latest_sim_id": latest_sid,
                            "recent_events": recent_events[-40:],
                            "completed_ids": sorted(done_ids),
                        },
                        indent=2,
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )

        conn.commit()
        batches_since_db_push += 1
        push_db_now = batches_since_db_push >= 4
        if push_db_now:
            batches_since_db_push = 0
        save_and_push_progress(done_ids, fixed_count, latest_sid, recent_events, runner_state="ACTIVE (GEMINI BRAIN AGENTS RUNNING)", push_db=push_db_now)
        print(f"[LIVE STATUS PUSHED] Checked: {len(done_ids)}/2123 | Fixed in DB: {fixed_count}")

    save_and_push_progress(done_ids, fixed_count, "ALL DONE", recent_events, runner_state="COMPLETED", push_db=True)
    conn.close()
    print("[DONE] All requested simulators checked and updated in database!")


if __name__ == "__main__":
    main()
