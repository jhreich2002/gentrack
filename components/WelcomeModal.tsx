import React from 'react';

interface Props {
  onSelect: (destination: 'lenders' | 'taxequity' | 'pursuits') => void;
}

const OPTIONS = [
  {
    key: 'lenders' as const,
    label: 'Lender Pursuits',
    description: 'Track active financing and debt-close activity across curtailed plants.',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 10h18M3 14h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
      </svg>
    ),
    accent: 'blue',
    border: 'border-blue-500/30 hover:border-blue-400/60',
    bg: 'hover:bg-blue-500/5',
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
    badge: 'bg-blue-500/15 text-blue-400',
  },
  {
    key: 'taxequity' as const,
    label: 'Tax Equity Pursuits',
    description: 'Monitor tax equity commitments and investor activity for renewable assets.',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    accent: 'emerald',
    border: 'border-emerald-500/30 hover:border-emerald-400/60',
    bg: 'hover:bg-emerald-500/5',
    iconBg: 'bg-emerald-500/10',
    iconColor: 'text-emerald-400',
    badge: 'bg-emerald-500/15 text-emerald-400',
  },
  {
    key: 'pursuits' as const,
    label: 'Plant Pursuits',
    description: 'Explore curtailed plants ranked by opportunity, news signal, and financing status.',
    icon: (
      <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    accent: 'violet',
    border: 'border-violet-500/30 hover:border-violet-400/60',
    bg: 'hover:bg-violet-500/5',
    iconBg: 'bg-violet-500/10',
    iconColor: 'text-violet-400',
    badge: 'bg-violet-500/15 text-violet-400',
  },
];

const WelcomeModal: React.FC<Props> = ({ onSelect }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-slate-800">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.25em] mb-2">Welcome to GenTrack</div>
          <h2 className="text-2xl font-black text-white">Where would you like to start?</h2>
          <p className="text-sm text-slate-500 mt-1">Select a pipeline to begin your session.</p>
        </div>

        {/* Options */}
        <div className="p-6 flex flex-col gap-3">
          {OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onSelect(opt.key)}
              className={`w-full flex items-center gap-5 p-5 rounded-xl border ${opt.border} ${opt.bg} bg-slate-900/40 transition-all duration-150 text-left group`}
            >
              <div className={`flex-shrink-0 w-12 h-12 rounded-xl ${opt.iconBg} flex items-center justify-center ${opt.iconColor}`}>
                {opt.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-white mb-0.5">{opt.label}</div>
                <div className="text-xs text-slate-500 leading-relaxed">{opt.description}</div>
              </div>
              <svg className="w-4 h-4 text-slate-600 group-hover:text-slate-400 flex-shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WelcomeModal;
