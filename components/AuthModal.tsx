import React, { useState } from 'react';
import { signIn, signUp } from '../services/authService';

interface Props {
  defaultTab?: 'signin' | 'signup';
  onClose: () => void;
}

const AuthModal: React.FC<Props> = ({ defaultTab = 'signin', onClose }) => {
  const [tab, setTab] = useState<'signin' | 'signup'>(defaultTab);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const reset = () => { setError(null); setSuccessMsg(null); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();

    if (tab === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      if (tab === 'signup') {
        await signUp(email, password);
        setSuccessMsg('Account created! Check your email to confirm, then sign in.');
        setTab('signin');
        setPassword('');
        setConfirmPassword('');
      } else {
        await signIn(email, password);
        onClose();
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="flex items-center justify-between px-8 pt-8 pb-6 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              <span className="text-xs font-black text-slate-500 uppercase tracking-widest">GENTRACK</span>
            </div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              {tab === 'signin' ? 'Welcome back' : 'Create account'}
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              {tab === 'signin'
                ? 'Sign in to access your watchlist and analytics.'
                : 'Get free access to U.S. power plant analytics.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-2 bg-slate-800/50 mx-8 mt-6 rounded-xl">
          {(['signin', 'signup'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); reset(); }}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                tab === t
                  ? 'bg-slate-700 text-white shadow'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-8 py-6 space-y-4">
          {successMsg && (
            <div className="bg-green-900/20 border border-green-500/30 text-green-400 text-xs font-medium px-4 py-3 rounded-xl">
              {successMsg}
            </div>
          )}
          {error && (
            <div className="bg-red-900/20 border border-red-500/30 text-red-400 text-xs font-medium px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Min. 6 characters"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {tab === 'signup' && (
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">
                Confirm Password
              </label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-black text-sm tracking-wide transition-all flex items-center justify-center gap-2 mt-2"
          >
            {loading && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            {tab === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="px-8 pb-6 text-center text-[11px] text-slate-600">
          {tab === 'signin' ? (
            <>No account?{' '}
              <button className="text-blue-400 hover:text-blue-300 font-bold" onClick={() => { setTab('signup'); reset(); }}>
                Create one free
              </button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button className="text-blue-400 hover:text-blue-300 font-bold" onClick={() => { setTab('signin'); reset(); }}>
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AuthModal;
