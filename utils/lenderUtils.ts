/**
 * GenTrack — lenderUtils
 *
 * Shared constants and helpers for lender-related UI components.
 * Used by LenderPursuitsDashboard and EntityDetailView.
 */

import React from 'react';
import { LoanStatus } from '../types';

// ── Pitch angle labels & colors ───────────────────────────────────────────────

export const PITCH_ANGLE_LABEL: Record<string, string> = {
  interconnection_advisory: 'Interconnection Advisory',
  asset_management:         'Asset Management',
  merchant_risk:            'Merchant Risk',
  refinancing_advisory:     'Refinancing Advisory',
  general_exposure:         'General Exposure',
};

export const PITCH_ANGLE_COLOR: Record<string, string> = {
  interconnection_advisory: 'bg-blue-900/30 border-blue-700/50 text-blue-400',
  asset_management:         'bg-purple-900/30 border-purple-700/50 text-purple-400',
  merchant_risk:            'bg-red-900/30 border-red-700/50 text-red-400',
  refinancing_advisory:     'bg-amber-900/30 border-amber-700/50 text-amber-400',
  general_exposure:         'bg-slate-800 border-slate-700 text-slate-400',
};

// ── Facility type abbreviations ───────────────────────────────────────────────

export const FACILITY_ABBR: Record<string, string> = {
  term_loan:        'TL',
  construction_loan:'CL',
  tax_equity:       'TE',
  revolving_credit: 'RC',
  bridge_loan:      'BL',
  letter_of_credit: 'LC',
  other:            'OT',
};

// ── Loan status badge ─────────────────────────────────────────────────────────

export function loanStatusBadge(status: LoanStatus | null | undefined): React.ReactNode {
  if (!status || status === 'unknown') return React.createElement(
    'span',
    { className: 'text-[9px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono', title: 'Loan status unknown' },
    '?'
  );
  if (status === 'active') return React.createElement(
    'span',
    { className: 'text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 font-mono font-bold', title: 'Active loan' },
    'LIVE'
  );
  if (status === 'matured') return React.createElement(
    'span',
    { className: 'text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-700 text-slate-500 font-mono line-through', title: 'Loan matured' },
    'MATURED'
  );
  if (status === 'refinanced') return React.createElement(
    'span',
    { className: 'text-[9px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-400 font-mono', title: 'Refinanced' },
    'REFI'
  );
  return null;
}

// ── Score color helpers ───────────────────────────────────────────────────────

export function scoreColor(s: number): string {
  if (s >= 70) return 'text-red-400';
  if (s >= 40) return 'text-amber-400';
  return 'text-slate-400';
}

export function scoreBarColor(s: number): string {
  if (s >= 70) return 'bg-red-500';
  if (s >= 40) return 'bg-amber-500';
  return 'bg-slate-500';
}

// ── USD formatter ─────────────────────────────────────────────────────────────

export function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}
