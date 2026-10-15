$ErrorActionPreference = 'Stop'

# Local-only preview helper. It does not deploy or upload anything.
$root = Split-Path -Parent $PSScriptRoot
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
  throw 'Python 3 was not found. Install Python or start any static HTTP server for this folder.'
}

Write-Host 'PokéSurvivor local preview:' -ForegroundColor Yellow
Write-Host '  http://localhost:8765/dev.html' -ForegroundColor Green
Write-Host 'Google/Firebase login is available only through this HTTP address, not file://.' -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C to stop. Nothing is deployed.' -ForegroundColor DarkGray

& $python -m http.server 8765 --bind 127.0.0.1 --directory $root
