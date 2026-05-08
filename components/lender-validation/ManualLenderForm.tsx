import React, { useState, useEffect, useRef } from 'react';
import {
  searchLenderEntities,
  addManualLenderLink,
  LenderEntitySuggestion,
} from '../../services/lenderValidationService';

interface Props {
  plantCode: string;
  plantName?: string | null;
  onSuccess: (linkId: number, lenderName: string) => void;
  onCancel: () => void;
}

const FACILITY_OPTIONS = [
  '',
  'term_loan',
  'revolver',
  'letter_of_credit',
  'bond',
  'tax_equity',
  'construction_loan',
  'bridge_loan',
  'mezzanine',
  'preferred_equity',
  'other',
];

const NOTE_MIN = 20;

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const ManualLenderForm: React.FC<Props> = ({ plantCode, plantName, onSuccess, onCancel }) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [facility, setFacility] = useState('');
  const [suggestions, setSuggestions] = useState<LenderEntitySuggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!name || name.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const s = await searchLenderEntities(name.trim());
      setSuggestions(s);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [name]);

  const urlOk  = isValidUrl(url);
  const noteOk = note.trim().length >= NOTE_MIN;
  const nameOk = name.trim().length > 0;
  const formOk = urlOk && noteOk && nameOk && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formOk) return;
    setSubmitting(true);
    setError(null);
    const res = await addManualLenderLink({
      plantCode,
      lenderName:    name.trim(),
      sourceUrl:     url.trim(),
      note:          note.trim(),
      facilityType:  facility || undefined,
    });
    setSubmitting(false);
    if (!res.success || !res.linkId) {
      setError(res.error ?? 'Failed to save manual link');
      return;
    }
    onSuccess(res.linkId, name.trim());
  }

  return (
    <form onSubmit={handleSubmit} className="bg-slate-900 border border-violet-700/40 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-violet-300">
          Manual lender entry
          {plantName && <span className="text-slate-400 font-normal"> · {plantName}</span>}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Cancel
        </button>
      </div>

      {/* Lender name with autocomplete */}
      <div className="relative">
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Lender name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setShowSuggest(true); }}
          onFocus={() => setShowSuggest(true)}
          onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          placeholder="e.g. JPMorgan Chase Bank, N.A."
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-violet-500"
        />
        {showSuggest && suggestions.length > 0 && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded shadow-lg max-h-48 overflow-y-auto">
            {suggestions.map(s => (
              <button
                key={s.id}
                type="button"
                onMouseDown={() => { setName(s.entityName); setShowSuggest(false); }}
                className="block w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
              >
                <div className="truncate">{s.entityName}</div>
                <div className="text-[10px] text-slate-500 truncate">{s.normalizedName}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Source URL */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Source URL <span className="text-red-400">*</span>
          <span className="text-slate-500 font-normal"> · article, filing, or PDF link</span>
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className={`w-full bg-slate-800 border rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none ${
            url && !urlOk ? 'border-red-500/60 focus:border-red-500' : 'border-slate-700 focus:border-violet-500'
          }`}
        />
        {url && !urlOk && (
          <p className="text-[11px] text-red-400 mt-1">Must be a valid http(s) URL.</p>
        )}
      </div>

      {/* Justification note */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Justification note <span className="text-red-400">*</span>
          <span className="text-slate-500 font-normal"> · {NOTE_MIN}+ characters</span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="What does the source say? Why is this the lender for this plant?"
          className={`w-full bg-slate-800 border rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none ${
            note && !noteOk ? 'border-red-500/60 focus:border-red-500' : 'border-slate-700 focus:border-violet-500'
          }`}
        />
        <div className="flex justify-between text-[10px] mt-0.5">
          <span className={noteOk ? 'text-emerald-400' : 'text-slate-500'}>
            {note.trim().length} / {NOTE_MIN}
          </span>
        </div>
      </div>

      {/* Facility type (optional) */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Facility type <span className="text-slate-500 font-normal">· optional</span>
        </label>
        <select
          value={facility}
          onChange={(e) => setFacility(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-violet-500"
        >
          {FACILITY_OPTIONS.map(o => (
            <option key={o} value={o}>{o || '— none —'}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!formOk}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-violet-600 hover:bg-violet-500 text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
        >
          {submitting ? 'Saving…' : 'Save manual link'}
        </button>
      </div>
    </form>
  );
};

export default ManualLenderForm;
