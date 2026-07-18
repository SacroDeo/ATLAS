-- 004: consent timestamp for privacy policy + terms agreement during onboarding
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMP WITH TIME ZONE;
