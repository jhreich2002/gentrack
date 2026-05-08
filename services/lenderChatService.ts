// services/lenderChatService.ts
// Phase 6: client wrapper around the lender-chat Edge Function.
import type {} from '../types';

export type LenderChatScope = 'plant' | 'lender' | 'global';

export interface LenderChatCitation {
  index:        number;
  chunk_id:     number;
  document_id:  number;
  source_type:  string;
  title:        string | null;
  url:          string | null;
  published_at: string | null;
  snippet:      string;
  similarity:   number;
}

export interface LenderChatStructuredRow {
  lender_name:        string;
  lender_normalized:  string;
  plant_code:         string;
  evidence_type:      string;
  confidence_class?:  string;
  lead_status?:       string;
}

export interface LenderChatResponse {
  ok:        boolean;
  answer:    string;
  citations: LenderChatCitation[];
  structured: {
    validated: LenderChatStructuredRow[];
    pending:   LenderChatStructuredRow[];
  };
}

export interface LenderChatRequest {
  scope:              LenderChatScope;
  plant_code?:        string;
  lender_normalized?: string;
  question:           string;
}

export async function askLenderChat(req: LenderChatRequest): Promise<LenderChatResponse | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!supabaseUrl) {
    console.warn('askLenderChat: VITE_SUPABASE_URL not set');
    return null;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/lender-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      console.error('askLenderChat HTTP', resp.status, await resp.text());
      return null;
    }
    return (await resp.json()) as LenderChatResponse;
  } catch (err) {
    console.error('askLenderChat fetch error:', err);
    return null;
  }
}
