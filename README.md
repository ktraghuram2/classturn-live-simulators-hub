# ClassTurn Virtual Laboratory — Standalone Database + Locked Legacy Layout Package

This self-contained folder includes **copies** of the Locked Legacy Layout, the Universal Simulator HTML template, the Universal Lab Kit runtime, and the complete 2,123-Simulator SQLite Database so every simulator HTML loads or builds **100% from the database and nothing else**.

## Included Files
1. `classturn_simulators.db` — Full SQLite database containing all **2,123** simulators (all 8 sections, horizontal MathML equations, controls, live readings, observation columns, and 60 FPS `canvas_js`).
2. `db_chunks/` — Compressed `<35 MB` shards of `classturn_simulators.db` so you can push to GitHub without hitting GitHub's 100 MB single-file limit (if you delete or `.gitignore` the raw `243 MB` `.db` file before pushing, `build_html_from_database.py` and `serve_from_database.py` automatically reassemble `classturn_simulators.db` from `db_chunks/`).
3. `legacy_layout_skeleton.html` — Exact copy of the locked 8-section ClassTurn Legacy Layout skeleton.
4. `universal_simulator.html` — Universal Locked HTML template populated directly from `classturn_simulators.db`.
5. `classturn-lab-kit.js` — Universal control, button, bounding-box auto-fit (`1:1`), and Style 2 curvy leader-line engine.
6. `serve_from_database.py` — Live server that renders `universal_simulator.html?id=<simulator_id>` directly from `classturn_simulators.db`.
7. `build_html_from_database.py` — 100-agent builder that generates any single simulator (`--id u01427`) or all 2,123 HTML files (`--all`) into `dist/` solely from `classturn_simulators.db` + `universal_simulator.html`.
8. `simulator_qa_master_questions.json` — Consolidated 35-Question Master Production QA Checklist.
9. `.github/workflows/build-and-deploy.yml` — GitHub Actions workflow that automatically builds all 2,123 HTML pages from the database and deploys them to GitHub Pages.

## Quick Start
### Option 1: Load Simulators Directly from Database (Live Server)
```bash
python serve_from_database.py
```
Then open:
- Catalog of all 2,123 sims: `http://localhost:8090/`
- Direct simulator from DB: `http://localhost:8090/universal_simulator.html?id=u01427`

### Option 2: Build Static HTML Pages from Database (For GitHub Pages / Static Hosting)
```bash
# Build a single simulator HTML from the database:
python build_html_from_database.py --id u01427

# Build all 2,123 simulator HTML files + searchable index.html into dist/:
python build_html_from_database.py --all
```
