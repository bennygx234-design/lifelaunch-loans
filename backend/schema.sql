-- ============================================================
-- LifeLaunch Loans — Supabase PostgreSQL Schema
-- ============================================================
-- Run this file in the Supabase SQL editor to initialise the
-- database.  Row-Level Security (RLS) is enabled on every
-- table so that users can only access their own data.
-- ============================================================

-- ─── Extensions ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Tables ─────────────────────────────────────────────────

-- users
-- Stores the public profile of each authenticated user.
-- The `id` column mirrors the UUID that Supabase Auth assigns
-- so we can join against auth.users without an extra lookup.
CREATE TABLE IF NOT EXISTS public.users (
    id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name           TEXT         NOT NULL,
    email          TEXT         NOT NULL UNIQUE,
    age            SMALLINT     CHECK (age > 0 AND age < 130),
    monthly_income NUMERIC(12, 2) CHECK (monthly_income >= 0),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.users IS 'Public profile data for each LifeLaunch user.';
COMMENT ON COLUMN public.users.id IS 'Mirrors auth.users.id so joins are trivial.';

-- loans
-- Each row represents one individual loan belonging to a user.
CREATE TABLE IF NOT EXISTS public.loans (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type            TEXT          NOT NULL CHECK (type IN ('student', 'auto', 'personal', 'business')),
    label           TEXT          NOT NULL,                          -- e.g. "Sallie Mae Undergraduate"
    principal       NUMERIC(14, 2) NOT NULL CHECK (principal > 0),  -- original loan amount
    rate            NUMERIC(6, 4)  NOT NULL CHECK (rate >= 0),      -- annual interest rate as decimal (e.g. 0.065 = 6.5%)
    term_months     SMALLINT       NOT NULL CHECK (term_months > 0),
    balance         NUMERIC(14, 2) NOT NULL CHECK (balance >= 0),   -- current outstanding balance
    monthly_payment NUMERIC(10, 2) NOT NULL CHECK (monthly_payment >= 0),
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.loans IS 'Individual loan records associated with a user.';
COMMENT ON COLUMN public.loans.rate IS 'Annual interest rate stored as a decimal fraction (0.065 = 6.5%).';

-- milestones
-- Tracks achievement unlocks (e.g. "Paid off first loan").
CREATE TABLE IF NOT EXISTS public.milestones (
    id             BIGSERIAL    PRIMARY KEY,
    user_id        UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    milestone_key  TEXT         NOT NULL,   -- e.g. 'first_payment', 'half_paid', 'debt_free'
    unlocked_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, milestone_key)         -- a milestone can only be unlocked once per user
);

COMMENT ON TABLE  public.milestones IS 'Gamification milestone achievements per user.';
COMMENT ON COLUMN public.milestones.milestone_key IS 'Stable identifier for the achievement type.';

-- repayment_plans
-- Stores the result of a repayment simulation for later retrieval.
CREATE TABLE IF NOT EXISTS public.repayment_plans (
    id         BIGSERIAL    PRIMARY KEY,
    user_id    UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    strategy   TEXT         NOT NULL CHECK (strategy IN ('snowball', 'avalanche', 'standard')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    plan_data  JSONB        NOT NULL DEFAULT '{}'   -- full simulation output
);

COMMENT ON TABLE  public.repayment_plans IS 'Saved repayment simulation results.';
COMMENT ON COLUMN public.repayment_plans.plan_data IS 'Full structured output from the repayment simulation engine.';

-- ─── Indexes ─────────────────────────────────────────────────

-- users
CREATE INDEX IF NOT EXISTS idx_users_email      ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON public.users (created_at DESC);

-- loans
CREATE INDEX IF NOT EXISTS idx_loans_user_id    ON public.loans (user_id);
CREATE INDEX IF NOT EXISTS idx_loans_type       ON public.loans (type);
CREATE INDEX IF NOT EXISTS idx_loans_balance    ON public.loans (balance);
CREATE INDEX IF NOT EXISTS idx_loans_created_at ON public.loans (created_at DESC);

-- milestones
CREATE INDEX IF NOT EXISTS idx_milestones_user_id      ON public.milestones (user_id);
CREATE INDEX IF NOT EXISTS idx_milestones_unlocked_at  ON public.milestones (unlocked_at DESC);

-- repayment_plans
CREATE INDEX IF NOT EXISTS idx_repayment_plans_user_id    ON public.repayment_plans (user_id);
CREATE INDEX IF NOT EXISTS idx_repayment_plans_strategy   ON public.repayment_plans (strategy);
CREATE INDEX IF NOT EXISTS idx_repayment_plans_created_at ON public.repayment_plans (created_at DESC);
-- GIN index for efficient JSONB queries on plan_data
CREATE INDEX IF NOT EXISTS idx_repayment_plans_plan_data  ON public.repayment_plans USING GIN (plan_data);

-- ─── Row-Level Security ──────────────────────────────────────
-- Enable RLS on all tables so that the Supabase anon/service
-- keys respect per-user data isolation.

ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repayment_plans ENABLE ROW LEVEL SECURITY;

-- ── users RLS ──────────────────────────────────────────────

-- Allow users to read their own profile row.
CREATE POLICY "users_select_own" ON public.users
    FOR SELECT
    USING (auth.uid() = id);

-- Allow users to insert their own profile row (uid must match).
CREATE POLICY "users_insert_own" ON public.users
    FOR INSERT
    WITH CHECK (auth.uid() = id);

-- Allow users to update their own profile row.
CREATE POLICY "users_update_own" ON public.users
    FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Deletion is intentionally not permitted for ordinary users.
-- A service-role call (or database admin) is required to delete accounts.

-- ── loans RLS ──────────────────────────────────────────────

CREATE POLICY "loans_select_own" ON public.loans
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "loans_insert_own" ON public.loans
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "loans_update_own" ON public.loans
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "loans_delete_own" ON public.loans
    FOR DELETE
    USING (auth.uid() = user_id);

-- ── milestones RLS ─────────────────────────────────────────

CREATE POLICY "milestones_select_own" ON public.milestones
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "milestones_insert_own" ON public.milestones
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Milestones are append-only; updates and deletes are not permitted.

-- ── repayment_plans RLS ────────────────────────────────────

CREATE POLICY "repayment_plans_select_own" ON public.repayment_plans
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "repayment_plans_insert_own" ON public.repayment_plans
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "repayment_plans_update_own" ON public.repayment_plans
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "repayment_plans_delete_own" ON public.repayment_plans
    FOR DELETE
    USING (auth.uid() = user_id);

-- ─── Helper function — upsert user profile on sign-up ────────
-- This function is invoked by a Supabase Database Webhook or
-- a trigger on auth.users so that a corresponding row in
-- public.users is created automatically after signup.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.users (id, email, name, created_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        NOW()
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- Trigger: fire after a new row is inserted into auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_auth_user();

-- ─── Seed milestone keys (informational reference) ───────────
-- These keys are used by the application layer. No data is
-- pre-inserted; they are unlocked programmatically.
--
-- 'first_payment'     — User makes their very first loan payment
-- 'half_paid'         — Any single loan reaches 50% paid off
-- 'paid_off_one'      — First loan fully paid off
-- 'three_months_streak' — Three consecutive on-time payments
-- 'debt_free'         — All loans have zero balance
-- 'snowball_starter'  — User runs their first snowball simulation
-- 'avalanche_starter' — User runs their first avalanche simulation
-- 'ai_advisor'        — User receives first AI advice

-- ─── End of schema ───────────────────────────────────────────
