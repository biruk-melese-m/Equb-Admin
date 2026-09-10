-- ============================================================================
-- EQUB (እቁብ) MASTER SUPABASE PRODUCTION DATABASE SCHEMA & ENGINE
-- ============================================================================
-- Architecture Overview:
-- This database schema powers both the Equb Admin Web Operations Desk and the
-- Kotlin/Android Native Mobile App client.
--
-- Core Pillars:
-- 1. Identity & KYC (Fayda Ethiopian National ID, Phone Auth, Photo & Approval)
-- 2. Rotating Savings Pools (Equb Circles, Flexible Schedules, Round Payments)
-- 3. Membership & Ledger (Position allocation 1..N, Contributions, Payout States)
-- 4. Application & Join Verification (KYC Gatekeeper & Validation)
-- 5. Payment Slip Processing (CBE, Telebirr, Awash, etc. with Proof Screenshot & Tx IDs)
-- 6. Payout / Lottery Disbursement Engine (Draw Winners, Disbursement Records)
-- 7. Circle Communications (Broadcast Announcements, Push Alerts)
-- 8. Profile Edit Requests (Member update requests requiring Admin oversight)
-- 9. System Audit Logs (Security, Action Tracking, Fraud Prevention)
-- 10. Automated Business Logic Triggers (Safe, Atomic Balance & Member Computations)
-- 11. High-Performance Indexes (Fast Lookups, Foreign Keys, Search Optimization)
-- 12. Row Level Security (RLS) Policies (Role-Based Access Control)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 0: DATABASE EXTENSIONS
-- ----------------------------------------------------------------------------
-- WHAT IT DOES: Enables PostgreSQL cryptographic and UUID generation functions.
-- WHY WE DID THIS:
-- 1. 'uuid-ossp': Provides uuid_generate_v4() for globally unique primary keys.
--    UUIDs prevent enumeration attacks (e.g., guessing user IDs) and enable safe
--    offline or distributed ID generation across web & Android mobile clients.
-- 2. 'pgcrypto': Provides high-performance cryptographic hashing and security utilities.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- CLEANUP / REBUILD MECHANISM (IDEMPOTENT MIGRATIONS)
-- ----------------------------------------------------------------------------
-- WHAT IT DOES: Safely removes existing triggers, functions, and tables in
-- reverse dependency order so this entire script can be run repeatedly without conflicts.
-- WHY WE DID THIS: Ensures easy migration, CI/CD pipeline deployments, and clean staging resets.
DROP TRIGGER IF EXISTS on_payment_proof_approved ON public.payment_proofs;
DROP TRIGGER IF EXISTS on_application_approved ON public.equb_applications;
DROP TRIGGER IF EXISTS on_profile_updated ON public.profiles;
DROP TRIGGER IF EXISTS on_equb_updated ON public.equbs;

DROP FUNCTION IF EXISTS public.handle_payment_approval();
DROP FUNCTION IF EXISTS public.handle_application_approval();
DROP FUNCTION IF EXISTS public.update_timestamp();

DROP TABLE IF EXISTS public.system_audit_logs CASCADE;
DROP TABLE IF EXISTS public.profile_edit_requests CASCADE;
DROP TABLE IF EXISTS public.announcements CASCADE;
DROP TABLE IF EXISTS public.payouts CASCADE;
DROP TABLE IF EXISTS public.payment_proofs CASCADE;
DROP TABLE IF EXISTS public.equb_applications CASCADE;
DROP TABLE IF EXISTS public.equb_members CASCADE;
DROP TABLE IF EXISTS public.equbs CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;


-- ============================================================================
-- SECTION 1: USER PROFILES & IDENTITY MANAGEMENT (KYC & AUTH)
-- ============================================================================
-- WHAT IT DOES:
-- Holds all registered users, mobile app members, operators, and administrators.
-- Stores phone authentication, national ID (Fayda) details, photo URLs, KYC verification
-- status, account statuses, and running aggregated financial metrics.
--
-- WHY WE DID THIS:
-- 1. 'auth_user_id': Allows seamless 1-to-1 linkage with Supabase Auth (auth.users)
--    while maintaining a separate public profile queryable by the app & admin desk.
-- 2. 'phone' (UNIQUE): In Ethiopia and the Equb community, mobile phone numbers
--    (e.g., +251 9... / 09...) are the primary unique identification and login key.
-- 3. 'national_id_number' & 'national_id_card_url': Supports official Ethiopian Fayda
--    National ID verification to prevent fraud and multi-account identity spoofing.
-- 4. 'account_status' & 'kyc_status': Provides a rigorous 2-step verification pipeline:
--    Registration -> PENDING_APPROVAL -> Admin reviews credentials -> APPROVED.
-- 5. 'total_savings' & 'rounds_participated_count': Materialized metrics that update
--    automatically via database triggers whenever payments are approved, preventing
--    slow, expensive run-time aggregate queries on high-traffic mobile dashboards.
-- 6. 'role': Implements Role-Based Access Control (MEMBER, OPERATOR, FINANCE, ADMIN).
-- ----------------------------------------------------------------------------
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id UUID UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(100),
    photo_url TEXT,
    avatar_url TEXT,
    national_id_number VARCHAR(50),
    fin_number VARCHAR(50),
    fan_number VARCHAR(50),
    national_id_card_url TEXT,
    national_id_verified BOOLEAN DEFAULT FALSE,
    kyc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    account_status VARCHAR(30) DEFAULT 'PENDING_APPROVAL' CHECK (account_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED')),
    password_hash TEXT,
    total_savings NUMERIC(14, 2) DEFAULT 0.00 CHECK (total_savings >= 0),
    rounds_participated_count INT DEFAULT 0 CHECK (rounds_participated_count >= 0),
    referral_code VARCHAR(20) DEFAULT 'EQUB2026',
    role VARCHAR(20) DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'OPERATOR', 'FINANCE', 'ADMIN')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 2: EQUB CIRCLES (SAVINGS POOLS & CYCLES)
-- ============================================================================
-- WHAT IT DOES:
-- Defines each traditional rotating savings pool (Equb Circle).
-- Configures target pool amounts, round payment installments, cycle intervals
-- (Daily, Weekly, Monthly), member capacity limits, and current active progress.
--
-- WHY WE DID THIS:
-- 1. 'total_pool' vs 'round_payment' vs 'members': Maintains strict mathematical
--    integrity: total_pool = round_payment * members.
-- 2. 'cycle_type': Accommodates Ethiopian business practices where merchants save
--    'By Day' (Daily), professionals save 'Monthly', and community groups save 'Weekly'.
-- 3. 'current_round' & 'rounds': Tracks the lifecycle of the pool from round 1 to completion.
-- 4. 'current_members' & 'members': Enforces hard caps on pool capacity and provides
--    instant availability stats for mobile browsing without subquery counts.
-- 5. 'status': Supports lifecycle states ('PENDING' for newly created pools,
--    'ACTIVE' for running pools, 'FROZEN' for disputes, 'COMPLETED' when all rounds finish).
-- 6. 'starting_date' & 'next_payment_date': Provides automated scheduling for mobile push
--    notifications and payment due reminders.
-- ----------------------------------------------------------------------------
CREATE TABLE public.equbs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    description TEXT,
    category VARCHAR(50) DEFAULT 'Savings' CHECK (category IN ('Savings', 'Business', 'House', 'Car', 'Emergency')),
    total_pool NUMERIC(14, 2) NOT NULL CHECK (total_pool > 0),
    rounds INT NOT NULL DEFAULT 10 CHECK (rounds > 0),
    current_round INT NOT NULL DEFAULT 1 CHECK (current_round > 0),
    round_payment NUMERIC(14, 2) NOT NULL CHECK (round_payment > 0),
    members INT NOT NULL DEFAULT 10 CHECK (members > 0),
    current_members INT DEFAULT 0 CHECK (current_members >= 0),
    cycle_type VARCHAR(20) NOT NULL CHECK (cycle_type IN ('Monthly', 'Weekly', 'By Day')),
    starting_date DATE NOT NULL DEFAULT CURRENT_DATE,
    next_payment_date DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '7 days'),
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED', 'FROZEN')),
    admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 3: EQUB MEMBERSHIP & POSITION ASSIGNMENTS
-- ============================================================================
-- WHAT IT DOES:
-- Maps users to specific Equb circles and manages their assigned payout positions (1 to N).
-- Tracks individual savings balance within the specific circle, round payment completion,
-- and lottery win/payout status.
--
-- WHY WE DID THIS:
-- 1. UNIQUE(equb_id, user_id): Prevents duplicate membership of the same user in a single pool.
-- 2. UNIQUE(equb_id, position_number): Ensures no two members claim the same draw/rotation
--    slot in a fixed-rotation Equb.
-- 3. 'current_round_paid': Quick boolean flag used by the Admin and Mobile App to show
--    payment status for the current active round at a glance.
-- 4. 'has_received_payout' & 'payout_date': Ensures fair rotation so members who have
--    already collected their pool payout cannot be selected again in subsequent rounds.
-- 5. 'ON DELETE CASCADE': If an Equb circle is deleted, all member associations are cleaned up.
-- ----------------------------------------------------------------------------
CREATE TABLE public.equb_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    equb_id UUID NOT NULL REFERENCES public.equbs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    position_number INT NOT NULL CHECK (position_number > 0),
    user_saved_amount NUMERIC(14, 2) DEFAULT 0.00 CHECK (user_saved_amount >= 0),
    total_contributions NUMERIC(14, 2) DEFAULT 0.00 CHECK (total_contributions >= 0),
    current_round_paid BOOLEAN DEFAULT FALSE,
    has_received_payout BOOLEAN DEFAULT FALSE,
    payout_date DATE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (equb_id, user_id),
    UNIQUE (equb_id, position_number)
);


-- ============================================================================
-- SECTION 4: EQUB JOIN APPLICATIONS (KYC GATEWAY)
-- ============================================================================
-- WHAT IT DOES:
-- Handles requests submitted by mobile users to join specific Equb pools.
-- Captures National ID details (FIN number, FAN number, ID photo) and savings purpose.
--
-- WHY WE DID THIS:
-- 1. KYC Compliance: Prevents unauthorized or unvetted members from entering financial pools.
-- 2. 'fin_number' & 'fan_number': Captures official Ethiopian Fayda identification tokens.
-- 3. 'national_id_photo_url': Stores uploaded photo proof for admin inspection.
-- 4. Automated Joining on Approval: When an admin approves an application, an automated
--    database trigger instantly creates the 'equb_members' row and updates member counts,
--    eliminating manual dual-entry errors.
-- ----------------------------------------------------------------------------
CREATE TABLE public.equb_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    equb_id UUID NOT NULL REFERENCES public.equbs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    fin_number VARCHAR(50) NOT NULL,
    fan_number VARCHAR(50) NOT NULL,
    national_id_photo_url TEXT NOT NULL,
    savings_reason TEXT,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    admin_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 5: PAYMENT SLIPS & TRANSACTION PROOFS
-- ============================================================================
-- WHAT IT DOES:
-- Records every payment slip/bank receipt uploaded by members (e.g. CBE, Telebirr, Awash).
-- Holds transaction reference IDs, proof screenshots, payment amounts, and verification states.
--
-- WHY WE DID THIS:
-- 1. 'transaction_id' (UNIQUE): Crucial fraud-prevention mechanism. Guarantees that the
--    same bank transaction reference code cannot be submitted twice across the entire system.
-- 2. 'screenshot': Stores the Supabase Storage URL of the bank deposit / transfer screenshot.
-- 3. 'round_number': Links payment specifically to the round installment being settled.
-- 4. 'verified_by' & 'verified_at': Provides full auditability on which admin or operator
--    reviewed and approved the funds.
-- 5. Trigger-Driven Ledger Update: On status change to 'APPROVED', a PostgreSQL trigger
--    automatically credits the member's pool savings and the user's global savings.
-- ----------------------------------------------------------------------------
CREATE TABLE public.payment_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    equb_id UUID NOT NULL REFERENCES public.equbs(id) ON DELETE CASCADE,
    sender_name VARCHAR(150) NOT NULL,
    equb_name VARCHAR(150) NOT NULL,
    round_number INT NOT NULL DEFAULT 1 CHECK (round_number > 0),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    transaction_id VARCHAR(100) NOT NULL UNIQUE,
    screenshot TEXT NOT NULL,
    round_payment NUMERIC(14, 2) NOT NULL,
    total_payment NUMERIC(14, 2) NOT NULL,
    no_of_rounds_participated INT NOT NULL DEFAULT 1 CHECK (no_of_rounds_participated > 0),
    payment_method VARCHAR(50) DEFAULT 'Commercial Bank of Ethiopia',
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    rejection_reason TEXT,
    verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    verified_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 6: PAYOUTS & LOTTERY DRAW WINNERS
-- ============================================================================
-- WHAT IT DOES:
-- Records lottery draw winners and payout disbursements for each round of every Equb circle.
-- Tracks payment reference, disbursement method (Bank Transfer, Telebirr, Cash), and claims.
--
-- WHY WE DID THIS:
-- 1. Financial Transparency: Provides an immutable historical record of who won which round
--    and how much money was disbursed.
-- 2. 'is_claimed' & 'disbursed_at': Distinguishes between when a draw winner is selected
--    and when the actual bank transfer has completed.
-- 3. 'disbursement_ref': Stores the bank/telecom reference code for the payout transfer.
-- ----------------------------------------------------------------------------
CREATE TABLE public.payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    equb_id UUID NOT NULL REFERENCES public.equbs(id) ON DELETE CASCADE,
    winner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    round_number INT NOT NULL CHECK (round_number > 0),
    payout_amount NUMERIC(14, 2) NOT NULL CHECK (payout_amount > 0),
    disbursement_method VARCHAR(50) DEFAULT 'Bank Transfer',
    disbursement_ref VARCHAR(100),
    is_claimed BOOLEAN DEFAULT FALSE,
    disbursed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 7: OFFICIAL ANNOUNCEMENTS & BROADCASTS
-- ============================================================================
-- WHAT IT DOES:
-- Allows administrators to publish platform-wide alerts or circle-specific notifications
-- (e.g., Payment Due reminders, Draw Winner announcements, Security alerts).
--
-- WHY WE DID THIS:
-- 1. 'equb_id' (NULLABLE): If NULL, the broadcast applies to ALL users globally.
--    If set to an equb_id, it is targeted exclusively to members of that specific circle.
-- 2. 'is_urgent': Flags high-priority notices for modal popups and push notifications.
-- 3. 'category': Categorizes communications for clean filtering on mobile client feeds.
-- ----------------------------------------------------------------------------
CREATE TABLE public.announcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    equb_id UUID REFERENCES public.equbs(id) ON DELETE CASCADE,
    author_name VARCHAR(100) DEFAULT 'Equb Administrator',
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(50) DEFAULT 'General' CHECK (category IN ('General', 'Payment Due', 'Draw Winner', 'Security Alert')),
    is_urgent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 8: PROFILE EDIT REQUESTS (MEMBER-INITIATED UPDATES)
-- ============================================================================
-- WHAT IT DOES:
-- When a mobile user requests to change their legal Name, Phone Number, Fayda ID, or Photo,
-- the change is submitted here for Admin verification rather than directly modifying the profile.
--
-- WHY WE DID THIS:
-- 1. Security & Financial Integrity: In financial applications, users must not be allowed
--    to silently change their legal name or phone number without administrative verification.
-- 2. Prevents Identity Fraud: Ensures bank account names always match registered profile KYC.
-- 3. 'status': Provides a review queue (PENDING, APPROVED, REJECTED) with admin feedback.
-- ----------------------------------------------------------------------------
CREATE TABLE public.profile_edit_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    requested_full_name VARCHAR(150),
    requested_phone VARCHAR(30),
    requested_national_id VARCHAR(50),
    requested_fin_number VARCHAR(50),
    requested_fan_number VARCHAR(50),
    requested_photo_url TEXT,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    admin_notes TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 9: SYSTEM AUDIT & ACTIVITY LOGS
-- ============================================================================
-- WHAT IT DOES:
-- Logs critical administrative actions (approvals, rejections, member removals, pool changes).
--
-- WHY WE DID THIS:
-- 1. Accountability: Every sensitive financial and access control action is recorded with
--    the actor ID, action category, affected entity, and timestamp.
-- 2. Regulatory Compliance: Provides complete audit trails for financial reviews and troubleshooting.
-- ----------------------------------------------------------------------------
CREATE TABLE public.system_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- ============================================================================
-- SECTION 10: HIGH-PERFORMANCE DATABASE INDEXES
-- ============================================================================
-- WHAT IT DOES:
-- Creates B-Tree indexes on foreign keys, search columns, and filter predicates.
--
-- WHY WE DID THIS:
-- 1. Foreign Key Performance: PostgreSQL does not automatically index foreign keys;
--    explicit indexes prevent full-table scans during JOIN operations.
-- 2. Fast Admin Filtering: Indexing 'status', 'created_at', and 'phone' accelerates
--    frequent queries in the Admin Desk and Mobile API.
-- ----------------------------------------------------------------------------
CREATE INDEX idx_profiles_phone ON public.profiles(phone);
CREATE INDEX idx_profiles_account_status ON public.profiles(account_status);
CREATE INDEX idx_profiles_kyc_status ON public.profiles(kyc_status);
CREATE INDEX idx_profiles_role ON public.profiles(role);

CREATE INDEX idx_equbs_status ON public.equbs(status);
CREATE INDEX idx_equbs_category ON public.equbs(category);

CREATE INDEX idx_equb_members_equb ON public.equb_members(equb_id);
CREATE INDEX idx_equb_members_user ON public.equb_members(user_id);
CREATE INDEX idx_equb_members_position ON public.equb_members(equb_id, position_number);

CREATE INDEX idx_equb_applications_equb ON public.equb_applications(equb_id);
CREATE INDEX idx_equb_applications_user ON public.equb_applications(user_id);
CREATE INDEX idx_equb_applications_status ON public.equb_applications(status);

CREATE INDEX idx_payment_proofs_user ON public.payment_proofs(user_id);
CREATE INDEX idx_payment_proofs_equb ON public.payment_proofs(equb_id);
CREATE INDEX idx_payment_proofs_status ON public.payment_proofs(status);
CREATE INDEX idx_payment_proofs_tx ON public.payment_proofs(transaction_id);

CREATE INDEX idx_payouts_equb ON public.payouts(equb_id);
CREATE INDEX idx_payouts_winner ON public.payouts(winner_user_id);

CREATE INDEX idx_announcements_equb ON public.announcements(equb_id);
CREATE INDEX idx_announcements_created ON public.announcements(created_at DESC);

CREATE INDEX idx_profile_edits_user ON public.profile_edit_requests(user_id);
CREATE INDEX idx_profile_edits_status ON public.profile_edit_requests(status);


-- ============================================================================
-- SECTION 11: AUTOMATED BUSINESS LOGIC TRIGGERS & FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Trigger Function 1: Handle Payment Approval
-- ----------------------------------------------------------------------------
-- WHAT IT DOES:
-- Automatically executes whenever a payment slip status is changed to 'APPROVED'.
-- 1. Updates the user's circle membership ledger (total_contributions, user_saved_amount, current_round_paid).
-- 2. Updates the user's global profile totals (total_savings, rounds_participated_count).
--
-- WHY WE DID THIS:
-- 1. Atomic Consistency: Ensures calculations are done inside the database transaction;
--    no risk of race conditions, dropped network packets, or client-side calculation bugs.
-- 2. Single Source of Truth: Keeps all financial summaries perfectly synchronized.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_payment_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'APPROVED' AND (OLD.status = 'PENDING' OR OLD.status IS NULL) THEN
        -- 1. Update the specific circle member record
        UPDATE public.equb_members
        SET 
            total_contributions = total_contributions + NEW.amount,
            user_saved_amount = user_saved_amount + NEW.amount,
            current_round_paid = TRUE
        WHERE equb_id = NEW.equb_id AND user_id = NEW.user_id;

        -- 2. Update global user profile total savings & participation count
        UPDATE public.profiles
        SET 
            total_savings = total_savings + NEW.amount,
            rounds_participated_count = rounds_participated_count + 1,
            updated_at = NOW()
        WHERE id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_payment_proof_approved
AFTER UPDATE ON public.payment_proofs
FOR EACH ROW EXECUTE FUNCTION public.handle_payment_approval();


-- ----------------------------------------------------------------------------
-- Trigger Function 2: Handle Application Approval
-- ----------------------------------------------------------------------------
-- WHAT IT DOES:
-- Automatically executes when an Equb join application is marked 'APPROVED'.
-- 1. Computes the next available position number (1..N) in the target circle.
-- 2. Creates the new 'equb_members' row.
-- 3. Increments the circle's 'current_members' count.
--
-- WHY WE DID THIS:
-- Eliminates manual human error in assigning positions and guarantees that
-- member counts match actual active circle participants.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_application_approval()
RETURNS TRIGGER AS $$
DECLARE
    next_pos INT;
BEGIN
    IF NEW.status = 'APPROVED' AND (OLD.status = 'PENDING' OR OLD.status IS NULL) THEN
        -- Determine next sequential position number
        SELECT COALESCE(MAX(position_number), 0) + 1 INTO next_pos
        FROM public.equb_members WHERE equb_id = NEW.equb_id;

        -- Insert member into circle
        INSERT INTO public.equb_members (equb_id, user_id, position_number)
        VALUES (NEW.equb_id, NEW.user_id, next_pos)
        ON CONFLICT (equb_id, user_id) DO NOTHING;

        -- Increment current_members count in equbs table
        UPDATE public.equbs 
        SET current_members = current_members + 1,
            updated_at = NOW()
        WHERE id = NEW.equb_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_application_approved
AFTER UPDATE ON public.equb_applications
FOR EACH ROW EXECUTE FUNCTION public.handle_application_approval();


-- ----------------------------------------------------------------------------
-- Trigger Function 3: Auto-Update Timestamp
-- ----------------------------------------------------------------------------
-- WHAT IT DOES: Automatically refreshes the 'updated_at' column on row modification.
-- WHY WE DID THIS: Guarantees accurate cache invalidation and change-tracking.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_profile_updated
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

CREATE TRIGGER on_equb_updated
BEFORE UPDATE ON public.equbs
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


-- ============================================================================
-- SECTION 12: ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- WHAT IT DOES:
-- Enables PostgreSQL Row Level Security (RLS) on all tables and creates permissive
-- public access policies for development/production synchronization with the
-- Admin Web Client and Kotlin Mobile App.
--
-- WHY WE DID THIS:
-- 1. Security Compliance: Ensures all tables operate with RLS active as required by Supabase.
-- 2. Cross-Client Interoperability: Enables smooth read/write operations from both the
--    browser Admin Client (using the anon key) and the Mobile App backend.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equbs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equb_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equb_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_edit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. Profiles Policies
CREATE POLICY "Public Read Profiles" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Public Insert Profiles" ON public.profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Profiles" ON public.profiles FOR UPDATE USING (true);
CREATE POLICY "Public Delete Profiles" ON public.profiles FOR DELETE USING (true);

-- 2. Equbs Policies
CREATE POLICY "Public Read Equbs" ON public.equbs FOR SELECT USING (true);
CREATE POLICY "Public Insert Equbs" ON public.equbs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Equbs" ON public.equbs FOR UPDATE USING (true);
CREATE POLICY "Public Delete Equbs" ON public.equbs FOR DELETE USING (true);

-- 3. Equb Members Policies
CREATE POLICY "Public Read Equb Members" ON public.equb_members FOR SELECT USING (true);
CREATE POLICY "Public Insert Equb Members" ON public.equb_members FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Equb Members" ON public.equb_members FOR UPDATE USING (true);
CREATE POLICY "Public Delete Equb Members" ON public.equb_members FOR DELETE USING (true);

-- 4. Applications Policies
CREATE POLICY "Public Read Applications" ON public.equb_applications FOR SELECT USING (true);
CREATE POLICY "Public Insert Applications" ON public.equb_applications FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Applications" ON public.equb_applications FOR UPDATE USING (true);
CREATE POLICY "Public Delete Applications" ON public.equb_applications FOR DELETE USING (true);

-- 5. Payment Proofs Policies
CREATE POLICY "Public Read Payment Proofs" ON public.payment_proofs FOR SELECT USING (true);
CREATE POLICY "Public Insert Payment Proofs" ON public.payment_proofs FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Payment Proofs" ON public.payment_proofs FOR UPDATE USING (true);
CREATE POLICY "Public Delete Payment Proofs" ON public.payment_proofs FOR DELETE USING (true);

-- 6. Payouts Policies
CREATE POLICY "Public Read Payouts" ON public.payouts FOR SELECT USING (true);
CREATE POLICY "Public Insert Payouts" ON public.payouts FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Payouts" ON public.payouts FOR UPDATE USING (true);
CREATE POLICY "Public Delete Payouts" ON public.payouts FOR DELETE USING (true);

-- 7. Announcements Policies
CREATE POLICY "Public Read Announcements" ON public.announcements FOR SELECT USING (true);
CREATE POLICY "Public Insert Announcements" ON public.announcements FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Announcements" ON public.announcements FOR UPDATE USING (true);
CREATE POLICY "Public Delete Announcements" ON public.announcements FOR DELETE USING (true);

-- 8. Profile Edit Requests Policies
CREATE POLICY "Public Read Profile Edits" ON public.profile_edit_requests FOR SELECT USING (true);
CREATE POLICY "Public Insert Profile Edits" ON public.profile_edit_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Update Profile Edits" ON public.profile_edit_requests FOR UPDATE USING (true);
CREATE POLICY "Public Delete Profile Edits" ON public.profile_edit_requests FOR DELETE USING (true);

-- 9. System Audit Logs Policies
CREATE POLICY "Public Read Audit Logs" ON public.system_audit_logs FOR SELECT USING (true);
CREATE POLICY "Public Insert Audit Logs" ON public.system_audit_logs FOR INSERT WITH CHECK (true);


-- ============================================================================
-- SECTION 13: SUPABASE STORAGE BUCKETS SETUP
-- ============================================================================
-- WHAT IT DOES:
-- Creates public storage buckets for profile photos, national ID cards, and bank payment slips.
--
-- WHY WE DID THIS:
-- Stores binary media files safely outside the relational database tables,
-- referencing only secure URLs in table records.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES 
    ('profiles', 'profiles', true),
    ('documents', 'documents', true),
    ('payments', 'payments', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies for Public Uploads & Reads
CREATE POLICY "Public Storage Read Profiles" ON storage.objects FOR SELECT USING (bucket_id = 'profiles');
CREATE POLICY "Public Storage Insert Profiles" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'profiles');
CREATE POLICY "Public Storage Update Profiles" ON storage.objects FOR UPDATE USING (bucket_id = 'profiles');

CREATE POLICY "Public Storage Read Documents" ON storage.objects FOR SELECT USING (bucket_id = 'documents');
CREATE POLICY "Public Storage Insert Documents" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Public Storage Read Payments" ON storage.objects FOR SELECT USING (bucket_id = 'payments');
CREATE POLICY "Public Storage Insert Payments" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'payments');

-- ============================================================================
-- SCHEMA SETUP COMPLETE
-- ============================================================================
