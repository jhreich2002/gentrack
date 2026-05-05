# =============================================================================
# run_cohort_500.ps1
#
# Phase 2 batch runner: UCC lender research for the 500 most-curtailed plants
# with nameplate capacity >= 50 MW and verified generation data through Oct 2025.
#
# Sequence:
#   Step 1 — Select & preview the 500-plant cohort (select_trial_plants.py)
#   Step 2 — Confirm before launching
#   Step 3 — Run UCC calibration loop (run-ucc-calibration.ts)
#   Step 4 — Post-run summary
#
# Usage:
#   cd C:\Users\jhrei\OneDrive\AIProjects\Gentrack
#   .\scripts\run_cohort_500.ps1
#
#   Skip confirmation prompt:
#   .\scripts\run_cohort_500.ps1 -SkipConfirm
#
#   Override defaults:
#   .\scripts\run_cohort_500.ps1 -Limit 200 -MinMW 100 -MaxSpend 10.00
#
#   Resume a previous session that was interrupted:
#   .\scripts\run_cohort_500.ps1 -Resume logs\ucc-session-2026-...
#
# Cost estimate: ~$0.03/plant * 500 plants = ~$15.00
# =============================================================================

param(
    [switch] $SkipConfirm,
    [int]    $Limit     = 500,
    [float]  $MinMW     = 50.0,
    [float]  $MaxSpend  = 20.00,
    [int]    $PerBatch  = 3,
    [string] $MinMonth  = "2025-10",
    [string] $Resume    = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────

$Root      = $PSScriptRoot | Split-Path -Parent
$Py        = Join-Path $Root ".venv\Scripts\python.exe"
$CodesPath = Join-Path $PSScriptRoot "cohort_500_plant_codes.txt"

# ── Helpers ───────────────────────────────────────────────────────────────────

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
        Write-Host "       Run: python -m venv .venv ; .venv\Scripts\pip install supabase python-dotenv"
        exit 1
    }
}

# ── Resume mode ───────────────────────────────────────────────────────────────

if ($Resume) {
    Write-Step "3" "Resuming UCC calibration session"
    Write-Host "  Resuming: $Resume" -ForegroundColor DarkCyan
    & npx tsx scripts/run-ucc-calibration.ts `
        --cohort-size $Limit `
        --max-spend   $MaxSpend `
        --per-batch   $PerBatch `
        --min-mw      $MinMW `
        --resume      $Resume
    if ($LASTEXITCODE -ne 0) { Write-Host "Calibration exited with code $LASTEXITCODE" -ForegroundColor Red; exit $LASTEXITCODE }
    exit 0
}

# ── Step 1: Select cohort ───────────────────────────────────────────────────── ─────────────────────────────────────────────────────

Write-Step "1" "Selecting top $Limit curtailed plants >= $MinMW MW"

Assert-Python

& $Py scripts/select_trial_plants.py `
    --limit     $Limit `
    --min-mw    $MinMW `
    --min-month $MinMonth `
    --out       $CodesPath

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: plant selection failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $CodesPath)) {
    Write-Host "ERROR: cohort file not written — check select_trial_plants.py output above." -ForegroundColor Red
    exit 1
}

$CodesContent = Get-Content $CodesPath -Raw
$PlantCount   = ($CodesContent -split ',').Count
Write-Host ""
Write-Host "  Cohort file: $CodesPath" -ForegroundColor Green
Write-Host "  Plants selected: $PlantCount" -ForegroundColor Green
Write-Host "  Estimated cost:  ~`$$([math]::Round($PlantCount * 0.03, 2)) at `$0.03/plant" -ForegroundColor Green

# ── Step 2: Confirm ───────────────────────────────────────────────────────────

Write-Step "2" "Confirm run parameters"
Write-Host "  Plants:    $PlantCount (>= $MinMW MW, most curtailed first)"
Write-Host "  Ceiling:   `$$MaxSpend"
Write-Host "  Per batch: $PerBatch plants per supervisor call"

if (-not $SkipConfirm) {
    Confirm-Continue "Ready to launch Phase 2 run? ($PlantCount plants, ceiling `$$MaxSpend)"
}

# ── Step 3: Run calibration loop ──────────────────────────────────────────────

Write-Step "3" "Running UCC calibration loop"

& npx tsx scripts/run-ucc-calibration.ts `
    --cohort-size $Limit `
    --max-spend   $MaxSpend `
    --per-batch   $PerBatch `
    --min-mw      $MinMW

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Calibration exited with code $LASTEXITCODE." -ForegroundColor Yellow
    Write-Host "To resume, find the session ID in the output above and run:" -ForegroundColor Yellow
    Write-Host "  .\scripts\run_cohort_500.ps1 -Resume logs\<session-id>" -ForegroundColor DarkYellow
    exit $LASTEXITCODE
}

# ── Step 4: Summary ───────────────────────────────────────────────────────────

Write-Step "4" "Post-run cohort summary"

& npx tsx scripts/cohort_summary.ts $($CodesContent -split ',' | ForEach-Object { $_.Trim() })

Write-Host ""
Write-Host "Phase 2 complete." -ForegroundColor Green
