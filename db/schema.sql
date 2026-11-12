-- LedgerLine database schema.
-- Safe to run repeatedly (every statement is idempotent). Run by scripts/migrate.js.
-- All money is stored as BIGINT paise (1 rupee = 100 paise). No floats anywhere.

-- ---------------------------------------------------------------------------
-- Users and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'holder', 'auditor')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- We store only the SHA-256 of the session token, so a leaked database
-- dump does not contain usable tokens.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
-- kind = 'customer' : a normal account owned by a user. Floor is zero.
-- kind = 'external' : exactly one row, "the outside world". Deposits come out
--                     of it and withdrawals go into it, so it is allowed to be
--                     negative. With it, the sum of ALL balances is always 0.
CREATE SEQUENCE IF NOT EXISTS accounts_id_seq START 1001;

CREATE TABLE IF NOT EXISTS accounts (
  id         BIGINT PRIMARY KEY DEFAULT nextval('accounts_id_seq'),
  owner_id   BIGINT REFERENCES users(id),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind       TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer', 'external')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  balance    BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Last line of defence: even if the application code is wrong, the database
  -- itself refuses to store a negative customer balance.
  CONSTRAINT customer_balance_not_negative CHECK (kind = 'external' OR balance >= 0),
  CONSTRAINT balance_in_safe_range CHECK (balance BETWEEN -9000000000000000 AND 9000000000000000),
  CONSTRAINT customer_has_owner CHECK ((kind = 'external') = (owner_id IS NULL))
);

-- At most one external account can ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS one_external_account ON accounts (kind) WHERE kind = 'external';
CREATE INDEX IF NOT EXISTS accounts_owner ON accounts (owner_id);

INSERT INTO accounts (id, owner_id, name, kind)
VALUES (1000, NULL, 'External world', 'external')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Ledger: transactions (one per money-moving request) and entries (double entry)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'transfer', 'adjustment')),
  status          TEXT NOT NULL CHECK (status IN ('posted', 'refused')),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  from_account_id BIGINT NOT NULL REFERENCES accounts(id),
  to_account_id   BIGINT NOT NULL REFERENCES accounts(id),
  initiated_by    BIGINT NOT NULL REFERENCES users(id),
  refusal_reason  TEXT,
  memo            TEXT CHECK (memo IS NULL OR char_length(memo) <= 200),
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT different_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT refused_has_reason CHECK ((status = 'refused') = (refusal_reason IS NOT NULL))
);

-- One row per account touched by a transaction.
--   posted transaction  -> one 'debit' row (from) and one 'credit' row (to)
--   refused transaction -> one row on the account the attempt was made against,
--                          with status 'refused' and the unchanged balance
-- prev_hash/hash form a per-account hash chain (see src/ledger/hash.js).
CREATE TABLE IF NOT EXISTS entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  direction      TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount         BIGINT NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL CHECK (status IN ('posted', 'refused')),
  balance_after  BIGINT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entries_account ON entries (account_id, id);
CREATE INDEX IF NOT EXISTS entries_transaction ON entries (transaction_id);

-- ---------------------------------------------------------------------------
-- Idempotency keys: one row per (user, client key). Remembered forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id         BIGINT NOT NULL REFERENCES users(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Audit events: everything that is not a ledger posting (logins, replays, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
-- The ledger tables accept INSERT only. UPDATE, DELETE and TRUNCATE raise an
-- error inside the database, whatever code (or SQL console) sends them.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on table "%" is not allowed: the ledger is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_append_only ON transactions;
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
DROP TRIGGER IF EXISTS transactions_no_truncate ON transactions;
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

DROP TRIGGER IF EXISTS entries_append_only ON entries;
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
DROP TRIGGER IF EXISTS entries_no_truncate ON entries;
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Accounts are never deleted (they can only be frozen).
DROP TRIGGER IF EXISTS accounts_no_delete ON accounts;
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
DROP TRIGGER IF EXISTS accounts_no_truncate ON accounts;
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON accounts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Double-entry enforcement
-- ---------------------------------------------------------------------------
-- Checked by the database at COMMIT: within one transaction, posted debits
-- must equal posted credits. A posting that would create or destroy money
-- cannot be committed, even by buggy application code.
CREATE OR REPLACE FUNCTION check_transaction_balances() RETURNS trigger AS $$
DECLARE
  net BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0)
    INTO net
    FROM entries
   WHERE transaction_id = NEW.transaction_id AND status = 'posted';
  IF net <> 0 THEN
    RAISE EXCEPTION 'transaction % does not balance (net %)', NEW.transaction_id, net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_must_balance ON entries;
CREATE CONSTRAINT TRIGGER entries_must_balance AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_balances();
