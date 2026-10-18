# ClassTurn Virtual Laboratory — 2,123 Live Simulators Hub & Database Package

## 🌐 Live Hosted Website Links (Open on Any Mobile or Laptop)

- 🚀 **[Open Live Simulators Hub (`live_panel.html` — All 2,123 Simulators)](https://ktraghuram2.github.io/classturn-live-simulators-hub/live_panel.html)**  
  Direct URL: `https://ktraghuram2.github.io/classturn-live-simulators-hub/live_panel.html`
- 🏠 **[Open Main Website Root (`index.html`)](https://ktraghuram2.github.io/classturn-live-simulators-hub/)**  
  Direct URL: `https://ktraghuram2.github.io/classturn-live-simulators-hub/`
- 🧪 **[Sample Direct Simulator — Concrete Compaction Factor Test (`u01427`)](https://ktraghuram2.github.io/classturn-live-simulators-hub/builds/u01427/index.html)**  
  Direct URL: `https://ktraghuram2.github.io/classturn-live-simulators-hub/builds/u01427/index.html`

---

## 📦 Included Files in This Repository
1. `live_panel.html` & `index.html` — Searchable Live Simulators Hub listing all **2,123** virtual laboratory simulators across Physics, Chemistry, Biology, and Engineering.
2. `db_chunks/` — Compressed `<35 MB` shards of `classturn_simulators.db` containing all **2,123** complete simulator records (all 8 sections, horizontal MathML equations, controls, live readings, observation columns, and 60 FPS `canvas_js`).
3. `legacy_layout_skeleton.html` — Locked 8-section ClassTurn Legacy Layout skeleton.
4. `universal_simulator.html` — Universal Locked HTML template populated directly from `classturn_simulators.db`.
5. `classturn-lab-kit.js` — Universal control, button, bounding-box auto-fit (`1:1`), and Style 2 curvy leader-line runtime engine.
6. `build_html_from_database.py` — Standalone 100-agent builder that reassembles `classturn_simulators.db` from `db_chunks/` and generates any single simulator (`--id u01427`) or all 2,123 HTML files (`--all`) into `dist/` solely from the database.
7. `serve_from_database.py` — Live local server that renders `live_panel.html` and every simulator directly from `classturn_simulators.db` on the fly (`http://localhost:8090/live_panel.html`).
8. `simulator_qa_master_questions.json` — Consolidated 35-Question Master Production QA Checklist.
9. `.github/workflows/build-and-deploy.yml` — Automated GitHub Actions workflow that builds all 2,123 HTML pages from the database and deploys them to GitHub Pages.
