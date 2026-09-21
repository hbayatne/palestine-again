-- 002_congress.sql — cache of Congressional (STOCK Act) trade disclosures.
-- The backend fetches public bulk datasets server-side (one fetch serves all
-- users, no browser CORS or per-user quota), normalizes them, and stores them
-- here for fast querying. Nothing user-specific.

CREATE TABLE IF NOT EXISTS congress_trades (
  id                BIGSERIAL PRIMARY KEY,
  external_id       TEXT UNIQUE NOT NULL,   -- stable dedupe key
  chamber           TEXT,                   -- house | senate
  member            TEXT,
  party             TEXT,
  ticker            TEXT,                   -- '' when the disclosure has no ticker
  asset_description TEXT,
  tx_type           TEXT,                   -- purchase | sale | exchange
  amount_low        NUMERIC,
  amount_high       NUMERIC,
  tx_date           DATE,
  disclosed_date    DATE,
  source            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_congress_ticker ON congress_trades (ticker);
CREATE INDEX IF NOT EXISTS idx_congress_txdate ON congress_trades (tx_date DESC);
CREATE INDEX IF NOT EXISTS idx_congress_type ON congress_trades (tx_type);

-- Single-row bookkeeping for the last sync.
CREATE TABLE IF NOT EXISTS congress_sync (
  id             INT PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  status         TEXT,
  rows_ingested  INT,
  CONSTRAINT congress_sync_singleton CHECK (id = 1)
);
INSERT INTO congress_sync (id, status) VALUES (1, 'never')
  ON CONFLICT (id) DO NOTHING;
