import { describe, expect, it } from 'vitest';

const normalize = (name: string): string => {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bj\s*p\s*morgan(\s+chase)?\b/g, 'jpmorgan')
    .replace(/(?:\s+(llc|lp|inc|incorporated|corp|corporation|co|company|ltd|limited|na|n a|plc|ag|sa|bank|capital|holdings|group|partners|services|financial|usa|us|na branch|new york branch))+$/g, '')
    .trim();
};

describe('normalize_lender_name', () => {
  it('normalizes JP Morgan variants', () => {
    const a = normalize('JPMorgan Chase Bank, N.A.');
    const b = normalize('JP Morgan Capital LLC');
    expect(a).toEqual(b);
  });

  it('normalizes Societe Generale variants', () => {
    const a = normalize('Société Générale, New York Branch');
    const b = normalize('Societe Generale');
    expect(a).toEqual(b);
  });

  it('strips chained corporate suffixes', () => {
    const a = normalize('Citibank, N.A.');
    const b = normalize('Citibank LLC');
    expect(a).toEqual(b);
  });
});
