-- archived_pursuits: tracks pursuits archived by users across all three dashboards
-- (plant, lender, tax_equity). Archived items are hidden from active dashboards
-- but remain accessible via the Archived Pursuits view.

CREATE TABLE IF NOT EXISTS archived_pursuits (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('plant', 'lender', 'tax_equity')),
  entity_id   TEXT NOT NULL,  -- eia_plant_code for plants, name for lender/tax_equity
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes       TEXT,
  PRIMARY KEY (entity_type, entity_id)
);

ALTER TABLE archived_pursuits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated" ON archived_pursuits
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Index to quickly fetch all archived items of a given type
CREATE INDEX idx_archived_pursuits_entity_type ON archived_pursuits (entity_type);
