"""
Standalone Database -> HTML Builder (Zero External Dependencies)
Reconstructs any single simulator or all 2,123 simulators SOLELY from:
  - classturn_simulators.db (or reassembles it automatically from db_chunks/)
  - universal_simulator.html
  - classturn-lab-kit.js
Usage:
  py build_html_from_database.py --id u01427
  py build_html_from_database.py --all
"""
import argparse
import gzip
import json
import re
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "classturn_simulators.db"
CHUNKS_DIR = ROOT / "db_chunks"
UNIVERSAL_HTML_PATH = ROOT / "universal_simulator.html"
LAB_KIT_PATH = ROOT / "classturn-lab-kit.js"
OUT_DIR = ROOT / "dist"


def ensure_database():
    if DB_PATH.exists() and DB_PATH.stat().st_size > 10_000_000:
        return DB_PATH
    parts = sorted(CHUNKS_DIR.glob("classturn_simulators.db.part*.gz"))
    if not parts:
        raise FileNotFoundError("Neither classturn_simulators.db nor db_chunks/ found!")
    print(f"Reassembling classturn_simulators.db from {len(parts)} GitHub-safe chunks...")
    with open(DB_PATH, "wb") as out_f:
        for part in parts:
            with gzip.open(part, "rb") as in_f:
                shutil.copyfileobj(in_f, out_f)
    print(f"Reassembled {DB_PATH.name} ({DB_PATH.stat().st_size / (1024*1024):.1f} MB)")
    return DB_PATH


def render_simulator_html(row: dict, template_html: str, asset_prefix: str = "") -> str:
    slots = json.loads(row["compiled_slots_json"] or "{}")
    res = template_html

    if asset_prefix:
        res = res.replace('src="classturn-lab-kit.js', f'src="{asset_prefix}classturn-lab-kit.js')

    title_plain = slots.get("title_plain") or row["title"]
    res = re.sub(
        r"<title>.*?</title>",
        lambda _: f"<title>{title_plain} · ClassTurn Virtual Laboratory</title>",
        res,
        count=1,
        flags=re.S,
    )
    res = re.sub(
        r'<p class="eyebrow" id="headerEyebrow">.*?</p>',
        lambda _: f'<p class="eyebrow" id="headerEyebrow">{slots.get("eyebrow_html", "VIRTUAL LABORATORY")}</p>',
        res,
        flags=re.S,
    )
    res = re.sub(
        r'<h1 id="headerTitle">.*?</h1>',
        lambda _: f'<h1 id="headerTitle">{slots.get("header_title_html", title_plain)}</h1>',
        res,
        flags=re.S,
    )
    res = re.sub(
        r'<p id="aimText".*?</p>',
        lambda _: f'<p id="aimText" style="line-height:1.5;">{slots.get("aim_html", "")}</p>',
        res,
        flags=re.S,
    )
    res = re.sub(
        r'<ul id="apparatusList">.*?</ul>',
        lambda _: f'<ul id="apparatusList">\n{slots.get("apparatus_html", "")}\n        </ul>',
        res,
        flags=re.S,
    )
    res = re.sub(
        r'<p id="principlesSummary".*?</p>',
        lambda _: f'<p id="principlesSummary" style="line-height:1.5; margin-bottom:10px;">{slots.get("principles_summary_html", "")}</p>',
        res,
        flags=re.S,
    )
    res = re.sub(
        r'<ul id="principlesList".*?</ul>',
        lambda _: f'<ul id="principlesList" class="principles-list" style="margin-top:4px;">\n{slots.get("principles_list_html", "")}\n        </ul>',
        res,
        flags=re.S,
    )
    if slots.get("procedure_section_html"):
        proc_html = slots["procedure_section_html"]
        step_counter = [0]
        def _inject_step_btn(m_li):
            step_counter[0] += 1
            s_num = step_counter[0]
            glow_cls = " ct-next-glow" if s_num == 1 else ""
            if "ct-step-arrow-btn" in m_li.group(0):
                return m_li.group(0)
            return f'{m_li.group(1)}<button type="button" class="ct-step-arrow-btn{glow_cls}" data-step="{s_num}" title="Execute Step {s_num} on Canvas">➔ Step {s_num}</button>'
        proc_html = re.sub(r"(<li[^>]*>)", _inject_step_btn, proc_html)
        res = re.sub(
            r'(<section[^>]*id="sec-04-procedure"[^>]*>\s*<h2>04 / Procedure</h2>)([\s\S]*?)(</section>)',
            lambda m: f"{m.group(1)}\n{proc_html}\n      {m.group(3)}",
            res,
            flags=re.S,
        )
    if slots.get("experiment_options_html"):
        res = re.sub(
            r'<select id="experimentSelect".*?</select>',
            lambda _: f'<select id="experimentSelect" class="atlas-select">\n{slots["experiment_options_html"]}\n          </select>',
            res,
            flags=re.S,
        )
    if slots.get("presets_html"):
        res = re.sub(
            r'<div class="preset-row" id="presetContainer".*?</div>',
            lambda _: f'<div class="preset-row" id="presetContainer" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">{slots["presets_html"]}</div>',
            res,
            flags=re.S,
        )
    else:
        res = re.sub(
            r'<div class="preset-row" id="presetContainer".*?</div>',
            lambda _: '<div class="preset-row" id="presetContainer" style="display:none;"></div>',
            res,
            flags=re.S,
        )
    if slots.get("actions_html"):
        res = re.sub(
            r'<div class="extra-actions-row".*?</div>',
            lambda _: f'<div class="extra-actions-row" id="extraActionsContainer" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">{slots["actions_html"]}</div>',
            res,
            flags=re.S,
        )
    else:
        res = re.sub(
            r'<div class="extra-actions-row".*?</div>',
            lambda _: '<div class="extra-actions-row" id="extraActionsContainer" style="display:none;"></div>',
            res,
            flags=re.S,
        )
    if slots.get("steppers_html"):
        res = re.sub(
            r'<div class="stepper-container" id="steppersContainer">.*?</div>',
            lambda _: f'<div class="stepper-container" id="steppersContainer">\n{slots["steppers_html"]}\n        </div>',
            res,
            flags=re.S,
        )
    if slots.get("readouts_html"):
        res = re.sub(
            r'<ul class="readouts-list" id="readoutsList">.*?</ul>',
            lambda _: f'<ul class="readouts-list" id="readoutsList">\n{slots["readouts_html"]}\n        </ul>',
            res,
            flags=re.S,
        )
    if slots.get("validation_html"):
        res = re.sub(
            r'<ul id="validationList".*?</ul>',
            lambda _: f'<ul id="validationList" style="margin:0; padding-left:20px; display:flex; flex-direction:column; gap:6px;">\n{slots["validation_html"]}\n        </ul>',
            res,
            flags=re.S,
        )
    if slots.get("observation_thead_html"):
        res = re.sub(
            r'<thead id="observationThead">.*?</thead>',
            lambda _: f'<thead id="observationThead">{slots["observation_thead_html"]}</thead>',
            res,
            flags=re.S,
        )
    if slots.get("legend_pills_html"):
        banner_marker = '<div class="apparatus-legend-banner" id="apparatusLegendBanner">'
        heading_marker = '<h2 class="atlas-notebook-heading" id="notebookHeading">'
        if banner_marker in res and heading_marker in res:
            s_pos = res.index(banner_marker) + len(banner_marker)
            e_pos = res.index(heading_marker)
            res = res[:s_pos] + f"\n{slots['legend_pills_html']}\n      </div>\n\n      " + res[e_pos:]

    res = re.sub(
        r'<script id="classturn-stage-script">[\s\S]*?</script>',
        lambda _: f'<script id="classturn-stage-script">\n{row["canvas_js"] or ""}\n  </script>',
        res,
    )
    return res


def main():
    parser = argparse.ArgumentParser(description="Build Simulator HTML pages directly from classturn_simulators.db")
    parser.add_argument("--id", help="Build a single simulator ID (e.g. u01427)")
    parser.add_argument("--all", action="store_true", help="Build all 2,123 simulators into dist/")
    args = parser.parse_args()

    ensure_database()
    template_html = UNIVERSAL_HTML_PATH.read_text(encoding="utf-8")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(LAB_KIT_PATH, OUT_DIR / "classturn-lab-kit.js")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    if args.id:
        row = conn.execute("SELECT id, title, canvas_js, compiled_slots_json FROM simulators WHERE id = ?", (args.id,)).fetchone()
        if not row:
            raise ValueError(f"Simulator {args.id} not found in classturn_simulators.db")
        html_str = render_simulator_html(dict(row), template_html, asset_prefix="")
        out_file = OUT_DIR / f"{args.id}.html"
        out_file.write_text(html_str, encoding="utf-8")
        print(f"Built {out_file} ({len(html_str):,} bytes) solely from database!")
    else:
        rows = [dict(r) for r in conn.execute("SELECT id, title, canvas_js, compiled_slots_json FROM simulators ORDER BY id").fetchall()]
        print(f"Building all {len(rows)} simulators into {OUT_DIR} using 100 parallel agents...")

        def build_one(r):
            sid = r["id"]
            slots = json.loads(r["compiled_slots_json"] or "{}")
            eb = slots.get("eyebrow_html", "VIRTUAL LABORATORY")
            sdir = OUT_DIR / "builds" / sid
            sdir.mkdir(parents=True, exist_ok=True)
            h = render_simulator_html(r, template_html, asset_prefix="../../")
            (sdir / "index.html").write_text(h, encoding="utf-8")
            return sid, r["title"], eb

        with ThreadPoolExecutor(max_workers=100) as ex:
            built_meta = list(ex.map(build_one, rows))

        # Copy live_panel.html as both dist/live_panel.html and dist/index.html + add .nojekyll
        (OUT_DIR / ".nojekyll").write_text("", encoding="utf-8")
        for extra in ["live_panel.html", "universal_simulator.html", "legacy_layout_skeleton.html", "simulator_qa_master_questions.json", "database_summary.json"]:
            src_f = ROOT / extra
            if src_f.exists():
                shutil.copy2(src_f, OUT_DIR / extra)
        if (ROOT / "live_panel.html").exists():
            shutil.copy2(ROOT / "live_panel.html", OUT_DIR / "index.html")
        print(f"Successfully built all {len(built_meta):,} HTML pages + live_panel.html into {OUT_DIR}")

    conn.close()


if __name__ == "__main__":
    main()
