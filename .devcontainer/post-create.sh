#!/usr/bin/env bash
# Runs once after the dev container is created.
set -euo pipefail

cd "$(dirname "$0")/.."

# Python virtualenv with the server's dependencies (src/server)
if [ ! -d .venv ]; then
    python -m venv .venv
fi

source .venv/bin/activate
pip install --upgrade pip
pip install -r src/server/requirements.txt

# Client dependencies (src/client); Node 26 comes from the devcontainer
# "node" feature. Uses the committed lockfile, so npm 10 is fine here.
(cd src/client && npm ci)

# OpenCode CLI (AI coding agent; Claude Code comes via the VS Code extension).
# Both read AGENTS.md, .claude/skills and the shared .claude/agents.
npm install -g @opencode/cli

# GitVersion (.NET global tool)
bash .devcontainer/install-gitversion.sh

# Avoid "dubious ownership" errors that break GitVersion on bind-mounted repos
git config --global --add safe.directory "$(pwd)"
