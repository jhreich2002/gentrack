import React from 'react';

export interface LenderEvidenceRow {
  lenderName: string;
  role: string | null;
  roleSummary: string | null;
  sourceUrl: string;
  evidenceQuote: string | null;
  inferred: boolean;
  inferredFromSiblingPlantId?: string | null;
}

interface Props {
  rows: LenderEvidenceRow[];
  loading?: boolean;
  emptyMessage?: string;
}

const LenderEvidenceTable: React.FC<Props> = ({ rows, loading = false, emptyMessage = 'No lender evidence found for this plant.' }) => {
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.lenderName}-${row.sourceUrl}-${idx}`} className="border-b border-slate-800/30 last:border-b-0 hover:bg-slate-800/30 transition-colors align-top">
              <td className="px-5 py-3 text-slate-200 font-semibold">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{row.lenderName}</span>
                  {row.inferred && (
                    <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-amber-500/30 bg-amber-900/20 text-amber-400 tracking-wider">
                      inferred from sibling
                    </span>
                  )}
                </div>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default LenderEvidenceTable;
