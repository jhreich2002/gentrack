"""
scripts/select_trial_plants.py — Select the 200 most-curtailed plants with
verified generation data through October 2025.

Output:
  - Printed ranked table (stdout)
  - scripts/trial_200_plant_codes.txt   (comma-separated EIA codes, one line)

Selection criteria (all must be true):
  1. is_likely_curtailed = true
  2. is_maintenance_offline = false
  3. trailing_zero_months = 0
  4. eia_plant_code != '99999'
  5. owner IS NOT NULL
  6. Has at least one non-null monthly_generation row with month >= '2025-10'
     (confirms EIA reported generation for this plant into late 2025)

Sorting:
  Primary:   curtailment_score DESC   (worst% off benchmark first)
  Secondary: nameplate_capacity_mw DESC (largest financial impact first)

Usage:
    python scripts/select_trial_plants.py               # top 200
    python scripts/select_trial_plants.py --limit 50    # smaller test set
    python scripts/select_trial_plants.py --dry-run     # print only, no file write
    python scripts/select_trial_plants.py --min-month 2025-08  # earlier cutoff
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Supabase setup
# ---------------------------------------------------------------------------

def _get_supabase():
    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: supabase-py not installed. Run: pip install supabase", file=sys.stderr)
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(
            "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
            file=sys.stderr,
        )
        sys.exit(1)
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Selection query
# ---------------------------------------------------------------------------

def select_trial_plants(
    sb,
    limit: int = 200,
    min_month: str = "2025-10",
    min_mw: float = 0.0,
) -> list[dict]:
    """
    Return up to `limit` plants ordered by curtailment_score DESC, MW DESC,
    filtered to those with verified generation data >= min_month.
    Pass min_mw > 0 to exclude plants smaller than that nameplate capacity.

    We do a two-step query because the Supabase Python client doesn't support
    subquery joins directly — so we first get plant IDs that have Oct-25+ data,
    then filter the plants list to that set.
    """

    # Step 1: get every plant_id that has a non-null mwh row for month >= min_month
    print(f"[1/3] Fetching plant IDs with generation data >= {min_month}...")
    resp = (
        sb.table("monthly_generation")
        .select("plant_id")
        .gte("month", min_month)
        .not_.is_("mwh", "null")
        .execute()
    )
    eligible_ids: set[str] = {row["plant_id"] for row in (resp.data or [])}
    if not eligible_ids:
        print(f"WARNING: No monthly_generation rows found with month >= {min_month}.")
        print("         Check that the EIA data pull covers this date range.")
        return []
    print(f"         → {len(eligible_ids):,} unique plant IDs have data through {min_month}")

    # Step 2: load curtailed plants meeting all quality criteria
    print("[2/3] Fetching curtailed plant list from plants table...")
    resp2 = (
        sb.table("plants")
        .select(
            "id, eia_plant_code, name, owner, state, fuel_source, "
            "curtailment_score, nameplate_capacity_mw, ttm_avg_factor"
        )
        .eq("is_likely_curtailed", True)
        .eq("is_maintenance_offline", False)
        .eq("trailing_zero_months", 0)
        .neq("eia_plant_code", "99999")
        .not_.is_("owner", "null")
        .order("curtailment_score", desc=True)
        .order("nameplate_capacity_mw", desc=True)
        .limit(10_000)   # get all, filter in Python
        .execute()
    )
    all_curtailed = resp2.data or []
    print(f"         → {len(all_curtailed):,} curtailed plants meet base criteria")

    # Step 3: intersect with eligible IDs, apply MW floor
    print(f"[3/3] Intersecting with {min_month}+ data requirement...")
    filtered = [p for p in all_curtailed if p["id"] in eligible_ids]
    print(f"         → {len(filtered):,} plants have both conditions")

    if min_mw > 0:
        filtered = [p for p in filtered if (p.get("nameplate_capacity_mw") or 0) >= min_mw]
        print(f"         → {len(filtered):,} plants after ≥{min_mw:.0f} MW filter")

    return filtered[:limit]


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

FUEL_ABBR = {"Solar": "SOL", "Wind": "WND", "Nuclear": "NUC"}


def print_table(plants: list[dict]) -> None:
    """Print a formatted ranked table to stdout."""
    col_widths = {
        "rank":   4,
        "code":   8,
        "name":   38,
        "state":  5,
        "fuel":   5,
        "score":  7,
        "mw":     8,
        "ttm":    7,
    }

    hdr = (
        f"{'#':>{col_widths['rank']}}  "
        f"{'Code':<{col_widths['code']}}  "
        f"{'Plant Name':<{col_widths['name']}}  "
        f"{'St':<{col_widths['state']}}  "
        f"{'Fuel':<{col_widths['fuel']}}  "
        f"{'Curt%':>{col_widths['score']}}  "
        f"{'MW':>{col_widths['mw']}}  "
        f"{'TTM CF':>{col_widths['ttm']}}"
    )
    sep = "-" * len(hdr)
    print()
    print(f"  TOP {len(plants)} MOST-CURTAILED PLANTS — Generation data through 2025-10")
    print(sep)
    print(hdr)
    print(sep)

    for i, p in enumerate(plants, 1):
        score   = p.get("curtailment_score") or 0
        mw      = p.get("nameplate_capacity_mw") or 0
        ttm     = p.get("ttm_avg_factor") or 0
        fuel    = FUEL_ABBR.get(p.get("fuel_source", ""), "???")
        name    = (p.get("name") or "")[:col_widths["name"]]

        print(
            f"  {i:>{col_widths['rank']}}  "
            f"{p['eia_plant_code']:<{col_widths['code']}}  "
            f"{name:<{col_widths['name']}}  "
            f"{p.get('state','??'):<{col_widths['state']}}  "
            f"{fuel:<{col_widths['fuel']}}  "
            f"{score:>{col_widths['score']}.1f}  "
            f"{mw:>{col_widths['mw']}.0f}  "
            f"{ttm:>{col_widths['ttm']}.3f}"
        )

    print(sep)
    print(
        f"  {len(plants)} plants  |  "
        f"avg curtailment: {sum(p.get('curtailment_score') or 0 for p in plants)/len(plants):.1f}%  |  "
        f"total MW: {sum(p.get('nameplate_capacity_mw') or 0 for p in plants):,.0f}"
    )
    print()


def write_codes_file(plants: list[dict], out_path: Path) -> None:
    codes = ",".join(p["eia_plant_code"] for p in plants)
    out_path.write_text(codes, encoding="utf-8")
    print(f"  Written: {out_path}")
    print(f"  ({len(plants)} codes, {len(codes)} chars)")
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Select the top N most-curtailed plants with Oct-25+ generation data"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=200,
        help="Number of plants to select (default: 200)",
    )
    parser.add_argument(
        "--min-month",
        type=str,
        default="2025-10",
        metavar="YYYY-MM",
        help="Minimum month for generation data requirement (default: 2025-10)",
    )
    parser.add_argument(
        "--min-mw",
        type=float,
        default=0.0,
        metavar="MW",
        help="Exclude plants smaller than this nameplate capacity (default: 0 = no filter)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print table but do not write codes file",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="Override output file path (default: scripts/trial_200_plant_codes.txt)",
    )
    args = parser.parse_args()

    sb = _get_supabase()

    plants = select_trial_plants(sb, limit=args.limit, min_month=args.min_month, min_mw=args.min_mw)

    if not plants:
        print("No plants selected — exiting.")
        sys.exit(1)

    print_table(plants)

    out_path = Path(args.out) if args.out else Path(__file__).parent / "trial_200_plant_codes.txt"

    if args.dry_run:
        print("  --dry-run: skipping file write.")
    else:
        write_codes_file(plants, out_path)
        print(f"  Pass to pipelines via:")
        print(f"    --plants $(Get-Content '{out_path}')")
        print()


if __name__ == "__main__":
    main()
