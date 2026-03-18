import React from 'react';

interface Props {
  onClose: () => void;
}

const STAGES = [
  {
    step: '01',
    border: 'border-red-500/30',
    bg: 'bg-red-500/10',
    textAccent: 'text-red-400',
    badgeBg: 'bg-red-500/20',
    title: 'Curtailment Detection',
    subtitle: 'EIA Generation Data',
    description:
      'Every plant is benchmarked against its regional ISO/RTO peers using trailing 12-month capacity factor data from the EIA. Plants whose output lags the regional average by a meaningful margin are flagged as likely curtailed and enter the pipeline.',
    tags: ['Capacity Factor', 'Regional Benchmark', 'TTM Average'],
    conditional: null,
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
      </svg>
    ),
  },
  {
    step: '02',
    border: 'border-cyan-500/30',
    bg: 'bg-cyan-500/10',
    textAccent: 'text-cyan-400',
    badgeBg: 'bg-cyan-500/20',
    title: 'Lender & Tax Equity Search',
    subtitle: 'Perplexity AI',
    description:
      'For each curtailed plant, Perplexity is queried to surface financing activity — debt closings, tax equity commitments, loan announcements. Named counterparties (banks, credit facilities, tax equity investors) are extracted and written to the plant\'s financing record.',
    tags: ['Perplexity AI', 'Named Counterparties', 'Debt Close', 'Tax Equity'],
    conditional: null,
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
      </svg>
    ),
  },
  {
    step: '03',
    border: 'border-violet-500/30',
    bg: 'bg-violet-500/10',
    textAccent: 'text-violet-400',
    badgeBg: 'bg-violet-500/20',
    title: 'Perplexity Deep Dive',
    subtitle: 'Conditional — lenders confirmed',
    description:
      'If lenders or tax equity investors are confirmed in step 2, a second targeted Perplexity search is triggered specifically on that plant. This deep dive pulls additional context — operational issues, project history, ownership changes — beyond what the financing search returned.',
    tags: ['Perplexity AI', 'Plant-Specific Query', 'Extended Context'],
    conditional: 'Only runs if lenders were found in Step 02',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
  {
    step: '04',
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/10',
    textAccent: 'text-blue-400',
    badgeBg: 'bg-blue-500/20',
    title: 'News Intelligence Aggregation',
    subtitle: 'RSS + Perplexity Combined',
    description:
      'Google News and Bing News RSS feeds are swept for each plant and merged with the Perplexity results from steps 2 and 3. The full article corpus — RSS and AI-sourced — is fed in batches to Gemini for unified classification across sentiment, event type, importance, and impact tags.',
    tags: ['Google News RSS', 'Bing RSS', 'Gemini Classification', 'Sentiment'],
    conditional: null,
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
      </svg>
    ),
  },
  {
    step: '05',
    border: 'border-amber-500/30',
    bg: 'bg-amber-500/10',
    textAccent: 'text-amber-400',
    badgeBg: 'bg-amber-500/20',
    title: 'Distress Scoring',
    subtitle: 'Signal Synthesis',
    description:
      'Curtailment severity, classified news sentiment, lender confirmation, and article recency are combined into a single distress score per plant. Higher scores surface assets where multiple independent signals — generation data, news coverage, and financing history — all align.',
    tags: ['Distress Score', 'Signal Weight', 'Recency Decay'],
    conditional: null,
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    step: '06',
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/10',
    textAccent: 'text-emerald-400',
    badgeBg: 'bg-emerald-500/20',
    title: 'Pursuit List',
    subtitle: 'Actionable Deal Flow',
    description:
      'Plants that are curtailed and have confirmed lender or tax equity counterparties surface in the Pursuit dashboards, ranked by distress score. These are underwriting-ready targets with corroborated financing histories and multi-source news intelligence backing every signal.',
    tags: ['Plant Pursuits', 'Lender Pursuits', 'Tax Equity Pursuits'],
    conditional: null,
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

const CONNECTORS = [
  'from-red-500/40 to-cyan-500/40',
  'from-cyan-500/40 to-violet-500/40',
  'from-violet-500/40 to-blue-500/40',
  'from-blue-500/40 to-amber-500/40',
  'from-amber-500/40 to-emerald-500/40',
];

const NEXT_ACCENT = ['text-cyan-400', 'text-violet-400', 'text-blue-400', 'text-amber-400', 'text-emerald-400'];

const PipelineTourModal: React.FC<Props> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl shadow-black/70 overflow-hidden my-auto">

        {/* Header */}
        <div className="relative px-8 pt-8 pb-6 border-b border-slate-800 overflow-hidden">
          <div className="absolute -top-10 -right-10 w-48 h-48 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -top-10 left-20 w-32 h-32 bg-emerald-600/10 rounded-full blur-3xl pointer-events-none" />

          <div className="relative flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">GENTRACK INTELLIGENCE</span>
              </div>
              <h2 className="text-2xl font-black text-white tracking-tight leading-tight mb-2">
                How Plants Reach<br />
                <span className="text-emerald-400">the Pursuit List</span>
              </h2>
              <p className="text-sm text-slate-400 max-w-lg leading-relaxed">
                Every plant in the Pursuit dashboards passed through a 6-stage automated pipeline — from raw generation data to confirmed, multi-source financing intelligence.
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-colors flex-shrink-0 mt-1"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Pipeline */}
        <div className="px-8 py-6 space-y-0 max-h-[55vh] overflow-y-auto custom-scrollbar">
          {STAGES.map((stage, i) => (
            <div key={stage.step}>
              <div className={`rounded-xl border ${stage.border} ${stage.bg} p-4 flex gap-4`}>
                {/* Icon + step number */}
                <div className="flex flex-col items-center gap-1 flex-shrink-0">
                  <div className={`w-10 h-10 rounded-xl border ${stage.border} ${stage.bg} flex items-center justify-center`}>
                    <span className={stage.textAccent}>{stage.icon}</span>
                  </div>
                  <span className={`text-[9px] font-black tracking-widest ${stage.textAccent} opacity-60`}>{stage.step}</span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <h3 className="text-sm font-black text-white">{stage.title}</h3>
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${stage.badgeBg} ${stage.textAccent}`}>
                      {stage.subtitle}
                    </span>
                  </div>

                  {/* Conditional badge */}
                  {stage.conditional && (
                    <div className={`inline-flex items-center gap-1.5 mb-2 px-2 py-1 rounded-lg border ${stage.border} ${stage.bg}`}>
                      <svg className={`w-3 h-3 ${stage.textAccent}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className={`text-[9px] font-bold ${stage.textAccent}`}>{stage.conditional}</span>
                    </div>
                  )}

                  <p className="text-xs text-slate-400 leading-relaxed mb-2">{stage.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {stage.tags.map(tag => (
                      <span key={tag} className={`text-[9px] font-bold px-2 py-0.5 rounded border ${stage.border} ${stage.textAccent} bg-slate-900/60`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Connector arrow */}
              {i < STAGES.length - 1 && (
                <div className="flex flex-col items-center py-0.5">
                  <div className={`w-px h-4 bg-gradient-to-b ${CONNECTORS[i]}`} />
                  <svg className={`w-3 h-3 ${NEXT_ACCENT[i]} opacity-50`} fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 16l-6-6h12l-6 6z" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-8 pb-8 pt-4">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3 mb-4 flex items-start gap-3">
            <svg className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs text-slate-400 leading-relaxed">
              <span className="font-bold text-slate-300">What this means for you: </span>
              Plants in the Pursuit list aren't flagged on generation data alone — they have Perplexity-confirmed financing counterparties, a targeted deep dive, and aggregated multi-source news all feeding into their distress score.
            </p>
          </div>

          <button
            onClick={onClose}
            className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-sm tracking-wide transition-all flex items-center justify-center gap-2"
          >
            Start Exploring
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PipelineTourModal;
