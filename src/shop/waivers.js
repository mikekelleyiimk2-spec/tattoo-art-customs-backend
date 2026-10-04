// Digital waivers + ID capture (shop toolset expansion, F2).
//
// Shops supply their own waiver text (we are NOT their lawyer — the editor
// and signing pages both carry the standing disclaimer). Clients sign on
// their phone; an optional ID photo is stored ENCRYPTED (AES-256-GCM) with
// an auto-delete retention policy. Plaintext ID bytes never touch disk/DB.
//
// Key: ID_DOC_KEY env (64 hex chars). Fail closed when missing.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { getBookingSettings } = require('./bookingFlow');

const ALG = 'aes-256-gcm';

function keyBytes() {
  if (!config.idDocConfigured()) {
    const e = new Error('ID capture is not configured on this server.');
    e.code = 'ID_CAPTURE_UNAVAILABLE';
    throw e;
  }
  return Buffer.from(config.idDocKey, 'hex');
}

function encryptIdPhoto(buffer) {
  const key = keyBytes();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc_blob: Buffer.concat([tag, enc]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

function decryptIdPhoto({ enc_blob, iv }) {
  const key = keyBytes();
  const raw = Buffer.from(String(enc_blob), 'base64');
  const tag = raw.subarray(0, 16);
  const enc = raw.subarray(16);
  const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(String(iv), 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// --- Waiver templates -------------------------------------------------------
async function createWaiver(shopUserId, { title, legalText }) {
  title = String(title || '').trim().slice(0, 120);
  legalText = String(legalText || '').trim().slice(0, 20000);
  if (!title) throw new Error('Give the waiver a title.');
  if (legalText.length < 20) throw new Error('Waiver text is too short.');
  return db.insert('shop_waivers', {
    shop_user_id: String(shopUserId), title, legal_text: legalText, active: 1,
  });
}

async function updateWaiver(shopUserId, waiverId, { title, legalText, active }) {
  const w = await db.get('SELECT * FROM shop_waivers WHERE id = ? AND shop_user_id = ?',
    [String(waiverId), String(shopUserId)]);
  if (!w) throw new Error('Waiver not found.');
  const patch = {};
  if (title !== undefined) patch.title = String(title).trim().slice(0, 120);
  if (legalText !== undefined) {
    const t = String(legalText).trim().slice(0, 20000);
    if (t.length < 20) throw new Error('Waiver text is too short.');
    patch.legal_text = t;
  }
  if (active !== undefined) patch.active = active ? 1 : 0;
  if (Object.keys(patch).length) await db.update('shop_waivers', w.id, patch);
  return db.get('SELECT * FROM shop_waivers WHERE id = ?', [w.id]);
}

async function getWaiversForShop(shopUserId) {
  return db.all(
    'SELECT * FROM shop_waivers WHERE shop_user_id = ? ORDER BY active DESC, created_at DESC',
    [String(shopUserId)]);
}

async function getActiveWaiver(shopUserId) {
  return db.get(
    'SELECT * FROM shop_waivers WHERE shop_user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
    [String(shopUserId)]);
}

// --- Signing ----------------------------------------------------------------
// signatureSvg: the drawn signature pad's SVG (small). idPhotoBuffer: optional
// JPEG/PNG bytes — encrypted immediately, plaintext never persisted.
async function signWaiver({ waiverId, bookingId, customerUserId, signerName, signatureSvg, idPhotoBuffer }) {
  const waiver = await db.get('SELECT * FROM shop_waivers WHERE id = ?', [String(waiverId)]);
  if (!waiver || Number(waiver.active) !== 1) throw new Error('This waiver is no longer active.');
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [String(bookingId)]);
  if (!booking) throw new Error('Booking not found.');
  if (String(booking.customer_user_id) !== String(customerUserId)) throw new Error('Not your booking.');
  if (String(booking.shop_user_id) !== String(waiver.shop_user_id)) throw new Error('Waiver does not belong to this booking’s shop.');
  signerName = String(signerName || '').trim().slice(0, 120);
  if (!signerName) throw new Error('Please type your full legal name.');
  signatureSvg = String(signatureSvg || '').slice(0, 20000);
  if (signatureSvg.length < 50) throw new Error('Please draw your signature.');
  const existing = await db.get(
    'SELECT id FROM waiver_signatures WHERE waiver_id = ? AND booking_id = ? AND customer_user_id = ? LIMIT 1',
    [waiver.id, booking.id, String(customerUserId)]);
  if (existing) throw new Error('You already signed this waiver for this booking.');
  const sigId = await db.insert('waiver_signatures', {
    waiver_id: waiver.id, booking_id: booking.id,
    customer_user_id: String(customerUserId),
    signer_name: signerName, signature_svg: signatureSvg,
    signed_at: Date.now(),
  });
  let idDocId = null;
  if (idPhotoBuffer && idPhotoBuffer.length) {
    if (idPhotoBuffer.length > 5 * 1024 * 1024) throw new Error('ID photo is too large (5MB max).');
    const { enc_blob, iv } = encryptIdPhoto(idPhotoBuffer); // throws when unconfigured
    const settings = await getBookingSettings(booking.shop_user_id);
    const days = Math.max(30, Math.min(2555, Number(settings.id_retention_days) || 730));
    idDocId = await db.insert('waiver_id_docs', {
      signature_id: sigId, enc_blob, iv,
      delete_after: Date.now() + days * 86400000,
    });
  }
  return { signatureId: sigId, idDocId };
}

async function getSignatureForShop(shopUserId, signatureId) {
  const sig = await db.get(
    `SELECT ws.*, w.shop_user_id, w.title AS waiver_title, b.start_at
     FROM waiver_signatures ws
     JOIN shop_waivers w ON w.id = ws.waiver_id
     JOIN bookings b ON b.id = ws.booking_id
     WHERE ws.id = ?`, [String(signatureId)]);
  if (!sig || String(sig.shop_user_id) !== String(shopUserId)) throw new Error('Signature not found.');
  const idDoc = await db.get('SELECT id, created_at, delete_after FROM waiver_id_docs WHERE signature_id = ? LIMIT 1', [sig.id]);
  return { ...sig, has_id_doc: !!idDoc, id_doc: idDoc || null };
}

// Decrypts in memory only for the shop's immediate view. Never logs plaintext.
async function getDecryptedIdDoc(shopUserId, signatureId) {
  const { id_doc } = await getSignatureForShop(shopUserId, signatureId);
  if (!id_doc) throw new Error('No ID on file.');
  const row = await db.get('SELECT enc_blob, iv FROM waiver_id_docs WHERE id = ?', [id_doc.id]);
  return decryptIdPhoto(row);
}

async function getSignaturesForBooking(bookingId) {
  return db.all(
    `SELECT ws.*, w.title AS waiver_title FROM waiver_signatures ws
     JOIN shop_waivers w ON w.id = ws.waiver_id
     WHERE ws.booking_id = ? ORDER BY ws.signed_at ASC`, [String(bookingId)]);
}

// Daily sweeper: hard-delete ID docs past retention. Signatures stay (legal record).
async function purgeExpiredIdDocs() {
  const stale = await db.all('SELECT id FROM waiver_id_docs WHERE delete_after <= ?', [Date.now()]);
  let n = 0;
  for (const s of stale) {
    const done = await db.query('DELETE FROM waiver_id_docs WHERE id = ?', [s.id]);
    if (done.changes) n += 1;
  }
  return n;
}

module.exports = {
  idCaptureConfigured: () => config.idDocConfigured(),
  encryptIdPhoto, decryptIdPhoto,
  createWaiver, updateWaiver, getWaiversForShop, getActiveWaiver,
  signWaiver, getSignatureForShop, getDecryptedIdDoc, getSignaturesForBooking,
  purgeExpiredIdDocs,
};
