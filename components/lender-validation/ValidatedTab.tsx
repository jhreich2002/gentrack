import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchValidatedLenders,
  fetchValidatedPortfolio,
  fetchValidationAudit,
  setLenderPursuitTier,
  ValidatedLender,
  ValidatedPortfolioRow,
  ValidationAuditEntry,
  LenderTier,
} from '../../services/lenderValidationService';
import LenderChatPanel from './LenderChatPanel';

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const TIER_STYLES: Record<LenderTier, string> = {
  hot:  'bg-red-900/50 border-red-700/50 text-red-300',
  warm: 'bg-amber-900/50 border-amber-700/50 text-amber-300',
  cold: 'bg-sky-900/50 border-sky-700/50 text-sky-300',
};

const TIER_DOT: Record<LenderTier, string> = {
  hot: 'bg-red-500', warm: 'bg-amber-500', cold: 'bg-sky-500',
};

interface Props {
  refreshKey?: number;
  onRefresh?: () => void;
}

const ValidatedTab: React.FC<Props> = ({ refreshKey = 0, onRefresh }) => {
  const [lenders, setLenders] = useState<ValidatedLender[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterTier, setFilterTier] = useState<'all' | 'untiered' | LenderTier>('all');
  const [selected, setSelected] = useState<ValidatedLender | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLenders(await fetchValidatedLenders());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const visible = lenders.filter(l => {
    if (filterTier === 'untiered' && l.tier !== null) return false;
    if (filterTier !== 'all' && filterTier !== 'untiered' && l.tier !== filterTier) return false;
    if (search && !l.lenderName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => b.curtailedMw - a.curtailedMw);

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/50 flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search lender…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-56"
        />
        <div className="flex items-center gap-1 text-xs">
          {(['all','untiered','hot','warm','cold'] as const).map(t => (
            <button
              key={t}
              onClick={() => setFilterTier(t)}
              className={`px-2 py-1 rounded uppercase tracking-wide font-semibold ${
                filterTier === t ? 'bg-blue-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 ml-auto">{visible.length} lender{visible.length === 1 ? '' : 's'}</span>
      </div>

      {/* Cards */}
      {loading ? (
        <div className="p-8 text-center text-slate-500 text-sm">Loading validated lenders…</div>
      ) : visible.length === 0 ? (
        <div className="p-8 text-center text-slate-500 text-sm">
          No validated lenders yet. Lenders graduate here once every candidate plant has been adjudicated.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(l => (
            <button
              key={l.lenderNormalized}
              onClick={() => setSelected(l)}
              className="text-left bg-slate-900 border border-slate-800 hover:border-blue-700/60 rounded-xl p-4 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="font-semibold text-white truncate">{l.lenderName}</div>
                {l.tier ? (
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border uppercase tracking-wide font-semibold ${TIER_STYLES[l.tier]}`}>
                    {l.tier}
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border uppercase tracking-wide font-semibold bg-slate-800 border-slate-700 text-slate-500">
                    set tier
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs text-slate-400 mb-2">
                <div>
                  <div className="text-slate-200 font-semibold">{l.validatedPlantCount}</div>
                  <div>plants</div>
                </div>
                <div>
                  <div className="text-amber-300 font-semibold">{l.curtailedPlantCount}</div>
                  <div>curtailed</div>
                </div>
                <div>
                  <div className="text-slate-200 font-semibold">{fmtMw(l.curtailedMw)}</div>
                  <div>exposure</div>
                </div>
              </div>
              <div className="text-[11px] text-slate-500">
                Promoted {timeAgo(l.promotedAt)}
                {l.tierSetAt && <> · tier set {timeAgo(l.tierSetAt)}</>}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <LenderDetailDrawer
          lender={selected}
          onClose={() => setSelected(null)}
          onChanged={async () => { await load(); onRefresh?.(); }}
        />
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Detail drawer
// ──────────────────────────────────────────────────────────────────────────────

interface DrawerProps {
  lender: ValidatedLender;
  onClose: () => void;
  onChanged: () => void;
}

const LenderDetailDrawer: React.FC<DrawerProps> = ({ lender, onClose, onChanged }) => {
  const [portfolio, setPortfolio] = useState<ValidatedPortfolioRow[]>([]);
  const [audit, setAudit] = useState<Map<string, ValidationAuditEntry[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState<LenderTier | null>(lender.tier);
  const [notes, setNotes] = useState(lender.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const port = await fetchValidatedPortfolio(lender.lenderNormalized);
      if (!alive) return;
      setPortfolio(port);
      // Fetch audit per plant in parallel.
      const auditMap = new Map<string, ValidationAuditEntry[]>();
      const codes = Array.from(new Set(port.map(p => p.plantCode)));
      const results = await Promise.all(codes.map(c => fetchValidationAudit(c).then(a => [c, a] as const)));
      for (const [code, entries] of results) auditMap.set(code, entries.filter(a => a.action === 'approve'));
      if (!alive) return;
      setAudit(auditMap);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [lender.lenderNormalized]);

  async function handleSaveTier(next: LenderTier | null) {
    setSaving(true);
    setError(null);
    const res = await setLenderPursuitTier(lender.lenderNormalized, next, notes || undefined);
    setSaving(false);
    if (!res.success) { setError(res.error ?? 'Failed'); return; }
    setTier(next);
    onChanged();
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[640px] max-w-[95vw] bg-slate-900 border-l border-slate-700 z-50 flex flex-col shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between flex-shrink-0">
          <div>
            <h3 className="font-bold text-white text-base">{lender.lenderName}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {lender.validatedPlantCount} validated plants · {lender.curtailedPlantCount} curtailed · {fmtMw(lender.curtailedMw)} exposure
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tier setter */}
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/40">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Pursuit tier</div>
          <div className="flex gap-2 mb-3">
            {(['hot','warm','cold'] as LenderTier[]).map(t => (
              <button
                key={t}
                disabled={saving}
                onClick={() => handleSaveTier(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded uppercase tracking-wide border transition-colors ${
                  tier === t
                    ? TIER_STYLES[t] + ' shadow-md'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${TIER_DOT[t]}`} />
                {t}
              </button>
            ))}
            <button
              disabled={saving || tier === null}
              onClick={() => handleSaveTier(null)}
              className="px-3 py-1.5 text-xs font-semibold rounded uppercase tracking-wide border bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if (tier) handleSaveTier(tier); }}
            rows={2}
            placeholder="Pursuit notes (saved on blur)…"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>

        {/* Plants */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <LenderChatPanel
            scope="lender"
            lenderNormalized={lender.lenderNormalized}
            contextLabel={lender.lenderName}
          />
          {loading ? (
            <div className="text-center text-slate-500 text-sm py-6">Loading portfolio…</div>
          ) : portfolio.length === 0 ? (
            <div className="text-center text-slate-500 text-sm py-6">No validated plants on file.</div>
          ) : (
            portfolio.map(row => {
              const audits = audit.get(row.plantCode) ?? [];
              const latest = audits[0]; // already action='approve'
              return (
                <div key={row.linkId} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{row.plantName ?? row.plantCode}</div>
                      <div className="text-[11px] text-slate-500">
                        {row.state ?? '—'} · {fmtMw(row.nameplateMw)}
                        {row.isLikelyCurtailed && <span className="text-amber-400"> · curtailed</span>}
                      </div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 uppercase tracking-wide font-semibold flex-shrink-0">
                      {row.confidenceClass.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {row.evidenceSummary && (
                    <p className="text-[12px] text-slate-300 leading-snug mb-1.5 line-clamp-3">{row.evidenceSummary}</p>
                  )}
                  {row.sourceUrl && (
                    <a
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline truncate block mb-1"
                    >
                      {row.sourceUrl}
                    </a>
                  )}
                  <div className="text-[10px] text-slate-500 italic">
                    {latest
                      ? <>Validated by {latest.reviewerEmail ?? 'unknown'} · {timeAgo(latest.timestamp)}</>
                      : <>Validated {timeAgo(row.validatedAt)}</>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
};

export default ValidatedTab;
