/**
 * GenTrack — OpportunitiesDashboard
 *
 * Unified ranked list of advisory opportunities across all entity types:
 * plants (curtailed), owner companies, lenders, and tax equity investors.
 *
 * Sorted by opportunity_score (distress + size + recency composite).
 * Click-through navigates to the correct detail view.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { OpportunityItem } from '../types';
import { fetchOpportunities } from '../services/opportunityService';

interface Props {
  onCompanyClick:    (ultParentName: string) => void;
  onLenderClick:     (lenderName: string) => void;
  onTaxEquityClick:  (investorName: string) => void;
  onPlantClick:      (eiaPlantCode: string) => void;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  plant:      'Plant',
  owner:      'Owner',
  lender:     'Lender',
  tax_equity: 'Tax Equity',
};

const ENTITY_TYPE_COLORS: Record<string, string> = {
  plant:      'bg-red-900/30 text-red-400 border-red-500/30',
  owner:      'bg-blue-900/30 text-blue-400 border-blue-500/30',
  lender:     'bg-cyan-900/30 text-cyan-400 border-cyan-500/30',
  tax_equity: 'bg-violet-900/30 text-violet-400 border-violet-500/30',
};

const FTI_CHIP_COLORS: Record<string, string> = {
  Restructuring: 'bg-red-900/20 text-red-400',
  Transactions:  'bg-green-900/20 text-green-400',
  Disputes:      'bg-amber-900/20 text-amber-400',
  Policy:        'bg-indigo-900/20 text-indigo-400',
};

function scoreColor(score: number): string {
  if (score >= 70) return 'text-red-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-green-400';
}

function scoreBarColor(score: number): string {
  if (score >= 70) return 'bg-red-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-green-500';
}

function formatDollars(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type EntityTypeFilter = 'all' | 'plant' | 'owner' | 'lender' | 'tax_equity';
type RecencyFilter = 0 | 7 | 30 | 90;

const PAGE_SIZE = 50;

const OpportunitiesDashboard: React.FC<Props> = ({
  onCompanyClick,
  onLenderClick,
  onTaxEquityClick,
  onPlantClick,
}) => {
  const [items, setItems]         = useState<OpportunityItem[]>([]);
  const [loading, setLoading]     = useState(true);

  const [entityTypeFilter, setEntityTypeFilter] = useState<EntityTypeFilter>('all');
  const [ftiFilter, setFtiFilter]               = useState<string>('all');
  const [minDollarsFilter, setMinDollarsFilter] = useState<number>(0);
  const [recencyFilter, setRecencyFilter]       = useState<RecencyFilter>(0);
  const [search, setSearch]                     = useState('');
  const [page, setPage]                         = useState(1);

  useEffect(() => {
    fetchOpportunities().then(rows => {
      setItems(rows);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    let result = items;

    if (entityTypeFilter !== 'all') {
      result = result.filter(i => i.entityType === entityTypeFilter);
    }

    if (ftiFilter !== 'all') {
      result = result.filter(i => i.ftiServiceLines.includes(ftiFilter));
    }

    if (minDollarsFilter > 0) {
      result = result.filter(i => i.entityType === 'plant' || (i.dollarsAtRisk != null && i.dollarsAtRisk >= minDollarsFilter));
    }

    if (recencyFilter > 0) {
      const minAgeMs = recencyFilter * 86_400_000;
      result = result.filter(i => {
        if (!i.lastNewsDate) return false;
        return Date.now() - new Date(i.lastNewsDate).getTime() <= minAgeMs;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(i => i.entityName.toLowerCase().includes(q));
    }

    return result;
  }, [items, entityTypeFilter, ftiFilter, minDollarsFilter, recencyFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleRowClick = (item: OpportunityItem) => {
    if (item.entityType === 'owner')      onCompanyClick(item.entityId);
    else if (item.entityType === 'lender')     onLenderClick(item.entityId);
    else if (item.entityType === 'tax_equity') onTaxEquityClick(item.entityId);
    else if (item.entityType === 'plant')      onPlantClick(item.entityId);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-amber-500 mx-auto mb-3" />
          <p className="text-slate-400 text-sm font-medium">Loading opportunities…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-top-4 duration-500">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-black text-white mb-2 tracking-tight">Opportunities</h1>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Ranked advisory targets across all entity types — sorted by distress, scale, and news recency.
        </p>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {(['plant','owner','lender','tax_equity'] as const).map(type => {
          const count = items.filter(i => i.entityType === type).length;
          return (
            <div key={type} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
              <div className={`text-[10px] font-black uppercase tracking-widest mb-1 ${ENTITY_TYPE_COLORS[type].split(' ')[1]}`}>
                {ENTITY_TYPE_LABELS[type]}
              </div>
              <div className="text-2xl font-black text-white">{count.toLocaleString()}</div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          placeholder="Search entity name…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500 w-52"
        />

        <select
          value={entityTypeFilter}
          onChange={e => { setEntityTypeFilter(e.target.value as EntityTypeFilter); setPage(1); }}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
        >
          <option value="all">All Types</option>
          <option value="plant">Plants</option>
          <option value="owner">Owners</option>
          <option value="lender">Lenders</option>
          <option value="tax_equity">Tax Equity</option>
        </select>

        <select
          value={ftiFilter}
          onChange={e => { setFtiFilter(e.target.value); setPage(1); }}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
        >
          <option value="all">All Service Lines</option>
          <option value="Restructuring">Restructuring</option>
          <option value="Transactions">Transactions</option>
          <option value="Disputes">Disputes</option>
          <option value="Policy">Policy</option>
        </select>

        <select
          value={minDollarsFilter}
          onChange={e => { setMinDollarsFilter(Number(e.target.value)); setPage(1); }}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
        >
          <option value={0}>Any Exposure</option>
          <option value={100_000_000}>≥ $100M</option>
          <option value={500_000_000}>≥ $500M</option>
          <option value={1_000_000_000}>≥ $1B</option>
        </select>

        <select
          value={recencyFilter}
          onChange={e => { setRecencyFilter(Number(e.target.value) as RecencyFilter); setPage(1); }}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-500"
        >
          <option value={0}>Any Recency</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-4 py-4 w-10 text-center">#</th>
                <th className="px-4 py-4">Entity</th>
                <th className="px-4 py-4">Opp. Score</th>
                <th className="px-4 py-4 text-right">Distress</th>
                <th className="px-4 py-4">Key Signal</th>
                <th className="px-4 py-4 text-right">$ at Risk</th>
                <th className="px-4 py-4">FTI Service Lines</th>
                <th className="px-4 py-4">Last News</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {paginated.map((item, idx) => {
                const rank = (page - 1) * PAGE_SIZE + idx + 1;
                return (
                  <tr
                    key={`${item.entityType}-${item.entityId}`}
                    onClick={() => handleRowClick(item)}
                    className="cursor-pointer transition-all hover:bg-slate-800/60 group"
                  >
                    <td className="px-4 py-4 text-center">
                      <span className="text-xs font-mono text-slate-600">{rank}</span>
                    </td>

                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${ENTITY_TYPE_COLORS[item.entityType]}`}>
                          {ENTITY_TYPE_LABELS[item.entityType]}
                        </span>
                        <span className="text-sm font-bold text-slate-200 group-hover:text-amber-400 transition-colors">
                          {item.entityName}
                        </span>
                      </div>
                    </td>

                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-black w-7 text-right ${scoreColor(item.opportunityScore)}`}>
                          {item.opportunityScore}
                        </span>
                        <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${scoreBarColor(item.opportunityScore)}`}
                            style={{ width: `${item.opportunityScore}%` }}
                          />
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-4 text-right">
                      {item.distressScore != null
                        ? <span className={`text-xs font-bold ${scoreColor(item.distressScore)}`}>{Math.round(item.distressScore)}</span>
                        : <span className="text-slate-600 text-xs">—</span>
                      }
                    </td>

                    <td className="px-4 py-4 max-w-xs">
                      {item.keySignal
                        ? <span className="text-xs text-slate-400 line-clamp-2">{item.keySignal}</span>
                        : <span className="text-slate-600 text-xs">—</span>
                      }
                    </td>

                    <td className="px-4 py-4 text-right font-mono text-xs text-slate-300">
                      {formatDollars(item.dollarsAtRisk)}
                    </td>

                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1">
                        {item.ftiServiceLines.length > 0
                          ? item.ftiServiceLines.map(sl => (
                              <span key={sl} className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${FTI_CHIP_COLORS[sl] ?? 'bg-slate-800 text-slate-400'}`}>
                                {sl}
                              </span>
                            ))
                          : <span className="text-slate-600 text-xs">—</span>
                        }
                      </div>
                    </td>

                    <td className="px-4 py-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatDate(item.lastNewsDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <div className="py-24 text-center text-slate-600">
            <p className="font-semibold">No opportunities match your filters.</p>
            <p className="text-sm mt-1">Adjust filters or run the refresh-entity-stats pipeline.</p>
          </div>
        )}

        {/* Pagination */}
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-6 py-4 bg-slate-800/40 border-t border-slate-800">
            <div className="text-xs text-slate-500">
              Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()} opportunities
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                ‹ Prev
              </button>
              <span className="text-xs text-slate-500 font-mono">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                Next ›
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default OpportunitiesDashboard;
