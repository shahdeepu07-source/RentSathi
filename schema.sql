-- ============================================================
-- SAJILORENT — SaaS Database Schema
-- Architecture: 4-tier role hierarchy + multi-tier notifications
-- Engine:       SQLite / PostgreSQL compatible
-- ============================================================

-- ───── 1. USERS (All 4 roles in one table) ───────────────────
CREATE TABLE users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT    NOT NULL UNIQUE,
    password_hash     TEXT    NOT NULL,
    role              TEXT    NOT NULL CHECK(role IN ('superadmin','admin','owner','tenant')),
    full_name         TEXT    NOT NULL DEFAULT '',
    phone             TEXT    DEFAULT '',
    email             TEXT    DEFAULT '',
    address           TEXT    DEFAULT '',
    notes             TEXT    DEFAULT '',

    -- Subscription (relevant for owners)
    subscription_status TEXT  DEFAULT 'active' CHECK(subscription_status IN ('active','trial','expired','canceled')),
    trial_start       TEXT,
    trial_end         TEXT,

    -- Soft delete
    deleted           INTEGER NOT NULL DEFAULT 0,
    deleted_at        TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_deleted ON users(deleted);

-- ───── 2. HOUSES (Properties) ────────────────────────────────
CREATE TABLE houses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    address     TEXT    DEFAULT '',
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    created_by  INTEGER REFERENCES users(id),

    deleted     INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_houses_owner ON houses(owner_id);
CREATE INDEX idx_houses_deleted ON houses(deleted);

-- ───── 3. TENANTS (Bridge: users ↔ houses) ───────────────────
CREATE TABLE tenants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    house_id      INTEGER NOT NULL REFERENCES houses(id),
    user_id       INTEGER REFERENCES users(id),       -- NULL if no login created
    rent_amount   REAL    NOT NULL DEFAULT 0,
    last_reading  REAL    NOT NULL DEFAULT 0,
    phone         TEXT    DEFAULT '',
    email         TEXT    DEFAULT '',
    address       TEXT    DEFAULT '',
    balance       REAL    NOT NULL DEFAULT 0,          -- positive=due, negative=advance

    deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tenants_house ON tenants(house_id);
CREATE INDEX idx_tenants_user ON tenants(user_id);
CREATE INDEX idx_tenants_deleted ON tenants(deleted);

-- ───── 4. BILLS (Immutable financial records) ────────────────
CREATE TABLE bills (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
    house_id      INTEGER NOT NULL REFERENCES houses(id),
    month         TEXT    NOT NULL,                    -- e.g. 'Ashwin 2081'

    -- Meter readings
    prev_reading  REAL    NOT NULL DEFAULT 0,
    curr_reading  REAL    NOT NULL DEFAULT 0,
    units         REAL    NOT NULL DEFAULT 0,
    rate_per_unit REAL    NOT NULL DEFAULT 15,

    -- Charges
    electricity   REAL    NOT NULL DEFAULT 0,
    rent          REAL    NOT NULL DEFAULT 0,
    water         REAL    NOT NULL DEFAULT 0,
    waste         REAL    NOT NULL DEFAULT 0,
    due_forward   REAL    NOT NULL DEFAULT 0,          -- previous balance brought in
    deduction     REAL    NOT NULL DEFAULT 0,
    deduction_reason TEXT  DEFAULT '',
    total         REAL    NOT NULL DEFAULT 0,

    -- Payment
    paid_status   INTEGER NOT NULL DEFAULT 0,
    payment_type  TEXT    CHECK(payment_type IN ('equal','due','advance',NULL)),
    payment_amount REAL,
    payment_reason TEXT,
    paid_at       TEXT,

    -- Notes from owner
    note          TEXT    DEFAULT '',

    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bills_tenant ON bills(tenant_id);
CREATE INDEX idx_bills_house ON bills(house_id);
CREATE INDEX idx_bills_month ON bills(month);
CREATE INDEX idx_bills_status ON bills(paid_status);

-- ───── 5. PAYMENTS (Audit trail for each payment event) ──────
CREATE TABLE payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id     INTEGER NOT NULL REFERENCES bills(id),
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
    house_id    INTEGER NOT NULL REFERENCES houses(id),
    amount      REAL    NOT NULL,
    type        TEXT    NOT NULL CHECK(type IN ('equal','due','advance')),
    reason      TEXT    DEFAULT '',
    processed_by INTEGER REFERENCES users(id),         -- who marked the payment
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───── 6. NOTIFICATIONS (Hierarchical 3-tier system) ────────
CREATE TABLE notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Sender info
    sender_id   INTEGER NOT NULL REFERENCES users(id),
    sender_role TEXT    NOT NULL CHECK(sender_role IN ('superadmin','admin','owner')),

    -- Targeting: NULL target_role means broadcast to all of that role
    target_role TEXT    NOT NULL CHECK(target_role IN ('admin','owner','tenant')),
    target_id   INTEGER REFERENCES users(id),          -- NULL = all in target_role

    -- Content
    title       TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    priority    TEXT    NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),

    -- Lifecycle
    is_active   INTEGER NOT NULL DEFAULT 1,
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notifications_target ON notifications(target_role, target_id);
CREATE INDEX idx_notifications_active ON notifications(is_active);

-- ───── 7. NOTIFICATION ACKNOWLEDGMENTS (dismissal tracking) ──
CREATE TABLE notification_ack (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    dismissed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(notification_id, user_id)
);

-- ───── 8. AUDIT LOG (Immutable history for compliance) ──────
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT    NOT NULL,     -- e.g. 'bill.created', 'payment.recorded', 'user.deleted'
    entity_type TEXT,                 -- 'bill','tenant','user','house','payment'
    entity_id   INTEGER,
    details     TEXT,                 -- JSON metadata / diff
    ip_address  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ───── 9. SYSTEM SETTINGS (Superadmin configuration) ────────
CREATE TABLE system_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT DEFAULT '',
    updated_by  INTEGER REFERENCES users(id),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────── DEFAULT SEED DATA ─────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
    ('rate_per_unit', '15', 'Default electricity rate per unit (Rs.)'),
    ('trial_days', '30', 'Free trial duration in days'),
    ('platform_name', 'SajiloRent', 'Display name for the platform'),
    ('currency_symbol', 'Rs.', 'Currency symbol for display');

-- ============================================================
-- END OF SCHEMA
-- ============================================================
