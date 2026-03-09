"""Look up plant details and run news fetch for the 5 curtailed plants."""
import json

with open("public/data/plants.json", "r") as f:
    d = json.load(f)

targets = ["63100", "65678", "56621", "56836", "56835"]
for p in d["plants"]:
    code = p.get("eiaPlantCode", "")
    if code in targets:
        print(f"{code} | {p['name']} | {p.get('state','')} | {p.get('fuelSource','')} | {p.get('owner','')}")
