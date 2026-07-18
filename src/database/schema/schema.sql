-- ATLAS Database Schema for Supabase
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- USERS TABLE
CREATE TABLE users (
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TASKS TABLE
CREATE TABLE tasks (
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
CREATE TABLE task_generation_locks (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, assigned_date)
);

-- CHECKINS TABLE
CREATE TABLE checkins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    checkin_type VARCHAR(50) DEFAULT 'daily' CHECK (checkin_type IN ('daily', 'socratic', 'stuck', 'checkin_midday', 'checkin_evening')),
    response TEXT,
    mood_rating INTEGER CHECK (mood_rating >= 1 AND mood_rating <= 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- MEMORY TABLE
CREATE TABLE memory (
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
CREATE TABLE weekly_reviews (
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
CREATE TABLE socratic_logs (
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

-- CREATE INDEXES
CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_onboarding_completed ON users(onboarding_completed);
CREATE INDEX idx_users_last_active ON users(last_active);
CREATE INDEX idx_users_current_streak ON users(current_streak);

CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_assigned_date ON tasks(assigned_date);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_user_date_status ON tasks(user_id, assigned_date, status);

CREATE INDEX idx_checkins_user_date ON checkins(user_id, date);
CREATE INDEX idx_checkins_type ON checkins(checkin_type);

CREATE INDEX idx_memory_user_id ON memory(user_id);
CREATE INDEX idx_memory_is_active ON memory(is_active);
CREATE INDEX idx_memory_user_active ON memory(user_id, is_active);

CREATE INDEX idx_weekly_reviews_user_week ON weekly_reviews(user_id, week_number);

CREATE INDEX idx_socratic_logs_user_task ON socratic_logs(user_id, task_id);

-- CREATE CONSTRAINTS
ALTER TABLE tasks 
    ADD CONSTRAINT unique_user_task_date 
    UNIQUE (user_id, title, assigned_date);

ALTER TABLE checkins 
    ADD CONSTRAINT unique_user_date_checkin 
    UNIQUE (user_id, date, checkin_type);

ALTER TABLE weekly_reviews 
    ADD CONSTRAINT unique_user_week_review 
    UNIQUE (user_id, week_number);

-- CREATE FUNCTION FOR UPDATING TIMESTAMPS
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- CREATE TRIGGERS
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tasks_updated_at 
    BEFORE UPDATE ON tasks 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_memory_updated_at 
    BEFORE UPDATE ON memory 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- VIEW FOR DAILY TASK COMPLETION
CREATE VIEW daily_completion_view AS
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
CREATE VIEW weekly_stats_view AS
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