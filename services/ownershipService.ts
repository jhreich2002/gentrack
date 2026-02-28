import { supabase } from './supabaseClient';
import { PlantOwnership } from '../types';

/**
 * Fetches ownership and PPA data for a single plant from the plant_ownership table.
 * Returns null if no record exists for the given EIA plant code.
 */
export async function fetchPlantOwnership(eiaPlantCode: string): Promise<PlantOwnership | null> {
  const { data, error } = await supabase
    .from('plant_ownership')
    .select('*')
    .eq('eia_site_code', eiaPlantCode)
    .maybeSingle();

  if (error) {
    console.error('fetchPlantOwnership error:', error.message);
    return null;
  }
  if (!data) return null;

  return {
    eiaPlantCode:              data.eia_site_code,
    powerPlant:                data.power_plant,
    plantKey:                  data.plant_key,
    techType:                  data.tech_type,
    plantOperator:             data.plant_operator,
    plantOperatorInstnKey:     data.plant_operator_instn_key,
    operatorUltParent:         data.operator_ult_parent,
    operatorUltParentInstnKey: data.operator_ult_parent_instn_key,
    owner:                     data.owner,
    operOwnPct:                data.oper_own,
    ownerEiaUtilityCode:       data.owner_eia_utility_code,
    ultParent:                 data.ult_parent,
    parentEiaUtilityCode:      data.parent_eia_utility_code,
    ownStatus:                 data.own_status,
    plannedOwn:                data.planned_own,
    largestPpaCounterparty:    data.largest_ppa_counterparty,
    largestPpaCapacityMW:      data.largest_ppa_contracted_capacity,
    largestPpaStartDate:       data.largest_ppa_contracted_start_date,
    largestPpaExpirationDate:  data.largest_ppa_contracted_expiration_date,
  };
}
