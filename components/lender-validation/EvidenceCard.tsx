import React from 'react';
import {
  PlantEvidenceRow,
  EvidenceType,
  ConfidenceClass,
} from '../../services/lenderValidationService';

const EVIDENCE_LABELS: Record<EvidenceType, string> = {
  edgar_loan:      'SEC EDGAR (loan)',
  edgar:           'SEC EDGAR',
  direct_filing:   'UCC State Filing',
  county_record:   'County Recorder',
  sponsor_pattern: 'Sponsor Pattern',
  supplement:      'Supplement',
  manual:          'Manual Entry',
  inferred:        'Inferred',
  llm_inference:   'LLM Inference',
  web_scrape:      'Web Scrape',
  news:            'News',
  news_article:    'News Article',
  doe_lpo:         'DOE LPO',
  ferc:            'FERC',
};

const EVIDENCE_COLORS: Record<EvidenceType, string> = {
  edgar_loan:      'bg-blue-900/30 text-blue-300 border-blue-700/40',
  edgar:           'bg-blue-900/30 text-blue-300 border-blue-700/40',
  direct_filing:   'bg-emerald-900/30 text-emerald-300 border-emerald-700/40',
  county_record:   'bg-emerald-900/30 text-emerald-300 border-emerald-700/40',
  sponsor_pattern: 'bg-amber-900/30 text-amber-300 border-amber-700/40',
  supplement:      'bg-slate-700/30 text-slate-400 border-slate-600/40',
  manual:          'bg-violet-900/30 text-violet-300 border-violet-700/40',
  inferred:        'bg-slate-700/30 text-slate-400 border-slate-600/40',
  llm_inference:   'bg-purple-900/30 text-purple-300 border-purple-700/40',
  web_scrape:      'bg-slate-700/30 text-slate-400 border-slate-600/40',
  news:            'bg-cyan-900/30 text-cyan-300 border-cyan-700/40',
  news_article:    'bg-cyan-900/30 text-cyan-300 border-cyan-700/40',
  doe_lpo:         'bg-indigo-900/30 text-indigo-300 border-indigo-700/40',
  ferc:            'bg-indigo-900/30 text-indigo-300 border-indigo-700/40',
};

const CONF_COLORS: Record<ConfidenceClass, string> = {
  confirmed:       'text-emerald-300',
  high_confidence: 'text-emerald-400',
  highly_likely:   'text-amber-300',
  possible:        'text-slate-400',
};

function safeHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

interface Props {
  evidence: PlantEvidenceRow;
  plantCode?: string;
}

const EvidenceCard: React.FC<Props> = ({ evidence, plantCode }) => {
  const ev = evidence;
  const host = safeHostname(ev.sourceUrl);
  const fallbackQuery = [ev.lenderName, plantCode, 'project finance loan'].filter(Boolean).join(' ');
  const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(fallbackQuery)}`;
  return (
    <div className={`border rounded-lg p-3 ${EVIDENCE_COLORS[ev.evidenceType] ?? 'bg-slate-800/30 border-slate-700/30'}`}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wide ${EVIDENCE_COLORS[ev.evidenceType] ?? ''}`}>
          {EVIDENCE_LABELS[ev.evidenceType] ?? ev.evidenceType}
        </span>
        <span className={`text-[10px] font-medium uppercase tracking-wide ${CONF_COLORS[ev.confidenceClass] ?? 'text-slate-400'}`}>
          {ev.confidenceClass.replace(/_/g, ' ')}
        </span>
      </div>

      {ev.evidenceSummary && (
        <p className="text-sm text-slate-200 leading-snug whitespace-pre-wrap mb-2">
          {ev.evidenceSummary}
        </p>
      )}

      {ev.sourceUrl ? (
        <a
          href={ev.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 hover:underline break-all inline-flex items-center gap-1"
        >
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          <span>{host ?? ev.sourceUrl}</span>
        </a>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 italic">No source URL recorded</span>
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-amber-300 hover:text-amber-200 underline"
            title="Search public sources for this lender + plant"
          >
            Find source
          </a>
        </div>
      )}

      {ev.leadStatus !== 'pending' && (
        <div className="mt-2 text-[10px] text-slate-500 uppercase tracking-wide">
          status: {ev.leadStatus}
        </div>
      )}
    </div>
  );
};

export default EvidenceCard;
