# =============================================================================
# run_trial_200.ps1
#
# One-time batch runner: news + financing digest for the 200 most-curtailed
# plants with verified generation data through October 2025.
#
# Sequence:
#   Step 1 — Select the 200 plants (select_trial_plants.py)
#   Step 2 — News + financing dry-run (confirm output before writing)
#   Step 3 — News + financing LIVE run (after confirmation)
#   Step 4 — Post-run summary (row counts from Supabase)
#
# Usage:
#   cd C:\Users\jhrei\Downloads\us-power-generation-capacity-factor-tracker
#   .\scripts\run_trial_200.ps1
#
#   Skip dry-run prompt:
#   .\scripts\run_trial_200.ps1 -SkipDryRunConfirm
#
#   Use a pre-existing codes file (skip selection step):
#   .\scripts\run_trial_200.ps1 -CodesFile .\scripts\trial_200_plant_codes.txt
#
# =============================================================================

param(
    [switch] $SkipDryRunConfirm,
    [string] $CodesFile       = "",
    [int]    $Limit           = 200,
    [string] $MinMonth        = "2025-10"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ────────────────────────────────────────────────────────────────────

$Root       = $PSScriptRoot | Split-Path -Parent
$Py         = Join-Path $Root ".venv\Scripts\python.exe"
$CodesPath  = if ($CodesFile) { $CodesFile } else { Join-Path $PSScriptRoot "trial_200_plant_codes.txt" }

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string] $n, [string] $msg) {
    Write-Host ""
    Write-Host "━━━ Step $n ─ $msg ━━━" -ForegroundColor Cyan
}

function Confirm-Continue([string] $prompt) {
    Write-Host ""
    Write-Host $prompt -ForegroundColor Yellow
    Write-Host "Press Enter to continue, or Ctrl+C to abort..." -ForegroundColor DarkYellow
    $null = Read-Host
}

function Assert-Python {
    if (-not (Test-Path $Py)) {
        Write-Host "ERROR: Python venv not found at $Py" -ForegroundColor Red
        Write-Host "       Run: python -m venv .venv && .venv\Scripts\pip install -r news_pipeline\requirements.txt"
        exit 1
    }
}

function Assert-EnvVars {
    $required = @("TAVILY_API_KEY", "GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    $missing  = $required | Where-Object { -not [System.Environment]::GetEnvironmentVariable($_) }
    if ($missing) {
        Write-Host "ERROR: Missing environment variables: $($missing -join ', ')" -ForegroundColor Red
        Write-Host "       Ensure these are set in your .env file and that it has been loaded."
        exit 1
    }
}

function Load-DotEnv {
    $envFile = Join-Path $Root ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+)$') {
                [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim('"').Trim("'"))
            }
        }
        Write-Host "  Loaded .env from $envFile" -ForegroundColor DarkGray
    }
}

function Get-RowCount([string] $table, [string[]] $plantIds) {
    # Query Supabase for approximate row count for the trial plant set
    $ids_json = ($plantIds | ForEach-Object { "'$_'" }) -join ","
    $script = @"
import os, json
from supabase import create_client
sb = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

# Build plant_id list in EIA-{code} format
codes_raw = '$($plantIds -join ",")'
codes = [c.strip() for c in codes_raw.split(',')]
ids = ['EIA-' + c for c in codes if c]

r = sb.table('news_articles').select('id', count='exact').in_('plant_id', ids).execute()

print(r.count if hasattr(r, 'count') and r.count is not None else len(r.data or []))
"@
    $count = & $Py -c $script 2>$null
    return ($count -as [int]) ?? 0
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║  GenTrack — 200-Plant Trial: News + Financing Digest             ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta

Load-DotEnv
Assert-Python
Assert-EnvVars

Push-Location $Root

# ── Step 1: Select plants ─────────────────────────────────────────────────────

Write-Step "1" "Select top $Limit most-curtailed plants (data >= $MinMonth)"

if ($CodesFile -and (Test-Path $CodesFile)) {
    Write-Host "  Using pre-existing codes file: $CodesFile" -ForegroundColor DarkGray
    $Codes = (Get-Content $CodesFile -Raw).Trim()
} else {
    & $Py scripts/select_trial_plants.py --limit $Limit --min-month $MinMonth
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: select_trial_plants.py failed (exit $LASTEXITCODE)" -ForegroundColor Red
        Pop-Location; exit 1
    }
    if (-not (Test-Path $CodesPath)) {
        Write-Host "ERROR: Expected codes file not found: $CodesPath" -ForegroundColor Red
        Pop-Location; exit 1
    }
    $Codes = (Get-Content $CodesPath -Raw).Trim()
}

$CodeCount = ($Codes -split ",").Count
Write-Host ""
Write-Host "  ✓ $CodeCount plant codes loaded" -ForegroundColor Green

# ── Step 2: News + Financing dry-run ─────────────────────────────────────────

Write-Step "2" "News + Financing ingest — DRY RUN (no writes)"

Write-Host "  Running news_pipeline/ingest.py --financing --dry-run ..." -ForegroundColor DarkGray
& $Py -m news_pipeline.ingest --plants $Codes --financing --dry-run
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Dry-run failed (exit $LASTEXITCODE)" -ForegroundColor Red
    Pop-Location; exit 1
}

Write-Host ""
Write-Host "  ✓ Dry-run complete — review output above." -ForegroundColor Green

if (-not $SkipDryRunConfirm) {
    Confirm-Continue "Ready to run LIVE news + financing ingest for $CodeCount plants?"
}

# ── Step 3: News + Financing LIVE ────────────────────────────────────────────

Write-Step "3" "News + Financing ingest — LIVE"

# Snapshot pre-run article count
$ArticlesBefore = Get-RowCount "news_articles" ($Codes -split ",")
Write-Host "  Articles before: $ArticlesBefore" -ForegroundColor DarkGray

Write-Host "  Running news_pipeline/ingest.py --financing ..." -ForegroundColor DarkGray
& $Py -m news_pipeline.ingest --plants $Codes --financing
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: news ingest exited with code $LASTEXITCODE — check logs above." -ForegroundColor Yellow
} else {
    Write-Host "  ✓ News + financing ingest complete." -ForegroundColor Green
}

# ── Step 4: Summary ───────────────────────────────────────────────────────────

Write-Step "4" "Post-run summary"

$ArticlesAfter = Get-RowCount "news_articles" ($Codes -split ",")

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │  Trial 200-plant digest — run complete       │" -ForegroundColor Cyan
Write-Host "  ├─────────────────────────────────────────────┤" -ForegroundColor Cyan
Write-Host ("  │  Plants targeted:      {0,-21}│" -f $CodeCount) -ForegroundColor Cyan
Write-Host ("  │  News articles added:  {0,-21}│" -f ($ArticlesAfter - $ArticlesBefore)) -ForegroundColor Cyan
Write-Host ("  │  News articles total:  {0,-21}│" -f $ArticlesAfter) -ForegroundColor Cyan
Write-Host "  └─────────────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Plant codes file: $CodesPath" -ForegroundColor DarkGray
Write-Host "  Spot-check in the app: open any of the 200 plants → Lenders tab" -ForegroundColor DarkGray
Write-Host ""

Pop-Location
