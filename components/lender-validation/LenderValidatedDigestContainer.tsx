import React, { useEffect, useState, type ReactNode } from 'react';
import { fetchLenderValidatedDigest } from '../../services/lenderDigestService';
import LenderValidatedDigestView from './LenderValidatedDigestView';
import type { LenderValidatedDigest, DigestPlantRow } from '../../types';

// Error boundary so a render error in the digest view surfaces a visible card
// instead of whitescreening the page (React 18 unmounts subtree on uncaught throw).
interface DigestErrorBoundaryProps {
  onBack: () => void;
  children: ReactNode;
}
interface DigestErrorBoundaryState {
  error: Error | null;
}
class DigestErrorBoundary extends React.Component<DigestErrorBoundaryProps, DigestErrorBoundaryState> {
  constructor(props: DigestErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): DigestErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[LenderValidatedDigest] render error:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bg-slate-900 border border-red-800/40 rounded-xl p-8 text-center">
          <p className="text-red-400 text-sm mb-2">Digest view crashed</p>
          <p className="text-slate-500 text-xs font-mono whitespace-pre-wrap break-words max-w-2xl mx-auto">
            {this.state.error.message}
          </p>
          <button
            onClick={this.props.onBack}
            className="mt-4 text-xs text-blue-400 hover:text-blue-300"
          >
            ← Back to lenders
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  lenderId: string;
  onPlantClick: (plantId: string, eiaCode: string) => void;
  onBack: () => void;
  onViewEvidence?: () => void;
  canWrite?: boolean;
  onPursuitChange?: (lenderId: string, label: 'hot' | 'warm' | 'cold' | null) => void;
  /** Called once the lender name is resolved from the digest, so parent can update breadcrumb */
  onNameResolved?: (name: string) => void;
}

const LenderValidatedDigestContainer: React.FC<Props> = ({
  lenderId,
  onPlantClick,
  onBack,
  onViewEvidence,
  canWrite,
  onPursuitChange,
  onNameResolved,
}) => {
  const [digest, setDigest] = useState<LenderValidatedDigest | null>(null);
  const [plants, setPlants] = useState<DigestPlantRow[]>([]);
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchLenderValidatedDigest(lenderId)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setDigest(result.digest);
          setPlants(result.plants);
          setArticles(result.articles);
          onNameResolved?.(result.digest.lenderName);
        } else {
          setDigest(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load digest');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [lenderId]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 gap-3 text-slate-400">
        <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
        <span className="text-sm">Loading digest…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-slate-900 border border-red-800/40 rounded-xl p-8 text-center">
        <p className="text-red-400 text-sm mb-2">Failed to load digest</p>
        <p className="text-slate-500 text-xs">{error}</p>
        <button
          onClick={onBack}
          className="mt-4 text-xs text-blue-400 hover:text-blue-300"
        >
          ← Back to lenders
        </button>
      </div>
    );
  }

  if (!digest) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-10 text-center max-w-lg mx-auto">
        <div className="text-3xl mb-4">📊</div>
        <h3 className="text-slate-200 font-semibold text-base mb-2">No Digest Yet</h3>
        <p className="text-slate-500 text-sm leading-relaxed">
          No engagement digest has been generated for this lender.
          Ask an admin to generate one from the{' '}
          <span className="text-slate-300 font-medium">Admin → Validated Lender Digests</span>{' '}
          panel.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
          <button
            onClick={onBack}
            className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 text-sm transition-colors"
          >
            ← Back to lenders
          </button>
          {onViewEvidence && (
            <button
              onClick={onViewEvidence}
              className="px-4 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 text-sm transition-colors"
            >
              View raw evidence
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <DigestErrorBoundary onBack={onBack}>
      <LenderValidatedDigestView
        digest={digest}
        plants={plants}
        articles={articles}
        onPlantClick={onPlantClick}
        onBack={onBack}
        onViewEvidence={onViewEvidence}
        canWrite={canWrite}
        onPursuitChange={onPursuitChange}
      />
    </DigestErrorBoundary>
  );
};

export default LenderValidatedDigestContainer;
