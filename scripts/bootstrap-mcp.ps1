# Install MCP package deps and build the server for first-time clone / local plugin install (Windows PowerShell).
# Required before the vehicle-fleet MCP server can start (one package: mcp/vehicle-fleet).
#
# Usage (from plugin root or anywhere):
#   powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-mcp.ps1
#   # or from plugin root in PowerShell:
#   .\scripts\bootstrap-mcp.ps1
#
# Linux / macOS / Git Bash: prefer ./scripts/bootstrap-mcp.sh

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) {
  Write-Error 'bootstrap-mcp: could not resolve plugin root'
  exit 1
}

function Resolve-Npm {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) { return $npm.Source }
  throw 'bootstrap-mcp: npm not found on PATH (install Node.js LTS, then re-open the shell)'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'bootstrap-mcp: node not found on PATH (install Node.js LTS)'
  exit 1
}

$npmExe = Resolve-Npm
Write-Host "bootstrap-mcp: using $npmExe"

$pkg = 'vehicle-fleet'
$dir = Join-Path $Root "mcp\$pkg"
$pkgJson = Join-Path $dir 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) {
  Write-Error "bootstrap-mcp: missing $pkgJson"
  exit 1
}
Write-Host "bootstrap-mcp: npm ci --ignore-scripts in mcp/$pkg"
Push-Location -LiteralPath $dir
try {
  & $npmExe ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  # MCP configs launch dist/index.js by absolute path, so build it here.
  Write-Host "bootstrap-mcp: npm run build in mcp/$pkg"
  & $npmExe run build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  $entry = Join-Path $dir 'dist\index.js'
  if (-not (Test-Path -LiteralPath $entry)) {
    Write-Error "bootstrap-mcp: build did not produce $entry"
    exit 1
  }
} finally {
  Pop-Location
}

Write-Host 'bootstrap-mcp: done'
