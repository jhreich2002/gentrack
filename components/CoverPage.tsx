import React, { useState } from 'react';
import AuthModal from './AuthModal';

const CoverPage: React.FC = () => {
  const [showModal, setShowModal] = useState(false);
  const [defaultTab, setDefaultTab] = useState<'signin' | 'signup'>('signin');

  const openSignIn = () => { setDefaultTab('signin'); setShowModal(true); };
  const openSignUp = () => { setDefaultTab('signup'); setShowModal(true); };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col overflow-hidden relative">

      {/* Ambient background glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-blue-600/5 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-indigo-600/5 blur-[120px]" />
        <div className="absolute top-[40%] left-[50%] w-[400px] h-[400px] rounded-full bg-cyan-600/4 blur-[100px]" />
      </div>

      {/* Grid dot pattern overlay */}
      <div className="absolute inset-0 opacity-[0.015] pointer-events-none"
        style={{ backgroundImage: 'radial-gradient(circle, #94a3b8 1px, transparent 1px)', backgroundSize: '32px 32px' }}
      />

      {/* Top nav */}
      <header className="relative z-10 flex items-center justify-between px-8 py-6 border-b border-slate-800/60">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-white font-black text-lg tracking-tight">GENTRACK</span>
          <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest ml-1 hidden sm:block">Power Analytics</span>
        </div>
        <button
          onClick={openSignIn}
          className="px-5 py-2 rounded-xl border border-slate-700 text-slate-300 text-sm font-bold hover:border-slate-500 hover:text-white transition-all"
        >
          Sign In
        </button>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">

        {/* Status badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-bold tracking-wide mb-10">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          LIVE EIA DATA — 1,000+ U.S. POWER PLANTS
        </div>

        {/* Headline */}
        <h1 className="text-5xl sm:text-7xl font-black text-white tracking-tight leading-none mb-6 max-w-4xl">
          U.S. Power Grid<br />
          <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-indigo-400 bg-clip-text text-transparent">
            Analytics Platform
          </span>
        </h1>

        <p className="text-slate-400 text-lg max-w-2xl leading-relaxed mb-12">
          Track capacity factors, identify curtailed assets, and benchmark wind, solar, and nuclear plants against regional peers — all from live EIA generation data.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-4">
          <button
            onClick={openSignUp}
            className="px-8 py-4 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-black text-sm tracking-wide shadow-xl shadow-blue-900/30 transition-all hover:scale-105 active:scale-95"
          >
            Create Free Account
          </button>
          <button
            onClick={openSignIn}
            className="px-8 py-4 rounded-2xl border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white font-bold text-sm transition-all"
          >
            Sign In
          </button>
        </div>

        {/* Decorative stat strip */}
        <div className="mt-20 grid grid-cols-3 sm:grid-cols-3 gap-px bg-slate-800/60 rounded-2xl overflow-hidden border border-slate-800 max-w-2xl w-full">
          {[
            { value: '1,000+', label: 'Active Plants Tracked' },
            { value: '12 Regions', label: 'ISO / RTO Coverage' },
            { value: 'Monthly', label: 'EIA Data Refresh' },
          ].map((stat, i) => (
            <div key={i} className="bg-slate-900/80 px-6 py-5 text-center">
              <div className="text-xl font-black text-white">{stat.value}</div>
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">{stat.label}</div>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 text-center py-6 text-[11px] text-slate-700 font-medium border-t border-slate-800/40">
        Data sourced from U.S. Energy Information Administration (EIA) Form 923 &amp; 860
      </footer>

      {/* Auth Modal */}
      {showModal && (
        <AuthModal
          defaultTab={defaultTab}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
};

export default CoverPage;
