-- PayPal's independent payment ledger. This is intentionally separate from
-- the Waffo flow and from the game-save document itself.
CREATE TABLE IF NOT EXISTS paypal_orders (
  internal_id TEXT PRIMARY KEY,
  paypal_order_id TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tickets_t1 INTEGER NOT NULL,
  status TEXT NOT NULL,
  capture_id TEXT,
  client_request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS paypal_orders_request_idx
  ON paypal_orders(uid, client_request_id);

CREATE TABLE IF NOT EXISTS ticket_grants (
  grant_id TEXT PRIMARY KEY,
  order_internal_id TEXT NOT NULL UNIQUE,
  paypal_order_id TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  tickets_t1 INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  locked_at INTEGER,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_grants_uid_status_idx
  ON ticket_grants(uid, status, created_at);
