-- Khaapa schema (all of the original migrations squashed into one).
-- Apply with: npx wrangler d1 migrations apply khaapa --remote   (or --local for dev)

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE attendance_reports (
  day TEXT PRIMARY KEY,       -- YYYY-MM-DD, Pakistan time
  csv TEXT NOT NULL,
  slots INTEGER NOT NULL,     -- slots that day
  missed INTEGER NOT NULL,    -- slots nobody turned up for
  off_slot INTEGER NOT NULL,  -- shifts started outside the person's own slot
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('coupon','promo')),
  sponsor_id INTEGER REFERENCES sponsors(id),
  discount_type TEXT NOT NULL CHECK (discount_type IN ('fixed','percent')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_order INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,                      -- NULL = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,                       -- last valid day (YYYY-MM-DD, Pakistan time); NULL = never
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  price INTEGER NOT NULL CHECK (price >= 0),
  cost INTEGER,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock_at INTEGER NOT NULL DEFAULT 5,
  image_key TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, preorder INTEGER NOT NULL DEFAULT 0);

CREATE TABLE mail_connect_links (
  token TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE mail_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,      -- AES-GCM encrypted with the TOKEN_KEY secret
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_sync_at TEXT,
  last_error TEXT
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,          -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,          -- PKCE S256
  expires_at TEXT NOT NULL
, scope TEXT NOT NULL DEFAULT 'read');

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, scope TEXT NOT NULL DEFAULT 'read');

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  amount INTEGER,                        -- whole PKR; NULL if the email could not be parsed
  sender_name TEXT,
  reference TEXT,
  subject TEXT,
  snippet TEXT,
  raw_text TEXT,
  sale_id INTEGER REFERENCES sales(id),  -- matched online sale, if any
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, ignored INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'nayapay');

CREATE TABLE preorder_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preorder_id INTEGER NOT NULL REFERENCES preorders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);

CREATE TABLE preorders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pickup_on TEXT NOT NULL,              -- YYYY-MM-DD, Pakistan time
  note TEXT,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','paid','collected','cancelled')),
  sale_id INTEGER REFERENCES sales(id),
  handled_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, token TEXT, proof_key TEXT);

CREATE TABLE request_locks (
  key TEXT PRIMARY KEY,          -- sha-256 of user id + method + path + body
  created_at TEXT NOT NULL
);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER,
  qty INTEGER NOT NULL CHECK (qty > 0)
, extra INTEGER NOT NULL DEFAULT 0);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  total INTEGER NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('cash','online')) DEFAULT 'cash',
  note TEXT,
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, subtotal INTEGER, discount INTEGER NOT NULL DEFAULT 0, code_id INTEGER REFERENCES discount_codes(id));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE shift_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT
);

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  opening_cash INTEGER,
  closing_cash INTEGER,
  note TEXT
);

CREATE TABLE slot_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week TEXT NOT NULL,                                        -- Monday of the week, YYYY-MM-DD Pakistan time
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 5), -- 1 = Monday
  start TEXT NOT NULL,                                       -- HH:MM Pakistan time
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, week, weekday, start)
);

CREATE TABLE slot_swaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  to_slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  responded_at TEXT
);

CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  reminded_at TEXT,                     -- reminder email sent (only when email sending is configured)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, pick_id INTEGER REFERENCES slot_picks(id) ON DELETE SET NULL);

CREATE TABLE sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('restock','sale','void','waste','correction')),
  note TEXT,
  sale_id INTEGER REFERENCES sales(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, unit_cost REAL);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')) DEFAULT 'staff',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, email TEXT, google_sub TEXT, picture TEXT, approved INTEGER NOT NULL DEFAULT 0, is_hr INTEGER NOT NULL DEFAULT 0, scopes TEXT NOT NULL DEFAULT '', mcp_write INTEGER NOT NULL DEFAULT 0);

CREATE INDEX activity_created ON activity_log(created_at);

CREATE INDEX discount_codes_sponsor ON discount_codes(sponsor_id);

CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);

CREATE INDEX payments_received ON payments(received_at);

CREATE INDEX payments_sale ON payments(sale_id);

CREATE INDEX preorder_items_order ON preorder_items(preorder_id);

CREATE INDEX preorders_phone ON preorders(phone, status);

CREATE INDEX preorders_pickup ON preorders(pickup_on, status);

CREATE INDEX sale_items_item ON sale_items(item_id);

CREATE INDEX sale_items_sale ON sale_items(sale_id);

CREATE INDEX sales_code ON sales(code_id);

CREATE INDEX sales_created ON sales(created_at);

CREATE INDEX sales_user ON sales(user_id);

CREATE INDEX sessions_user ON sessions(user_id);

CREATE INDEX shift_requests_status ON shift_requests(status);

CREATE INDEX shift_requests_user ON shift_requests(user_id, status);

CREATE INDEX shifts_open ON shifts(ended_at);

CREATE INDEX shifts_user ON shifts(user_id);

CREATE INDEX slot_picks_block ON slot_picks(week, weekday, start);

CREATE INDEX slot_swaps_from ON slot_swaps(from_user_id, status);

CREATE INDEX slot_swaps_to ON slot_swaps(to_user_id, status);

CREATE UNIQUE INDEX slots_pick ON slots(pick_id, starts_at) WHERE pick_id IS NOT NULL;

CREATE INDEX slots_start ON slots(starts_at);

CREATE INDEX slots_user ON slots(user_id);

CREATE INDEX stock_moves_created ON stock_moves(created_at);

CREATE INDEX stock_moves_item ON stock_moves(item_id);

CREATE UNIQUE INDEX users_email ON users(email);

CREATE UNIQUE INDEX users_google_sub ON users(google_sub);

CREATE TRIGGER slot_picks_cap BEFORE INSERT ON slot_picks
WHEN (SELECT COUNT(*) FROM slot_picks WHERE week = NEW.week AND weekday = NEW.weekday AND start = NEW.start) >= 3
BEGIN
  SELECT RAISE(ABORT, 'slot full');
END;
