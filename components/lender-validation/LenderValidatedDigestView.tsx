import React, { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  LenderValidatedDigest,
  DigestPlantRow,
  NewsArticle,
  LenderDigestKpis,
} from '../../types';
import { formatMonthYear } from '../../constants';
import LenderValidatedPlantsMap from './LenderValidatedPlantsMap';

// ── helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number | null, decimals = 1): string {
  if (n === null || n === undefined) return '—';
  return n.toFixed(decimals);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
}

function cfDeltaClass(delta: number | null): string {
  if (delta === null) return 'text-slate-400';
  if (delta >= 3) return 'text-emerald-400';
  if (delta >= 0) return 'text-emerald-300/80';
  if (delta >= -3) return 'text-amber-400';
  return 'text-rose-400';
}

function cfDeltaLabel(delta: number | null): string {
  if (delta === null) return '—';
  const prefix = delta >= 0 ? '+' : '';
  return `${prefix}${fmt(delta)} pp`;
}

function newsRiskClass(score: number | null): string {
  if (score === null) return 'text-slate-400';
  if (score >= 70) return 'text-rose-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-emerald-400';
}

function pursuitBadge(label: 'hot' | 'warm' | 'cold' | null): React.ReactNode {
  if (!label) return null;
  const cfg: Record<string, string> = {
    hot: 'border-rose-500/40 bg-rose-900/20 text-rose-400',
    warm: 'border-amber-500/40 bg-amber-900/20 text-amber-400',
    cold: 'border-sky-500/40 bg-sky-900/20 text-sky-400',
  };
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border tracking-wider ${cfg[label]}`}>
      {label}
    </span>
  );
}

function sentimentChip(label: NewsArticle['sentimentLabel']): React.ReactNode {
  if (!label) return null;
  const cfg: Record<string, string> = {
    positive: 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30',
    negative: 'bg-rose-900/30 text-rose-400 border-rose-500/30',
    neutral: 'bg-slate-800 text-slate-400 border-slate-700',
  };
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cfg[label]}`}>
      {label}
    </span>
  );
}

function fuelChip(fuel: string): React.ReactNode {
  const cfg: Record<string, string> = {
    Solar: 'bg-yellow-900/20 text-yellow-400 border-yellow-500/30',
    Wind: 'bg-sky-900/20 text-sky-400 border-sky-500/30',
    Nuclear: 'bg-green-900/20 text-green-400 border-green-500/30',
  };
  const cls = cfg[fuel] ?? 'bg-slate-800 text-slate-400 border-slate-700';
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cls}`}>
      {fuel}
    </span>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}

const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub }) => (
  <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-5 py-4 flex flex-col gap-1">
    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{label}</span>
    <span className="text-2xl font-bold text-slate-100 leading-none">{value}</span>
    {sub && <span className="text-xs text-slate-400 leading-tight mt-0.5">{sub}</span>}
  </div>
);

// ── Portfolio CF chart ─────────────────────────────────────────────────────────

interface CfChartProps {
  cfSeries: LenderValidatedDigest['cfSeries'];
}

const PortfolioCfChart: React.FC<CfChartProps> = ({ cfSeries }) => {
  const data = cfSeries.map((p) => ({
    name: p.month,
    portfolioCf: p.portfolioCf !== null ? Math.round(p.portfolioCf * 10) / 10 : null,
    blendedRegionalCf: p.blendedRegionalCf !== null ? Math.round(p.blendedRegionalCf * 10) / 10 : null,
  }));

  const allVals = data.flatMap((d) => [d.portfolioCf, d.blendedRegionalCf]).filter((v): v is number => v !== null);
  const minVal = allVals.length > 0 ? Math.min(...allVals) : 0;
  const maxVal = allVals.length > 0 ? Math.max(...allVals) : 50;
  const yDomain: [number, number] = [
    Math.max(0, Math.floor(minVal) - 3),
    Math.min(100, Math.ceil(maxVal) + 3),
  ];

  return (
    <div className="h-72 w-full bg-slate-800/50 rounded-xl p-4 border border-slate-700">
      <h3 className="text-sm font-semibold text-slate-300 mb-4">
        Portfolio Capacity Factor vs Blended Regional Baseline (MW-weighted, %)
      </h3>
      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={data} margin={{ top: 4, right: 20, left: -20, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis
            dataKey="name"
            stroke="#94a3b8"
            fontSize={10}
            tickFormatter={formatMonthYear}
            interval={2}
          />
          <YAxis
            stroke="#94a3b8"
            fontSize={10}
            domain={yDomain}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            labelFormatter={(label: string) => formatMonthYear(label)}
            formatter={(value: number | null, name: string) => [
              value !== null ? `${value}%` : 'N/A',
              name === 'portfolioCf' ? 'Portfolio CF' : 'Blended Regional',
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
            formatter={(value: string) =>
              value === 'portfolioCf' ? 'Portfolio CF (MW-weighted)' : 'Blended Regional Baseline'
            }
          />
          <Line
            name="blendedRegionalCf"
            type="monotone"
            dataKey="blendedRegionalCf"
            stroke="#64748b"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
          />
          <Line
            name="portfolioCf"
            type="monotone"
            dataKey="portfolioCf"
            stroke="#38bdf8"
            strokeWidth={3}
            dot={false}
            activeDot={{ r: 6 }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── AI overview card ──────────────────────────────────────────────────────────

interface AiOverviewProps {
  thesis: string | null;
  health: string | null;
  pitchBullets: string[];
  riskBullets: string[];
}

const AiOverviewCard: React.FC<AiOverviewProps> = ({ thesis, health, pitchBullets, riskBullets }) => {
  const [thesisOpen, setThesisOpen] = useState(true);
  const [healthOpen, setHealthOpen] = useState(false);

  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
        <span className="text-indigo-400 text-lg">✦</span>
        <h2 className="text-sm font-bold text-slate-200">AI Portfolio Overview</h2>
        <span className="ml-auto text-[9px] text-slate-600 font-semibold uppercase tracking-wider">Gemini</span>
      </div>

      {/* Two-column: narratives left, bullet chips right */}
      <div className="flex flex-col lg:flex-row gap-0 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
        {/* Narratives */}
        <div className="flex-1 p-5 space-y-3">
          {/* Engagement thesis */}
          <div>
            <button
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setThesisOpen((v) => !v)}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                Engagement thesis
              </span>
              <span className="ml-auto text-slate-600 text-xs">{thesisOpen ? '▲' : '▼'}</span>
            </button>
            {thesisOpen && (
              <p className="mt-2 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                {thesis ?? 'Digest not yet generated — trigger from Admin page.'}
              </p>
            )}
          </div>

          {/* Portfolio health */}
          <div>
            <button
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setHealthOpen((v) => !v)}
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Portfolio health
              </span>
              <span className="ml-auto text-slate-600 text-xs">{healthOpen ? '▲' : '▼'}</span>
            </button>
            {healthOpen && (
              <p className="mt-2 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                {health ?? '—'}
              </p>
            )}
          </div>
        </div>

        {/* Bullet chips */}
        <div className="w-full lg:w-72 p-5 space-y-4">
          {pitchBullets.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-500 mb-2">
                Reasons to engage
              </p>
              <ul className="space-y-1.5">
                {pitchBullets.map((b, i) => (
                  <li key={i} className="flex gap-2 items-start text-xs text-slate-300">
                    <span className="text-emerald-500 shrink-0 mt-0.5">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {riskBullets.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-rose-400 mb-2">
                Risks to flag
              </p>
              <ul className="space-y-1.5">
                {riskBullets.map((b, i) => (
                  <li key={i} className="flex gap-2 items-start text-xs text-slate-300">
                    <span className="text-rose-400 shrink-0 mt-0.5">⚠</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pitchBullets.length === 0 && riskBullets.length === 0 && (
            <p className="text-xs text-slate-500 italic">Generate digest to see advisory bullets.</p>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Plant table ───────────────────────────────────────────────────────────────

type SortKey = 'name' | 'mw' | 'ttmCf' | 'delta' | 'newsRisk';

interface PlantTableProps {
  plants: DigestPlantRow[];
  onPlantClick: (plantId: string, eiaCode: string) => void;
  selectedPlantId: string | null;
  onFilterSelect: (plantId: string | null) => void;
}

const PlantTable: React.FC<PlantTableProps> = ({ plants, onPlantClick, selectedPlantId, onFilterSelect }) => {
  const [sortKey, setSortKey] = useState<SortKey>('mw');
  const [sortDesc, setSortDesc] = useState(true);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const sorted = [...plants].sort((a, b) => {
    const mul = sortDesc ? -1 : 1;
    switch (sortKey) {
      case 'name':    return mul * a.plantName.localeCompare(b.plantName);
      case 'mw':      return mul * ((a.nameplateMw ?? 0) - (b.nameplateMw ?? 0));
      case 'ttmCf':   return mul * ((a.ttmCf ?? -1) - (b.ttmCf ?? -1));
      case 'delta':   return mul * ((a.cfDeltaPp ?? -999) - (b.cfDeltaPp ?? -999));
      case 'newsRisk':return mul * ((a.newsRiskScore ?? 0) - (b.newsRiskScore ?? 0));
      default:        return 0;
    }
  });

  const SortHeader: React.FC<{ k: SortKey; label: string }> = ({ k, label }) => (
    <th
      className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5 cursor-pointer hover:text-slate-300 select-none"
      onClick={() => handleSort(k)}
    >
      {label}
      {sortKey === k && <span className="ml-1 text-blue-400">{sortDesc ? '↓' : '↑'}</span>}
    </th>
  );

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Validated Plants</h3>
        <span className="text-xs text-slate-500">({plants.length})</span>
        {selectedPlantId && (
          <button
            onClick={() => onFilterSelect(null)}
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded px-2 py-0.5 transition-colors"
          >
            ✕ Clear filter
          </button>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800/60 bg-slate-900/70">
            <SortHeader k="name" label="Plant" />
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5">State</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5">Fuel</th>
            <SortHeader k="mw" label="MW" />
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5">Role</th>
            <SortHeader k="ttmCf" label="TTM CF" />
            <SortHeader k="delta" label="Δ vs Region" />
            <SortHeader k="newsRisk" label="News Risk" />
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5">Validated</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const isActive = selectedPlantId === p.plantId;
            return (
              <tr
                key={p.plantId}
                className={`border-b border-slate-800/30 last:border-b-0 cursor-pointer transition-colors ${
                  isActive ? 'bg-blue-900/20' : 'hover:bg-slate-800/40'
                }`}
                onClick={() => {
                  onFilterSelect(isActive ? null : p.plantId);
                }}
              >
                <td className="px-4 py-3">
                  <button
                    className="text-blue-400 hover:text-blue-300 font-semibold text-left"
                    onClick={(e) => { e.stopPropagation(); onPlantClick(p.plantId, p.eiaPlantCode); }}
                  >
                    {p.plantName}
                  </button>
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{p.state ?? '—'}</td>
                <td className="px-4 py-3">{fuelChip(p.fuelSource)}</td>
                <td className="px-4 py-3 text-slate-300 text-xs font-semibold">
                  {p.nameplateMw != null ? p.nameplateMw.toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{p.role ?? '—'}</td>
                <td className="px-4 py-3 text-slate-200 text-xs font-semibold">
                  {p.ttmCf !== null ? `${fmt(p.ttmCf)}%` : '—'}
                </td>
                <td className={`px-4 py-3 text-xs font-semibold ${cfDeltaClass(p.cfDeltaPp)}`}>
                  {cfDeltaLabel(p.cfDeltaPp)}
                </td>
                <td className={`px-4 py-3 text-xs font-semibold ${newsRiskClass(p.newsRiskScore)}`}>
                  {p.newsRiskScore !== null ? Math.round(p.newsRiskScore) : '—'}
                </td>
                <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(p.validatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ── News feed ─────────────────────────────────────────────────────────────────

interface NewsFeedProps {
  articles: NewsArticle[];
  /** When set, only show articles relevant to this plant */
  filterPlantName: string | null;
}

const NewsFeed: React.FC<NewsFeedProps> = ({ articles, filterPlantName }) => {
  const filtered = filterPlantName
    ? articles.filter(
        (a) =>
          a.entityCompanyNames.some((n) =>
            n.toLowerCase().includes(filterPlantName.toLowerCase()),
          ) ||
          (a.lenders?.some((l) => l.toLowerCase().includes(filterPlantName.toLowerCase()))) ||
          a.title.toLowerCase().includes(filterPlantName.toLowerCase()),
      )
    : articles;

  const sorted = [...filtered].sort((a, b) => {
    const scoreA = (a.relevanceScore ?? 0) * 0.5 + (new Date(a.publishedAt).getTime() / 1e13) * 0.5;
    const scoreB = (b.relevanceScore ?? 0) * 0.5 + (new Date(b.publishedAt).getTime() / 1e13) * 0.5;
    return scoreB - scoreA;
  });

  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Portfolio News</h3>
        {filterPlantName && (
          <span className="text-[10px] bg-blue-900/30 text-blue-400 border border-blue-500/30 rounded px-2 py-0.5">
            {filterPlantName}
          </span>
        )}
        <span className="ml-auto text-xs text-slate-500">{sorted.length} articles</span>
      </div>

      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-slate-500 text-sm">
          {filterPlantName ? 'No news for this plant.' : 'No recent news articles.'}
        </div>
      ) : (
        <div className="divide-y divide-slate-800/50 max-h-[600px] overflow-y-auto custom-scrollbar">
          {sorted.map((article) => (
            <div key={article.id} className="px-4 py-3 hover:bg-slate-800/30 transition-colors">
              <div className="flex items-start gap-2 mb-1">
                {sentimentChip(article.sentimentLabel)}
                <span className="text-[9px] text-slate-500 ml-auto shrink-0">
                  {fmtDate(article.publishedAt)}
                </span>
              </div>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-slate-200 hover:text-blue-300 leading-snug line-clamp-2"
              >
                {article.title}
              </a>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {article.sourceName && (
                  <span className="text-[9px] text-slate-500">{article.sourceName}</span>
                )}
                {article.importance && (
                  <span
                    className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                      article.importance === 'high'
                        ? 'bg-rose-900/20 text-rose-400 border-rose-500/30'
                        : article.importance === 'medium'
                        ? 'bg-amber-900/20 text-amber-400 border-amber-500/30'
                        : 'bg-slate-800 text-slate-500 border-slate-700'
                    }`}
                  >
                    {article.importance}
                  </span>
                )}
                {article.impactTags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="text-[9px] text-slate-500 bg-slate-800 rounded px-1.5 py-0.5"
                  >
                    {tag.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main view ─────────────────────────────────────────────────────────────────

export interface LenderValidatedDigestViewProps {
  digest: LenderValidatedDigest;
  /** Enriched plant rows with CF and news risk data. */
  plants: DigestPlantRow[];
  /** News articles scoped to this lender's validated plants. */
  articles: NewsArticle[];
  /** Called when the user clicks a plant name to open PlantDetailView. */
  onPlantClick: (plantId: string, eiaPlantCode: string) => void;
  /** Called to return to the lender list. */
  onBack: () => void;
  /** Called to navigate to the raw evidence table for this lender. */
  onViewEvidence?: () => void;
  /** Whether the pursuit dropdown should be interactive. */
  canWrite?: boolean;
  /** Called when the pursuit label is changed. */
  onPursuitChange?: (lenderId: string, label: 'hot' | 'warm' | 'cold' | null) => void;
}

const PURSUIT_OPTIONS: Array<{ value: 'hot' | 'warm' | 'cold' | ''; label: string }> = [
  { value: '', label: '— No label —' },
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' },
];

const LenderValidatedDigestView: React.FC<LenderValidatedDigestViewProps> = ({
  digest,
  plants,
  articles,
  onPlantClick,
  onBack,
  onViewEvidence,
  canWrite = false,
  onPursuitChange,
}) => {
  const [newsFeedPlantId, setNewsFeedPlantId] = useState<string | null>(null);
  const newsFeedPlantName = plants.find((p) => p.plantId === newsFeedPlantId)?.plantName ?? null;

  const { kpis } = digest;

  const isStale =
    digest.generatedAt
      ? (Date.now() - new Date(digest.generatedAt).getTime()) / 86_400_000 > 7
      : false;

  const handleFeedFilter = (plantId: string | null) => {
    setNewsFeedPlantId(plantId);
  };

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          ← Back to lenders
        </button>
        <span className="text-slate-700">/</span>
        <span className="text-base font-bold text-slate-100">{digest.lenderName}</span>
        {pursuitBadge(digest.pursuitLabel)}

        {/* Pursuit label selector */}
        {canWrite && onPursuitChange && (
          <select
            value={digest.pursuitLabel ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              onPursuitChange(digest.lenderId, (val || null) as 'hot' | 'warm' | 'cold' | null);
            }}
            className="ml-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {PURSUIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-3">
          {/* Staleness badge */}
          <span
            className={`text-[10px] px-2 py-0.5 rounded border ${
              isStale
                ? 'bg-amber-900/20 text-amber-400 border-amber-500/30'
                : 'bg-slate-800 text-slate-500 border-slate-700'
            }`}
          >
            Generated {timeAgo(digest.generatedAt)}
            {isStale && ' — stale'}
          </span>

          {/* View raw evidence */}
          {onViewEvidence && (
            <button
              onClick={onViewEvidence}
              className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 transition-colors"
            >
              View raw evidence
            </button>
          )}
        </div>
      </div>

      {/* ── AI Overview ── */}
      <AiOverviewCard
        thesis={digest.aiEngagementThesis}
        health={digest.aiPortfolioHealth}
        pitchBullets={digest.aiPitchBullets}
        riskBullets={digest.aiRiskBullets}
      />

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Validated plants"
          value={digest.plantCount}
        />
        <KpiCard
          label="Total MW"
          value={kpis.totalMw != null ? kpis.totalMw.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
        />
        <KpiCard
          label="Portfolio TTM CF"
          value={kpis.weightedTtmCf !== null ? `${fmt(kpis.weightedTtmCf)}%` : '—'}
          sub={
            kpis.cfDeltaPp !== null ? (
              <span className={cfDeltaClass(kpis.cfDeltaPp)}>
                {cfDeltaLabel(kpis.cfDeltaPp)} vs regional
              </span>
            ) : undefined
          }
        />
        <KpiCard
          label="Avg news risk"
          value={
            kpis.avgNewsRisk !== null ? (
              <span className={newsRiskClass(kpis.avgNewsRisk)}>
                {Math.round(kpis.avgNewsRisk)}
              </span>
            ) : '—'
          }
          sub="0 = low, 100 = high"
        />
        <KpiCard
          label="Distress score"
          value={
            kpis.avgDistressScore !== null ? (
              <span className={newsRiskClass(kpis.avgDistressScore)}>
                {Math.round(kpis.avgDistressScore)}
              </span>
            ) : '—'
          }
          sub="0 = low, 100 = high"
        />
        <KpiCard
          label="Active loans"
          value={kpis.activeLoanCount ?? '—'}
          sub={kpis.curtailedCount != null && kpis.curtailedCount > 0
            ? `${kpis.curtailedCount} likely curtailed`
            : undefined}
        />
      </div>

      {/* ── CF Chart ── */}
      <PortfolioCfChart cfSeries={digest.cfSeries} />

      {/* ── Geographic map of validated plants ── */}
      <LenderValidatedPlantsMap plants={plants} onPlantClick={onPlantClick} />

      {/* ── Lower: Plant table + News feed ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Plant table — 65% */}
        <div className="lg:col-span-2">
          <PlantTable
            plants={plants}
            onPlantClick={onPlantClick}
            selectedPlantId={newsFeedPlantId}
            onFilterSelect={handleFeedFilter}
          />
        </div>

        {/* News feed — 35% */}
        <div className="lg:col-span-1">
          <NewsFeed
            articles={articles}
            filterPlantName={newsFeedPlantName}
          />
        </div>
      </div>

    </div>
  );
};

export default LenderValidatedDigestView;
