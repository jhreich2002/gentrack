import React from 'react';
import { UCCEvidenceRecord } from '../services/uccResearchService';

interface Props {
  lenderName: string;
  evidence:   UCCEvidenceRecord[];
  onClose:    () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ucc_scrape:     'UCC State Filing',
  county_scrape:  'County Recorder',
  edgar:          'SEC EDGAR',
  sponsor_history:'Sponsor History Pattern',
  web_scrape:     'Sponsor Portfolio Page',
  perplexity:     'Trade Press Search',
  gemini:         'Gemini AI',
};

const SOURCE_COLORS: Record<string, string> = {
  ucc_scrape:     'bg-emerald-900/30 text-emerald-400 border-emerald-700/30',
  county_scrape:  'bg-emerald-900/30 text-emerald-400 border-emerald-700/30',
  edgar:          'bg-blue-900/30 text-blue-400 border-blue-700/30',
  sponsor_history:'bg-amber-900/30 text-amber-400 border-amber-700/30',
  web_scrape:     'bg-slate-700/30 text-slate-400 border-slate-600/30',
  perplexity:     'bg-purple-900/30 text-purple-400 border-purple-700/30',
  gemini:         'bg-violet-900/30 text-violet-400 border-violet-700/30',
};

const CONF_COLORS: Record<string, string> = {
  confirmed:     'text-emerald-400',
  highly_likely: 'text-amber-400',
  possible:      'text-slate-400',
};

const UCCEvidenceDrawer: React.FC<Props> = ({ lenderName, evidence, onClose }) => {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-[520px] max-w-[90vw] bg-slate-900 border-l border-slate-700 z-50 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between flex-shrink-0">
          <div>
            <h3 className="font-bold text-white text-base">{lenderName}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {evidence.length} evidence record{evidence.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Evidence list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {evidence.length === 0 ? (
            <div className="text-center text-slate-500 py-12 text-sm">No evidence records found.</div>
          ) : (
            evidence.map(ev => (
              <div key={ev.id} className={`border rounded-xl p-4 ${SOURCE_COLORS[ev.source_type] ?? 'bg-slate-800/30 border-slate-700/30'}`}>
                {/* Source type + worker */}
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${SOURCE_COLORS[ev.source_type] ?? ''}`}>
                    {SOURCE_LABELS[ev.source_type] ?? ev.source_type}
                  </span>
                  <span className={`text-xs font-medium ${CONF_COLORS[ev.confidence_contribution] ?? 'text-slate-400'}`}>
                    {ev.confidence_contribution?.replace(/_/g, ' ')}
                  </span>
                </div>

                {/* Excerpt */}
                <p className="text-sm text-slate-200 leading-relaxed">{ev.excerpt}</p>

                {/* Extracted fields */}
                {ev.extracted_fields && Object.keys(ev.extracted_fields).length > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    {Object.entries(ev.extracted_fields)
                      .filter(([, v]) => v != null && v !== '')
                      .slice(0, 6)
                      .map(([key, value]) => (
                        <div key={key} className="text-xs">
                          <span className="text-slate-500">{key.replace(/_/g, ' ')}: </span>
                          <span className="text-slate-300">{String(value)}</span>
                        </div>
                      ))}
                  </div>
                )}

                {/* Source URL */}
                {ev.source_url && (
                  <a
                    href={ev.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    <span className="truncate">{ev.source_url}</span>
                  </a>
                )}

                {/* Worker + review status */}
                <div className="mt-2 flex items-center justify-between text-xs text-slate-600">
                  <span>{ev.worker_name?.replace(/_/g, ' ')}</span>
                  {ev.lender_name && ev.lender_name !== lenderName && (
                    <span className="text-slate-500">via {ev.lender_name}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
};

export default UCCEvidenceDrawer;
