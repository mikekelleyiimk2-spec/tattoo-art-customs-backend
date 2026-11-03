// Self-serve account deletion (privacy follow-up, 2026-11-02).
//
// The privacy policy has always promised "delete your account and data at
// any time from your account page" — until now the code had no such path
// (only an email request). This lib is the working feature behind
// POST /account/delete.
//
// What "delete" means here, following the codebase's own data patterns:
//   - The account IS the OneMind seat (docs/onemind-signin-contract.md §3):
//     one users row, one onemind_id. Deleting the account deletes that row
//     and everything that is purely the account's own data — sessions,
//     seat ties/claims, profiles, photos, favorites, messages sent,
//     credit ledger, payout destinations, raffle entries, shop config.
//   - Shared / financial records follow the house precedent (a design with
//     sales cannot be hard-deleted — admin moderation blocks it): rows
//     other people or the business books depend on are KEPT, with the
//     person's direct identifiers scrubbed (emails blanked) and their
//     user-id columns left orphaned — once the users row is gone, a
//     dangling id resolves to nobody.
//   - The deleting artist's designs: unsold pieces are deleted with
//     their files; sold pieces stay for their buyers with artist_id
//     nulled (designs.artist_id is nullable by schema).
//   - Active PayPal subscriptions are canceled at PayPal first
//     (best-effort, exactly like the membership cancel route: a PayPal
//     failure never blocks the local deletion).
//   - Email-keyed seat state (pending claims, guest pending ties) is
//     deleted by the account's email too — a leftover claim tap would
//     otherwise resurrect a seat for a deleted account.
const db = require('../db');
const paypal = require('./paypal');
const { removeStored, resolveStoredPath } = require('./storage');
const fs = require('fs');
const path = require('path');

// [table, key column] — rows that are purely the account's own data.
const DELETE_BY_USER_ID = [
  // Sessions + seat state (the sign-in itself).
  ['sessions', 'user_id'],
  ['account_ties', 'user_id'],
  ['seat_sessions', 'user_id'],
  ['seat_entitlements', 'user_id'],
  ['seat_traps', 'user_id'],
  ['personal_ai_seats', 'user_id'],
  ['verify_events', 'user_id'],
  ['seat_claims', 'user_id'],
  // Profile + content.
  ['member_photos', 'user_id'],
  ['artist_profiles', 'user_id'],
  ['shop_profiles', 'user_id'],
  ['notifications', 'user_id'],
  ['push_subscriptions', 'user_id'],
  ['user_favorites', 'user_id'],
  ['user_localities', 'user_id'],
  ['conversation_participants', 'user_id'],
  ['messages', 'sender_id'],
  ['combos', 'user_id'],
  ['design_boards', 'owner_user_id'],
  ['ai_listings', 'owner_user_id'],
  ['healed_likes', 'user_id'],
  ['healed_comments', 'user_id'],
  ['journal_entries', 'customer_user_id'],
  // Money held on the site (the account's own ledger + destinations).
  ['subscriptions', 'user_id'],
  ['account_credits', 'user_id'],
  ['credit_topups', 'user_id'],
  ['cashout_requests', 'user_id'],
  ['payout_destinations', 'user_id'],
  // Purchases / entries / usage that belong to the account alone.
  ['print_orders', 'user_id'],
  ['pro_purchases', 'user_id'],
  ['play_purchases', 'user_id'],
  ['review_fee_pool', 'user_id'],
  ['artist_upload_usage', 'user_id'],
  ['business_card_orders', 'user_id'],
  ['event_signups', 'customer_user_id'],
  ['holiday_raffle_entries', 'user_id'],
  ['holiday_raffle_winners', 'user_id'],
  ['raffle_entries', 'user_id'],
  ['first_custom_redemptions', 'user_id'],
  ['design_appeals', 'artist_id'],
  ['submission_codes', 'created_by_user'],
  ['redeem_codes', 'issued_to_user'],
  // Social graph, both directions.
  ['follows', 'follower_user_id'],
  ['follows', 'followed_user_id'],
  // Waitlist / slot offers addressed to this person.
  ['waitlist', 'customer_user_id'],
  ['waitlist', 'shop_user_id'],
  ['slot_offers', 'winner_customer_id'],
  // Referral perks tied to the account.
  ['raffle_referral_credits', 'referrer_user_id'],
  ['raffle_referral_credits', 'referred_user_id'],
  ['referral_redemptions', 'referred_user_id'],
  // Shop-side configuration + the shop's own client list (the shop's
  // data; its customers' shared/financial rows are scrubbed, not here).
  ['shop_clients', 'shop_user_id'],
  ['shop_staff', 'shop_user_id'],
  ['shop_staff', 'artist_user_id'],
  ['availability_rules', 'shop_user_id'],
  ['shop_aftercare_templates', 'shop_user_id'],
  ['shop_announcements', 'shop_user_id'],
  ['shop_booking_settings', 'shop_user_id'],
  ['shop_chairs', 'shop_user_id'],
  ['shop_events', 'shop_user_id'],
  ['shop_expenses', 'shop_user_id'],
  ['shop_inventory_items', 'shop_user_id'],
  ['shop_storefront_settings', 'shop_user_id'],
  ['shop_tap_subscriptions', 'shop_user_id'],
  ['shop_review_settings', 'shop_user_id'],
  ['shop_artists', 'shop_user_id'],
  ['shop_blasts', 'shop_user_id'],
];

// [table, key column] — email-keyed seat state + rosters under the
// account's address. Case-insensitive: addresses were typed by hand.
const DELETE_BY_EMAIL = [
  ['seat_claims', 'email'],
  ['guest_pending_ties', 'email'],
  ['play_purchases', 'email'],
  ['tester_signups', 'email'],
  ['mailing_list', 'email'],
  ['merch_notify', 'email'],
  ['app_launch_signups', 'email'],
  ['founding_figure_signups', 'email'],
];

// [table, SET clause, key column] — rows kept for other parties / the
// business books, with the person's direct identifiers blanked.
const SCRUBS = [
  ['orders', "client_email = ''", 'buyer_id'],
  ['orders', "client_email = ''", 'client_user_id'],
  ['orders', "guest_email = ''", 'buyer_id'],
  ['payouts', "paypal_email = ''", 'recipient_id'],
  ['bug_reports', "reporter_email = ''", 'user_id'],
];

async function existingTables(tx) {
  const rows = db.getMode() === 'pg'
    ? await tx.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'")
    : await tx.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((r) => r.name));
}

// Delete the account and its personal data. Returns a summary; throws on
// a database failure (the caller turns that into a flash, and nothing is
// half-deleted — the data work runs in one transaction).
async function deleteAccount(userId) {
  const user = await db.get(
    'SELECT id, email, role, avatar_url FROM users WHERE id = ?', [userId]);
  if (!user) return { deleted: false, reason: 'not_found' };

  // 1. Cancel active PayPal subscriptions first (best-effort — mirrors
  //    the membership cancel route: still proceed locally on failure).
  const subs = await db.all(
    "SELECT paypal_subscription_id FROM subscriptions WHERE user_id = ? AND status = 'active'",
    [userId]);
  let paypalCanceled = 0;
  for (const s of subs) {
    if (!s.paypal_subscription_id) continue;
    try {
      await paypal.cancelSubscription(s.paypal_subscription_id, 'Account deleted by member');
      paypalCanceled++;
    } catch (e) { /* PayPal unreachable/unknown sub — local delete proceeds */ }
  }

  // 2. Collect the account's files before the rows go (avatar, member
  //    photos, and the files of their unsold designs).
  const photoRows = await db.all('SELECT path FROM member_photos WHERE user_id = ?', [userId]);
  const unsoldDesigns = await db.all(
    `SELECT color_path, linework_path, linework_wm_path, color_wm_path,
            linework_blur_path, custom_watermark_path
     FROM designs WHERE artist_id = ? AND sale_count = 0`, [userId]);
  const uploadFiles = [];
  for (const p of photoRows) {
    if (p.path) uploadFiles.push(path.join('photos', path.basename(p.path)));
  }
  if (user.avatar_url) uploadFiles.push(path.join('avatars', path.basename(user.avatar_url)));
  const designFiles = [];
  for (const d of unsoldDesigns) {
    for (const k of Object.keys(d)) if (d[k]) designFiles.push(d[k]);
  }

  // 3. One transaction: personal rows out, shared rows scrubbed,
  //    designs dispositioned, the users row (the seat) deleted last.
  const counts = {};
  await db.transaction(async (tx) => {
    const tables = await existingTables(tx);
    // The pg transaction handle reports only rows, not change counts —
    // count before deleting so the summary stays honest on both dialects.
    const del = async (table, col, val) => {
      if (!tables.has(table)) return;
      const before = await tx.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [val]).catch(() => null);
      await tx.query(`DELETE FROM ${table} WHERE ${col} = ?`, [val]);
      const n = before ? Number(before.n) || 0 : 0;
      if (n) counts[table] = (counts[table] || 0) + n;
    };
    for (const [table, col] of DELETE_BY_USER_ID) await del(table, col, userId);
    for (const [table, col] of DELETE_BY_EMAIL) {
      if (!tables.has(table)) continue;
      const before = await tx.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE LOWER(${col}) = LOWER(?)`, [user.email]);
      await tx.query(`DELETE FROM ${table} WHERE LOWER(${col}) = LOWER(?)`, [user.email]);
      const n = before ? Number(before.n) || 0 : 0;
      if (n) counts[table] = (counts[table] || 0) + n;
    }
    for (const [table, setClause, col] of SCRUBS) {
      if (!tables.has(table)) continue;
      await tx.query(`UPDATE ${table} SET ${setClause} WHERE ${col} = ?`, [userId]);
    }
    // Someone else's client list holding this person's email: blank the
    // address (the shops' rows stay — they are the shops' records).
    if (tables.has('shop_clients')) {
      await tx.query(
        "UPDATE shop_clients SET email = '' WHERE LOWER(email) = LOWER(?)", [user.email]);
    }
    if (tables.has('designs')) {
      // Sold pieces stay for their buyers, unattributed; unsold pieces
      // are the artist's own content and go with the account.
      await tx.query(
        'UPDATE designs SET artist_id = NULL WHERE artist_id = ? AND sale_count > 0', [userId]);
      const before = await tx.get(
        'SELECT COUNT(*) AS n FROM designs WHERE artist_id = ? AND sale_count = 0', [userId]);
      await tx.query(
        'DELETE FROM designs WHERE artist_id = ? AND sale_count = 0', [userId]);
      const n = before ? Number(before.n) || 0 : 0;
      if (n) counts.designs = n;
    }
    await tx.query('DELETE FROM users WHERE id = ?', [userId]);
  });

  // 4. Files, best-effort, after the commit (same patterns the account
  //    and admin routes already use for photo/design removal).
  let filesRemoved = 0;
  for (const rel of uploadFiles) {
    const abs = resolveStoredPath(rel);
    if (abs) { try { fs.unlinkSync(abs); filesRemoved++; } catch (e) { /* already gone */ } }
  }
  for (const rel of designFiles) {
    try { await removeStored(rel); filesRemoved++; } catch (e) { /* already gone */ }
  }

  return { deleted: true, email: user.email, paypalCanceled, counts, filesRemoved };
}

module.exports = { deleteAccount, DELETE_BY_USER_ID, DELETE_BY_EMAIL, SCRUBS };
