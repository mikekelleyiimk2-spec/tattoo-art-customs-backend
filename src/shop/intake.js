// Intake forms (shop toolset, Phase 3).
//
// One intake form per booking (intake_forms.booking_id UNIQUE). The customer
// fills in placement/size/cover-up/details plus up to 5 reference photos
// before the appointment; the shop reads it at GET /intake/view/:bookingId.
//
// Text fields run through the contact-info screener (src/lib/screening.js):
// a flag does NOT block the save — the form is kept and a review_queue row
// is opened for an admin, mirroring the portfolio-upload pattern.
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { screenText } = require('../lib/screening');

const MAX_PHOTOS = 5;
const INTAKE_DIR = 'intake'; // relative to config.uploadDir

function intakeAbsDir() {
  const dir = path.join(config.uploadDir, INTAKE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Persist uploaded reference photos; returns relative paths for
// reference_photos_json. `files` are multer file objects.
function storeIntakePhotos(bookingId, files) {
  const dir = intakeAbsDir();
  const saved = [];
  for (const f of files || []) {
    if (saved.length >= MAX_PHOTOS) break;
    const ext = path.extname(f.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    const name = `${bookingId}-${Date.now()}-${saved.length}${ext}`;
    fs.renameSync(f.path, path.join(dir, name));
    saved.push(path.join(INTAKE_DIR, name));
  }
  return saved;
}

// Save (insert or update) the intake form for a booking. The caller must be
// the booking's customer — verified here, not trusted from the route.
async function saveIntake({ bookingId, customerUserId, fields = {}, files = [] }) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [String(bookingId)]);
  if (!booking) throw new Error('Booking not found.');
  if (booking.customer_user_id !== customerUserId) throw new Error('That booking is not yours.');
  if (booking.status === 'cancelled') throw new Error('That booking was cancelled.');

  const placement = String(fields.placement || '').trim().slice(0, 120) || null;
  const sizeText = String(fields.size_text || '').trim().slice(0, 120) || null;
  const coverUp = fields.cover_up ? 1 : 0;
  const details = String(fields.details || '').trim().slice(0, 4000) || null;

  const photos = storeIntakePhotos(booking.id, files);
  const existing = await db.get('SELECT * FROM intake_forms WHERE booking_id = ?', [booking.id]);
  let mergedPhotos = photos;
  if (existing && existing.reference_photos_json) {
    try {
      const prev = JSON.parse(existing.reference_photos_json);
      if (Array.isArray(prev)) mergedPhotos = [...prev, ...photos].slice(0, MAX_PHOTOS);
    } catch (_) { /* keep the new set */ }
  }

  const data = {
    booking_id: booking.id, placement, size_text: sizeText,
    cover_up: coverUp, details,
    reference_photos_json: JSON.stringify(mergedPhotos),
  };
  const id = await db.upsert('intake_forms', 'booking_id', data);

  // Screen the free-text fields; a flag opens admin review but keeps the form.
  const screen = screenText(`${placement || ''}\n${sizeText || ''}\n${details || ''}`);
  if (!screen.ok) {
    await db.insert('review_queue', {
      item_type: 'intake', item_id: id,
      reason: 'Contact info detected in intake form: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open',
    });
  }
  return { id, flagged: !screen.ok };
}

async function getIntakeForBooking(bookingId) {
  return db.get('SELECT * FROM intake_forms WHERE booking_id = ?', [String(bookingId)]);
}

module.exports = { MAX_PHOTOS, INTAKE_DIR, intakeAbsDir, storeIntakePhotos, saveIntake, getIntakeForBooking };
