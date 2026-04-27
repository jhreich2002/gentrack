import React, { useState, useEffect } from 'react';
import {
  fetchLenderLinks,
  fetchPlantAliases,
  fetchEvidenceRecords,
  fetchAgentRuns,
  UCCResearchPlant,
  UCCLenderLink,
  UCCEvidenceRecord,
  UCCAgentRun,
} from '../services/uccResearchService';
import UCCEvidenceDrawer from './UCCEvidenceDrawer';

interface Props {
  plant:             UCCResearchPlant;
  onBack:            () => void;
  onRun:             () => void;
  onRunWithBudget:   (budget: number) => void;
  running:           boolean;
}

type ConfidenceClass = 'confirmed' | 'highly_likely' | 'possible';

const CONF_STYLES: Record<ConfidenceClass, string> = {
  confirmed:     'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
  highly_likely: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
  possible:      'bg-slate-700/40 text-slate-400 border-slate-600/40',
};

const CONF_LABELS: Record<ConfidenceClass, string> = {
  confirmed:     'CONFIRMED',
  highly_likely: 'HIGHLY LIKELY',
  possible:      'POSSIBLE',
};

const SOURCE_ICONS: Record<string, string> = {
  ucc_scrape:     '📋',
  county_scrape:  '🏛',
  edgar:          '📑',
  sponsor_history:'📊',
  web_scrape:     '🌐',
  perplexity:     '🔍',
  gemini:         '✨',
};

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  return `${Math.round(mw).toLocaleString()} MW`;
}

const UCCPlantDetail: React.FC<Props> = ({ plant, onBack, onRun, onRunWithBudget, running }) => {
  const [links, setLinks]         = useState<UCCLenderLink[]>([]);
  const [aliases, setAliases]     = useState<Awaited<ReturnType<typeof fetchPlantAliases>>>([]);
  const [lastRun, setLastRun]     = useState<UCCAgentRun | null>(null);
  const [loading, setLoading]     = useState(true);

  // Drawer state
  const [drawerOpen, setDrawerOpen]         = useState(false);
  const [drawerEvidence, setDrawerEvidence] = useState<UCCEvidenceRecord[]>([]);
  const [drawerLender, setDrawerLender]     = useState<string>('');

  useEffect(() => {
    async function load() {
      const [l, a, runs] = await Promise.all([
        fetchLenderLinks(plant.plant_code),
        fetchPlantAliases(plant.plant_code),
        fetchAgentRuns(plant.plant_code),
      ]);
      setLinks(l);
      setAliases(a);
      setLastRun(runs[0] ?? null);
      setLoading(false);
    }
    load();
  }, [plant.plant_code]);

  const openDrawer = async (link: UCCLenderLink) => {
    const evidence = await fetchEvidenceRecords(plant.plant_code, link.lender_entity_id);
    setDrawerEvidence(evidence);
    setDrawerLender(link.lender_name);
    setDrawerOpen(true);
  };

  const spvAliases  = aliases.filter(a => a.entity_type === 'spv');
  const confirmedLinks    = links.filter(l => l.confidence_class === 'confirmed');
  const likelyLinks       = links.filter(l => l.confidence_class === 'highly_likely');
  const possibleLinks     = links.filter(l => l.confidence_class === 'possible');

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-slate-400 hover:text-slate-200 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-white">{plant.plant_name}</h2>
            <p className="text-xs text-slate-400">
              {plant.state} · {fmtMw(plant.capacity_mw)} · {plant.technology ?? '—'}
              {plant.sponsor_name && <> · <span className="text-slate-300">{plant.sponsor_name}</span></>}
            </p>
          </div>
          <button
            onClick={onRun}
            disabled={running}
            className="px-4 py-2 bg-amber-700 hover:bg-amber-600 disabled:bg-amber-900/30 disabled:text-amber-800 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {running ? 'Running…' : links.length > 0 ? 'Re-run Research' : 'Run Research'}
          </button>
        </div>
      </div>

      {/* Budget / unresolved reason banner */}
      {!loading && !running && (plant.workflow_status === 'budget_exceeded' || plant.workflow_status === 'unresolved') && lastRun?.final_outcome && (
        <div className={`px-6 py-3 border-b flex items-center justify-between gap-4 text-sm ${
          plant.workflow_status === 'budget_exceeded'
            ? 'bg-yellow-900/20 border-yellow-800/40 text-yellow-300'
            : 'bg-red-900/20 border-red-800/40 text-red-400'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold shrink-0">
              {plant.workflow_status === 'budget_exceeded' ? '$ Budget halted:' : '⚠ Unresolved:'}
            </span>
            <span className="truncate text-xs opacity-80">{lastRun.final_outcome}</span>
          </div>
          <button
            onClick={() => onRunWithBudget(0.50)}
            disabled={running}
            className="shrink-0 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            Re-run with $0.50 budget
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">Loading…</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex gap-0 h-full">

            {/* Left panel: EIA profile + SPV aliases */}
            <div className="w-72 flex-shrink-0 border-r border-slate-800 p-5 overflow-y-auto">
              <div className="space-y-5">
                {/* Plant info */}
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Plant Profile</h3>
                  <div className="space-y-1.5 text-sm">
                    {[
                      ['Code',      plant.plant_code],
                      ['State',     plant.state],
                      ['County',    plant.county ?? '—'],
                      ['Capacity',  fmtMw(plant.capacity_mw)],
                      ['Technology',plant.technology ?? '—'],
                      ['COD Year',  plant.cod_year ?? '—'],
                      ['Sponsor',   plant.sponsor_name ?? '—'],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-2">
                        <span className="text-slate-500">{label}</span>
                        <span className="text-slate-200 text-right">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* SPV aliases */}
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">SPV Aliases</h3>
                  {spvAliases.length === 0 ? (
                    <p className="text-xs text-slate-600">No SPV aliases found yet. Run entity resolution first.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {spvAliases.map((alias, i) => (
                        <div key={i} className="bg-slate-900 rounded-lg px-3 py-2">
                          <div className="text-sm text-slate-200">{alias.entity_name}</div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-xs text-slate-500">{alias.source ?? '—'}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                              alias.confidence_score >= 80 ? 'bg-emerald-900/40 text-emerald-300'
                              : alias.confidence_score >= 60 ? 'bg-amber-900/40 text-amber-300'
                              : 'bg-slate-700 text-slate-400'
                            }`}>
                              {alias.confidence_score}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right panel: lender candidates */}
            <div className="flex-1 p-5 overflow-y-auto">
              {links.length === 0 ? (
                <div className="text-center text-slate-500 py-12 text-sm">
                  No lender candidates yet. Run research to discover lenders from UCC filings and EDGAR disclosures.
                </div>
              ) : (
                <div className="space-y-5">
                  {([
                    { label: 'Confirmed', items: confirmedLinks,    cls: 'confirmed' as ConfidenceClass    },
                    { label: 'Highly Likely', items: likelyLinks,   cls: 'highly_likely' as ConfidenceClass },
                    { label: 'Possible',  items: possibleLinks,     cls: 'possible' as ConfidenceClass     },
                  ] as Array<{ label: string; items: UCCLenderLink[]; cls: ConfidenceClass }>)
                    .filter(g => g.items.length > 0)
                    .map(group => (
                      <div key={group.cls}>
                        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                          {group.label} <span className="text-slate-600 font-normal">({group.items.length})</span>
                        </h3>
                        <div className="space-y-1.5">
                          {group.items.map(link => (
                            <button
                              key={link.id}
                              onClick={() => openDrawer(link)}
                              className={`w-full text-left bg-slate-900 border rounded-xl px-4 py-3 hover:border-slate-600 transition-colors ${CONF_STYLES[group.cls]}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-white text-sm">{link.lender_name}</span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${CONF_STYLES[group.cls]}`}>
                                  {CONF_LABELS[group.cls]}
                                </span>
                              </div>
                              <p className="text-xs text-slate-400 mt-1 line-clamp-2">{link.evidence_summary}</p>
                              <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500">
                                <span>{link.evidence_type === 'direct' ? '📋 Direct filing' : '📊 Inferred'}</span>
                                {link.source_url && <span className="truncate text-blue-400/70">{new URL(link.source_url).hostname}</span>}
                                <span className="text-amber-500/60">→ View evidence</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Evidence drawer */}
      {drawerOpen && (
        <UCCEvidenceDrawer
          lenderName={drawerLender}
          evidence={drawerEvidence}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
};

export default UCCPlantDetail;
