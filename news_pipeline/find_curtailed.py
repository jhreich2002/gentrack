"""Find the top 10 most curtailed plants with generation through Oct 2025."""
import json

with open("public/data/plants.json", "r") as f:
    data = json.load(f)

plants = data["plants"]
stats_map = data.get("stats", {})

# Already have articles for these
existing = {"6008", "3161", "56564"}

results = []
for p in plants:
    pid = p["id"]
    if pid in existing:
        continue
    
    s = stats_map.get(pid)
    if not s:
        continue
    
    score = s.get("curtailmentScore", 0)
    if score <= 0:
        continue
    
    # Check has generation through Oct 2025
    monthly = s.get("monthlyFactors", [])
    has_oct = False
    for m in monthly:
        if m.get("month") == "2025-10" and m.get("factor") is not None and m["factor"] > 0:
            has_oct = True
            break
    
    if not has_oct:
        continue
    
    results.append({
        "id": pid,
        "name": p["name"],
        "state": p.get("state", ""),
        "fuel": p.get("fuelSource", ""),
        "owner": p.get("owner", ""),
        "capacity_mw": p.get("nameplateCapacityMW", 0),
        "curtailment_score": score,
        "ttm_avg": round(s.get("ttmAverage", 0) * 100, 1),
    })

results.sort(key=lambda x: x["curtailment_score"], reverse=True)

print(f"Top 10 most curtailed plants with Oct 2025 generation:\n")
print(f"{'#':>2} {'Score':>5} {'TTM%':>5} {'Cap MW':>7} {'Fuel':>8} {'State':>5}  {'Name':<40} {'Owner'}")
print("-" * 120)
for i, r in enumerate(results[:10]):
    print(f"{i+1:>2} {r['curtailment_score']:>5} {r['ttm_avg']:>5} {r['capacity_mw']:>7.1f} {r['fuel']:>8} {r['state']:>5}  {r['name']:<40} {r['owner']}")
