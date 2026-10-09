// Client profiles CRM (shop toolset, phase 8).
//
// Persistent per-shop client records: contact info, allergies, notes,
// plus a tattoo history per client (each tattoo: description, placement,
// date done, artist, aftercare notes, optional link to a booking).
//
// Every function is scoped to the owning shop — shopUserId is required and
// always filtered on, so one shop can never read or touch another shop's
// clients. Callers: routes-clients.js (shop-gated routes).
const db = require('../db');

function clean(v, max = 500) {
  return String(v || '').trim().slice(0, max) || null;
}

// Create a client record. Throws when the name is missing.
async function createClient(shopUserId, fields = {}) {
  const name = clean(fields.name, 200);
  if (!name) throw new Error('Client name is required.');
  return db.insert('shop_clients', {
    shop_user_id: shopUserId,
    name,
    email: clean(fields.email, 200),
    phone: clean(fields.phone, 80),
    allergies: clean(fields.allergies, 1000),
    notes: clean(fields.notes, 2000),
    updated_at: Date.now(),
  });
}

// Every client for one shop, newest-tattoo-count included, A-Z by name.
async function getClients(shopUserId) {
  return db.all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM shop_client_tattoos t WHERE t.client_id = c.id) AS tattoo_count
     FROM shop_clients c
     WHERE c.shop_user_id = ?
     ORDER BY c.name ASC`,
    [String(shopUserId)]);
}

// One client (shop-scoped) with their full tattoo history attached.
async function getClient(id, shopUserId) {
  const client = await db.get(
    'SELECT * FROM shop_clients WHERE id = ? AND shop_user_id = ?',
    [String(id), String(shopUserId)]);
  if (!client) return null;
  client.tattoos = await getTattoos(client.id);
  return client;
}

// Update a client record (shop-scoped). Throws when the client or name is missing.
async function updateClient(id, shopUserId, fields = {}) {
  const client = await db.get(
    'SELECT id FROM shop_clients WHERE id = ? AND shop_user_id = ?',
    [String(id), String(shopUserId)]);
  if (!client) throw new Error('Client not found.');
  const name = clean(fields.name, 200);
  if (!name) throw new Error('Client name is required.');
  await db.update('shop_clients', client.id, {
    name,
    email: clean(fields.email, 200),
    phone: clean(fields.phone, 80),
    allergies: clean(fields.allergies, 1000),
    notes: clean(fields.notes, 2000),
    updated_at: Date.now(),
  });
  return true;
}

// Delete a client (shop-scoped) and their tattoo history. Throws when missing.
// Tattoos are deleted explicitly first so the history always goes with the
// client, even on SQLite with foreign keys off.
async function deleteClient(id, shopUserId) {
  const client = await db.get(
    'SELECT id FROM shop_clients WHERE id = ? AND shop_user_id = ?',
    [String(id), String(shopUserId)]);
  if (!client) throw new Error('Client not found.');
  await db.query('DELETE FROM shop_client_tattoos WHERE client_id = ?', [client.id]);
  await db.query('DELETE FROM shop_clients WHERE id = ?', [client.id]);
  return true;
}

// Add a tattoo to a client's history (shop-scoped). The booking link is
// accepted only when the booking actually belongs to this shop — anything
// else is silently dropped so one shop can't reference another shop's data.
async function addTattoo(clientId, shopUserId, fields = {}) {
  const client = await db.get(
    'SELECT id FROM shop_clients WHERE id = ? AND shop_user_id = ?',
    [String(clientId), String(shopUserId)]);
  if (!client) throw new Error('Client not found.');
  const description = clean(fields.description, 300);
  if (!description) throw new Error('A description is required for the tattoo.');
  let bookingId = fields.booking_id != null && String(fields.booking_id).trim() !== ''
    ? String(fields.booking_id).trim()
    : null;
  if (bookingId) {
    const booking = await db.get(
      'SELECT id FROM bookings WHERE id = ? AND shop_user_id = ?',
      [bookingId, String(shopUserId)]);
    if (!booking) bookingId = null;
  }
  return db.insert('shop_client_tattoos', {
    client_id: client.id,
    booking_id: bookingId,
    description,
    placement: clean(fields.placement, 200),
    date_done: clean(fields.date_done, 40),
    artist_name: clean(fields.artist_name, 200),
    aftercare_notes: clean(fields.aftercare_notes, 1000),
  });
}

// Tattoo history for one client, newest first.
async function getTattoos(clientId) {
  return db.all(
    'SELECT * FROM shop_client_tattoos WHERE client_id = ? ORDER BY created_at DESC',
    [String(clientId)]);
}

module.exports = {
  createClient, getClients, getClient, updateClient, deleteClient,
  addTattoo, getTattoos,
};
