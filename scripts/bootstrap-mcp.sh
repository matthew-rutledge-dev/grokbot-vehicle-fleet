#!/usr/bin/env bash
# Install MCP package deps and build the server for first-time clone / local plugin install.
# Required before the vehicle-fleet MCP server can start (one package: mcp/vehicle-fleet).
#
# Linux / macOS / Git Bash (Windows):
#   ./scripts/bootstrap-mcp.sh
#   # or: bash scripts/bootstrap-mcp.sh
# Native PowerShell (Windows): prefer scripts/bootstrap-mcp.ps1
#
# CRLF: if checkout used CRLF and the shebang fails, run via bash (above) or:
#   sed -i 's/\r$//' scripts/bootstrap-mcp.sh && ./scripts/bootstrap-mcp.sh
# .gitattributes forces LF for *.sh on clone.

# Avoid `set -euo pipefail` as one word — older Git Bash + CRLF broke on pipefail.
set -eu
(set -o pipefail) 2>/dev/null || true

_SCRIPT="${BASH_SOURCE[0]:-$0}"
# Strip CR if this file was sourced/run with CRLF lingering in path expansions
_SCRIPT="${_SCRIPT%$'\r'}"
ROOT="$(cd "$(dirname "$_SCRIPT")/.." && pwd)"

# Git Bash / MSYS: prefer the bash npm shim. On cmd.exe use bootstrap-mcp.ps1 (npm.cmd).
NPM=npm
if ! command -v npm >/dev/null 2>&1; then
  if command -v npm.cmd >/dev/null 2>&1; then
    NPM=npm.cmd
  else
    echo "bootstrap-mcp: npm not found on PATH (install Node.js LTS, then re-open the shell)" >&2
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "bootstrap-mcp: node not found on PATH (install Node.js LTS)" >&2
  exit 1
fi

pkg=vehicle-fleet
dir="$ROOT/mcp/$pkg"
if [[ ! -f "$dir/package.json" ]]; then
  echo "bootstrap-mcp: missing $dir/package.json" >&2
  exit 1
fi
echo "bootstrap-mcp: npm ci --ignore-scripts in mcp/$pkg"
(cd "$dir" && "$NPM" ci --ignore-scripts)
# MCP configs launch dist/index.js by absolute path, so build it here.
echo "bootstrap-mcp: npm run build in mcp/$pkg"
(cd "$dir" && "$NPM" run build)
if [[ ! -f "$dir/dist/index.js" ]]; then
  echo "bootstrap-mcp: build did not produce $dir/dist/index.js" >&2
  exit 1
fi
echo "bootstrap-mcp: done"
