// Customer healed/journal photo uploads.
// Single 'photo' field, stored under assets/uploads/photos — served publicly
// at /img/photos (index.js). These are customer-uploaded photos of healed
// work, not catalog art, so the watermark-only artwork rule does not apply.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');

const photosDir = path.join(config.uploadDir, 'photos');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(photosDir, { recursive: true });
    cb(null, photosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 5) || '.jpg';
    const who = (req.user && req.user.id) || 'anon';
    cb(null, `${who}-${Date.now()}-photo${ext}`);
  },
});

const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WebP images are allowed.'));
  },
}).single('photo');

// Promise-style wrapper with friendly errors (null on success).
function handlePhotoUpload(req, res) {
  return new Promise((resolve) => {
    uploadPhoto(req, res, (err) => resolve(err || null));
  });
}

// Asset-relative path for storing in photo_path columns.
function photoRelPath(file) {
  return path.relative(config.uploadDir, file.path);
}

module.exports = { uploadPhoto, handlePhotoUpload, photoRelPath, photosDir };
