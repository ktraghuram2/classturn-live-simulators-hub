"""
Cloud Shell Multi-Agent Gemini Brain QA & Auto-Rectifier
========================================================
- Picks each simulator from classturn_simulators.db
- Sends the simulator + questions from simulator_qa_master_questions.json
  DIRECTLY to a real Gemini AI model (100% in Gemini's brain, zero Python regex checking)
- Runs multiple Gemini AI agents in parallel (--agents 10)
- If Gemini finds any problem, Gemini returns the corrected simulator code/slots
- Automatically updates classturn_simulators.db, rebuilds db_chunks/, and pushes to GitHub!
"""
import argparse
import concurrent.futures
import gzip
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
DB_PATH = ROOT / "classturn_simulators.db"
CHUNKS_DIR = ROOT / "db_chunks"
QUESTIONS_PATH = ROOT / "simulator_qa_master_questions.json"
PROGRESS_PATH = ROOT / "gemini_brain_qa_progress.json"


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
        # Auto-pick first project in Cloud Shell if unset
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


def call_gemini_brain(prompt_text: str, model_name: str = "gemini-2.5-flash") -> dict:
    """
    Calls Gemini directly (either via GEMINI_API_KEY or Cloud Shell Vertex AI ADC)
    and returns parsed JSON from Gemini's brain.
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
        headers = {"Content-Type": "application/json"}
    else:
        token = get_gcloud_access_token()
        project = get_gcloud_project()
        if not token or not project:
            raise RuntimeError(
                "Set GEMINI_API_KEY='your_key' or set a Google Cloud project in Cloud Shell (gcloud config set project PROJECT_ID)."
            )
        url = (
            f"https://us-central1-aiplatform.googleapis.com/v1/projects/{project}"
            f"/locations/us-central1/publishers/google/models/{model_name}:generateContent"
        )
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        resp_json = json.loads(resp.read().decode("utf-8"))
    text_out = resp_json["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text_out)


def build_agent_prompt(sim_row: dict, qa_questions: dict) -> str:
    slots = json.loads(sim_row["compiled_slots_json"] or "{}")
    return f"""You are a dedicated Gemini Scientific & Visual QA Agent for the ClassTurn Virtual Laboratory.
Your job is to inspect Simulator `{sim_row['id']}` ("{sim_row['title']}") IN YOUR OWN BRAIN against the attached Master QA Questions.
Do NOT write Python test scripts. Read the simulator's HTML slots and `canvas_js` directly below, evaluate every QA question in your mind, and if ANY problem exists (e.g., raw LaTeX in prose/units, missing 3D shading or low-contrast outlines on dark #090d16 canvas, broken control responsiveness, or inaccurate physics/equations), rectify it directly.

### MASTER QA QUESTIONS TO CHECK IN YOUR BRAIN:
{json.dumps(qa_questions.get('categories', []), indent=2, ensure_ascii=False)}

### SIMULATOR RECORD TO INSPECT (`{sim_row['id']}`):
- Title: {sim_row['title']}
- Subject: {sim_row['subject_category']} / {sim_row['sub_topic']}
- Compiled Slots JSON (8 Pedagogical Sections, Equations, Controls, Readouts, Table Headers):
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


def main():
    parser = argparse.ArgumentParser(description="Multi-Agent Gemini Brain QA & Database Auto-Updater")
    parser.add_argument("--agents", type=int, default=8, help="Number of parallel Gemini AI agents")
    parser.add_argument("--batch-size", type=int, default=20, help="Save & commit every N simulators")
    parser.add_argument("--model", type=str, default="gemini-2.5-flash", help="Gemini model name")
    parser.add_argument("--start-id", type=str, default="u00001", help="Simulator ID to start from")
    parser.add_argument("--limit", type=int, default=2123, help="Max simulators to process")
    args = parser.parse_args()

    ensure_database()
    qa_questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))

    done_ids = set()
    if PROGRESS_PATH.exists():
        try:
            done_ids = set(json.loads(PROGRESS_PATH.read_text(encoding="utf-8")).get("completed_ids", []))
        except Exception:
            pass

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        "SELECT id, title, subject_category, sub_topic, compiled_slots_json, canvas_js "
        "FROM simulators WHERE id >= ? ORDER BY id ASC LIMIT ?",
        (args.start_id, args.limit),
    )
    rows = [dict(r) for r in cur.fetchall() if r["id"] not in done_ids]
    print(f"[QA] Starting {args.agents} parallel Gemini Brain Agents on {len(rows)} simulators...")

    processed_since_save = 0
    fixed_count = 0

    for i in range(0, len(rows), args.batch_size):
        batch = rows[i : i + args.batch_size]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.agents) as pool:
            futures = {
                pool.submit(review_one_simulator, row, qa_questions, args.model): row
                for row in batch
            }
            for fut in concurrent.futures.as_completed(futures):
                orig_row = futures[fut]
                sid = orig_row["id"]
                res = fut.result()
                status = res.get("status", "ERROR")
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
                    print(f"  [FIXED] {sid}: {res.get('issues_found', [])}")
                elif status == "PASS":
                    print(f"  [PASS]  {sid}")
                else:
                    print(f"  [ERR]   {sid}: {res.get('error')}")
                    continue

                done_ids.add(sid)
                processed_since_save += 1

        conn.commit()
        PROGRESS_PATH.write_text(
            json.dumps({"completed_count": len(done_ids), "fixed_count": fixed_count, "completed_ids": sorted(done_ids)}, indent=2),
            encoding="utf-8",
        )
        print(f"[BATCH SAVED] Completed: {len(done_ids)} | Fixed in DB: {fixed_count}")

        if processed_since_save >= args.batch_size:
            processed_since_save = 0
            repack_db_chunks()
            subprocess.run(["git", "add", "db_chunks", "gemini_brain_qa_progress.json"], cwd=ROOT, check=False)
            subprocess.run(["git", "commit", "-m", f"Gemini Brain QA: {len(done_ids)} checked, {fixed_count} rectified"], cwd=ROOT, check=False)
            subprocess.run(["git", "push", "origin", "main"], cwd=ROOT, check=False)

    conn.close()
    print("[DONE] All requested simulators checked and updated in database!")


if __name__ == "__main__":
    main()
