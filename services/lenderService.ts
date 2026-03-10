/**
 * GenTrack — lenderService
 *
 * Fetches structured lender/financing rows from the plant_lenders table.
 * Populated by the lender_pipeline Python script (SEC EDGAR extraction).
 */

import { supabase } from './supabaseClient';

export interface PlantLender {
  id: string;
  eia_plant_code: string;
  lender_name: string;
  facility_type: string;
  loan_amount_usd: number | null;
  interest_rate_text: string | null;
  maturity_date: string | null;
  maturity_text: string | null;
  filing_type: string;
  filing_date: string;
  filing_url: string;
  accession_no: string;
  excerpt_text: string | null;
  confidence: 'high' | 'medium' | 'low';
  extracted_at: string;
}

export async function fetchPlantLenders(eiaPlantCode: string): Promise<PlantLender[]> {
  const { data, error } = await supabase
    .from('plant_lenders')
    .select('*')
    .eq('eia_plant_code', eiaPlantCode)
    .order('filing_date', { ascending: false });

  if (error) {
    console.error('fetchPlantLenders error:', error);
    return [];
  }
  return (data ?? []) as PlantLender[];
}
