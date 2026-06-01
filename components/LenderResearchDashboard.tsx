import React, { useEffect, useMemo, useState } from 'react';
import LenderEvidenceTable from './lender-validation/LenderEvidenceTable';
import {
  type AdminPlantRow,
  type PlantLenderEvidenceRow,
  fetchAdminPlantState,
  fetchPlantLenderRows,
  triggerPlantResearch,
} from '../services/lenderResearchService';

interface Props {
  userRole: 'admin' | 'analyst' | 'viewer';
}

function statusBadge(row: AdminPlantRow): { label: string; className: string } {
  if (!row.lastResearchAt) {
    return {
      label: 'Never researched',
      className: 'bg-slate-800 text-slate-400 border-slate-700',
    };
  }

  if (row.lastStatus === 'error') {
    return {
      label: 'Error',
      className: 'bg-red-900/20 text-red-400 border-red-600/30',
    };
  }

  if (row.lastStatus === 'no_lender_identifiable' || (row.lastStatus === 'complete' && row.lenderCount === 0)) {
    return {
      label: 'Researched - no lenders',
      className: 'bg-amber-900/20 text-amber-400 border-amber-600/30',
    };
  }

  return {
    label: `Researched (${row.lenderCount})`,
    className: 'bg-emerald-900/20 text-emerald-400 border-emerald-600/30',
  };
}

const LenderResearchDashboard: React.FC<Props> = ({ userRole }) => {
  const [plants, setPlants] = useState<AdminPlantRow[]>([]);
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [rows, setRows] = useState<PlantLenderEvidenceRow[]>([]);

  const [loadingPlants, setLoadingPlants] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [curtailedOnly, setCurtailedOnly] = useState(true);
  const [withLendersOnly, setWithLendersOnly] = useState(false);

  const selectedPlant = useMemo(
    () => plants.find((p) => p.plantId === selectedPlantId) ?? null,
    [plants, selectedPlantId]
  );

  const loadPlants = async () => {
    setLoadingPlants(true);
    const data = await fetchAdminPlantState({
      curtailedOnly,
      lastRunBucket: 'any',
      search,
    });

    const filtered = withLendersOnly ? data.filter((p) => p.lenderCount > 0) : data;
    setPlants(filtered);

    if (!selectedPlantId || !filtered.some((p) => p.plantId === selectedPlantId)) {
      setSelectedPlantId(filtered[0]?.plantId ?? null);
    }

    setLoadingPlants(false);
  };

  const loadRows = async (plantId: string | null) => {
    if (!plantId) {
      setRows([]);
      return;
    }
    setLoadingRows(true);
    const data = await fetchPlantLenderRows(plantId);
    setRows(data);
    setLoadingRows(false);
  };

  useEffect(() => {
    loadPlants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, curtailedOnly, withLendersOnly]);

  useEffect(() => {
    loadRows(selectedPlantId);
  }, [selectedPlantId]);

  const handleRefreshSelected = async (force = false) => {
    if (!selectedPlantId || userRole !== 'admin') return;
    setRefreshing(true);
    await triggerPlantResearch(selectedPlantId, force);
    await Promise.all([loadPlants(), loadRows(selectedPlantId)]);
    setRefreshing(false);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/30 flex-shrink-0">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-white">Lender Research</h1>
            <p className="text-xs text-slate-400 mt-0.5">One research view per plant from v_plant_financing</p>
          </div>
          {userRole === 'admin' && selectedPlantId && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleRefreshSelected(false)}
                disabled={refreshing}
                className="px-3 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white"
              >
                {refreshing ? 'Refreshing...' : 'Refresh selected'}
              </button>
              <button
                onClick={() => handleRefreshSelected(true)}
                disabled={refreshing}
                className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-100"
              >
                Force refresh
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="px-6 py-3 border-b border-slate-800/70 bg-slate-900/20 flex items-center gap-4 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search plants"
          className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 min-w-[220px]"
        />
        <label className="text-xs text-slate-300 flex items-center gap-2">
          <input type="checkbox" checked={curtailedOnly} onChange={(e) => setCurtailedOnly(e.target.checked)} />
          curtailed only
        </label>
        <label className="text-xs text-slate-300 flex items-center gap-2">
          <input type="checkbox" checked={withLendersOnly} onChange={(e) => setWithLendersOnly(e.target.checked)} />
          with lenders only
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-r border-slate-800 overflow-y-auto custom-scrollbar">
          {loadingPlants ? (
            <div className="p-4 text-sm text-slate-500">Loading plants...</div>
          ) : plants.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No plants match current filters.</div>
          ) : (
            <div className="divide-y divide-slate-800/60">
              {plants.map((plant) => {
                const badge = statusBadge(plant);
                const isActive = plant.plantId === selectedPlantId;
                return (
                  <button
                    key={plant.plantId}
                    onClick={() => setSelectedPlantId(plant.plantId)}
                    className={`w-full text-left p-4 transition-colors ${isActive ? 'bg-slate-800/60' : 'hover:bg-slate-900/70'}`}
                  >
                    <div className="text-sm font-semibold text-slate-100 truncate">{plant.plantName}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{plant.state ?? 'N/A'} {plant.nameplateMw ? `• ${plant.nameplateMw.toFixed(1)} MW` : ''}</div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className={`text-[9px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${badge.className}`}>
                        {badge.label}
                      </span>
                      {plant.lastResearchAt && (
                        <span className="text-[10px] text-slate-500">
                          {new Date(plant.lastResearchAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-white">{selectedPlant?.plantName ?? 'Select a plant'}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Lender | Role | Summary | Source</p>
          </div>

          <LenderEvidenceTable
            rows={rows.map((r) => ({
              lenderName: r.lenderName,
              role: r.role,
              roleSummary: r.roleSummary,
              sourceUrl: r.sourceUrl,
              evidenceQuote: r.evidenceQuote,
              inferred: r.inferred,
              inferredFromSiblingPlantId: r.inferredFromSiblingPlantId,
            }))}
            loading={loadingRows}
            emptyMessage={selectedPlant ? 'No lender evidence is available for this plant.' : 'Select a plant to view lender evidence.'}
          />
        </div>
      </div>
    </div>
  );
};

export default LenderResearchDashboard;
