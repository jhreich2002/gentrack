// components/lender-validation/LenderChatPanel.tsx
// Phase 6: chat panel for the lender RAG copilot.
//
// Mounts inside Plant detail (scope='plant'), Validated lender drawer
// (scope='lender'), or as a global widget (scope='global').
import React, { useState } from 'react';
import {
  askLenderChat,
  type LenderChatScope,
  type LenderChatResponse,
} from '../../services/lenderChatService';

interface Props {
  scope:              LenderChatScope;
  plantCode?:         string;
  lenderNormalized?:  string;
  contextLabel?:      string; // e.g. "Solana Generating Station (56812)"
}

const SUGGESTIONS: Record<LenderChatScope, string[]> = {
  plant: [
    'Who provided debt financing for this plant?',
    'Is there evidence of a tax equity investor?',
    'Has the project been refinanced?',
  ],
  lender: [
    'Which plants is this lender associated with?',
    'What roles does this lender play (debt vs tax equity)?',
    'When was the most recent financing event involving this lender?',
  ],
  global: [
    'Which lenders appear most often in financing news this quarter?',
    'Has Citigroup been named on any new project finance deals?',
  ],
};

const LenderChatPanel: React.FC<Props> = ({
  scope, plantCode, lenderNormalized, contextLabel,
}) => {
  const [question, setQuestion] = useState('');
  const [loading, setLoading]   = useState(false);
  const [resp, setResp]         = useState<LenderChatResponse | null>(null);
  const [err, setErr]           = useState<string | null>(null);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setLoading(true);
    setErr(null);
    setResp(null);
    const r = await askLenderChat({
      scope,
      plant_code:        plantCode,
      lender_normalized: lenderNormalized,
      question:          text,
    });
    setLoading(false);
    if (!r) setErr('Request failed. Check console for details.');
    else setResp(r);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">
          Ask the lender copilot
          {contextLabel && <span className="ml-2 text-sm text-slate-400">— {contextLabel}</span>}
        </h3>
        <span className="text-xs uppercase tracking-wide text-slate-500">{scope}</span>
      </div>

      <div className="flex gap-2 flex-wrap mb-3">
        {SUGGESTIONS[scope].map(s => (
          <button
            key={s}
            type="button"
            onClick={() => { setQuestion(s); ask(s); }}
            disabled={loading}
            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      <form
        onSubmit={e => { e.preventDefault(); ask(question); }}
        className="flex gap-2 mb-4"
      >
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask about lenders, roles, financing events…"
          maxLength={1000}
          className="flex-1 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {err && <div className="text-sm text-rose-400 mb-2">{err}</div>}

      {resp && (
        <div className="space-y-4">
          <div className="bg-slate-950 border border-slate-800 rounded p-3 text-sm text-slate-200 whitespace-pre-wrap">
            {resp.answer}
          </div>

          {resp.citations.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Citations</h4>
              <ul className="space-y-2">
                {resp.citations.map(c => (
                  <li key={c.chunk_id} className="text-xs border border-slate-800 rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-indigo-400">[{c.index}]</span>
                      <span className="uppercase text-slate-500">{c.source_type}</span>
                      {c.published_at && (
                        <span className="text-slate-500">
                          {new Date(c.published_at).toISOString().slice(0, 10)}
                        </span>
                      )}
                      <span className="text-slate-600">sim {c.similarity.toFixed(3)}</span>
                    </div>
                    {c.title && <div className="text-slate-300 mb-1">{c.title}</div>}
                    <div className="text-slate-400">{c.snippet}{c.snippet.length >= 240 ? '…' : ''}</div>
                    {c.url && (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:underline"
                      >
                        Source ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(resp.structured.validated.length > 0 || resp.structured.pending.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <h4 className="text-xs uppercase tracking-wide text-emerald-400 mb-2">
                  Validated ({resp.structured.validated.length})
                </h4>
                <ul className="space-y-1 text-xs text-slate-300">
                  {resp.structured.validated.slice(0, 10).map((v, i) => (
                    <li key={i}>{v.lender_name} → {v.plant_code} <span className="text-slate-500">({v.evidence_type})</span></li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="text-xs uppercase tracking-wide text-amber-400 mb-2">
                  Pending review ({resp.structured.pending.length})
                </h4>
                <ul className="space-y-1 text-xs text-slate-300">
                  {resp.structured.pending.slice(0, 10).map((p, i) => (
                    <li key={i}>{p.lender_name} → {p.plant_code} <span className="text-slate-500">({p.confidence_class})</span></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LenderChatPanel;
