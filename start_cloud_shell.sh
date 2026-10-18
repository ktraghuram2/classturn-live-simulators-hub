#!/usr/bin/env bash
set -e

echo "============================================================"
echo " ClassTurn Multi-Agent Gemini Brain QA Runner (Cloud Shell)"
echo "============================================================"

REPO_DIR="$HOME/classturn-live-simulators-hub"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[1/3] Cloning classturn-live-simulators-hub..."
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone ktraghuram2/classturn-live-simulators-hub "$REPO_DIR"
  else
    git clone https://github.com/ktraghuram2/classturn-live-simulators-hub.git "$REPO_DIR"
  fi
else
  echo "[1/3] Updating existing repo in $REPO_DIR..."
  git -C "$REPO_DIR" pull --rebase origin main || true
fi

cd "$REPO_DIR"

echo "[2/3] Launching background tmux session 'gemini-qa' (8 parallel Gemini agents)..."
tmux kill-session -t gemini-qa 2>/dev/null || true
tmux new-session -d -s gemini-qa "python3 cloud_shell_gemini_qa_agent.py --agents 8 --batch-size 20 2>&1 | tee -a gemini_qa.log"

echo "[3/3] Started in background!"
echo "  - To watch live progress anytime:  tmux attach -t gemini-qa"
echo "  - Or view log file:                tail -f $REPO_DIR/gemini_qa.log"
