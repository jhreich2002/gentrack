/**
 * GenTrack — archiveService
 *
 * Manages the archived_pursuits table. Users can archive individual plants,
 * lenders, or tax equity investors from their respective pursuit dashboards.
 * Archived items are hidden from active dashboards but remain accessible
 * via the Archived Pursuits view.
 */

import { supabase } from './supabaseClient';

export type ArchiveEntityType = 'plant' | 'lender' | 'tax_equity';

export interface ArchivedPursuit {
  entityType: ArchiveEntityType;
  entityId:   string;
  archivedAt: string;
  notes:      string | null;
}

export interface ArchivedPursuitSets {
  plants:    Set<string>;
  lenders:   Set<string>;
  taxEquity: Set<string>;
}

export async function fetchArchivedPursuits(includePermanent = false): Promise<ArchivedPursuitSets> {
  const { data, error } = await supabase
    .from('archived_pursuits')
    .select('entity_type, entity_id, permanently_archived')
    .or(includePermanent ? '' : 'permanently_archived.is.false');

  if (error) {
    console.error('fetchArchivedPursuits error:', error);
    return { plants: new Set(), lenders: new Set(), taxEquity: new Set() };
  }

  const result: ArchivedPursuitSets = {
    plants:    new Set(),
    lenders:   new Set(),
    taxEquity: new Set(),
  };

  for (const row of data ?? []) {
    if (row.entity_type === 'plant')      result.plants.add(row.entity_id);
    else if (row.entity_type === 'lender')     result.lenders.add(row.entity_id);
    else if (row.entity_type === 'tax_equity') result.taxEquity.add(row.entity_id);
  }

  return result;
}

export async function fetchArchivedPursuitsList(includePermanent = false): Promise<ArchivedPursuit[]> {
  const { data, error } = await supabase
    .from('archived_pursuits')
    .select('entity_type, entity_id, archived_at, notes, permanently_archived')
    .or(includePermanent ? '' : 'permanently_archived.is.false')
    .order('archived_at', { ascending: false });

  if (error) {
    console.error('fetchArchivedPursuitsList error:', error);
    return [];
  }

  return (data ?? []).map(row => ({
    entityType: row.entity_type as ArchiveEntityType,
    entityId:   row.entity_id,
    archivedAt: row.archived_at,
    notes:      row.notes ?? null,
    permanentlyArchived: row.permanently_archived ?? false,
  }));
}


export async function archivePursuit(
  entityType: ArchiveEntityType,
  entityId:   string,
  permanent: boolean = false,
): Promise<void> {
  const { error } = await supabase
    .from('archived_pursuits')
    .upsert({ entity_type: entityType, entity_id: entityId, permanently_archived: permanent }, { onConflict: 'entity_type,entity_id' });
  if (error) {
    console.error('archivePursuit error:', error);
    throw error;
  }
}

export async function unarchivePursuit(
  entityType: ArchiveEntityType,
  entityId:   string,
): Promise<void> {
  const { error } = await supabase
    .from('archived_pursuits')
    .delete()
    .eq('entity_type', entityType)
    .eq('entity_id', entityId);

  if (error) {
    console.error('unarchivePursuit error:', error);
    throw error;
  }
}
