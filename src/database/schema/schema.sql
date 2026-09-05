-- ATLAS Database Schema for Supabase
--
-- Authoritative shape of a FRESH ATLAS database. Every statement is idempotent
-- (IF NOT EXISTS / OR REPLACE / guarded DO blocks) so this file can be re-run
-- against an existing database without error — that is what makes
-- `npm run db:setup` safe to run more than once, and what lets the migration
-- runner apply this file first and then the ordered migrations on top.
--
-- Run order: this file, then src/database/migrations/*.sql in numeric order.
-- `npm run db:setup` (src/database/migrate.js) does exactly that.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    goal TEXT,
    deadline VARCHAR(255),
    available_time VARCHAR(100),
    motivation TEXT,
    biggest_struggle TEXT,
    personality_type VARCHAR(50) CHECK (personality_type IN ('competitive', 'friendly', 'analytical', 'gamified')),
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_active DATE,
    onboarding_completed BOOLEAN DEFAULT false,
    onboarding_state VARCHAR(50) DEFAULT 'goal',
    timezone VARCHAR(50) DEFAULT 'UTC',
    is_active BOOLEAN DEFAULT true,
    -- Onboarding & scheduling
    experience_level VARCHAR(50),
    domain_knowledge TEXT,
    life_struggle TEXT,
    awaiting_life_struggle BOOLEAN DEFAULT false,
    secondary_goals TEXT,
    preferred_time TIME,
    preferred_start_date DATE,
    start_preference VARCHAR(20),
    task_mode VARCHAR(20),
    input_mode VARCHAR(30) DEFAULT 'chat',
    -- Roadmap
    roadmap TEXT,
    roadmap_json JSONB,
    -- Daily delivery bookkeeping
    last_tasks_sent_date DATE,
    last_morning_question_date DATE,
    morning_answer_received_today BOOLEAN DEFAULT false,
    last_morning_answer TEXT,
    daily_task_preference VARCHAR(20),
    daily_task_preference_date DATE,
    -- Progressive profile questions
    progressive_onboarding_step INTEGER DEFAULT 0,
    last_progressive_question_date DATE,
    terms_agreed_at TIMESTAMP WITH TIME ZONE,
    -- Premium / entitlements. `tier` and `premium_until` are read by
    -- entitlements.isPremium() on every gated feature and were previously only
    -- ever created by hand in the Supabase console — a fresh database had no
    -- such columns and every premium check failed.
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free', 'premium', 'founding')),
    premium_until TIMESTAMP WITH TIME ZONE,
    premium_source TEXT CHECK (premium_source IN ('group', 'paid', 'coupon', 'founding') OR premium_source IS NULL),
    is_beta BOOLEAN DEFAULT false,
    -- Retention / nudge bookkeeping
    reengagement_nudge_sent_at TIMESTAMP WITH TIME ZONE,
    day2_recovery_sent_at TIMESTAMP WITH TIME ZONE,
    commitment_screened_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TASKS TABLE
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    why_it_matters TEXT,
    estimated_time VARCHAR(50),
    assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped', 'too_hard', 'in_progress')),
    difficulty_level VARCHAR(50) DEFAULT 'medium' CHECK (difficulty_level IN ('easy', 'medium', 'hard')),
    skip_reason TEXT,
    is_daily BOOLEAN DEFAULT false,
    is_socratic BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    source VARCHAR(20) DEFAULT 'ai',
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TASK GENERATION LOCKS (prevents duplicate daily generation)
CREATE TABLE IF NOT EXISTS task_generation_locks (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, assigned_date)
);

-- CHECKINS TABLE
CREATE TABLE IF NOT EXISTS checkins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    checkin_type VARCHAR(50) DEFAULT 'daily' CHECK (checkin_type IN ('daily', 'socratic', 'stuck', 'checkin_midday', 'checkin_evening')),
    response TEXT,
    mood_rating INTEGER CHECK (mood_rating >= 1 AND mood_rating <= 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- MEMORY TABLE
CREATE TABLE IF NOT EXISTS memory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    strengths TEXT,
    weaknesses TEXT,
    patterns TEXT,
    strategies TEXT,
    excuses TEXT,
    version INTEGER DEFAULT 1,
    token_count INTEGER,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- WEEKLY REVIEWS TABLE
CREATE TABLE IF NOT EXISTS weekly_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_number INTEGER NOT NULL,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    review_text TEXT NOT NULL,
    completion_rate DECIMAL(5,2),
    tasks_assigned INTEGER,
    tasks_completed INTEGER,
    tasks_skipped INTEGER,
    best_day VARCHAR(20),
    worst_day VARCHAR(20),
    patterns_detected TEXT,
    recommendations TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- SOCRATIC LOGS TABLE
CREATE TABLE IF NOT EXISTS socratic_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    user_response TEXT,
    evaluation_result JSONB,
    understanding_level VARCHAR(50) CHECK (understanding_level IN ('deep', 'moderate', 'shallow', 'none')),
    follow_up_required BOOLEAN DEFAULT false,
    follow_up_question TEXT,
    follow_up_depth INTEGER DEFAULT 0,
    parent_log_id UUID REFERENCES socratic_logs(id) ON DELETE SET NULL,
    awaiting_response BOOLEAN DEFAULT false,
    reinforcement_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The five tables below existed only in the live Supabase project, created by
-- hand and never written down. A fresh deploy therefore failed on the first
-- chat message (conversation_history), on every premium check (app_settings),
-- and on /feedback, /redeem and /verifypay. Definitions reconstructed from
-- every read and write in src/ — see the comment on each table for the callers.
-- ─────────────────────────────────────────────────────────────────────────────

-- CONVERSATION HISTORY
-- Written on every chat turn by conversationEngine.appendTurn(); read by
-- getHistory() (role, content, created_at ordered by created_at desc) and by
-- feedbackQueries.betaStats() (user_id, role, created_at).
CREATE TABLE IF NOT EXISTS conversation_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- The history read is always "newest N for this user", and clearOldHistory
-- prunes by (user_id, created_at) — this index serves both.
CREATE INDEX IF NOT EXISTS idx_conversation_history_user_created
    ON conversation_history (user_id, created_at DESC);

-- APP SETTINGS — key/value flags. Currently one row: payments_enabled.
-- entitlements.paymentsEnabled() reads `value` where key='payments_enabled';
-- premiumQueries.setPaymentsEnabled() updates it. `value` is JSONB because the
-- code compares `data.value === true`, i.e. a real JSON boolean, not a string.
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed the one flag the code requires. Payments start OFF: during beta every
-- user gets full ATLAS free. Without this row the .single() read returns
-- PGRST116 and entitlements has to guess.
INSERT INTO app_settings (key, value)
VALUES ('payments_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- PAYMENTS — manual UPI ledger (the Dodo webhook path grants premium directly
-- and does not write here). logPayment() inserts telegram_id/amount_inr/txn_ref
-- and reads back `id`, so the id must be a small integer the admin can type
-- into /verifypay. verifyPayment() filters on .eq('status','pending').
CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    amount_inr INTEGER NOT NULL,
    txn_ref VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'rejected')),
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_telegram ON payments (telegram_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

-- The UPI reference length check that add_webhook_idempotency.sql tried to add
-- with `ADD CONSTRAINT IF NOT EXISTS` — not valid Postgres syntax, so that
-- statement always failed and the constraint never existed.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_txn_ref_length') THEN
        ALTER TABLE payments ADD CONSTRAINT check_txn_ref_length
            CHECK (length(txn_ref) >= 6 AND length(txn_ref) <= 50);
    END IF;
END $$;

-- COUPONS — single-use codes. redeemCoupon() is atomic via
-- .is('redeemed_by', null), which requires redeemed_by to be NULL when unspent.
-- `code` is the lookup key and is always normalized to uppercase, no spaces.
CREATE TABLE IF NOT EXISTS coupons (
    code VARCHAR(64) PRIMARY KEY,
    grants_tier VARCHAR(20) NOT NULL DEFAULT 'founding'
        CHECK (grants_tier IN ('premium', 'founding')),
    duration_days INTEGER,          -- NULL = lifetime
    redeemed_by BIGINT,             -- NULL = unspent; the atomicity guard
    redeemed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupons_redeemed_by ON coupons (redeemed_by);

-- FEEDBACK — /feedback submissions. addFeedback() reads back `id` and shows it
-- to the user as "Feedback #N", so this is a serial, not a UUID. Keyed by
-- telegram_id (not users.id) because betaStats() joins on telegram_id.
CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    username VARCHAR(255),
    text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_telegram ON feedback (telegram_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);

-- CREATE INDEXES
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_onboarding_completed ON users(onboarding_completed);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
CREATE INDEX IF NOT EXISTS idx_users_current_streak ON users(current_streak);
CREATE INDEX IF NOT EXISTS idx_users_is_beta ON users(is_beta);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_date ON tasks(assigned_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_user_date_status ON tasks(user_id, assigned_date, status);

CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, date);
CREATE INDEX IF NOT EXISTS idx_checkins_type ON checkins(checkin_type);

CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_is_active ON memory(is_active);
CREATE INDEX IF NOT EXISTS idx_memory_user_active ON memory(user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_weekly_reviews_user_week ON weekly_reviews(user_id, week_number);

CREATE INDEX IF NOT EXISTS idx_socratic_logs_user_task ON socratic_logs(user_id, task_id);

-- CREATE CONSTRAINTS
-- `ADD CONSTRAINT IF NOT EXISTS` is not valid Postgres, so each one is guarded
-- by a catalog lookup instead — that is what makes re-running this file safe.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_task_date') THEN
        ALTER TABLE tasks ADD CONSTRAINT unique_user_task_date
            UNIQUE (user_id, title, assigned_date);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_date_checkin') THEN
        ALTER TABLE checkins ADD CONSTRAINT unique_user_date_checkin
            UNIQUE (user_id, date, checkin_type);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_user_week_review') THEN
        ALTER TABLE weekly_reviews ADD CONSTRAINT unique_user_week_review
            UNIQUE (user_id, week_number);
    END IF;
END $$;

-- CREATE FUNCTION FOR UPDATING TIMESTAMPS
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- CREATE TRIGGERS
-- CREATE TRIGGER has no IF NOT EXISTS before PG 14 and Supabase pins older
-- versions on some projects, so drop-then-create keeps this idempotent.
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_memory_updated_at ON memory;
CREATE TRIGGER update_memory_updated_at
    BEFORE UPDATE ON memory
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- VIEW FOR DAILY TASK COMPLETION
CREATE OR REPLACE VIEW daily_completion_view AS
SELECT 
    u.id as user_id,
    u.telegram_id,
    u.username,
    t.assigned_date,
    COUNT(t.id) as total_tasks,
    COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_tasks,
    COUNT(CASE WHEN t.status = 'skipped' THEN 1 END) as skipped_tasks,
    COUNT(CASE WHEN t.status = 'too_hard' THEN 1 END) as too_hard_tasks,
    ROUND(
        COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::DECIMAL / 
        NULLIF(COUNT(t.id), 0) * 100, 
        2
    ) as completion_rate
FROM users u
LEFT JOIN tasks t ON u.id = t.user_id 
    AND t.assigned_date = CURRENT_DATE
WHERE u.is_active = true
GROUP BY u.id, u.telegram_id, u.username, t.assigned_date;

-- VIEW FOR WEEKLY STATS
CREATE OR REPLACE VIEW weekly_stats_view AS
SELECT 
    u.id as user_id,
    u.telegram_id,
    DATE_TRUNC('week', t.assigned_date) as week_start,
    COUNT(t.id) as total_tasks,
    COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_tasks,
    COUNT(CASE WHEN t.status = 'skipped' THEN 1 END) as skipped_tasks
FROM users u
LEFT JOIN tasks t ON u.id = t.user_id
WHERE u.is_active = true
GROUP BY u.id, u.telegram_id, DATE_TRUNC('week', t.assigned_date);