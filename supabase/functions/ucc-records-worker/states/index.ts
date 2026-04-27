/**
 * State UCC portal adapter registry.
 * Each adapter takes a debtor name string and returns structured filing records.
 * States without a working portal return null and trigger Perplexity fallback.
 */

export interface UccFilingRecord {
  filing_number:           string;
  filing_type:             string;
  filing_date:             string | null;
  amendment_date:          string | null;
  termination_date:        string | null;
  debtor_name:             string;
  secured_party_name:      string;
  is_representative_party: boolean;
  representative_role:     string | null;
  collateral_text:         string | null;
  source_url:              string;
  raw_text:                string;
}

export interface StateAdapter {
  state:   string;
  search:  (debtorName: string) => Promise<UccFilingRecord[]>;
  enabled: boolean;
}

// ── Helpers shared across adapters ────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'GenTrack-LenderResearch/1.0 (compliance@example.com)',
  'Accept':     'text/html,application/json,*/*',
};

const TIMEOUT_MS = 12_000;

function detectRepresentativeRole(name: string): { is_rep: boolean; role: string | null } {
  const lower = name.toLowerCase();
  if (lower.includes('collateral agent'))     return { is_rep: true, role: 'collateral_agent' };
  if (lower.includes('administrative agent')) return { is_rep: true, role: 'administrative_agent' };
  if (lower.includes('trustee'))              return { is_rep: true, role: 'trustee' };
  if (lower.includes('indenture trustee'))    return { is_rep: true, role: 'trustee' };
  if (lower.includes(', as agent'))           return { is_rep: true, role: 'administrative_agent' };
  if (lower.includes(' as collateral'))       return { is_rep: true, role: 'collateral_agent' };
  return { is_rep: false, role: null };
}

// ── California ─────────────────────────────────────────────────────────────────
// CA SOS has a JSON API endpoint for UCC searches.

async function searchCA(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded = encodeURIComponent(debtorName);
  const url     = `https://ucc.sos.ca.gov/secured/results?debtorName=${encoded}&fileDate=&type=D&county=&page=1`;

  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseCAResults(html, debtorName);
  } catch {
    return [];
  }
}

function parseCAResults(html: string, debtorName: string): UccFilingRecord[] {
  const results: UccFilingRecord[] = [];
  // CA results are in a table — extract rows matching pattern
  const rowRegex = /<tr[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row    = match[1];
    const cells  = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
      m[1].replace(/<[^>]+>/g, '').trim()
    );
    if (cells.length < 4) continue;

    const filingNum    = cells[0] ?? '';
    const filingDate   = cells[1] ?? null;
    const debtorCell   = cells[2] ?? debtorName;
    const securedParty = cells[3] ?? '';
    if (!securedParty) continue;

    const { is_rep, role } = detectRepresentativeRole(securedParty);
    results.push({
      filing_number:           filingNum,
      filing_type:             'ucc1',
      filing_date:             filingDate,
      amendment_date:          null,
      termination_date:        null,
      debtor_name:             debtorCell,
      secured_party_name:      securedParty,
      is_representative_party: is_rep,
      representative_role:     role,
      collateral_text:         null,
      source_url:              `https://ucc.sos.ca.gov/secured/results?debtorName=${encodeURIComponent(debtorName)}`,
      raw_text:                cells.join(' | '),
    });
  }
  return results;
}

// ── Texas ──────────────────────────────────────────────────────────────────────
// TX SOS direct search portal — HTML form POST.

async function searchTX(debtorName: string): Promise<UccFilingRecord[]> {
  const searchUrl = 'https://direct.sos.state.tx.us/ucc_search/ucc-search.asp';
  const body      = new URLSearchParams({
    debtorName,
    searchType: 'debtorName',
    county:     '',
    submit:     'Search',
  });

  try {
    const resp = await fetch(searchUrl, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseTXResults(html, debtorName, searchUrl);
  } catch {
    return [];
  }
}

function parseTXResults(html: string, debtorName: string, sourceUrl: string): UccFilingRecord[] {
  const results: UccFilingRecord[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let   match;
  let   rowCount = 0;

  while ((match = rowRegex.exec(html)) !== null) {
    rowCount++;
    if (rowCount < 3) continue; // skip header rows
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    if (cells.length < 3 || !cells[2]) continue;

    const { is_rep, role } = detectRepresentativeRole(cells[2]);
    results.push({
      filing_number:           cells[0] ?? '',
      filing_type:             'ucc1',
      filing_date:             cells[1] ?? null,
      amendment_date:          null,
      termination_date:        null,
      debtor_name:             debtorName,
      secured_party_name:      cells[2],
      is_representative_party: is_rep,
      representative_role:     role,
      collateral_text:         cells[3] ?? null,
      source_url:              sourceUrl,
      raw_text:                cells.join(' | '),
    });
  }
  return results;
}

// ── Colorado ───────────────────────────────────────────────────────────────────
// CO SOS UCC search at sos.state.co.us/ucc — HTML form GET.

async function searchCO(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded  = encodeURIComponent(debtorName);
  const searchUrl = `https://www.sos.state.co.us/ucc/pages/search/searchDebtors.xhtml`;
  // CO uses a JSF form; attempt a GET with params first then fall back to form POST
  const getUrl = `https://www.sos.state.co.us/ucc/pages/search/searchDebtors.xhtml?debtorName=${encoded}`;
  try {
    const resp = await fetch(getUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseCOResults(html, debtorName, searchUrl);
  } catch {
    return [];
  }
}

function parseCOResults(html: string, debtorName: string, sourceUrl: string): UccFilingRecord[] {
  // CO results table: Filing No | Type | Filing Date | Lapse Date | Debtor Name | Secured Party
  return parseGenericTable(html, sourceUrl, debtorName, 1, 2, 5, -1);
}

// ── Arizona ────────────────────────────────────────────────────────────────────
// AZ SOS UCC search at ucc.azsos.gov — ASP.NET WebForms (requires ViewState extraction).

async function searchAZ(debtorName: string): Promise<UccFilingRecord[]> {
  const baseUrl = 'https://ucc.azsos.gov/ucc_efile/SearchUCC.aspx';
  try {
    // Step 1: GET the form to capture ASP.NET ViewState
    const getResp = await fetch(baseUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!getResp.ok) return [];
    const formHtml = await getResp.text();

    const viewState       = extractHiddenField(formHtml, '__VIEWSTATE');
    const eventValidation = extractHiddenField(formHtml, '__EVENTVALIDATION');
    const vsGenerator     = extractHiddenField(formHtml, '__VIEWSTATEGENERATOR');
    if (!viewState) return []; // Portal changed structure

    // Step 2: POST the search form
    const body = new URLSearchParams({
      '__VIEWSTATE':            viewState,
      '__VIEWSTATEGENERATOR':   vsGenerator ?? '',
      '__EVENTVALIDATION':      eventValidation ?? '',
      'ctl00$MainContent$txtDebtorName': debtorName,
      'ctl00$MainContent$btnSearch':     'Search',
      'ctl00$MainContent$ddlSearchType': 'DebtorName',
    });

    const postResp = await fetch(baseUrl, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!postResp.ok) return [];
    const html = await postResp.text();
    return parseAZResults(html, debtorName, baseUrl);
  } catch {
    return [];
  }
}

function extractHiddenField(html: string, fieldName: string): string | null {
  const re = new RegExp(`<input[^>]+name="${fieldName}"[^>]+value="([^"]*)"`, 'i');
  return html.match(re)?.[1] ?? null;
}

function parseAZResults(html: string, debtorName: string, sourceUrl: string): UccFilingRecord[] {
  // AZ results: Filing No | Filing Date | Lapse Date | Debtor | Secured Party | Collateral
  return parseGenericTable(html, sourceUrl, debtorName, 0, 1, 4, 5);
}

// ── Nevada ─────────────────────────────────────────────────────────────────────
// NV SOS UCC search at esos.nv.gov — HTML GET search.

async function searchNV(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://esos.nv.gov/UCC/UCCSearch/?searchType=DEBTOR_NAME&searchValue=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseNVResults(html, debtorName, searchUrl);
  } catch {
    return [];
  }
}

function parseNVResults(html: string, debtorName: string, sourceUrl: string): UccFilingRecord[] {
  // NV results: Filing No | Type | Filing Date | Expiration | Debtor | Secured Party
  return parseGenericTable(html, sourceUrl, debtorName, 1, 2, 5, -1);
}

// ── Minnesota ──────────────────────────────────────────────────────────────────
// MN SOS UCC search portal — HTML GET.

async function searchMN(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://ucc.sos.state.mn.us/ucc_results.asp?name=${encoded}&type=D`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── Iowa ───────────────────────────────────────────────────────────────────────

async function searchIA(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://sos.iowa.gov/ucc/search.aspx?name=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 2, 4, 5);
  } catch {
    return [];
  }
}

// ── Illinois ───────────────────────────────────────────────────────────────────

async function searchIL(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://www.ilsos.gov/uccSearch/uccSearchDebtorName.do?debtorName=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── North Carolina ─────────────────────────────────────────────────────────────

async function searchNC(debtorName: string): Promise<UccFilingRecord[]> {
  const body      = new URLSearchParams({ searchType: 'name', name: debtorName, submit: 'Search' });
  const searchUrl = 'https://www.sosnc.gov/online_services/ucc/ucc_search_results';
  try {
    const resp = await fetch(searchUrl, {
      method:  'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 1, 2, 4, 5);
  } catch {
    return [];
  }
}

// ── Florida ────────────────────────────────────────────────────────────────────
// FL Sunbiz UCC search — HTML form GET.

async function searchFL(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://search.sunbiz.org/Inquiry/UCCSearch/GetList?searchTerm=${encoded}&listType=Name`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── Indiana ────────────────────────────────────────────────────────────────────

async function searchIN(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://bsd.sos.in.gov/PublicBusinessSearch/Business?searchValue=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── Georgia ────────────────────────────────────────────────────────────────────

async function searchGA(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://ecorp.sos.ga.gov/AccountancyUCC/uccSearch?debtorName=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 2, 4, 5);
  } catch {
    return [];
  }
}

// ── New York ───────────────────────────────────────────────────────────────────

async function searchNY(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://appext20.dos.ny.gov/pls/ucc_public/web_search_ucc.search_results?p_debtor_name=${encoded}&p_search_type=NAME`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── Wisconsin ──────────────────────────────────────────────────────────────────

async function searchWI(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://www.wdfi.org/apps/UCCSearch/SearchResults.aspx?searchType=DebtorName&debtorName=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── New Mexico ─────────────────────────────────────────────────────────────────

async function searchNM(debtorName: string): Promise<UccFilingRecord[]> {
  const encoded   = encodeURIComponent(debtorName);
  const searchUrl = `https://portal.sos.state.nm.us/BFS/online/UccSearch/DebtorSearch?Name=${encoded}`;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseGenericTable(html, searchUrl, debtorName, 0, 1, 3, 4);
  } catch {
    return [];
  }
}

// ── Generic HTML table parser (used for similar-structured state portals) ─────

function parseGenericTable(
  html:      string,
  sourceUrl: string,
  debtorName: string,
  filingTypeCol: number = 0,
  dateCol:       number = 1,
  securedCol:    number = 2,
  collateralCol: number = 3,
): UccFilingRecord[] {
  const results: UccFilingRecord[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let   match;
  let   rowCount = 0;

  while ((match = rowRegex.exec(html)) !== null) {
    rowCount++;
    if (rowCount < 2) continue;
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    const secured = cells[securedCol];
    if (!secured || secured.length < 3) continue;

    const { is_rep, role } = detectRepresentativeRole(secured);
    results.push({
      filing_number:           cells[0] ?? '',
      filing_type:             cells[filingTypeCol]?.toLowerCase().includes('amend') ? 'ucc3_amendment'
                             : cells[filingTypeCol]?.toLowerCase().includes('terminat') ? 'ucc3_termination'
                             : 'ucc1',
      filing_date:             cells[dateCol] ?? null,
      amendment_date:          null,
      termination_date:        null,
      debtor_name:             debtorName,
      secured_party_name:      secured,
      is_representative_party: is_rep,
      representative_role:     role,
      collateral_text:         cells[collateralCol] ?? null,
      source_url:              sourceUrl,
      raw_text:                cells.join(' | '),
    });
  }
  return results;
}

// ── Adapter registry ──────────────────────────────────────────────────────────

export const STATE_ADAPTERS: Record<string, StateAdapter> = {
  CA: { state: 'CA', search: searchCA, enabled: true  },
  TX: { state: 'TX', search: searchTX, enabled: true  },
  CO: { state: 'CO', search: searchCO, enabled: true  },
  AZ: { state: 'AZ', search: searchAZ, enabled: true  },
  NV: { state: 'NV', search: searchNV, enabled: true  },
  MN: { state: 'MN', search: searchMN, enabled: true  },
  IA: { state: 'IA', search: searchIA, enabled: true  },
  IL: { state: 'IL', search: searchIL, enabled: true  },
  NC: { state: 'NC', search: searchNC, enabled: true  },
  FL: { state: 'FL', search: searchFL, enabled: true  },
  IN: { state: 'IN', search: searchIN, enabled: true  },
  GA: { state: 'GA', search: searchGA, enabled: true  },
  NY: { state: 'NY', search: searchNY, enabled: true  },
  WI: { state: 'WI', search: searchWI, enabled: true  },
  NM: { state: 'NM', search: searchNM, enabled: true  },
};

export function getAdapter(state: string): StateAdapter | null {
  return STATE_ADAPTERS[state.toUpperCase()] ?? null;
}
