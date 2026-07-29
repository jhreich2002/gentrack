# Evaluation Memo: Curtailment Prediction as a Platform Feature

**To:** [Manager]
**From:** [Your name]
**Date:** June 18, 2026
**Re:** Feasibility of adding curtailment prediction to the Gentrack platform

## Recommendation
Build a **Curtailment Risk Score** (6–12 month outlook), not a curtailment *prediction*. The platform's data supports the former and cannot honestly support the latter without material new data investments. Marketing the feature as "prediction" in the operational/forecasting sense would not survive a technical conversation with a sophisticated lender or tax-equity counterparty.

## What the platform has today
- **EIA-923 monthly generation** (one MWh figure per plant per month, ~2-month lag).
- **EIA-860** nameplate, owners, COD, location, fuel.
- **News-derived signals**: outage / curtailment / financial event tags, per-plant risk score.
- A heuristic flag, `is_likely_curtailed`, defined as: active trailing-12-month CF below 80% of sub-regional peer average. This is a **low-CF flag**, not a verified curtailment label — it conflates economic curtailment with bad resource years, derates, partial outages, and mis-tagged sub-regions.

## What the platform does NOT have
Nodal LMPs, congestion / transmission outages, hourly dispatch (EIA-930 not ingested), interconnection queue position, POI / substation, weather and resource forecasts, ISO curtailment disclosures (CAISO OASIS, ERCOT 60-day, SPP / MISO market reports). These are the actual drivers of curtailment.

## Three possible product framings

| Framing | Question answered | Data needed | Feasible here? |
|---|---|---|---|
| Operational forecast | Curtailed next hour / day? | Nodal LMP, weather, dispatch | No — wrong platform |
| **Curtailment Risk Score (6–12 mo)** | Is this asset's CF likely to stay depressed or worsen? | Existing data + light external | **Yes — recommended** |
| Greenfield siting risk | Will a new project here face curtailment? | Queue, congestion, transmission plans | Partial — needs new ingest |

## Phased plan

**Phase 0 — Validate the existing label (prerequisite).** Manually cross-check 30–50 flagged plants against ISO curtailment disclosures and stored news summaries. Compute precision / recall. If precision is <70%, fix the label before building anything downstream.

**Phase 1 — Risk Score v1 (existing data only).** Monthly-cadence gradient-boosted classifier emitting a 0–100 risk score per plant. Features: CF gap to sub-regional peer, CF trend slope, persistence (months below threshold), cohort drift, COD age, owner effect, news-derived outage / curtailment tags. Train on 2024–2025, hold out 2026. Report AUC by ISO and fuel separately — they will differ.

**Phase 2 — Targeted external data to lift accuracy.**
1. EIA-930 hourly (free) — ISO-level curtailment context.
2. CAISO / ERCOT / SPP / MISO public disclosures — cleaner training labels.
3. NREL WIND / NSRDB modeled resource — separates curtailment from bad-resource years.
4. LBNL interconnection queue — POI saturation features.

**Phase 3 — True nodal forecasting.** Only if there is a clear differentiated angle (e.g., FTI's restructuring / lender lens: "will this asset cure curtailment in time to service debt"). Otherwise we are competing with Aurora, PCI, and ISO-internal tools and will lose.

## Risks and pushback points
- **Naming.** "Prediction" implies operational forecasting. Insist on "Curtailment Risk Score" externally.
- **Label noise.** Without Phase 0, model performance metrics will be cosmetic.
- **Data ceiling.** Existing data alone caps model lift at ~10–15 AUC points above the current heuristic. Real gains require Phase 2 spend.
- **Audience fit.** Lenders want loan-tenor horizons; developers want operational; tax-equity wants residual-yield. Pick one user before building.

## Decisions needed from leadership
1. Primary user: lender risk, developer asset management, or tax-equity underwriting?
2. Approval to brand the output as a *risk score* rather than a *prediction*.
3. Budget for Phase 2 external datasets (or commitment to ship Phase 1 only).
4. Sign-off on Phase 0 label-validation work as a hard gate.

## Bottom line
Feasible as a defensible **risk score** product, on-strategy with the platform's lender and tax-equity focus. Not feasible — and not advisable to attempt — as an operational curtailment forecast on the current data foundation.
