import React, { useState } from 'react';

export interface LenderEvidenceRow {
  lenderName: string;
  role: string | null;
  roleSummary: string | null;
  sourceUrl: string;
  evidenceQuote: string | null;
  inferred: boolean;
  inferredFromSiblingPlantId?: string | null;
  linkId?: string;
  isManual?: boolean;
  manualNote?: string | null;
  validationState?: 'pending' | 'validated' | 'rejected';
}

interface Actions {
  onValidate: (linkId: string) => void;
  onReject: (linkId: string, reason: string | null) => void;
}

interface Props {
  rows: LenderEvidenceRow[];
  loading?: boolean;
  emptyMessage?: string;
  actions?: Actions;
}

const ValidationBadge: React.FC<{ state: 'validated' | 'rejected' }> = ({ state }) => {
  if (state === 'validated') {
    return (
      <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-900/20 text-emerald-400 tracking-wider">
        Validated
      </span>
    );
  }
  return (
    <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-rose-500/40 bg-rose-900/20 text-rose-400 tracking-wider">
      Rejected
    </span>
  );
};

const ActionCell: React.FC<{ row: LenderEvidenceRow; actions: Actions }> = ({ row, actions }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  if (!row.linkId) return <td className="px-4 py-3" />;

  const state = row.validationState ?? 'pending';

  if (state !== 'pending') {
    return (
      <td className="px-4 py-3">
        <ValidationBadge state={state} />
      </td>
    );
  }

  if (rejecting) {
    return (
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-44 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
          />
          <div className="flex gap-1">
            <button
              onClick={() => { actions.onReject(row.linkId!, reason.trim() || null); setRejecting(false); setReason(''); }}
              className="text-[10px] px-2 py-0.5 rounded bg-rose-800 hover:bg-rose-700 text-rose-100 font-semibold"
            >
              Confirm
            </button>
            <button
              onClick={() => { setRejecting(false); setReason(''); }}
              className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </td>
    );
  }

  return (
    <td className="px-4 py-3">
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => actions.onValidate(row.linkId!)}
          className="text-[10px] px-2.5 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100 font-semibold transition-colors"
        >
          Validate
        </button>
        <button
          onClick={() => setRejecting(true)}
          className="text-[10px] px-2.5 py-1 rounded bg-rose-900 hover:bg-rose-800 text-rose-200 font-semibold transition-colors"
        >
          Mark wrong
        </button>
      </div>
    </td>
  );
};

const LenderEvidenceTable: React.FC<Props> = ({ rows, loading = false, emptyMessage = 'No lender evidence found for this plant.', actions }) => {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-slate-400">
        <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500"></div>
        <span className="text-sm font-medium">Loading lender evidence...</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
        <p className="text-slate-500 text-sm font-semibold">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800/60 bg-slate-900/70">
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Lender</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Role</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Summary</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Source</th>
            {actions && <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-4 py-2.5">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.lenderName}-${row.sourceUrl}-${idx}`} className="border-b border-slate-800/30 last:border-b-0 hover:bg-slate-800/30 transition-colors align-top">
              <td className="px-5 py-3 text-slate-200 font-semibold">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{row.lenderName}</span>
                  {row.isManual && (
                    <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-blue-500/30 bg-blue-900/20 text-blue-400 tracking-wider">
                      Manual
                    </span>
                  )}
                  {row.inferred && (
                    <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-amber-500/30 bg-amber-900/20 text-amber-400 tracking-wider">
                      inferred from sibling
                    </span>
                  )}
                </div>
                {row.manualNote && (
                  <div className="text-[10px] text-slate-500 mt-0.5 font-normal">{row.manualNote}</div>
                )}
              </td>
              <td className="px-5 py-3 text-slate-300 text-xs">{row.role ?? 'N/A'}</td>
              <td className="px-5 py-3 text-slate-300 text-xs leading-relaxed">
                {row.roleSummary ?? 'N/A'}
                {row.evidenceQuote && (
                  <div className="text-[10px] text-slate-500 mt-1">"{row.evidenceQuote}"</div>
                )}
              </td>
              <td className="px-5 py-3 text-xs">
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                >
                  View source
                </a>
              </td>
              {actions && <ActionCell row={row} actions={actions} />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default LenderEvidenceTable;
