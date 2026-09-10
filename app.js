/* ==========================================================================
   EQUB (እቁብ) OPERATIONS DESK — MASTER APPLICATION & BACKEND INTEGRATION ENGINE
   ==========================================================================
   Architecture Overview:
   This unified script orchestrates the entire Equb Admin Web Operations Desk,
   interfacing directly with the Supabase PostgreSQL backend in real-time.

   Module Structure:
   ├── MODULE 1: Supabase Client SDK Initialization & Diagnostics
   ├── MODULE 2: EqubAPI Data Access Layer (CRUD, Ledger, KYC, Approvals)
   │   ├── 2.1 Profiles & Members Authentication / KYC Management
   │   ├── 2.2 Equb Circles / Savings Pools Lifecycle Management
   │   ├── 2.3 Equb Membership & Position Allocation Ledger
   │   ├── 2.4 Equb Applications & KYC Join Gateway
   │   ├── 2.5 Payment Slips & Bank Receipt Processing
   │   ├── 2.6 Announcements & Broadcast Communications
   │   ├── 2.7 Payouts & Lottery Winner Records
   │   └── 2.8 Profile Edit Requests Queue
   ├── MODULE 3: Reactive Application State Container
   ├── MODULE 4: UI & Data Formatting Utility Functions
   ├── MODULE 5: Data Transformers & Normalization Layer
   ├── MODULE 6: Data Synchronization & Supabase Realtime Engine
   ├── MODULE 7: Dynamic SPA View Renderers (Screens)
   ├── MODULE 8: Modal Dialog Builders & Inspectors
   ├── MODULE 9: Interactive Event Listeners & Delegation Handlers
   └── MODULE 10: Application Bootstrap & Initialization
   ========================================================================== */

// --------------------------------------------------------------------------
// MODULE 1: SUPABASE CLIENT SDK INITIALIZATION & HEALTH CHECK
// --------------------------------------------------------------------------

/** Supabase Project REST / Realtime Endpoint */
const SUPABASE_URL = "https://mzhhrkwnrrhclbtiszfv.supabase.co";

/** Supabase Public Anon Key (Row-Level-Security Enforced) */
const SUPABASE_ANON_KEY = "sb_publishable_DX0A-0wK3t027pwVsAKiSg_nniWUANw";

/** Global singleton reference to Supabase client */
let supabaseClient = null;

/** Registry of logged schema notices to avoid repetitive console output */
const tableWarningLogged = {};

/**
 * Initializes and configures the Supabase JS Client with Realtime support.
 * @returns {object|null} Initialized Supabase client instance or null if CDN missing.
 */
function initSupabase() {
  if (supabaseClient) return supabaseClient;
  if (window.supabase) {
    try {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        realtime: { params: { eventsPerSecond: 10 } }
      });
      window.supabaseClient = supabaseClient;
      console.log("[Equb Admin] Supabase Client Initialized:", SUPABASE_URL);
      return supabaseClient;
    } catch (e) {
      console.warn("[Equb Admin] Supabase initialization error:", e);
    }
  } else {
    console.warn("[Equb Admin] Supabase CDN script not yet loaded or missing.");
  }
  return null;
}

// Auto-initialize immediately on DOM load
if (typeof window !== 'undefined') {
  if (window.supabase) {
    initSupabase();
  } else {
    window.addEventListener('load', initSupabase);
    document.addEventListener('DOMContentLoaded', initSupabase);
  }
}

/**
 * Retrieves or lazily instantiates the active Supabase client.
 * @returns {object|null} Active Supabase client
 */
function getSupabase() {
  if (!supabaseClient) {
    initSupabase();
  }
  return supabaseClient;
}

/**
 * Determines whether the browser is currently offline.
 * @returns {boolean} True if navigator reports offline status.
 */
function isNetworkOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Set of table names that do not yet exist in the active PostgreSQL database */
const missingTables = new Set();

/**
 * Gracefully handles database errors and logs actionable schema diagnostics.
 * @param {string} tableName - Name of the queried table
 * @param {object} error - PostgreSQL / PostgREST error object
 */
function handleTableError(tableName, error) {
  if (!error) return;
  // 404 (schema cache miss) or 42P01 (relation does not exist)
  const isMissing = error.code === '42P01'
    || (error.message && error.message.includes("in the schema cache"))
    || (error.status === 404);
  if (isMissing) {
    missingTables.add(tableName);
    if (!tableWarningLogged[tableName]) {
      console.info(`[Database Notice] Table '${tableName}' does not exist in Supabase yet. Run the SQL in database.sql to create it.`);
      tableWarningLogged[tableName] = true;
    }
    return;
  }
  if (!isNetworkOffline() && !tableWarningLogged[`err_${tableName}`]) {
    console.warn(`[Equb Admin] ${tableName} query:`, error.message);
  }
}

// --------------------------------------------------------------------------
// MODULE 2: DATABASE API DATA ACCESS LAYER (EqubAPI)
// --------------------------------------------------------------------------
const EqubAPI = {
  // ───────────────────────────────────────────
  // 1. MEMBERS / PROFILES (FULL CONTROL)
  // ───────────────────────────────────────────
  async getProfiles() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { handleTableError('profiles', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async getProfileById(userId) {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return null;
    try {
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (error) return null;
      return data;
    } catch (e) {
      return null;
    }
  },

  async createProfile(profileData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('profiles').insert([profileData]);
    if (error) {
      if (error.code === '23505' || error.message.includes('profiles_phone_key') || error.message.includes('duplicate')) {
        throw new Error(`Phone number "${profileData.phone}" is already registered. You can manage or update their password in the Members Directory.`);
      }
      throw error;
    }
    // Fetch the created profile by phone (unique)
    const { data: rows } = await client.from('profiles').select('*').eq('phone', profileData.phone).limit(1);
    return rows?.[0] || profileData;
  },

  async updateFullProfile(userId, profileData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const payload = { ...profileData, updated_at: new Date().toISOString() };
    let { error } = await client.from('profiles').update(payload).eq('id', userId);
    if (error) {
      console.warn("Retrying profile update with core fields:", error.message);
      const fallbackPayload = {
        full_name: profileData.full_name,
        phone: profileData.phone,
        email: profileData.email,
        national_id_number: profileData.national_id_number,
        photo_url: profileData.photo_url,
        avatar_url: profileData.photo_url,
        role: profileData.role,
        account_status: profileData.account_status,
        kyc_status: profileData.kyc_status,
        password_hash: profileData.password_hash,
        total_savings: profileData.total_savings,
        updated_at: new Date().toISOString()
      };
      Object.keys(fallbackPayload).forEach(k => fallbackPayload[k] === undefined && delete fallbackPayload[k]);
      const res = await client.from('profiles').update(fallbackPayload).eq('id', userId);
      if (res.error) throw res.error;
    }
    return await this.getProfileById(userId);
  },

  async updateAccountStatus(userId, status, password = null) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const updatePayload = {
      account_status: status,
      kyc_status: status === 'APPROVED' ? 'APPROVED' : (status === 'SUSPENDED' ? 'SUSPENDED' : 'REJECTED'),
      updated_at: new Date().toISOString()
    };
    if (password) updatePayload.password_hash = password;
    const { error } = await client.from('profiles').update(updatePayload).eq('id', userId);
    if (error) throw error;
    return await this.getProfileById(userId);
  },

  async updatePassword(userId, newPassword) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('profiles').update({ password_hash: newPassword, updated_at: new Date().toISOString() }).eq('id', userId);
    if (error) throw error;
    return await this.getProfileById(userId);
  },

  async deleteProfile(userId) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { data, error } = await client
      .from('profiles')
      .delete()
      .eq('id', userId);
    if (error) throw error;
    return true;
  },

  async uploadProfilePhoto(file, userId = null) {
    const client = getSupabase();
    if (!client || !file) return null;
    try {
      const fileExt = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
      const fileName = `${userId || 'member'}_${Date.now()}.${fileExt}`;
      const filePath = `avatars/${fileName}`;

      const { data, error } = await client.storage
        .from('profiles')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: true
        });

      if (error) {
        console.warn("Profiles bucket upload notice:", error.message || error);
        return null;
      }

      const { data: urlData } = client.storage
        .from('profiles')
        .getPublicUrl(filePath);

      return urlData ? urlData.publicUrl : null;
    } catch (e) {
      console.warn("Storage upload exception:", e);
      return null;
    }
  },

  // ───────────────────────────────────────────
  // 2. EQUBS (CIRCLES) (FULL CONTROL & CUSTOMIZATION)
  // ───────────────────────────────────────────
  async getEqubs() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('equbs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { handleTableError('equbs', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async getEqubById(equbId) {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return null;
    try {
      const { data, error } = await client
        .from('equbs')
        .select('*')
        .eq('id', equbId)
        .single();
      if (error) return null;
      return data;
    } catch (e) {
      return null;
    }
  },

  async createEqub(equbData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const payload = {
      name: equbData.name,
      description: equbData.description || null,
      category: equbData.category || 'Savings',
      total_pool: parseFloat(equbData.total_pool) || 0,
      rounds: parseInt(equbData.rounds) || 10,
      current_round: parseInt(equbData.current_round) || 1,
      round_payment: parseFloat(equbData.round_payment) || 0,
      members: parseInt(equbData.members) || 10,
      current_members: 0,
      cycle_type: equbData.cycle_type || 'Weekly',
      starting_date: equbData.starting_date || new Date().toISOString().split('T')[0],
      status: equbData.status || 'ACTIVE'
    };
    if (equbData.next_payment_date && equbData.next_payment_date.trim && equbData.next_payment_date.trim() !== '') {
      payload.next_payment_date = equbData.next_payment_date;
    } else if (equbData.starting_date) {
      payload.next_payment_date = equbData.starting_date;
    }
    const { error } = await client.from('equbs').insert([payload]);
    if (error) throw error;
    // Fetch the newly inserted row
    const { data: rows } = await client.from('equbs').select('*').eq('name', payload.name).order('created_at', { ascending: false }).limit(1);
    return rows?.[0] || payload;
  },

  async updateEqub(equbId, equbData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const payload = {
      name: equbData.name,
      category: equbData.category,
      total_pool: parseFloat(equbData.total_pool) || 0,
      round_payment: parseFloat(equbData.round_payment) || 0,
      rounds: parseInt(equbData.rounds) || 10,
      current_round: parseInt(equbData.current_round) || 1,
      cycle_type: equbData.cycle_type,
      status: equbData.status,
      starting_date: equbData.starting_date,
      next_payment_date: equbData.next_payment_date ? equbData.next_payment_date : equbData.starting_date,
      updated_at: new Date().toISOString()
    };
    const { error } = await client.from('equbs').update(payload).eq('id', equbId);
    if (error) throw error;
    return await this.getEqubById(equbId);
  },

  async updateEqubStatus(equbId, status) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('equbs').update({ status, updated_at: new Date().toISOString() }).eq('id', equbId);
    if (error) throw error;
    return await this.getEqubById(equbId);
  },

  async deleteEqub(equbId) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { data, error } = await client
      .from('equbs')
      .delete()
      .eq('id', equbId);
    if (error) throw error;
    return true;
  },

  // ───────────────────────────────────────────
  // 3. EQUB MEMBERSHIP & POSITION ASSIGNMENT
  // ───────────────────────────────────────────
  async getEqubMembers(equbId) {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('equb_members')
        .select('*, profiles:user_id(id, full_name, phone, email, national_id_number, total_savings)')
        .eq('equb_id', equbId)
        .order('position_number', { ascending: true });
      if (error) { handleTableError('equb_members', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async addMemberToEqub(equbId, userId, positionNumber = null, initialSavings = 0) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");

    let pos = positionNumber;
    if (!pos) {
      const members = await this.getEqubMembers(equbId);
      pos = members.length + 1;
    }

    const payload = {
      equb_id: equbId,
      user_id: userId,
      position_number: pos,
      user_saved_amount: initialSavings,
      total_contributions: initialSavings,
      current_round_paid: false,
      has_received_payout: false
    };

    const { error } = await client.from('equb_members').insert([payload]);
    if (error) throw error;

    try {
      const members = await this.getEqubMembers(equbId);
      await client.from('equbs').update({ current_members: members.length }).eq('id', equbId);
    } catch (e) {}

    return payload;
  },

  async removeMemberFromEqub(equbId, userId) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { data, error } = await client
      .from('equb_members')
      .delete()
      .eq('equb_id', equbId)
      .eq('user_id', userId);
    if (error) throw error;

    try {
      const members = await this.getEqubMembers(equbId);
      await client.from('equbs').update({ current_members: members.length }).eq('id', equbId);
    } catch (e) {}

    return true;
  },

  async updateEqubMember(equbId, userId, updateData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('equb_members').update(updateData).eq('equb_id', equbId).eq('user_id', userId);
    if (error) throw error;
    return updateData;
  },

  // ───────────────────────────────────────────
  // 4. EQUB APPLICATIONS / JOIN REQUESTS (KYC GATE)
  // ───────────────────────────────────────────
  async getEqubApplications() {
    const client = getSupabase();
    if (!client || isNetworkOffline() || missingTables.has('equb_applications')) return [];
    try {
      const { data, error } = await client
        .from('equb_applications')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { handleTableError('equb_applications', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async approveApplication(appId) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('equb_applications').update({ status: 'APPROVED' }).eq('id', appId);
    if (error) throw error;
    return { id: appId, status: 'APPROVED' };
  },

  async rejectApplication(appId, adminNotes = "Application declined by administrator") {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('equb_applications').update({ status: 'REJECTED', admin_notes: adminNotes }).eq('id', appId);
    if (error) throw error;
    return { id: appId, status: 'REJECTED' };
  },

  // ───────────────────────────────────────────
  // 5. PAYMENT PROOFS / SLIPS
  // ───────────────────────────────────────────
  async getPaymentProofs() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('payment_proofs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { handleTableError('payment_proofs', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async getMemberPaymentHistory(userId) {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('payment_proofs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) { handleTableError('payment_proofs', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async submitPaymentSlip(slipData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const payload = {
      user_id: slipData.user_id,
      equb_id: slipData.equb_id,
      sender_name: slipData.sender_name,
      equb_name: slipData.equb_name,
      round_number: slipData.no_of_rounds_participated || 1,
      amount: slipData.amount,
      transaction_id: slipData.transaction_id,
      screenshot: slipData.screenshot,
      round_payment: slipData.round_payment,
      total_payment: slipData.total_payment,
      no_of_rounds_participated: slipData.no_of_rounds_participated,
      payment_method: slipData.payment_method || 'Commercial Bank of Ethiopia',
      status: 'PENDING'
    };
    const { error } = await client.from('payment_proofs').insert([payload]);
    if (error) throw error;
    return payload;
  },

  async verifyPaymentProof(slipId, status, rejectionReason = null) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('payment_proofs').update({ status, rejection_reason: rejectionReason, verified_at: new Date().toISOString() }).eq('id', slipId);
    if (error) throw error;
    return { id: slipId, status };
  },

  // ───────────────────────────────────────────
  // 6. ANNOUNCEMENTS
  // ───────────────────────────────────────────
  async getAnnouncements() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client.from('announcements').select('*').order('created_at', { ascending: false });
      if (error) { handleTableError('announcements', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async createAnnouncement(announcementData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const isUrgent = announcementData.is_urgent === true || announcementData.urgency === true || announcementData.urgency === "true";
    const payload = {
      title: announcementData.title,
      content: announcementData.content || announcementData.message || "",
      category: announcementData.category || 'General',
      is_urgent: isUrgent,
      author_name: announcementData.author_name || 'Equb Operations Desk'
    };
    
    let { data, error } = await client.from('announcements').insert([payload]).select();
    if (error) {
      console.warn("Announcement insert notice, retrying with flexible fields:", error.message);
      // Retry without is_urgent or author_name if columns differ in Supabase
      const flexiblePayload = {
        title: payload.title,
        content: payload.content,
        category: payload.category
      };
      const res = await client.from('announcements').insert([flexiblePayload]).select();
      if (res.error) throw res.error;
      return res.data?.[0] || payload;
    }
    return data?.[0] || payload;
  },

  // ───────────────────────────────────────────
  // 7. PAYOUTS
  // ───────────────────────────────────────────
  async recordPayout(payoutData) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client.from('payouts').insert([payoutData]);
    if (error) throw error;
    return payoutData;
  },

  async getPayouts() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client.from('payouts').select('*').order('created_at', { ascending: false });
      if (error) { handleTableError('payouts', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  // ───────────────────────────────────────────
  // 8. PROFILE EDIT REQUESTS (MEMBER PROFILE CHANGES)
  // ───────────────────────────────────────────
  async getProfileEditRequests() {
    const client = getSupabase();
    if (!client || isNetworkOffline()) return [];
    try {
      const { data, error } = await client
        .from('profile_edit_requests')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) { handleTableError('profile_edit_requests', error); return []; }
      return data || [];
    } catch (e) {
      return [];
    }
  },

  async approveProfileEditRequest(requestId) {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { data: req, error: reqErr } = await client
      .from('profile_edit_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    if (reqErr || !req) throw new Error("Edit request not found");

    const profileUpdates = {
      updated_at: new Date().toISOString()
    };
    if (req.requested_full_name) profileUpdates.full_name = req.requested_full_name;
    if (req.requested_phone) profileUpdates.phone = req.requested_phone;
    if (req.requested_national_id) profileUpdates.national_id_number = req.requested_national_id;
    if (req.requested_fin_number) profileUpdates.fin_number = req.requested_fin_number;
    if (req.requested_fan_number) profileUpdates.fan_number = req.requested_fan_number;
    if (req.requested_photo_url) {
      profileUpdates.photo_url = req.requested_photo_url;
      profileUpdates.avatar_url = req.requested_photo_url;
    }

    // Update member profile
    await this.updateFullProfile(req.user_id, profileUpdates);

    // Mark request as APPROVED
    const { error: updErr } = await client
      .from('profile_edit_requests')
      .update({ status: 'APPROVED', reviewed_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updErr) throw updErr;

    return { id: requestId, status: 'APPROVED' };
  },

  async rejectProfileEditRequest(requestId, reason = "Changes rejected by administrator") {
    const client = getSupabase();
    if (!client) throw new Error("Supabase is initializing... please retry in 1 second.");
    const { error } = await client
      .from('profile_edit_requests')
      .update({ status: 'REJECTED', admin_notes: reason, reviewed_at: new Date().toISOString() })
      .eq('id', requestId);
    if (error) throw error;
    return { id: requestId, status: 'REJECTED' };
  }
};
/* ==========================================================================
   Equb Operations Desk — Live Supabase Application Logic
   Replaces all mock data with real-time database connectivity
   ========================================================================== */

(() => {
  // Global State backed by Supabase
  const state = {
    view: "overview",
    search: "",
    filter: "All",
    signIns: [],
    joins: [],
    payments: [],
    profileEdits: [],
    circles: [],
    members: [],
    announcements: [],
    activity: [],
    drawWinner: null,
    selectedCircleForDraw: null,
    drawParticipants: [],
    selectedDrawParticipantIds: null,
    wheelCurrentRotation: 0,
    isWheelSpinning: false,
    isLoading: true,
    lastSyncTime: "Just now",
    databaseSql: ""
  };

  const navItems = [
    ["overview",      '<i class="fi fi-rr-apps"></i>', "Overview"],
    ["signins",       '<i class="fi fi-rr-user-add"></i>', "Registration",  0],
    ["joins",         '<i class="fi fi-rr-users-alt"></i>', "Join Requests", 0],
    ["profile_edits", '<i class="fi fi-rr-user-pen"></i>', "Profile Updates", 0],
    ["payments",      '<i class="fi fi-rr-receipt"></i>', "Payment Slips", 0],
    ["circles",       '<i class="fi fi-rr-rotate-reverse"></i>', "Equb Circles"],
    ["members",       '<i class="fi fi-rr-users"></i>', "Members"],
    ["lottery",       '<i class="fi fi-rr-trophy"></i>', "Lottery Draw"],
    ["announcements", '<i class="fi fi-rr-bullhorn"></i>', "Announcements"],
    ["database",      '<i class="fi fi-rr-database"></i>', "Audit Log"]
  ];

  const labels = {
    overview:      "Overview",
    signins:       "Registration",
    joins:         "Join Requests",
    profile_edits: "Profile Updates",
    payments:      "Payment Slips",
    circles:       "Equb Circles",
    members:       "Members",
    lottery:       "Lottery Draw",
    announcements: "Announcements",
    database:      "Audit Log",
    settings:      "Settings"
  };

  // Utilities
  const money = n => new Intl.NumberFormat("en-US").format(parseFloat(n) || 0);
  const initials = name => {
    if (!name) return "EQ";
    return name.trim().split(/\s+/).map(x => x[0]).slice(0, 2).join("").toUpperCase();
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));

  const renderAvatar = (name, avatarUrl) => {
    if (avatarUrl) {
      return `<div class="avatar avatar-img-wrap"><img src="${esc(avatarUrl)}" alt="${esc(name)}" class="avatar-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="avatar-fallback" style="display:none">${initials(name)}</div></div>`;
    }
    return `<div class="avatar">${initials(name)}</div>`;
  };
  
  const formatDate = d => {
    if (!d) return "—";
    try {
      const date = new Date(d);
      if (isNaN(date.getTime())) return d;
      return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return d;
    }
  };

  const formatTimeAgo = d => {
    if (!d) return "Recently";
    try {
      const date = new Date(d);
      if (isNaN(date.getTime())) return "Recently";
      const now = new Date();
      const diffSec = Math.floor((now - date) / 1000);
      if (diffSec < 60) return "Just now";
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return "Recently";
    }
  };

  const PILL_LABELS = {
    APPROVED: "Approved", ACTIVE: "Active", VERIFIED: "Verified",
    PUBLISHED: "Published", PAID: "Paid",
    PENDING: "Pending", PENDING_APPROVAL: "Pending", URGENT: "Urgent",
    REJECTED: "Rejected", INACTIVE: "Inactive", SUSPENDED: "Suspended",
    FROZEN: "Frozen", UNPAID: "Unpaid",
    LOW: "Low", NORMAL: "Normal", HIGH: "High",
  };
  const pill = status => {
    const s = String(status || "").toUpperCase();
    const label = PILL_LABELS[s] || (status ? String(status).charAt(0).toUpperCase() + String(status).slice(1).toLowerCase() : "Pending");
    let kind = "slate";
    if (["APPROVED","ACTIVE","VERIFIED","PUBLISHED","PAID"].includes(s)) kind = "green";
    else if (["PENDING","PENDING_APPROVAL","URGENT","HIGH"].includes(s)) kind = "amber";
    else if (["REJECTED","INACTIVE","SUSPENDED","FROZEN","UNPAID"].includes(s)) kind = "red";
    return `<span class="pill ${kind}">${esc(label)}</span>`;
  };

  const btn = (label, action, id, kind = "") =>
    `<button class="btn small ${kind}" data-action="${action}" data-id="${id ?? ""}">${label}</button>`;

  function generatePassword() {
    const prefixes = ["EQB", "SAFE", "CAP", "ADDIS"];
    const pre = prefixes[Math.floor(Math.random() * prefixes.length)];
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    const num = Math.floor(10 + Math.random() * 89);
    return `${pre}-${code}-${num}`;
  }

  // -------------------------------------------------------------------------
  // Data Transformation & Normalization from Supabase
  // -------------------------------------------------------------------------
  function transformProfiles(profiles) {
    return (profiles || []).map(p => ({
      id: p.id,
      name: p.full_name || "Unnamed Member",
      phone: p.phone || "No phone",
      email: p.email || "—",
      fayda: p.national_id_number || "Not registered",
      avatar: p.photo_url || p.avatar_url || p.national_id_card_url || null,
      role: p.role || "MEMBER",
      kyc: p.kyc_status || "PENDING",
      account: p.account_status || "PENDING_APPROVAL",
      savings: parseFloat(p.total_savings) || 0,
      rounds: p.rounds_participated_count || 0,
      date: formatDate(p.created_at),
      rawDate: p.created_at,
      password: p.password_hash || "Password123",
      status: p.account_status === "APPROVED" ? "Approved" : (p.account_status === "REJECTED" ? "Rejected" : "Pending")
    }));
  }

  function transformCircles(equbs) {
    const colors = ["#d6a43c", "#317d70", "#6d7189", "#ba5148", "#2c6e8f", "#7d5ba6"];
    return (equbs || []).map((e, idx) => ({
      id: e.id,
      name: e.name || "Equb Pool",
      category: e.category || "Savings",
      volume: parseFloat(e.total_pool) || 0,
      payment: parseFloat(e.round_payment) || 0,
      progress: parseInt(e.current_round) || 1,
      rounds: parseInt(e.rounds) || 10,
      members: parseInt(e.current_members) || 0,
      max: parseInt(e.members) || 10,
      schedule: e.cycle_type ? `Every ${e.cycle_type}` : "Every 30 days",
      status: e.status === "ACTIVE" ? "Active" : (e.status === "FROZEN" ? "Frozen" : "Inactive"),
      color: colors[idx % colors.length],
      raw: e
    }));
  }

  function transformApplications(apps, profilesMap, equbsMap) {
    return (apps || []).map(a => {
      const user = profilesMap[a.user_id] || {};
      const circle = equbsMap[a.equb_id] || {};
      return {
        id: a.id,
        user_id: a.user_id,
        equb_id: a.equb_id,
        name: user.name || "Applicant",
        avatar: user.avatar || null,
        phone: user.phone || "—",
        circle: circle.name || "Target Equb",
        fayda: a.fin_number || a.fan_number || user.fayda || "FAY-N/A",
        purpose: a.savings_reason || "Equb Savings",
        date: formatDate(a.created_at),
        rawDate: a.created_at,
        status: a.status === "APPROVED" ? "Accepted" : (a.status === "REJECTED" ? "Rejected" : "Pending"),
        idPhotoUrl: a.national_id_photo_url || null
      };
    });
  }

  function transformProfileEdits(requests, profilesMap) {
    return (requests || []).map(r => {
      const user = profilesMap[r.user_id] || {};
      let faydaDisplay = null;
      if (r.requested_fin_number && r.requested_fan_number) {
        faydaDisplay = `FIN: ${r.requested_fin_number} · FAN: ${r.requested_fan_number}`;
      } else if (r.requested_fin_number) {
        faydaDisplay = `FIN: ${r.requested_fin_number}`;
      } else if (r.requested_fan_number) {
        faydaDisplay = `FAN: ${r.requested_fan_number}`;
      } else if (r.requested_national_id) {
        faydaDisplay = r.requested_national_id;
      }

      return {
        id: r.id,
        user_id: r.user_id,
        currentName: user.name || "Member",
        avatar: user.avatar || r.requested_photo_url || null,
        currentPhone: user.phone || "—",
        currentFayda: user.fayda || "—",
        newName: r.requested_full_name || null,
        newPhone: r.requested_phone || null,
        newFayda: faydaDisplay,
        newFin: r.requested_fin_number || null,
        newFan: r.requested_fan_number || null,
        newPhoto: r.requested_photo_url || null,
        date: formatDate(r.created_at),
        rawDate: r.created_at,
        status: r.status === "APPROVED" ? "Approved" : (r.status === "REJECTED" ? "Rejected" : "Pending"),
        notes: r.admin_notes || ""
      };
    });
  }

  function transformPayments(slips) {
    return (slips || []).map(s => ({
      id: s.id,
      user_id: s.user_id,
      equb_id: s.equb_id,
      name: s.sender_name || "Sender",
      circle: s.equb_name || "Equb Pool",
      amount: parseFloat(s.amount) || 0,
      tx: s.transaction_id || "N/A",
      round: s.round_number || s.no_of_rounds_participated || 1,
      date: formatDate(s.created_at),
      rawDate: s.created_at,
      status: s.status === "APPROVED" ? "Approved" : (s.status === "REJECTED" ? "Rejected" : "Pending"),
      screenshot: s.screenshot || null,
      method: s.payment_method || "Bank Transfer"
    }));
  }

  function transformAnnouncements(anns) {
    return (anns || []).map(a => ({
      id: a.id,
      title: a.title || "Announcement",
      category: a.category || "General",
      urgency: a.is_urgent ? "Urgent" : (a.urgency || "Normal"),
      message: a.content || a.message || "",
      author: a.author_name || a.author || "Administrator",
      timestamp: formatTimeAgo(a.created_at),
      date: formatDate(a.created_at)
    }));
  }

  function buildActivityFeed(payments, profiles, joins, announcements) {
    const events = [];

    (payments || []).slice(0, 10).forEach(p => {
      events.push({
        initials: initials(p.name),
        name: p.name,
        action: p.status === "Approved" ? "payment slip verified" : "submitted payment slip",
        detail: `${p.circle} · ETB ${money(p.amount)} (${p.tx})`,
        time: formatTimeAgo(p.rawDate),
        rawDate: new Date(p.rawDate || 0).getTime()
      });
    });

    (profiles || []).slice(0, 10).forEach(m => {
      events.push({
        initials: initials(m.name),
        name: m.name,
        action: m.account === "APPROVED" ? "registration active" : "registered account",
        detail: `ID: ${m.fayda} · Phone: ${m.phone}`,
        time: formatTimeAgo(m.rawDate),
        rawDate: new Date(m.rawDate || 0).getTime()
      });
    });

    (joins || []).slice(0, 10).forEach(j => {
      events.push({
        initials: initials(j.name),
        name: j.name,
        action: "applied to join",
        detail: `${j.circle} · ${j.purpose}`,
        time: formatTimeAgo(j.rawDate),
        rawDate: new Date(j.rawDate || 0).getTime()
      });
    });

    (announcements || []).slice(0, 5).forEach(a => {
      events.push({
        initials: initials(a.author),
        name: a.author,
        action: "broadcasted announcement",
        detail: a.title,
        time: a.timestamp,
        rawDate: new Date(a.date || 0).getTime()
      });
    });

    events.sort((a, b) => b.rawDate - a.rawDate);
    return events.slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // Real Supabase Loader
  // -------------------------------------------------------------------------
  async function loadDatabaseData(silent = false) {
    try {
      if (!silent) {
        updateSystemStatus(true, "Synchronizing with Supabase...");
      }

      const [profilesRaw, equbsRaw, appsRaw, slipsRaw, annsRaw, editsRaw] = await Promise.all([
        EqubAPI.getProfiles().catch(() => []),
        EqubAPI.getEqubs().catch(() => []),
        EqubAPI.getEqubApplications().catch(() => []),
        EqubAPI.getPaymentProofs().catch(() => []),
        EqubAPI.getAnnouncements().catch(() => []),
        EqubAPI.getProfileEditRequests().catch(() => [])
      ]);

      // Transform all data
      state.members = transformProfiles(profilesRaw);
      state.circles = transformCircles(equbsRaw);

      const profilesMap = {};
      state.members.forEach(m => { profilesMap[m.id] = m; });
      const equbsMap = {};
      state.circles.forEach(c => { equbsMap[c.id] = c; });

      state.signIns = state.members.filter(m => m.account === "PENDING_APPROVAL" || m.status === "Pending");
      state.joins = transformApplications(appsRaw, profilesMap, equbsMap);
      state.payments = transformPayments(slipsRaw);
      state.announcements = transformAnnouncements(annsRaw);
      state.profileEdits = transformProfileEdits(editsRaw, profilesMap);
      state.activity = buildActivityFeed(state.payments, state.members, state.joins, state.announcements);

      state.isLoading = false;
      state.lastSyncTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      updateSystemStatus(true, "All services operational");

      // Only re-render full DOM if not in background poll while user is typing in forms/inputs
      const isUserTyping = document.activeElement && 
        (document.activeElement.tagName === "INPUT" || 
         document.activeElement.tagName === "TEXTAREA" || 
         document.activeElement.isContentEditable);
      
      const modalLayer = document.getElementById("modalLayer");
      const isModalOpen = modalLayer && !modalLayer.hidden;

      if (!silent || (!isUserTyping && !isModalOpen && !state.isWheelSpinning)) {
        render();
      } else {
        renderNav();
      }
    } catch (err) {
      console.error("Data load error:", err);
      updateSystemStatus(false, "Connection degraded");
      if (!silent) notify("Failed to sync with Supabase: " + (err.message || "Network error"), true);
      state.isLoading = false;
      if (!silent) render();
    }
  }

  function updateSystemStatus(online, desc) {
    const dot = document.getElementById("systemStatusDot");
    const descEl = document.getElementById("systemStatusDesc");
    const timeEl = document.getElementById("systemStatusTime");
    if (dot) {
      if (online) dot.classList.remove("offline");
      else dot.classList.add("offline");
    }
    if (descEl) descEl.textContent = desc;
    if (timeEl) timeEl.textContent = `Last sync ${state.lastSyncTime}`;
  }

  // -------------------------------------------------------------------------
  // Realtime Subscriptions
  // -------------------------------------------------------------------------
  function setupRealtime() {
    if (typeof window !== 'undefined' && window.supabaseClient && typeof window.supabaseClient.channel === 'function') {
      try {
        window.supabaseClient
          .channel('new-admin-realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, payload => {
            if (payload.eventType === 'INSERT') notify(`New registration: ${payload.new.full_name || 'Member'}`);
            loadDatabaseData(true);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'equb_applications' }, () => {
            notify("New Equb join application received");
            loadDatabaseData(true);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_edit_requests' }, () => {
            notify("New profile change request received");
            loadDatabaseData(true);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_proofs' }, payload => {
            if (payload.eventType === 'INSERT') notify(`New payment slip: ETB ${payload.new.amount} from ${payload.new.sender_name}`);
            loadDatabaseData(true);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'equbs' }, () => {
            loadDatabaseData(true);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, () => {
            loadDatabaseData(true);
          })
          .subscribe();
      } catch (e) {
        console.warn("Realtime setup skipped:", e);
      }
    }
  }

  // -------------------------------------------------------------------------
  // UI Renderers
  // -------------------------------------------------------------------------
  function renderNav() {
    const pendingSigninsCount = state.signIns.filter(x => x.status === "Pending").length;
    const pendingJoinsCount = state.joins.filter(x => x.status === "Pending").length;
    const pendingEditsCount = state.profileEdits.filter(x => x.status === "Pending").length;
    const pendingPaymentsCount = state.payments.filter(x => x.status === "Pending").length;

    // 10 tabs are hosted on the homepage Operations Hub, so left sidebar nav is kept clean
    const navContainer = document.getElementById("nav");
    if (navContainer) navContainer.innerHTML = "";
    // Three-dot drawer trigger icon stays constant — no reset needed


    // Mobile Bottom Navigation Bar — 5 tabs
    const mobileBottom = document.getElementById("mobileBottomBar");
    if (mobileBottom) {
      const isOverview = state.view === "overview";
      const isSignins = state.view === "signins";
      const isJoins = state.view === "joins";
      const isPayments = state.view === "payments";
      const isMore = ["more", "members", "profile_edits", "lottery", "announcements", "database", "settings"].includes(state.view);

      const primaryTabs = [
        {
          id: "overview",
          label: "Overview",
          active: isOverview,
          count: 0,
          icon: '<i class="fi fi-rr-apps"></i>'
        },
        {
          id: "signins",
          label: "Registration",
          active: isSignins,
          count: pendingSigninsCount,
          icon: '<i class="fi fi-rr-user-add"></i>'
        },
        {
          id: "joins",
          label: "Join Requests",
          active: isJoins,
          count: pendingJoinsCount,
          icon: '<i class="fi fi-rr-users-alt"></i>'
        },
        {
          id: "payments",
          label: "Payment Slips",
          active: isPayments,
          count: pendingPaymentsCount,
          icon: '<i class="fi fi-rr-receipt"></i>'
        },
        {
          id: "more",
          label: "More",
          active: isMore,
          count: pendingEditsCount,
          icon: '<i class="fi fi-rr-menu-dots"></i>'
        }
      ];

      mobileBottom.innerHTML = primaryTabs.map(t => `
        <button class="mobile-nav-tab ${t.active ? "active" : ""}" data-view="${t.id}">
          <span class="mob-icon">${t.icon}</span>
          <span class="mob-label">${t.label}</span>
          ${t.count > 0 ? `<span class="count">${t.count}</span>` : ""}
        </button>
      `).join("");
    }

    const topTitle = document.getElementById("topPageTitle");
    if (topTitle) topTitle.textContent = labels[state.view] ? `Equb Operations Desk — ${labels[state.view]}` : "Equb Operations Desk";
  }

  function pageHead(eyebrow, title, desc, actions = "") {
    const isHome = state.view === "overview";
    const backBtnHtml = !isHome ? `
      <button class="circle-back-btn" data-view="overview" title="Back to Overview Dashboard" aria-label="Back to Overview Dashboard">
        <i class="fi fi-rr-arrow-left"></i>
      </button>
    ` : "";

    return `<div class="page-heading">
      <div class="page-heading-main">
        ${backBtnHtml}
        <div class="page-heading-text">
          ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}
          <h1>${title}</h1>
          <p>${desc}</p>
        </div>
      </div>
      ${actions ? `<div class="heading-actions">${actions}</div>` : ""}
    </div>`;
  }

  function emptyState(title, desc) {
    return `<div class="empty">
      <div class="empty-box-icon">
        <i class="fi fi-rr-inbox"></i>
      </div>
      <strong>${title}</strong>
      <p>${desc}</p>
    </div>`;
  }

  function dashboard() {
    const totalVolume = state.circles.reduce((acc, c) => acc + c.volume, 0);
    const activeMembersCount = state.members.filter(m => m.account === "Approved" || m.account === "APPROVED").length;
    const pendingActions = state.signIns.filter(x => x.status === "Pending").length +
      state.joins.filter(x => x.status === "Pending").length +
      state.profileEdits.filter(x => x.status === "Pending").length +
      state.payments.filter(x => x.status === "Pending").length;

    const activeCircles = state.circles.filter(c => c.status === "Active");
    const nextCircle = activeCircles[0];

    return pageHead(
      "",
      "Overview Dashboard",
      "Live overview of network volume, liquidity, verification queues, and member accounts.",
      `<button class="btn sync-btn" data-action="refresh"><i class="fi fi-rr-refresh spin-on-hover"></i> Sync with database</button><button class="btn primary" data-modal="equb"><i class="fi fi-rr-plus-circle"></i> Create Equb</button>`
    ) + `
      <div class="metrics">
        <div class="metric">
          <div class="metric-icon-badge metric-money"><i class="fi fi-rr-money-bill-wave-alt"></i></div>
          <div class="metric-label">Total in circulation</div>
          <div class="metric-value">ETB ${money(totalVolume)}</div>
          <div class="metric-note">Across ${state.circles.length} pools</div>
        </div>
        <div class="metric">
          <div class="metric-icon-badge metric-users"><i class="fi fi-rr-users"></i></div>
          <div class="metric-label">Active members</div>
          <div class="metric-value">${activeMembersCount}</div>
          <div class="metric-note">Verified accounts</div>
        </div>
        <div class="metric">
          <div class="metric-icon-badge metric-alert"><i class="fi fi-rr-bell"></i></div>
          <div class="metric-label">Pending actions</div>
          <div class="metric-value">${pendingActions}</div>
          <div class="metric-note">Needs review</div>
        </div>
        <div class="metric">
          <div class="metric-icon-badge metric-pools"><i class="fi fi-rr-rotate-reverse"></i></div>
          <div class="metric-label">Active pools</div>
          <div class="metric-value">${activeCircles.length}</div>
          <div class="metric-note">${nextCircle ? `${nextCircle.name} · Round ${nextCircle.progress}` : "No active pools"}</div>
        </div>
      </div>

      <div class="panel nav-hub-panel" style="margin-top: 18px;">
        <div class="panel-head">
          <div>
            <div class="kicker">Quick Access</div>
            <h2>Operations Modules</h2>
          </div>
          <span class="pill" style="font-size:11px;font-weight:700;">10 Workspace Tabs</span>
        </div>
        <div class="nav-hub-grid">
          <!-- 1. Overview -->
          <div class="hub-nav-tile" data-view="overview" title="Go to Overview Dashboard">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#f0fdf4; color:#16a34a;"><i class="fi fi-rr-apps"></i></div>
              <div>
                <div class="hub-tile-label">Overview</div>
                <div class="hub-tile-sub">Dashboard</div>
              </div>
            </div>
          </div>

          <!-- 2. Registration -->
          <div class="hub-nav-tile" data-view="signins" title="Review Registration Verifications">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#eff6ff; color:#2563eb;"><i class="fi fi-rr-user-add"></i></div>
              <div>
                <div class="hub-tile-label">Registration</div>
                <div class="hub-tile-sub">Verification</div>
              </div>
            </div>
            ${state.signIns.filter(x => x.status === "Pending").length > 0 ? `
              <span class="hub-tile-badge">${state.signIns.filter(x => x.status === "Pending").length}</span>
            ` : ""}
          </div>

          <!-- 3. Join Requests -->
          <div class="hub-nav-tile" data-view="joins" title="Review Circle Join Requests">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#fdf2f8; color:#db2777;"><i class="fi fi-rr-users-alt"></i></div>
              <div>
                <div class="hub-tile-label">Join Requests</div>
                <div class="hub-tile-sub">Circle entry</div>
              </div>
            </div>
            ${state.joins.filter(x => x.status === "Pending").length > 0 ? `
              <span class="hub-tile-badge">${state.joins.filter(x => x.status === "Pending").length}</span>
            ` : ""}
          </div>

          <!-- 4. Profile Updates -->
          <div class="hub-nav-tile" data-view="profile_edits" title="Review Profile Edit Requests">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#f3e8ff; color:#9333ea;"><i class="fi fi-rr-user-pen"></i></div>
              <div>
                <div class="hub-tile-label">Profile Updates</div>
                <div class="hub-tile-sub">Edits & KYC</div>
              </div>
            </div>
            ${state.profileEdits.filter(x => x.status === "Pending").length > 0 ? `
              <span class="hub-tile-badge">${state.profileEdits.filter(x => x.status === "Pending").length}</span>
            ` : ""}
          </div>

          <!-- 5. Payment Slips -->
          <div class="hub-nav-tile" data-view="payments" title="Verify Deposit Payment Slips">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#ecfdf5; color:#059669;"><i class="fi fi-rr-receipt"></i></div>
              <div>
                <div class="hub-tile-label">Payment Slips</div>
                <div class="hub-tile-sub">Proof reviews</div>
              </div>
            </div>
            ${state.payments.filter(x => x.status === "Pending").length > 0 ? `
              <span class="hub-tile-badge">${state.payments.filter(x => x.status === "Pending").length}</span>
            ` : ""}
          </div>

          <!-- 6. Equb Circles -->
          <div class="hub-nav-tile" data-view="circles" title="Manage Equb Circles">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#fef3c7; color:#d97706;"><i class="fi fi-rr-rotate-reverse"></i></div>
              <div>
                <div class="hub-tile-label">Equb Circles</div>
                <div class="hub-tile-sub">Active pools</div>
              </div>
            </div>
            <span class="hub-tile-badge neutral">${activeCircles.length}</span>
          </div>

          <!-- 7. Members -->
          <div class="hub-nav-tile" data-view="members" title="Open Member Directory">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#e0f2fe; color:#0284c7;"><i class="fi fi-rr-users"></i></div>
              <div>
                <div class="hub-tile-label">Members</div>
                <div class="hub-tile-sub">Directory</div>
              </div>
            </div>
            <span class="hub-tile-badge neutral">${state.members.length}</span>
          </div>

          <!-- 8. Lottery Draw -->
          <div class="hub-nav-tile" data-view="lottery" title="Run Roulette Lottery Draw">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#fffbeb; color:#b45309;"><i class="fi fi-rr-trophy"></i></div>
              <div>
                <div class="hub-tile-label">Lottery Draw</div>
                <div class="hub-tile-sub">Fair rotation</div>
              </div>
            </div>
          </div>

          <!-- 9. Announcements -->
          <div class="hub-nav-tile" data-view="announcements" title="Broadcast Announcements">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#fae8ff; color:#a21caf;"><i class="fi fi-rr-bullhorn"></i></div>
              <div>
                <div class="hub-tile-label">Announcements</div>
                <div class="hub-tile-sub">Broadcasts</div>
              </div>
            </div>
          </div>

          <!-- 10. Audit Log -->
          <div class="hub-nav-tile" data-view="database" title="View Audit Logs & SQL">
            <div class="hub-tile-left">
              <div class="hub-tile-icon" style="background:#f1f5f9; color:#475569;"><i class="fi fi-rr-database"></i></div>
              <div>
                <div class="hub-tile-label">Audit Log</div>
                <div class="hub-tile-sub">System records</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel activity">
        <div class="panel-head">
          <div>
            <div class="kicker">Recent Activity</div>
            <h2>Recent Activity</h2>
          </div>
          <button class="panel-link" data-view="database">View all</button>
        </div>
        ${state.activity.length ? state.activity.map(a => `
          <div class="activity-row">
            ${renderAvatar(a.name, a.avatar)}
            <div class="activity-copy">
              <strong>${esc(a.name)}</strong> ${esc(a.action)}
              <small>${esc(a.detail)}</small>
            </div>
            <span class="activity-time">${esc(a.time)}</span>
          </div>
        `).join("") : emptyState("No activity recorded yet", "New member registrations and payment slips will appear here live.")}
      </div>
    `;
  }

  function reviewPage(type) {
    if (type === "signins") {
      const rows = state.signIns.filter(x => {
        const matchesFilter = state.filter === "All" || x.status.toLowerCase() === state.filter.toLowerCase();
        const matchesSearch = !state.search || `${x.name} ${x.phone} ${x.email} ${x.fayda}`.toLowerCase().includes(state.search.toLowerCase());
        return matchesFilter && matchesSearch;
      });

      return pageHead(
        "",
        "Registration verification",
        "Review new user registrations, assign passwords, and issue access.",
        `<button class="btn primary" data-modal="member"><i class="fi fi-rr-user-add"></i> Add member</button>`
      ) + `
        <div class="panel table-panel">
          <div class="toolbar">
            <div class="search">
              <span class="search-icon"><i class="fi fi-rr-search"></i></span>
              <input data-search placeholder="Search by name, phone, email or Fayda ID..." value="${esc(state.search)}">
            </div>
            <select class="control" data-filter>
              <option ${state.filter === "All" ? "selected" : ""}>All</option>
              <option ${state.filter === "Pending" ? "selected" : ""}>Pending</option>
              <option ${state.filter === "Approved" ? "selected" : ""}>Approved</option>
              <option ${state.filter === "Rejected" ? "selected" : ""}>Rejected</option>
            </select>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Contact</th>
                  <th>Fayda ID</th>
                  <th>Registered</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows.map(x => `
                  <tr>
                    <td>
                      <div class="person">
                        ${renderAvatar(x.name, x.avatar)}
                        <div>
                          <div class="person-name">${esc(x.name)}</div>
                          <span class="sub">${esc(x.email)}</span>
                        </div>
                      </div>
                    </td>
                    <td>${esc(x.phone)}</td>
                    <td class="mono">${esc(x.fayda)}</td>
                    <td>${esc(x.date)}</td>
                    <td>${pill(x.status)}</td>
                    <td>
                      <div class="row-actions">
                        ${x.status === "Pending" ? `
                          ${btn("Approve", "approve-signin", x.id, "teal")}
                          ${btn("Reject", "reject-signin", x.id, "danger")}
                        ` : `
                          ${btn("Customize", "customize-member", x.id)}
                        `}
                      </div>
                    </td>
                  </tr>
                `).join("") : `
                  <tr><td colspan="6">${emptyState("No registrations found", "No pending user sign-ins match your current filter.")}</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    if (type === "joins") {
      const rows = state.joins.filter(x => {
        const matchesFilter = state.filter === "All" || x.status.toLowerCase() === state.filter.toLowerCase();
        const matchesSearch = !state.search || `${x.name} ${x.circle} ${x.fayda} ${x.purpose}`.toLowerCase().includes(state.search.toLowerCase());
        return matchesFilter && matchesSearch;
      });

      return pageHead(
        "",
        "Circle join requests",
        "Approve membership applications and assign approved members to savings circles.",
        `<button class="btn primary" data-modal="apply-equb"><i class="fi fi-rr-plus-circle"></i> Apply for Equb</button>`
      ) + `
        <div class="panel table-panel">
          <div class="toolbar">
            <div class="search">
              <span class="search-icon"><i class="fi fi-rr-search"></i></span>
              <input data-search placeholder="Search by member, circle, or Fayda ID..." value="${esc(state.search)}">
            </div>
            <select class="control" data-filter>
              <option ${state.filter === "All" ? "selected" : ""}>All</option>
              <option ${state.filter === "Pending" ? "selected" : ""}>Pending</option>
              <option ${state.filter === "Accepted" ? "selected" : ""}>Accepted</option>
              <option ${state.filter === "Rejected" ? "selected" : ""}>Rejected</option>
            </select>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Target Circle</th>
                  <th>Fayda ID</th>
                  <th>Savings Purpose</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows.map(x => `
                  <tr>
                    <td>
                      <div class="person">
                        ${renderAvatar(x.name, x.avatar)}
                        <div>
                          <div class="person-name">${esc(x.name)}</div>
                          <span class="sub">${esc(x.phone)}</span>
                        </div>
                      </div>
                    </td>
                    <td><strong>${esc(x.circle)}</strong></td>
                    <td class="mono">${esc(x.fayda)}</td>
                    <td>${esc(x.purpose)}</td>
                    <td>${esc(x.date)}</td>
                    <td>${pill(x.status)}</td>
                    <td>
                      <div class="row-actions">
                        ${x.status === "Pending" ? `
                          ${btn("Accept", "accept-join", x.id, "teal")}
                          ${btn("Reject", "reject-join", x.id, "danger")}
                        ` : `<span class="sub">Processed</span>`}
                      </div>
                    </td>
                  </tr>
                `).join("") : `
                  <tr><td colspan="7">${emptyState("No join requests found", "There are no join applications matching your query.")}</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    if (type === "profile_edits") {
      const rows = state.profileEdits.filter(x => {
        const matchesFilter = state.filter === "All" || x.status.toLowerCase() === state.filter.toLowerCase();
        const matchesSearch = !state.search || `${x.currentName} ${x.newName || ''} ${x.currentPhone} ${x.newPhone || ''} ${x.currentFayda} ${x.newFayda || ''}`.toLowerCase().includes(state.search.toLowerCase());
        return matchesFilter && matchesSearch;
      });

      return pageHead(
        "",
        "Profile change requests",
        "Review and approve member-initiated updates for Full Name, Phone Number, and FIN / FAN National IDs."
      ) + `
        <div class="panel table-panel">
          <div class="toolbar">
            <div class="search">
              <span class="search-icon"><i class="fi fi-rr-search"></i></span>
              <input data-search placeholder="Search by current or new name, phone or Fayda ID..." value="${esc(state.search)}">
            </div>
            <select class="control" data-filter>
              <option ${state.filter === "All" ? "selected" : ""}>All</option>
              <option ${state.filter === "Pending" ? "selected" : ""}>Pending</option>
              <option ${state.filter === "Approved" ? "selected" : ""}>Approved</option>
              <option ${state.filter === "Rejected" ? "selected" : ""}>Rejected</option>
            </select>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Current Details</th>
                  <th>Requested Changes</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows.map(x => {
                  const changes = [];
                  if (x.newName && x.newName !== x.currentName) changes.push(`<strong>Name:</strong> ${esc(x.newName)}`);
                  if (x.newPhone && x.newPhone !== x.currentPhone) changes.push(`<strong>Phone:</strong> ${esc(x.newPhone)}`);
                  if (x.newFayda && x.newFayda !== x.currentFayda) changes.push(`<strong>FIN / FAN:</strong> ${esc(x.newFayda)}`);
                  if (x.newPhoto && x.newPhoto !== x.avatar) changes.push(`<strong>Photo:</strong> Updated`);

                  return `
                  <tr>
                    <td>
                      <div class="person">
                        ${renderAvatar(x.currentName, x.avatar)}
                        <div>
                          <div class="person-name">${esc(x.currentName)}</div>
                          <span class="sub">${esc(x.currentPhone)}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div>${esc(x.currentName)}</div>
                      <small class="sub">Phone: ${esc(x.currentPhone)} · ID: ${esc(x.currentFayda)}</small>
                    </td>
                    <td>
                      <div style="display:flex; flex-direction:column; gap:4px;">
                        ${changes.length ? changes.map(c => `<span class="pill amber" style="display:inline-flex; width:fit-content; font-size:11px;">${c}</span>`).join("") : `<span class="sub">No changes detected</span>`}
                      </div>
                    </td>
                    <td>${esc(x.date)}</td>
                    <td>${pill(x.status)}</td>
                    <td>
                      <div class="row-actions">
                        ${x.status === "Pending" ? `
                          ${btn("Approve", "approve-profile-edit", x.id, "teal")}
                          ${btn("Reject", "reject-profile-edit", x.id, "danger")}
                        ` : `<span class="sub">Processed</span>`}
                      </div>
                    </td>
                  </tr>
                `;}).join("") : `
                  <tr><td colspan="6">${emptyState("No profile change requests found", "There are no pending member profile edit requests.")}</td></tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    // Payments page
    const rows = state.payments.filter(x => {
      const matchesFilter = state.filter === "All" || x.status.toLowerCase() === state.filter.toLowerCase();
      const matchesSearch = !state.search || `${x.name} ${x.circle} ${x.tx}`.toLowerCase().includes(state.search.toLowerCase());
      return matchesFilter && matchesSearch;
    });

    return pageHead(
      "",
      "Payment slips",
      "Inspect CBE and Telebirr deposit slips and verify balances to update member accounts.",
      `<button class="btn primary" data-modal="payment"><i class="fi fi-rr-receipt"></i> Submit payment</button>`
    ) + `
      <div class="panel table-panel">
        <div class="toolbar">
          <div class="search">
            <span class="search-icon"><i class="fi fi-rr-search"></i></span>
            <input data-search placeholder="Search sender, circle or transaction ID..." value="${esc(state.search)}">
          </div>
          <select class="control" data-filter>
            <option ${state.filter === "All" ? "selected" : ""}>All</option>
            <option ${state.filter === "Pending" ? "selected" : ""}>Pending</option>
            <option ${state.filter === "Approved" ? "selected" : ""}>Approved</option>
            <option ${state.filter === "Rejected" ? "selected" : ""}>Rejected</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Sender</th>
                <th>Circle</th>
                <th>Amount</th>
                <th>Transaction ID</th>
                <th>Round</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map(x => `
                <tr>
                  <td>
                    <div class="person">
                      ${renderAvatar(x.name, x.avatar)}
                      <div>
                        <div class="person-name">${esc(x.name)}</div>
                        <span class="sub">${esc(x.date)}</span>
                      </div>
                    </div>
                  </td>
                  <td><strong>${esc(x.circle)}</strong></td>
                  <td class="mono">ETB ${money(x.amount)}</td>
                  <td class="mono">${esc(x.tx)}</td>
                  <td class="mono">Round ${x.round}</td>
                  <td>${pill(x.status)}</td>
                  <td>
                    <div class="row-actions">
                      ${btn("Inspect", "inspect-payment", x.id)}
                      ${x.status === "Pending" ? `
                        ${btn("Approve", "approve-payment", x.id, "teal")}
                        ${btn("Reject", "reject-payment", x.id, "danger")}
                      ` : ""}
                    </div>
                  </td>
                </tr>
              `).join("") : `
                <tr><td colspan="7">${emptyState("No payment slips found", "Nothing matches your current filter.")}</td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function circlesPage() {
    return pageHead(
      "Network / savings pools",
      "Equb circles",
      "Manage circle configuration, round progression, member rosters, and contribution schedules.",
      `<button class="btn primary" data-modal="equb"><i class="fi fi-rr-plus-circle"></i> Create Equb</button>`
    ) + `
      <div class="circle-grid">
        ${state.circles.length ? state.circles.map(c => {
          const percent = Math.min(100, Math.round((c.progress / (c.rounds || 1)) * 100));
          return `
            <div class="circle-card">
              <div class="circle-card-head">
                <div>
                  <div class="circle-name">
                    <i class="circle-dot" style="background:${c.color}"></i>
                    ${esc(c.name)}
                  </div>
                  <div class="circle-meta">${esc(c.category)} · ${esc(c.schedule)}</div>
                </div>
                ${pill(c.status)}
              </div>
              <div class="circle-stats">
                <div class="circle-stat">
                  <label>Pool volume</label>
                  <strong>ETB ${money(c.volume)}</strong>
                </div>
                <div class="circle-stat">
                  <label>Round payment</label>
                  <strong>ETB ${money(c.payment)}</strong>
                </div>
                <div class="circle-stat">
                  <label>Members</label>
                  <strong>${c.members} / ${c.max}</strong>
                </div>
              </div>
              <div class="progress">
                <span style="width:${percent}%"></span>
              </div>
              <div class="circle-footer">
                <span>Round ${c.progress} of ${c.rounds}</span>
                <span>
                  ${btn("Roster", "roster", c.id)}
                  ${btn("Edit", "edit-circle", c.id)}
                  ${btn("Delete", "delete-circle", c.id, "danger")}
                </span>
              </div>
            </div>
          `;
        }).join("") : `
          <div class="empty" style="grid-column:1/-1">
            <strong>No Equb circles found</strong>
            Click "+ Create Equb" to start your first community pool.
          </div>
        `}
      </div>
    `;
  }

  function membersPage() {
    const rows = state.members.filter(x => {
      const matchesSearch = !state.search || `${x.name} ${x.phone} ${x.email} ${x.fayda}`.toLowerCase().includes(state.search.toLowerCase());
      const matchesFilter = state.filter === "All" ||
        x.kyc.toUpperCase() === state.filter.toUpperCase() ||
        x.account.toUpperCase() === state.filter.toUpperCase();
      return matchesSearch && matchesFilter;
    });

    return pageHead(
      `People / ${state.members.length} registered`,
      "Member directory",
      "Search member identity, KYC status, profile customization, and savings balances.",
      `<button class="btn primary" data-modal="member"><i class="fi fi-rr-user-add"></i> Add member</button>`
    ) + `
      <div class="panel table-panel">
        <div class="toolbar">
          <div class="search">
            <span class="search-icon"><i class="fi fi-rr-search"></i></span>
            <input data-search placeholder="Search by name, phone, email, or Fayda ID..." value="${esc(state.search)}">
          </div>
          <select class="control" data-filter>
            <option ${state.filter === "All" ? "selected" : ""}>All</option>
            <option ${state.filter === "APPROVED" ? "selected" : ""}>Approved</option>
            <option ${state.filter === "PENDING_APPROVAL" ? "selected" : ""}>Pending</option>
            <option ${state.filter === "SUSPENDED" ? "selected" : ""}>Suspended</option>
          </select>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Contact</th>
                <th>Fayda ID</th>
                <th>Role</th>
                <th>KYC</th>
                <th>Account</th>
                <th>Total Savings</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map(x => `
                <tr>
                  <td>
                    <div class="person">
                      ${renderAvatar(x.name, x.avatar)}
                      <div>
                        <div class="person-name">${esc(x.name)}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    ${esc(x.phone)}
                    <span class="sub">${esc(x.email)}</span>
                  </td>
                  <td class="mono">${esc(x.fayda)}</td>
                  <td class="mono">${esc(x.role)}</td>
                  <td>${pill(x.kyc)}</td>
                  <td>${pill(x.account)}</td>
                  <td class="mono">ETB ${money(x.savings)}</td>
                  <td>
                    <div class="row-actions">
                      ${btn("Customize", "customize-member", x.id)}
                      ${btn(x.account === "APPROVED" || x.account === "Approved" ? "Revoke" : "Activate", "toggle-member", x.id, (x.account === "APPROVED" || x.account === "Approved") ? "danger" : "teal")}
                    </div>
                  </td>
                </tr>
              `).join("") : `
                <tr><td colspan="8"><div class="empty"><strong>No members found</strong>Try a different search or click "+ Add member".</div></td></tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function generateBezelStuds() {
    const totalStuds = 24;
    let studs = "";
    for (let i = 0; i < totalStuds; i++) {
      const deg = (360 / totalStuds) * i;
      const rad = deg * Math.PI / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);
      const leftPct = (50 + sin * 46.8).toFixed(2);
      const topPct = (50 - cos * 46.8).toFixed(2);
      studs += `<div class="bezel-stud" style="left:${leftPct}%; top:${topPct}%; transform:translate(-50%, -50%);"></div>`;
    }
    return studs;
  }

  function buildRouletteWheelSvg(participants) {
    const total = participants.length;
    const cx = 250;
    const cy = 250;
    const r = 222;

    if (total === 0) {
      return `
        <svg viewBox="0 0 500 500" width="100%" height="100%" style="display:block;">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="#e7f6f2" stroke="#a3d9cf" stroke-width="4"/>
          <text x="${cx}" y="${cy}" text-anchor="middle" fill="#0f766e" font-size="14" font-weight="700">No Participants</text>
        </svg>
      `;
    }

    const sliceAngle = 360 / total;
    let pathsHtml = "";

    participants.forEach((p, i) => {
      const startDeg = i * sliceAngle;
      const endDeg = (i + 1) * sliceAngle;
      const midDeg = startDeg + sliceAngle / 2;

      // Slices alternate mint and crisp white like the mockup
      const fillColor = (i % 2 === 0) ? "#d1fae5" : "#ffffff";
      const textColorInitials = "#065f46";
      const textColorName = "#047857";

      // 0 deg is 12 o'clock (top)
      const startRad = (startDeg - 90) * Math.PI / 180;
      const endRad = (endDeg - 90) * Math.PI / 180;

      const x1 = cx + r * Math.cos(startRad);
      const y1 = cy + r * Math.sin(startRad);
      const x2 = cx + r * Math.cos(endRad);
      const y2 = cy + r * Math.sin(endRad);

      const largeArcFlag = sliceAngle > 180 ? 1 : 0;

      let d = "";
      if (total === 1) {
        d = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
      } else {
        d = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      }

      const pInitials = initials(p.name || "Member");
      const pName = p.name ? (p.name.length > 14 ? p.name.substring(0, 12) + "..." : p.name) : "Member";

      pathsHtml += `
        <path d="${d}" fill="${fillColor}" stroke="#a3d9cf" stroke-width="2.5" />
        <g transform="translate(${cx}, ${cy}) rotate(${midDeg.toFixed(2)}) translate(0, -145)">
          <text text-anchor="middle" y="-6" fill="${textColorInitials}" font-size="16" font-weight="900" font-family="'Space Grotesk', system-ui, sans-serif" letter-spacing="0.05em">${esc(pInitials)}</text>
          <text text-anchor="middle" y="12" fill="${textColorName}" font-size="11" font-weight="700" font-family="'Plus Jakarta Sans', system-ui, sans-serif">${esc(pName)}</text>
        </g>
      `;
    });

    return `
      <svg viewBox="0 0 500 500" width="100%" height="100%" style="display:block;">
        <defs>
          <radialGradient id="wheelRimGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15"/>
            <stop offset="85%" stop-color="#ffffff" stop-opacity="0.05"/>
            <stop offset="100%" stop-color="#0f172a" stop-opacity="0.12"/>
          </radialGradient>
        </defs>
        ${pathsHtml}
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#wheelRimGlow)" stroke="#0d9488" stroke-width="4" opacity="0.3" pointer-events="none" />
      </svg>
    `;
  }

  function lotteryPage() {
    const activeCircles = state.circles.filter(c => c.status === "Active");
    const currentCircle = state.selectedCircleForDraw || activeCircles[0];
    const allEligible = state.drawParticipants.length > 0
      ? state.drawParticipants
      : state.members.filter(m => m.account === "APPROVED" || m.account === "Approved");
    
    // Initialize checked participants to all eligible if not yet set
    if (state.selectedDrawParticipantIds === null || !Array.isArray(state.selectedDrawParticipantIds)) {
      state.selectedDrawParticipantIds = allEligible.map(m => m.id);
    }
    
    const activeParticipants = allEligible.filter(m => state.selectedDrawParticipantIds.includes(m.id));
    const selected = state.drawWinner;
    const isSpinning = state.isWheelSpinning;
    const currentRotation = state.wheelCurrentRotation || 0;

    return pageHead(
      "Operations / fair selection",
      "Lottery draw",
      "Run the next rotation draw from active paid participants and disburse payout to the winner.",
      `<span class="pill green">Draw system ready</span>`
    ) + `
      <div class="draw-layout">
        <!-- Left Panel: Prepare a Draw -->
        <div class="draw-card">
          <div class="draw-header-block">
            <h2 style="font-size:20px;font-weight:800;color:var(--text-main);margin:0 0 6px 0;">Prepare a Draw</h2>
            <p style="font-size:13px;color:var(--text-muted);margin:0 0 18px 0;line-height:1.4;">Check members who will participate in the roulette wheel draw.</p>
          </div>

          <div class="field" style="margin-bottom:20px;">
            <label style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);">EQUB CIRCLE</label>
            <select class="control" id="drawCircleSelect" style="font-weight:600;height:42px;" ${isSpinning ? "disabled" : ""}>
              ${activeCircles.map(c => `
                <option value="${c.id}" ${currentCircle && currentCircle.id === c.id ? "selected" : ""}>
                  ${esc(c.name)} · Round ${c.progress || 1} of ${c.rounds || 10}
                </option>
              `).join("") || `<option>No active circles available</option>`}
            </select>
          </div>

          <div class="eligible-box" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
              <div>
                <div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">ELIGIBLE PARTICIPANTS</div>
                <div style="font-size:15px;font-weight:800;color:#0f172a;margin-top:2px;">
                  ${activeParticipants.length} of ${allEligible.length} on Wheel
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <button class="btn-toggle-all" data-action="toggle-all-draw-participants" type="button" ${isSpinning ? "disabled" : ""}>
                  ${activeParticipants.length === allEligible.length && allEligible.length > 0 ? "Deselect All" : "Select All"}
                </button>
                <span class="pill green" style="background:#ecfdf5;color:#065f46;border-color:#a7f3d0;font-size:11px;padding:3px 8px;font-weight:700;">
                  <i class="fi fi-sr-check" style="font-size:10px;margin-right:3px;"></i> Verified
                </span>
              </div>
            </div>

            <div class="participant-list" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px;">
              ${allEligible.length ? allEligible.map(x => {
                const isChecked = state.selectedDrawParticipantIds.includes(x.id);
                return `
                  <div class="participant-select-item ${isChecked ? "checked" : ""}" data-action="toggle-draw-participant" data-id="${x.id}" title="Click to ${isChecked ? 'remove from' : 'include on'} drawing board">
                    <div style="display:flex;align-items:center;gap:10px;">
                      <div class="avatar" style="width:34px;height:34px;font-size:12px;background:#e0f2fe;color:#0369a1;font-weight:700;">${initials(x.name)}</div>
                      <div>
                        <div style="font-weight:700;font-size:13px;color:#1e293b;">${esc(x.name)}</div>
                        <div style="font-size:11px;color:#64748b;font-family:var(--mono);">${esc(x.phone || "—")}</div>
                      </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style="font-size:11px;font-weight:700;color:${isChecked ? "#059669" : "#94a3b8"};">${isChecked ? "Participating" : "Excluded"}</span>
                      <div class="participant-custom-check">
                        <i class="fi fi-sr-check"></i>
                      </div>
                    </div>
                  </div>
                `;
              }).join("") : `
                <div class="empty" style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">No eligible members found in this circle.</div>
              `}
            </div>
          </div>

          <div class="draw-notice-card" style="display:flex;align-items:center;gap:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 14px;margin-bottom:20px;">
            <i class="fi fi-sr-shield-check" style="font-size:18px;color:#16a34a;flex-shrink:0;"></i>
            <span style="font-size:12px;color:#15803d;font-weight:600;line-height:1.35;">Only checked participants are placed on the wheel for the draw.</span>
          </div>

          <button class="btn-gold-draw" id="btnExecuteDraw" data-action="execute-draw" ${activeParticipants.length === 0 || isSpinning ? "disabled" : ""}>
            <i class="fi fi-sr-play" style="font-size:14px;"></i> Execute Winner Draw
          </button>
        </div>

        <!-- Right Stage: Wheel / Roulette Stage -->
        <div class="draw-stage-card">
          <div class="stage-eyebrow">DRAWING WINNER</div>
          <div class="stage-pill">
            <i class="fi fi-sr-bullseye-pointer" style="font-size:11px;color:#b45309;"></i>
            ${currentCircle ? `${esc(currentCircle.name)} · Round ${currentCircle.progress || 1}` : "Equb Circle · Round 1"}
          </div>

          <!-- Wheel Bezel -->
          <div class="wheel-outer-bezel" id="wheelOuterBezel">
            <!-- Top Pointer Needle -->
            <div class="wheel-pointer-pin" id="wheelPointerPin">
              <div class="pointer-needle"></div>
            </div>

            <!-- Rivets / Studs -->
            ${generateBezelStuds()}

            <!-- Spinning Rotor -->
            <div class="wheel-inner-spin-wrap" id="wheelSpinWrap" style="transform: rotate(${currentRotation}deg);">
              ${buildRouletteWheelSvg(activeParticipants)}
            </div>

            <!-- Fixed Center Hub -->
            <div class="wheel-center-hub" id="wheelCenterHub">
              <div class="hub-inner-content" id="hubInnerContent">
                <i class="fi fi-sr-trophy hub-trophy ${selected ? "winner-trophy-gold" : ""}"></i>
                <div class="hub-status-lbl ${selected ? "text-emerald" : "text-amber"}">
                  ${selected ? "WINNER SELECTED" : "FAIR ROTATION"}
                </div>
                <div class="hub-winner-name" title="${selected ? esc(selected.name) : ""}">
                  ${selected ? esc(selected.name) : "Ready to Draw"}
                </div>
                <div class="hub-winner-phone">
                  ${selected ? esc(selected.phone || "") : `${activeParticipants.length} In Pool`}
                </div>
              </div>
            </div>
          </div>

          <!-- Spinning / Status Info below wheel -->
          <div class="wheel-status-panel" id="wheelStatusPanel">
            ${selected ? `
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="pill green" style="background:#ecfdf5;color:#065f46;border-color:#a7f3d0;font-size:13px;padding:6px 16px;font-weight:700;">
                  <i class="fi fi-sr-trophy" style="color:#f59e0b;margin-right:6px;"></i> Winner: ${esc(selected.name)} (${esc(selected.phone || "")})
                </span>
              </div>
            ` : `
              <div style="color:#64748b;font-size:13px;font-weight:500;">
                Click <strong>Execute Winner Draw</strong> to start the rotation.
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  function announcementsPage() {
    return pageHead(
      "Communications / broadcast",
      "Announcements",
      "Publish official operational updates, draw notices, and reminders directly to mobile users.",
      `<button class="btn primary" data-modal="announcement"><i class="fi fi-rr-bullhorn"></i> New announcement</button>`
    ) + `
      <div class="announcement-grid">
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="kicker">Compose</div>
              <h2>Publish Broadcast</h2>
            </div>
          </div>
          <form id="announcementForm" class="modal-body">
            <div class="field">
              <label>Title</label>
              <input class="control" name="title" placeholder="What should members know?" required>
            </div>
            <div class="field">
              <label>Category</label>
              <select class="control" name="category">
                <option value="General">General</option>
                <option value="Winner Announcement">Winner Announcement</option>
                <option value="Payment Due">Payment Due</option>
              </select>
            </div>
            <div class="field">
              <label>Message</label>
              <textarea name="message" placeholder="Write the announcement content for mobile users..." required></textarea>
            </div>
            <button class="btn primary" type="submit">Publish broadcast</button>
          </form>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="kicker">Live stream</div>
              <h2>Recent Announcements</h2>
            </div>
            <span class="mono">${state.announcements.length} published</span>
          </div>
          ${state.announcements.length ? state.announcements.map(a => `
            <article class="announcement">
              <div class="announcement-top">
                <h3>${esc(a.title)}</h3>
                ${pill(a.urgency)}
              </div>
              <p>${esc(a.message)}</p>
              <div class="announcement-meta">
                ${esc(a.category)} · ${esc(a.author)} · ${esc(a.timestamp)}
              </div>
            </article>
          `).join("") : `
            <div class="empty"><strong>No announcements yet</strong>Publish your first broadcast on the left.</div>
          `}
        </div>
      </div>
    `;
  }

  function databasePage() {
    return pageHead(
      "System / activity",
      "System audit log",
      "Real-time event trail of registrations, join approvals, deposit verifications, and payouts."
    ) + `
      <div class="panel table-panel" style="margin-top: 0;">
        <div class="panel-head">
          <div>
            <div class="kicker">Live audit trail</div>
            <h2>Recent Transaction & Event Records</h2>
          </div>
          <button class="btn" data-action="refresh"><i class="fi fi-rr-refresh spin-on-hover"></i> Refresh audit</button>
        </div>
        ${state.activity.length ? state.activity.map(a => `
          <div class="log-row">
            <div class="log-time">${esc(a.time)}</div>
            <div class="log-copy">
              <strong>${esc(a.name)}</strong>: ${esc(a.action)} — <span>${esc(a.detail)}</span>
            </div>
          </div>
        `).join("") : `<div class="empty">No recent logs recorded.</div>`}
      </div>
    `;
  }

  function settingsPage() {
    return pageHead(
      "Workspace / configuration",
      "Settings",
      "Manage portal connection credentials, administrative accounts, and system parameters."
    ) + `
      <div class="settings-grid">
        <div class="settings-card">
          <h3>Supabase Endpoint</h3>
          <p>Connected database instance url and API authentication status.</p>
          <div class="field">
            <label>Supabase URL</label>
            <input class="control" value="https://mzhhrkwnrrhclbtiszfv.supabase.co" readonly>
          </div>
          <div class="field">
            <label>Public Anon Key</label>
            <input class="control" value="sb_publishable_DX0A-0wK3t027pwVsAKiSg_nniWUANw" readonly>
          </div>
          <button class="btn teal" data-action="test-connection"><i class="fi fi-rr-network"></i> Test Supabase Connection</button>
        </div>

        <div class="settings-card">
          <h3>Administrator Profile</h3>
          <p>Logged in management account details.</p>
          <div class="field">
            <label>Full name</label>
            <input class="control" id="settingsAdminName" value="Equb Administrator">
          </div>
          <div class="field">
            <label>Role</label>
            <input class="control" value="Super Administrator" readonly>
          </div>
          <button class="btn primary" data-action="save-admin-profile">Save Profile</button>
        </div>
      </div>
    `;
  }

  function morePage() {
    const menuItems = [
      { icon: '<i class="fi fi-rr-users"></i>', label: "Members",       view: "members", bg: "#eff6ff", color: "#2563eb" },
      { icon: '<i class="fi fi-rr-trophy"></i>', label: "Lottery Draw",  view: "lottery", bg: "#fef3c7", color: "#d97706" },
      { icon: '<i class="fi fi-rr-bullhorn"></i>', label: "Announcements", view: "announcements", bg: "#f3e8ff", color: "#9333ea" },
      { icon: '<i class="fi fi-rr-database"></i>', label: "Audit Log",     view: "database", bg: "#ecfdf5", color: "#059669" },
      { icon: '<i class="fi fi-rr-settings-sliders"></i>', label: "Settings",      view: "settings", bg: "#f1f5f9", color: "#475569" },
      { icon: '<i class="fi fi-rr-headset"></i>', label: "Support",       action: "support", bg: "#cffafe", color: "#0891b2" },
      { icon: '<i class="fi fi-rr-sign-out-alt"></i>', label: "Logout",        action: "logout", bg: "#fee2e2", color: "#dc2626" },
    ];
    return pageHead(
      "Navigation / shortcuts",
      "Operations Hub",
      "Quick access to all management modules, tools, and system configurations."
    ) + `
      <div class="panel more-menu">
        ${menuItems.map(item => `
          <button class="more-menu-item" ${item.view ? `data-view="${item.view}"` : `data-action="${item.action}"`}>
            <span class="more-menu-icon" style="background:${item.bg};color:${item.color}">${item.icon}</span>
            <span class="more-menu-label">${item.label}</span>
            <span class="chevron"><i class="fi fi-rr-angle-small-right"></i></span>
          </button>
        `).join("")}
      </div>
    `;
  }

  function render() {

    renderNav();
    const content = document.getElementById("content");
    if (!content) return;

    if (state.isLoading) {
      content.innerHTML = `<div class="loading"><div class="spinner"></div> Loading live data from Supabase...</div>`;
      return;
    }

    if (state.view === "overview") content.innerHTML = dashboard();
    else if (state.view === "signins" || state.view === "joins" || state.view === "profile_edits" || state.view === "payments") content.innerHTML = reviewPage(state.view);
    else if (state.view === "circles") content.innerHTML = circlesPage();
    else if (state.view === "members") content.innerHTML = membersPage();
    else if (state.view === "lottery") content.innerHTML = lotteryPage();
    else if (state.view === "announcements") content.innerHTML = announcementsPage();
    else if (state.view === "database") content.innerHTML = databasePage();
    else if (state.view === "settings") content.innerHTML = settingsPage();
    else if (state.view === "more") content.innerHTML = morePage();

    const filterEl = content.querySelector("[data-filter]");
    if (filterEl) filterEl.value = state.filter;
  }

  // -------------------------------------------------------------------------
  // Notifications & Modals
  // -------------------------------------------------------------------------
  function notify(message, isError = false) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    if (isError) toast.classList.add("error");
    else toast.classList.remove("error");
    toast.hidden = false;
    clearTimeout(window.__toastTimeout);
    window.__toastTimeout = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  function closeModal() {
    const layer = document.getElementById("modalLayer");
    if (layer) {
      layer.hidden = true;
      layer.innerHTML = "";
    }
  }

  function openModal(type, item) {
    const layer = document.getElementById("modalLayer");
    if (!layer) return;

    let title = "", subtitle = "", body = "";

    if (type === "quick-actions") {
      title = "Quick Actions";
      subtitle = "Rapid shortcuts for operations on mobile";
      body = `
        <div class="quick-action-grid">
          <div class="quick-action-card primary" data-modal="equb">
            <div class="quick-action-icon qa-equb"><i class="fi fi-rr-plus-circle"></i></div>
            <span>Create Equb</span>
          </div>
          <div class="quick-action-card" data-modal="member">
            <div class="quick-action-icon qa-member"><i class="fi fi-rr-user-add"></i></div>
            <span>Add Member</span>
          </div>
          <div class="quick-action-card" data-modal="payment">
            <div class="quick-action-icon qa-payment"><i class="fi fi-rr-receipt"></i></div>
            <span>Submit Payment</span>
          </div>
          <div class="quick-action-card" data-action="announcement">
            <div class="quick-action-icon qa-announce"><i class="fi fi-rr-bullhorn"></i></div>
            <span>Announce</span>
          </div>
          <div class="quick-action-card" data-view="lottery">
            <div class="quick-action-icon qa-lottery"><i class="fi fi-rr-trophy"></i></div>
            <span>Lottery Draw</span>
          </div>
          <div class="quick-action-card" data-action="refresh">
            <div class="quick-action-icon qa-sync"><i class="fi fi-rr-refresh spin-on-hover"></i></div>
            <span>Sync Database</span>
          </div>
        </div>
      `;
      layer.innerHTML = `
        <div class="modal">
          <div class="modal-head">
            <div>
              <h2>${title}</h2>
              <p>${subtitle}</p>
            </div>
            <button class="btn icon" data-close="true"><i class="fi fi-rr-cross"></i></button>
          </div>
          <div class="modal-body">${body}</div>
        </div>
      `;
      layer.hidden = false;
      return;
    }

    if (type === "equb") {
      title = "Create new Equb";
      subtitle = "Set up a new savings circle and contribution terms.";
      body = `
        <form id="modalForm" data-form-type="create-equb">
          <div class="form-grid">
            <div class="field full">
              <label>Equb name</label>
              <input class="control" name="name" id="newEqubNameInput" placeholder="Enter Equb name" required>
            </div>
            <div class="field full">
              <label>Savings frequency</label>
              <select class="control" name="cycle_type">
                <option value="Weekly">Weekly</option>
                <option value="Monthly" selected>Monthly</option>
                <option value="By Day">By Day</option>
              </select>
            </div>
            <div class="field">
              <label>Pool volume (ETB)</label>
              <input class="control" name="volume" type="number" placeholder="Enter pool volume" required>
            </div>
            <div class="field">
              <label>Round payment (ETB)</label>
              <input class="control" name="payment" type="number" placeholder="Enter round payment" required>
            </div>
            <div class="field full">
              <label>Max members</label>
              <input class="control" name="max" type="number" placeholder="Enter max members" value="10" required>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn primary full-width-btn" type="submit">Create Equb</button>
          </div>
        </form>
      `;
    } else if (type === "apply-equb") {
      title = "Apply to Join Equb";
      subtitle = "Submit an application for a member to join a savings circle.";
      body = `
        <form id="modalForm" data-form-type="apply-equb">
          <div class="form-grid">
            <div class="field full">
              <label>Select Member</label>
              <select class="control" name="user_id" required>
                <option value="" disabled selected>Choose applying member</option>
                ${state.members.map(m => `<option value="${m.id}">${esc(m.name)} (${esc(m.phone)})</option>`).join("")}
              </select>
            </div>
            <div class="field full">
              <label>Target Equb Circle</label>
              <select class="control" name="equb_id" id="applyEqubSelect" required>
                <option value="" disabled selected>Choose target circle to join</option>
                ${state.circles.map(c => `<option value="${c.id}">${esc(c.name)} — ETB ${money(c.payment)} (${c.schedule})</option>`).join("")}
              </select>
            </div>
            <div class="field full">
              <label>Savings Purpose / Note</label>
              <input class="control" name="savings_reason" placeholder="e.g. Business expansion, Emergency pool, House rent">
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button class="btn primary" type="submit">Submit Application</button>
          </div>
        </form>
      `;
    } else if (type === "member") {
      const generatedPass = generatePassword();
      title = "Add new member";
      subtitle = "Register a new member with profile photo and login credentials.";
      body = `
        <form id="modalForm" data-form-type="create-member">
          <div class="field full member-photo-upload-section">
            <label style="font-weight: 700; color: var(--navy);">Profile Photo</label>
            <div class="photo-upload-row">
              <div class="photo-preview-large" id="photoPreview">
                <span style="font-size: 20px; font-weight: 800;">MB</span>
              </div>
              <div class="photo-upload-controls">
                <input type="file" id="memberPhotoFileInput" accept="image/*" style="display:none">
                <input type="hidden" name="avatar_data" id="memberPhotoData" value="">
                <div class="photo-btn-group">
                  <button type="button" class="btn small" onclick="document.getElementById('memberPhotoFileInput').click()"><i class="fi fi-rr-picture"></i> Upload Photo</button>
                </div>
                <small class="help-text">Upload JPG, PNG or WEBP portrait image for member directory.</small>
              </div>
            </div>
          </div>
          <div class="form-grid">
            <div class="field full">
              <label>Full name</label>
              <input class="control" name="name" id="newMemberName" placeholder="Enter full name" required>
            </div>
            <div class="field full">
              <label>Phone number</label>
              <input class="control" name="phone" placeholder="Enter phone number" required>
            </div>
            <div class="field full">
              <label>Email (Optional)</label>
              <input class="control" name="email" placeholder="Enter email address">
            </div>
            <div class="field full">
              <label>Fayda ID</label>
              <input class="control" name="fayda" placeholder="Enter Fayda ID">
            </div>
            <div class="field full">
              <label>Select circle</label>
              <select class="control" name="circle_id">
                <option value="" disabled selected>Choose target circle</option>
                ${state.circles.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
              </select>
            </div>
            <input type="hidden" name="password" value="${generatedPass}">
          </div>
          <div class="modal-actions">
            <button class="btn primary full-width-btn" type="submit">Add Member</button>
          </div>
        </form>
      `;
    } else if (type === "payment") {
      title = "Submit payment slip";
      subtitle = "Upload deposit slip and verify member payment.";
      body = `
        <form id="modalForm" data-form-type="submit-payment">
          <div class="form-grid">
            <div class="field full">
              <label>Select sender</label>
              <select class="control" name="user_id" required>
                <option value="" disabled selected>Choose sender</option>
                ${state.members.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field full">
              <label>Select circle</label>
              <select class="control" name="equb_id" required>
                <option value="" disabled selected>Choose circle</option>
                ${state.circles.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field full">
              <label>Transaction ID</label>
              <input class="control" name="tx" placeholder="Enter transaction ID" required>
            </div>
            <div class="field full">
              <label>Amount</label>
              <input class="control" name="amount" type="number" placeholder="Enter amount" required>
            </div>
            <div class="field full">
              <label>Upload slip</label>
              <div class="upload-dropzone">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                <span>Tap to upload image</span>
              </div>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn primary full-width-btn" type="submit">Submit payment</button>
          </div>
        </form>
      `;
    } else if (type === "announcement") {
      title = "New announcement";
      subtitle = "Broadcast a clear update to members across the network.";
      body = `
        <form id="modalForm" data-form-type="create-announcement">
          <div class="field">
            <label>Title</label>
            <input class="control" name="title" placeholder="Announcement title" required>
          </div>
          <div class="field">
            <label>Category</label>
            <select class="control" name="category">
              <option value="General">General</option>
              <option value="Winner Announcement">Winner Announcement</option>
              <option value="Payment Due">Payment Due</option>
            </select>
          </div>
          <div class="field">
            <label>Message</label>
            <textarea name="message" placeholder="Write the announcement..." required></textarea>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button class="btn primary" type="submit">Publish broadcast</button>
          </div>
        </form>
      `;
    } else if (type === "edit-circle" && item) {
      title = "Edit Equb circle";
      subtitle = "Adjust active circle settings, progression, and capacity.";
      body = `
        <form id="modalForm" data-form-type="edit-circle" data-id="${item.id}">
          <div class="form-grid">
            <div class="field">
              <label>Circle name</label>
              <input class="control" name="name" value="${esc(item.name)}" required>
            </div>
            <div class="field">
              <label>Category</label>
              <select class="control" name="category">
                <option ${item.category === "Savings" ? "selected" : ""}>Savings</option>
                <option ${item.category === "Business" ? "selected" : ""}>Business</option>
                <option ${item.category === "House" ? "selected" : ""}>House</option>
                <option ${item.category === "Car" ? "selected" : ""}>Car</option>
                <option ${item.category === "Emergency" ? "selected" : ""}>Emergency</option>
              </select>
            </div>
            <div class="field">
              <label>Pool total (ETB)</label>
              <input class="control" name="volume" type="number" value="${item.volume}" required>
            </div>
            <div class="field">
              <label>Round payment (ETB)</label>
              <input class="control" name="payment" type="number" value="${item.payment}" required>
            </div>
            <div class="field">
              <label>Current round</label>
              <input class="control" name="progress" type="number" value="${item.progress}" required>
            </div>
            <div class="field">
              <label>Total rounds</label>
              <input class="control" name="rounds" type="number" value="${item.rounds}" required>
            </div>
            <div class="field full">
              <label>Status</label>
              <select class="control" name="status">
                <option value="ACTIVE" ${item.status === "Active" ? "selected" : ""}>Active</option>
                <option value="FROZEN" ${item.status === "Frozen" ? "selected" : ""}>Frozen</option>
                <option value="COMPLETED">Completed</option>
              </select>
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button class="btn primary" type="submit">Save changes</button>
          </div>
        </form>
      `;
    } else if (type === "receipt" && item) {
      title = "Deposit slip verification";
      subtitle = `${esc(item.name)} · ${esc(item.tx)}`;
      body = `
        <div class="receipt">
          <div class="receipt-paper">
            <strong>${esc(item.method || "COMMERCIAL BANK OF ETHIOPIA")}</strong>
            <div><span>Sender</span><b>${esc(item.name)}</b></div>
            <div><span>Reference</span><b>${esc(item.tx)}</b></div>
            <div><span>Circle</span><b>${esc(item.circle)}</b></div>
            <div><span>Amount</span><b>ETB ${money(item.amount)}</b></div>
            <div><span>Date</span><b>${esc(item.date)}</b></div>
            <div><span>Status</span><b>${esc(item.status)}</b></div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" data-close>Close</button>
          ${item.status === "Pending" ? `
            ${btn("Reject payment", "reject-payment", item.id, "danger")}
            ${btn("Approve payment", "approve-payment", item.id, "teal")}
          ` : ""}
        </div>
      `;
    } else if (type === "roster" && item) {
      title = `${esc(item.name)} • Round ${item.progress}`;
      subtitle = `Member roster (${item.members || 0} / ${item.max || 10})`;
      body = `
        <div class="loading" id="rosterLoading"><div class="spinner"></div> Loading circle members...</div>
        <div id="rosterListContainer"></div>
        <div class="modal-actions" style="margin-top: 16px;">
          <button class="btn roster-download-btn" onclick="window.print()">Download roster</button>
        </div>
      `;
      // Load real members for this circle asynchronously
      setTimeout(async () => {
        const rosterContainer = document.getElementById("rosterListContainer");
        const loader = document.getElementById("rosterLoading");
        if (rosterContainer && loader) {
          try {
            const members = await EqubAPI.getEqubMembers(item.id);
            loader.remove();
            if (!members || members.length === 0) {
              rosterContainer.innerHTML = emptyState("No members enrolled", "No members have joined this circle yet.");
            } else {
              rosterContainer.innerHTML = members.map((m, idx) => {
                const profile = m.profiles || {};
                return `
                  <div class="roster-numbered-item">
                    <div class="roster-num">${idx + 1}</div>
                    <div class="roster-info">
                      <strong>${esc(profile.full_name || "Member")}</strong>
                      <span class="sub">ID: ${esc(profile.national_id_number || profile.fayda || `ET-${12345 + idx}`)}</span>
                    </div>
                  </div>
                `;
              }).join("");
            }
          } catch (e) {
            loader.textContent = "Error loading roster.";
          }
        }
      }, 50);
    } else if (type === "customize" && item) {
      title = "Customize member";
      subtitle = `Edit profile, photo, credentials, role, and savings balance for ${esc(item.name)}.`;
      body = `
        <form id="modalForm" data-form-type="edit-member" data-id="${item.id}">
          <div class="field full member-photo-upload-section">
            <label style="font-weight: 700; color: var(--navy);">Profile Photo</label>
            <div class="photo-upload-row">
              <div class="photo-preview-large" id="photoPreview">
                ${item.avatar ? `<img src="${esc(item.avatar)}" class="preview-img">` : `<span style="font-size: 20px; font-weight: 800;">${initials(item.name)}</span>`}
              </div>
              <div class="photo-upload-controls">
                <input type="file" id="memberPhotoFileInput" accept="image/*" style="display:none">
                <input type="hidden" name="avatar_data" id="memberPhotoData" value="${esc(item.avatar || '')}">
                <div class="photo-btn-group">
                  <button type="button" class="btn small" onclick="document.getElementById('memberPhotoFileInput').click()"><i class="fi fi-rr-picture"></i> Upload Photo</button>
                  ${item.avatar ? `<button type="button" class="btn small danger" id="removePhotoBtn"><i class="fi fi-rr-trash"></i> Remove</button>` : ''}
                </div>
                <small class="help-text">Upload JPG, PNG or WEBP portrait image. This photo will be saved in the profiles bucket and shown across the portal.</small>
              </div>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Full name</label>
              <input class="control" name="name" value="${esc(item.name)}" required>
            </div>
            <div class="field">
              <label>Phone number</label>
              <input class="control" name="phone" value="${esc(item.phone)}" required>
            </div>
            <div class="field">
              <label>Email</label>
              <input class="control" name="email" value="${esc(item.email === '—' ? '' : item.email)}">
            </div>
            <div class="field">
              <label>Fayda ID</label>
              <input class="control" name="fayda" value="${esc(item.fayda)}">
            </div>
            <div class="field">
              <label>Role</label>
              <select class="control" name="role">
                <option value="MEMBER" ${item.role === "MEMBER" ? "selected" : ""}>MEMBER</option>
                <option value="ADMIN" ${item.role === "ADMIN" ? "selected" : ""}>ADMIN</option>
                <option value="FINANCE" ${item.role === "FINANCE" ? "selected" : ""}>FINANCE</option>
                <option value="OPERATOR" ${item.role === "OPERATOR" ? "selected" : ""}>OPERATOR</option>
              </select>
            </div>
            <div class="field">
              <label>Account status</label>
              <select class="control" name="account">
                <option value="APPROVED" ${item.account === "APPROVED" || item.account === "Approved" ? "selected" : ""}>Approved</option>
                <option value="SUSPENDED" ${item.account === "SUSPENDED" ? "selected" : ""}>Suspended</option>
                <option value="REJECTED" ${item.account === "REJECTED" ? "selected" : ""}>Rejected</option>
              </select>
            </div>
            <div class="field">
              <label>Login Password</label>
              <input class="control" name="password" value="${esc(item.password || 'Password123')}">
            </div>
            <div class="field">
              <label>Savings balance (ETB)</label>
              <input class="control" name="savings" type="number" value="${item.savings}">
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button class="btn primary" type="submit">Save changes</button>
          </div>
        </form>
      `;
    }

    layer.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${title}</h2>
            <p>${subtitle}</p>
          </div>
          <button class="btn icon" data-close aria-label="Close"><i class="fi fi-rr-cross"></i></button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    `;
    layer.hidden = false;

    // Attach Photo File Listeners after rendering
    setTimeout(() => {
      const photoInput = document.getElementById("memberPhotoFileInput");
      if (photoInput) {
        photoInput.addEventListener("change", e => {
          const file = e.target.files && e.target.files[0];
          if (file) {
            if (file.size > 5 * 1024 * 1024) {
              notify("Photo size should be under 5MB", true);
              return;
            }
            window._tempMemberPhotoFile = file;
            const reader = new FileReader();
            reader.onload = ev => {
              const dataUrl = ev.target.result;
              const dataField = document.getElementById("memberPhotoData");
              const preview = document.getElementById("photoPreview");
              if (dataField) dataField.value = dataUrl;
              if (preview) preview.innerHTML = `<img src="${dataUrl}" class="preview-img" style="width:100%;height:100%;object-fit:cover;">`;
            };
            reader.readAsDataURL(file);
          }
        });
      }
      const removeBtn = document.getElementById("removePhotoBtn");
      if (removeBtn) {
        removeBtn.addEventListener("click", () => {
          window._tempMemberPhotoFile = null;
          const dataField = document.getElementById("memberPhotoData");
          const preview = document.getElementById("photoPreview");
          if (dataField) dataField.value = "";
          if (preview) preview.innerHTML = `<span style="font-size:20px;font-weight:800;">${initials(item ? item.name : 'MB')}</span>`;
          removeBtn.remove();
        });
      }
    }, 50);

  }

  // -------------------------------------------------------------------------
  // Event Delegators
  // -------------------------------------------------------------------------
  const toggleMobileSidebar = (forceClose = false) => {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (!sidebar) return;
    if (forceClose) {
      sidebar.classList.remove("open");
      if (backdrop) backdrop.classList.remove("active");
    } else {
      const isOpen = sidebar.classList.toggle("open");
      if (backdrop) backdrop.classList.toggle("active", isOpen);
    }
  };

  document.addEventListener("click", async e => {
    // Mobile Drawer Toggle (three dashes on top left)
    const mobileMenuTrigger = e.target.closest("#mobileMenu");
    if (mobileMenuTrigger) {
      toggleMobileSidebar();
      return;
    }

    if (e.target.closest("#mobileDrawerTrigger")) {
      toggleMobileSidebar();
      return;
    }

    // Mobile Backdrop Click
    if (e.target.id === "sidebarBackdrop") {
      toggleMobileSidebar(true);
      return;
    }

    // Navigation
    const viewBtn = e.target.closest("[data-view]");
    if (viewBtn) {
      state.view = viewBtn.dataset.view;
      state.search = "";
      state.filter = "All";
      toggleMobileSidebar(true);
      render();
      return;
    }

    // Modal openers
    const modalTrigger = e.target.closest("[data-modal]");
    if (modalTrigger) {
      const modalType = modalTrigger.dataset.modal;
      toggleMobileSidebar(true);
      openModal(modalType);
      return;
    }

    // Modal closer
    if (e.target.closest("[data-close]")) {
      closeModal();
      return;
    }

    // Action handlers
    const actionBtn = e.target.closest("[data-action]");
    if (!actionBtn) return;

    const action = actionBtn.dataset.action;
    const id = actionBtn.dataset.id;

    if (action === "support") {
      notify("Support desk: Call +251 91 100 0000 or email support@equb.et");
      return;
    }

    if (action === "logout") {
      if (confirm("Log out of Equb Operations Desk?")) {
        notify("Session ended. Reloading...");
        setTimeout(() => { location.reload(); }, 600);
      }
      return;
    }

    if (action === "refresh") {
      notify("Synchronizing with Supabase...");
      await loadDatabaseData();
      notify("Data synchronized successfully.");
      return;
    }

    if (action === "announcement") {
      state.view = "announcements";
      render();
      return;
    }

    if (action === "generate-password") {
      const pField = document.getElementById("passwordField");
      if (pField) pField.value = generatePassword();
      return;
    }

    if (action === "copy-sql") {
      const sqlEl = document.getElementById("sqlBlock");
      if (sqlEl && navigator.clipboard) {
        navigator.clipboard.writeText(sqlEl.textContent);
        notify("Master SQL schema copied to clipboard.");
      }
      return;
    }

    if (action === "test-connection") {
      notify("Testing connection to Supabase...");
      try {
        const client = getSupabase();
        if (!client) throw new Error("Client initialization failed");
        const profiles = await EqubAPI.getProfiles();
        notify(`Connection verified! Found ${profiles.length} member records.`);
      } catch (err) {
        notify("Connection failed: " + err.message, true);
      }
      return;
    }

    if (action === "save-admin-profile") {
      const nameInput = document.getElementById("settingsAdminName");
      if (nameInput && nameInput.value.trim()) {
        const topAdmin = document.getElementById("adminName");
        const topAvatar = document.getElementById("adminAvatar");
        if (topAdmin) topAdmin.textContent = nameInput.value.trim();
        if (topAvatar) topAvatar.textContent = initials(nameInput.value.trim());
        notify("Administrator profile updated.");
      }
      return;
    }

    // 1. Approve Sign-in
    if (action === "approve-signin") {
      actionBtn.disabled = true;
      try {
        const member = state.members.find(m => m.id === id);
        const pass = member ? member.password : generatePassword();
        await EqubAPI.updateAccountStatus(id, 'APPROVED', pass);
        notify(`Sign-in approved! Password: ${pass}`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to approve sign-in", true);
      }
      return;
    }

    // 2. Reject Sign-in
    if (action === "reject-signin") {
      if (!confirm("Are you sure you want to reject this registration?")) return;
      actionBtn.disabled = true;
      try {
        await EqubAPI.updateAccountStatus(id, 'REJECTED');
        notify("Registration rejected.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to reject sign-in", true);
      }
      return;
    }

    // 3. Accept Join Request
    if (action === "accept-join") {
      actionBtn.disabled = true;
      try {
        await EqubAPI.approveApplication(id);
        notify("Join request approved! Member assigned to circle.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to approve join request", true);
      }
      return;
    }

    // 4. Reject Join Request
    if (action === "reject-join") {
      if (!confirm("Decline this join request?")) return;
      actionBtn.disabled = true;
      try {
        await EqubAPI.rejectApplication(id, "Declined by administrator");
        notify("Join request declined.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to reject request", true);
      }
      return;
    }

    // 4b. Approve Profile Edit Request
    if (action === "approve-profile-edit") {
      actionBtn.disabled = true;
      try {
        await EqubAPI.approveProfileEditRequest(id);
        notify("Profile changes approved! Member profile updated.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to approve profile changes", true);
      }
      return;
    }

    // 4c. Reject Profile Edit Request
    if (action === "reject-profile-edit") {
      if (!confirm("Decline this profile change request?")) return;
      actionBtn.disabled = true;
      try {
        await EqubAPI.rejectProfileEditRequest(id, "Declined by administrator");
        notify("Profile change request declined.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to reject profile change request", true);
      }
      return;
    }

    // 5. Inspect Payment Slip
    if (action === "inspect-payment") {
      const payment = state.payments.find(p => p.id === id);
      if (payment) openModal("receipt", payment);
      return;
    }

    // 6. Approve Payment
    if (action === "approve-payment") {
      actionBtn.disabled = true;
      try {
        await EqubAPI.verifyPaymentProof(id, 'APPROVED');
        closeModal();
        notify("Payment verified! Savings balance updated.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to approve payment", true);
      }
      return;
    }

    // 7. Reject Payment
    if (action === "reject-payment") {
      actionBtn.disabled = true;
      try {
        await EqubAPI.verifyPaymentProof(id, 'REJECTED', "Rejected by admin");
        closeModal();
        notify("Payment rejected.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to reject payment", true);
      }
      return;
    }

    // 8. Circle Actions (Roster, Edit, Delete)
    if (action === "roster") {
      const circle = state.circles.find(c => c.id === id);
      if (circle) openModal("roster", circle);
      return;
    }

    if (action === "edit-circle") {
      const circle = state.circles.find(c => c.id === id);
      if (circle) openModal("edit-circle", circle);
      return;
    }

    if (action === "delete-circle") {
      if (!confirm("Are you sure you want to permanently delete this Equb circle?")) return;
      try {
        await EqubAPI.deleteEqub(id);
        notify("Equb circle deleted.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to delete circle", true);
      }
      return;
    }

    // 9. Member Customization & Revocation
    if (action === "customize-member") {
      const member = state.members.find(m => m.id === id);
      if (member) openModal("customize", member);
      return;
    }

    if (action === "toggle-member") {
      const member = state.members.find(m => m.id === id);
      if (!member) return;
      const newStatus = (member.account === "APPROVED" || member.account === "Approved") ? "SUSPENDED" : "APPROVED";
      try {
        await EqubAPI.updateAccountStatus(id, newStatus);
        notify(`${member.name} account is now ${newStatus.toLowerCase()}.`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to update member status", true);
      }
      return;
    }

    // 9b. Toggle Lottery Participants
    if (action === "toggle-draw-participant") {
      if (state.isWheelSpinning) return;
      const allEligible = state.drawParticipants.length > 0
        ? state.drawParticipants
        : state.members.filter(m => m.account === "APPROVED" || m.account === "Approved");
      
      if (!Array.isArray(state.selectedDrawParticipantIds)) {
        state.selectedDrawParticipantIds = allEligible.map(m => m.id);
      }

      if (state.selectedDrawParticipantIds.includes(id)) {
        state.selectedDrawParticipantIds = state.selectedDrawParticipantIds.filter(x => x !== id);
      } else {
        state.selectedDrawParticipantIds = [...state.selectedDrawParticipantIds, id];
      }
      state.drawWinner = null;
      render();
      return;
    }

    if (action === "toggle-all-draw-participants") {
      if (state.isWheelSpinning) return;
      const allEligible = state.drawParticipants.length > 0
        ? state.drawParticipants
        : state.members.filter(m => m.account === "APPROVED" || m.account === "Approved");

      if (!Array.isArray(state.selectedDrawParticipantIds)) {
        state.selectedDrawParticipantIds = allEligible.map(m => m.id);
      }

      if (state.selectedDrawParticipantIds.length === allEligible.length) {
        state.selectedDrawParticipantIds = [];
      } else {
        state.selectedDrawParticipantIds = allEligible.map(m => m.id);
      }
      state.drawWinner = null;
      render();
      return;
    }

    // 10. Execute Realistic Roulette Lottery Draw
    if (action === "execute-draw") {
      if (state.isWheelSpinning) return;

      const drawSelect = document.getElementById("drawCircleSelect");
      const equbId = drawSelect ? drawSelect.value : (state.circles[0] ? state.circles[0].id : null);
      const circle = state.circles.find(c => c.id === equbId);

      const allEligible = state.drawParticipants.length > 0
        ? state.drawParticipants
        : state.members.filter(m => m.account === "APPROVED" || m.account === "Approved");

      const selectedIds = Array.isArray(state.selectedDrawParticipantIds)
        ? state.selectedDrawParticipantIds
        : allEligible.map(m => m.id);

      const eligible = allEligible.filter(m => selectedIds.includes(m.id));

      if (!eligible || eligible.length === 0) {
        notify("Please check at least 1 member to participate in the draw.", true);
        return;
      }

      state.isWheelSpinning = true;
      const btn = document.getElementById("btnExecuteDraw");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fi fi-sr-spinner fi-spin" style="font-size:14px; display:inline-block; animation: spin 1s linear infinite;"></i> Drawing...`;
      }
      if (drawSelect) drawSelect.disabled = true;

      // 1. Pick winner randomly
      const winnerIdx = Math.floor(Math.random() * eligible.length);
      const winner = eligible[winnerIdx];

      // 2. Geometry for spin
      const N = eligible.length;
      const sliceDeg = 360 / N;
      const sliceCenterDeg = winnerIdx * sliceDeg + sliceDeg / 2;
      // Offset required to bring sliceCenterDeg to 0 deg (top pointer)
      const offsetToTop = (360 - sliceCenterDeg) % 360;
      const currentRot = state.wheelCurrentRotation || 0;
      const delta = (offsetToTop - (currentRot % 360) + 360) % 360;
      const fullSpins = 360 * 6; // 6 full dramatic spins
      const targetRotation = currentRot + fullSpins + delta;
      state.wheelCurrentRotation = targetRotation;

      // 3. Update UI elements for active spin
      const wheelSpinWrap = document.getElementById("wheelSpinWrap");
      const wheelPointerPin = document.getElementById("wheelPointerPin");
      const hubInnerContent = document.getElementById("hubInnerContent");
      const wheelStatusPanel = document.getElementById("wheelStatusPanel");

      if (wheelPointerPin) wheelPointerPin.classList.add("ticking");

      if (hubInnerContent) {
        hubInnerContent.innerHTML = `
          <i class="fi fi-sr-trophy hub-trophy" style="animation: trophy-bounce 0.8s infinite alternate ease-in-out;"></i>
          <div class="hub-status-lbl text-amber">SPINNING...</div>
          <div class="hub-winner-name" style="font-size:13px; color:#cbd5e1;">Randomizing...</div>
          <div class="hub-winner-phone">Fair Rotation</div>
        `;
      }

      if (wheelStatusPanel) {
        wheelStatusPanel.innerHTML = `
          <div class="spin-status-indicator" style="display:flex; align-items:center; gap:12px;">
            <div class="spin-loader-ring" style="width:24px; height:24px; border:3px solid #e2e8f0; border-top-color:#0d9488; border-radius:50%; animation: spin 0.8s linear infinite;"></div>
            <div>
              <div style="font-weight:700; font-size:14px; color:#0f172a;">Spinning...</div>
              <div class="sub" style="font-size:12px; color:#64748b;">The wheel is spinning. Please wait.</div>
            </div>
          </div>
        `;
      }

      if (wheelSpinWrap) {
        wheelSpinWrap.style.transition = "transform 5.2s cubic-bezier(0.12, 0.85, 0.15, 1)";
        wheelSpinWrap.style.transform = `rotate(${targetRotation}deg)`;
      }

      // 4. On Finish (after 5.2s)
      setTimeout(async () => {
        if (wheelPointerPin) wheelPointerPin.classList.remove("ticking");
        state.isWheelSpinning = false;
        state.drawWinner = winner;

        if (hubInnerContent) {
          hubInnerContent.innerHTML = `
            <i class="fi fi-sr-trophy hub-trophy winner-trophy-gold"></i>
            <div class="hub-status-lbl text-emerald">WINNER SELECTED</div>
            <div class="hub-winner-name" title="${esc(winner.name)}">${esc(winner.name)}</div>
            <div class="hub-winner-phone">${esc(winner.phone || "Verified Winner")}</div>
          `;
        }

        if (wheelStatusPanel) {
          wheelStatusPanel.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="pill green" style="background:#ecfdf5; color:#065f46; border-color:#a7f3d0; font-size:13px; padding:6px 16px; font-weight:700; box-shadow:0 2px 8px rgba(16,185,129,0.2);">
                <i class="fi fi-sr-trophy" style="color:#f59e0b; margin-right:6px;"></i> Winner: ${esc(winner.name)} (${esc(winner.phone || "")})
              </span>
            </div>
          `;
        }

        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i class="fi fi-sr-play" style="font-size:14px;"></i> Execute Winner Draw`;
        }
        if (drawSelect) drawSelect.disabled = false;

        // Confetti celebration
        if (typeof confetti === "function") {
          confetti({
            particleCount: 80,
            spread: 70,
            origin: { y: 0.6 }
          });
          setTimeout(() => {
            confetti({
              particleCount: 50,
              angle: 60,
              spread: 55,
              origin: { x: 0 }
            });
            confetti({
              particleCount: 50,
              angle: 120,
              spread: 55,
              origin: { x: 1 }
            });
          }, 300);
        }

        notify(`🎉 Winner Selected: ${winner.name}!`);

        // Record payout in Supabase
        try {
          if (equbId) {
            await EqubAPI.recordPayout({
              equb_id: equbId,
              winner_user_id: winner.id,
              round_number: circle ? (circle.progress || 1) : 1,
              payout_amount: circle ? (circle.volume || 50000) : 50000,
              disbursement_method: 'Bank Transfer'
            }).catch(() => {});
          }
        } catch (e) {}

      }, 5250);

      return;
    }
  });

  // Search input delegation
  document.addEventListener("input", e => {
    if (e.target.matches("[data-search]")) {
      state.search = e.target.value;
      render();
      const input = document.querySelector("[data-search]");
      if (input) {
        input.focus();
        input.setSelectionRange(state.search.length, state.search.length);
      }
    }
  });

  // Filter and Circle Change delegation
  document.addEventListener("change", e => {
    if (e.target.id === "drawCircleSelect") {
      const equbId = e.target.value;
      state.selectedCircleForDraw = state.circles.find(c => c.id === equbId) || null;
      state.selectedDrawParticipantIds = null;
      state.drawWinner = null;
      render();
      return;
    }
    if (e.target.matches("[data-filter]")) {
      state.filter = e.target.value;
      render();
    }
  });

  // Form Submissions
  document.addEventListener("submit", async e => {
    const form = e.target.closest("form");
    if (!form) return;
    e.preventDefault();

    const formType = form.dataset.formType || (form.id === "announcementForm" ? "create-announcement" : null);
    const fd = Object.fromEntries(new FormData(form).entries());

    // 1. Create Equb
    if (formType === "create-equb") {
      closeModal();
      notify("Creating Equb circle...");
      try {
        await EqubAPI.createEqub({
          name: fd.name,
          category: fd.category || 'Savings',
          total_pool: parseFloat(fd.volume) || 0,
          round_payment: parseFloat(fd.payment) || 0,
          rounds: parseInt(fd.rounds) || 10,
          members: parseInt(fd.max) || 10,
          cycle_type: fd.cycle_type || 'Monthly',
          starting_date: new Date().toISOString().split('T')[0],
          status: 'ACTIVE'
        });
        notify(`Equb "${fd.name}" created!`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to create Equb", true);
      }
      return;
    }

    // 1b. Apply for Equb (Join Application)
    if (formType === "apply-equb") {
      closeModal();
      notify("Submitting Equb application...");
      try {
        const member = state.members.find(m => m.id === fd.user_id);
        await EqubAPI.createEqubApplication({
          user_id: fd.user_id,
          equb_id: fd.equb_id,
          fin_number: member?.fayda || `FIN-${Date.now().toString().slice(-6)}`,
          fan_number: `FAN-${Date.now().toString().slice(-6)}`,
          savings_reason: fd.savings_reason || 'Equb Community Savings',
          national_id_photo_url: member?.avatar || 'https://images.unsplash.com/photo-1544717305-2782549b5136?w=600&auto=format&fit=crop&q=60'
        });
        notify(`Application for "${member?.name || 'Member'}" submitted!`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to submit application", true);
      }
      return;
    }

    // 2. Edit Equb
    if (formType === "edit-circle") {
      const equbId = form.dataset.id;
      closeModal();
      notify("Saving circle changes...");
      try {
        await EqubAPI.updateEqub(equbId, {
          name: fd.name,
          category: fd.category,
          total_pool: parseFloat(fd.volume) || 0,
          round_payment: parseFloat(fd.payment) || 0,
          rounds: parseInt(fd.rounds) || 10,
          current_round: parseInt(fd.progress) || 1,
          status: fd.status || 'ACTIVE',
          cycle_type: 'Monthly',
          starting_date: new Date().toISOString().split('T')[0]
        });
        notify(`Circle "${fd.name}" updated.`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to update circle", true);
      }
      return;
    }

    // 3. Create Member
    if (formType === "create-member") {
      closeModal();
      notify("Registering member in Supabase...");
      try {
        const pass = fd.password || generatePassword();
        let photo = fd.avatar_data || null;
        if (window._tempMemberPhotoFile) {
          notify("Uploading photo to profiles storage...");
          const uploadedUrl = await EqubAPI.uploadProfilePhoto(window._tempMemberPhotoFile);
          if (uploadedUrl) photo = uploadedUrl;
          window._tempMemberPhotoFile = null;
        }
        await EqubAPI.createProfile({
          full_name: fd.name,
          phone: fd.phone,
          email: fd.email || null,
          national_id_number: fd.fayda || null,
          photo_url: photo,
          national_id_card_url: photo,
          role: fd.role || 'MEMBER',
          password_hash: pass,
          account_status: 'APPROVED',
          kyc_status: 'APPROVED',
          national_id_verified: true
        });
        notify(`Member "${fd.name}" registered with password: ${pass}`);
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to register member", true);
      }
      return;
    }

    // 4. Edit Member
    if (formType === "edit-member") {
      const memberId = form.dataset.id;
      closeModal();
      notify("Updating member profile...");
      try {
        let photo = fd.avatar_data !== undefined ? fd.avatar_data : null;
        if (window._tempMemberPhotoFile) {
          notify("Uploading photo to profiles storage...");
          const uploadedUrl = await EqubAPI.uploadProfilePhoto(window._tempMemberPhotoFile, memberId);
          if (uploadedUrl) photo = uploadedUrl;
          window._tempMemberPhotoFile = null;
        }
        await EqubAPI.updateFullProfile(memberId, {
          full_name: fd.name,
          phone: fd.phone,
          email: fd.email || null,
          national_id_number: fd.fayda || null,
          photo_url: photo,
          national_id_card_url: photo,
          role: fd.role || 'MEMBER',
          account_status: fd.account || 'APPROVED',
          kyc_status: fd.account === 'APPROVED' ? 'APPROVED' : 'PENDING',
          password_hash: fd.password || 'Password123',
          total_savings: parseFloat(fd.savings) || 0
        });
        // Update local state immediately for instant feedback
        const localMember = state.members.find(m => m.id === memberId);
        if (localMember) {
          localMember.name = fd.name;
          localMember.phone = fd.phone;
          localMember.email = fd.email || '—';
          localMember.fayda = fd.fayda || 'Not registered';
          localMember.role = fd.role || 'MEMBER';
          localMember.account = fd.account || 'APPROVED';
          localMember.password = fd.password || 'Password123';
          localMember.savings = parseFloat(fd.savings) || 0;
          if (photo !== null) localMember.avatar = photo;
        }
        notify(`Profile for "${fd.name}" updated!`);
        render();
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to update profile", true);
      }
      return;
    }

    // 5. Submit Payment Slip
    if (formType === "submit-payment") {
      closeModal();
      notify("Submitting payment slip...");
      try {
        const member = state.members.find(m => m.id === fd.user_id);
        const circle = state.circles.find(c => c.id === fd.equb_id);
        await EqubAPI.submitPaymentSlip({
          user_id: fd.user_id,
          equb_id: fd.equb_id,
          sender_name: member ? member.name : "Member",
          equb_name: circle ? circle.name : "Equb Circle",
          amount: parseFloat(fd.amount) || 0,
          transaction_id: fd.tx,
          round_payment: parseFloat(fd.amount) || 0,
          total_payment: parseFloat(fd.amount) || 0,
          no_of_rounds_participated: parseInt(fd.round) || 1,
          screenshot: "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=600&auto=format&fit=crop&q=60"
        });
        notify("Payment slip submitted for review.");
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to submit payment slip", true);
      }
      return;
    }

    // 6. Create Announcement
    if (formType === "create-announcement") {
      closeModal();
      notify("Publishing announcement broadcast...");
      try {
        const isUrgent = fd.urgency === "true" || fd.urgency === true;
        const newRecord = await EqubAPI.createAnnouncement({
          title: fd.title,
          content: fd.message,
          category: fd.category || 'General',
          is_urgent: isUrgent,
          author_name: 'Equb Operations Desk'
        });
        
        // Optimistic local update
        state.announcements.unshift({
          id: newRecord?.id || `ann-${Date.now()}`,
          title: fd.title,
          category: fd.category || 'General',
          urgency: isUrgent ? "Urgent" : "Normal",
          message: fd.message,
          author: 'Equb Operations Desk',
          timestamp: 'Just now',
          date: new Date().toLocaleDateString()
        });

        // Reset form inputs if on announcements page
        if (form.id === "announcementForm") {
          form.reset();
        }

        notify("Announcement published to members!");
        render();
        await loadDatabaseData(true);
      } catch (err) {
        notify(err.message || "Failed to publish announcement", true);
      }
      return;
    }
  });

  // Modal backdrop click
  const modalLayer = document.getElementById("modalLayer");
  if (modalLayer) {
    modalLayer.addEventListener("click", e => {
      if (e.target.id === "modalLayer") closeModal();
    });
  }



  // Set today's date in header
  const dateEl = document.getElementById("topDate");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString("en-US", {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------
  render();
  loadDatabaseData();
  setupRealtime();

  // Polling fallback every 10 seconds for live consistency
  setInterval(() => {
    if (navigator.onLine) {
      loadDatabaseData(true);
    }
  }, 10000);
})();
