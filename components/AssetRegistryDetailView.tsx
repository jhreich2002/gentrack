import React, { useState, useEffect } from 'react';
import { fetchAssetDetail, fetchAssetOwners, AssetRegistryRow } from '../services/developerService';

interface Props {
  assetId: string;
  onBack: () => void;
  onPlantClick?: (plantId: string) => void;
  onDeveloperClick?: (developerId: string) => void;
}

function confidenceColor(score: number | null) {
  if (!score) return 'text-slate-500';
  if (score >= 85) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

export default function AssetRegistryDetailView({ assetId, onBack, onPlantClick }: Props) {
  const [asset, setAsset] = useState<AssetRegistryRow | null>(null);
  const [owners, setOwners] = useState<{ developer_name: string; ownership_pct: number | null; role: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchAssetDetail(assetId),
      fetchAssetOwners(assetId),
    ]).then(([a, o]) => {
      setAsset(a);
      setOwners(o);
      setLoading(false);
    });
  }, [assetId]);

  if (loading || !asset) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        {loading ? 'Loading asset details…' : 'Asset not found'}
      </div>
    );
  }

  const breakdown = asset.confidence_breakdown || {};

  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <button onClick={onBack} className="flex items-center gap-2 text-slate-500 hover:text-blue-400 transition-colors mb-4 group">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
          <span className="text-sm font-medium group-hover:underline">Back</span>
        </button>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-black text-white tracking-tight">{asset.name}</h1>
            <div className="flex items-center gap-3 mt-2">
              {asset.technology && (
                <span className="text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-blue-900/20 text-blue-400 border border-blue-500/20">
                  {asset.technology}
                </span>
              )}
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                asset.graduated
                  ? 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30'
                  : 'bg-amber-900/30 text-amber-400 border-amber-500/30'
              }`}>
                {asset.graduated ? 'Graduated' : 'Staged'}
              </span>
              {asset.verified && (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-green-900/20 text-green-400 border border-green-500/20">
                  Verified
                </span>
              )}
            </div>
          </div>
          {asset.eia_plant_code && onPlantClick && (
            <button
              onClick={() => onPlantClick(asset.eia_plant_code!)}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all"
            >
              View EIA Plant Detail →
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-3 gap-6">
        {/* Left: Details */}
        <div className="col-span-2 space-y-6">
          {/* Core Info */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Project Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Status" value={asset.status} />
              <Field label="Capacity" value={asset.capacity_mw ? `${asset.capacity_mw.toLocaleString()} MW` : null} />
              {asset.storage_mw && <Field label="Storage" value={`${asset.storage_mw} MW`} />}
              <Field label="State" value={asset.state} />
              <Field label="County" value={asset.county} />
              <Field label="Expected COD" value={asset.expected_cod} />
              <Field label="Offtaker" value={asset.offtaker} />
              {asset.lat && asset.lng && <Field label="Coordinates" value={`${asset.lat.toFixed(4)}, ${asset.lng.toFixed(4)}`} />}
            </div>
          </div>

          {/* EIA Link */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">EIA Match</h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="EIA Plant Code" value={asset.eia_plant_code} />
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Match Confidence</div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                  asset.match_confidence === 'high' ? 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30'
                    : asset.match_confidence === 'medium' ? 'bg-amber-900/30 text-amber-400 border-amber-500/30'
                    : asset.match_confidence === 'low' ? 'bg-red-900/30 text-red-400 border-red-500/30'
                    : 'bg-slate-800 text-slate-600 border-slate-700'
                }`}>
                  {asset.match_confidence || 'none'}
                </span>
              </div>
            </div>
          </div>

          {/* Owners */}
          {owners.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Ownership & Stakeholders</h3>
              <div className="space-y-2">
                {owners.map((o, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-slate-800/50">
                    <span className="text-sm text-slate-300 font-semibold">{o.developer_name}</span>
                    <div className="flex items-center gap-3">
                      {o.role && (
                        <span className="text-[10px] uppercase font-bold text-slate-500">{o.role}</span>
                      )}
                      {o.ownership_pct != null && (
                        <span className="text-sm font-mono text-blue-400">{o.ownership_pct}%</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sources */}
          {asset.source_urls && asset.source_urls.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Sources</h3>
              <ul className="space-y-1">
                {asset.source_urls.map((url, i) => (
                  <li key={i}>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-500 hover:underline truncate block">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Right Sidebar: Confidence */}
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Confidence Score</h3>
            <div className={`text-5xl font-black text-center mb-4 ${confidenceColor(asset.confidence_score)}`}>
              {asset.confidence_score != null ? asset.confidence_score.toFixed(0) : '—'}
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden mb-4">
              <div
                className={`h-full rounded-full transition-all ${
                  (asset.confidence_score || 0) >= 85 ? 'bg-emerald-500'
                    : (asset.confidence_score || 0) >= 60 ? 'bg-amber-500'
                    : 'bg-red-500'
                }`}
                style={{ width: `${Math.min(100, asset.confidence_score || 0)}%` }}
              />
            </div>
            {Object.keys(breakdown).length > 0 && (
              <div className="space-y-2">
                {Object.entries(breakdown).map(([key, val]) => (
                  <div key={key} className="flex justify-between text-sm">
                    <span className="text-slate-500 capitalize">{key.replace(/_/g, ' ')}</span>
                    <span className="text-slate-300 font-mono">{typeof val === 'boolean' ? (val ? '✓' : '✗') : String(val)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!asset.graduated && asset.blocking_reason && (
            <div className="bg-amber-900/10 border border-amber-500/20 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-2">Blocking Reason</h3>
              <p className="text-sm text-amber-400/80">{asset.blocking_reason}</p>
              <div className="text-[10px] text-slate-600 mt-2">Staging attempts: {asset.staging_attempts}</div>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-3">Timeline</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Discovered</span>
                <span className="text-slate-400 text-[10px]">{new Date(asset.discovered_at).toLocaleDateString()}</span>
              </div>
              {asset.last_refreshed_at && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Last Refreshed</span>
                  <span className="text-slate-400 text-[10px]">{new Date(asset.last_refreshed_at).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[10px] text-slate-600 mb-1">{label}</div>
      <div className="text-sm text-slate-300 font-medium">{value || <span className="text-slate-700">—</span>}</div>
    </div>
  );
}
