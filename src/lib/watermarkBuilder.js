// On-site watermark builder for design artists.
//
// Owner rule 2026-09-29: protection is NOT opt-in. This builder refuses to
// produce weak marks — it only generates dense, dark, multi-line marks that
// are hard to clean off or trace around:
//   - color choices are restricted to a DARK palette (enforced server-side,
//     palette membership + a luminance guard, never just the UI),
//   - at least 2 lines of text are required,
//   - text is rendered LARGE, at multiple overlapping angles,
//   - the finished mark must clear a minimum ink-coverage threshold or it
//     is rejected with guidance to add more text.
//
// The saved mark becomes the artist's default custom watermark
// (watermarks/custom/<artistId>.png under ASSET_DIR). The upload pipeline
// uses it whenever the artist picks "my own watermark" without uploading a
// file, and renders it with inverted luminance mapping (dark ink -> opaque)
// so the dark strokes actually show over the artwork.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');

// Dark-only palette. Anything not on this list is rejected server-side.
const DARK_PALETTE = [
  { hex: '#000000', name: 'Black' },
  { hex: '#161616', name: 'Charcoal' },
  { hex: '#0d1b2a', name: 'Midnight navy' },
  { hex: '#2b0a0a', name: 'Dark oxblood' },
  { hex: '#0f2e1d', name: 'Deep forest' },
  { hex: '#2a1a3e', name: 'Dark plum' },
  { hex: '#3d2b00', name: 'Dark bronze' },
  { hex: '#1f2937', name: 'Dark slate' },
];

// Defense in depth: even a palette color must be genuinely dark.
const MAX_LUMINANCE = 0.16;
// Minimum share of the canvas covered in dark ink.
const MIN_INK_COVERAGE = 0.10;
// Canvas for the generated mark.
const MARK_W = 1400;
const MARK_H = 1000;
// Font sizes per line index (fractions of canvas height stay large).
const LINE_SIZES = [170, 130, 105];
// Each line is stamped at several overlapping angles for density.
const STAMP_ANGLES = [-16, 10, 30];
const MAX_LINE_LEN = 48;

function hexLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeArtistId(artistId) {
  const s = String(artistId == null ? '' : artistId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('Invalid artist id.');
  return s;
}

function defaultMarkRel(artistId) {
  return `watermarks/custom/${safeArtistId(artistId)}.png`;
}

function defaultMarkAbs(artistId) {
  return require('./storage').resolveStoredPath(defaultMarkRel(artistId))
    || path.join(config.uploadDir, defaultMarkRel(artistId));
}

function defaultMarkExists(artistId) {
  try { return fs.existsSync(defaultMarkAbs(artistId)); } catch (e) { return false; }
}

// Validate builder input. Returns { lines, colorHex } or throws.
function validateBuilderInput({ lines, color }) {
  const clean = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l == null ? '' : l).trim())
    .filter((l) => l.length > 0);
  if (clean.length < 2) {
    throw new Error('Use at least 2 lines of text (for example your signature and your studio name) — a single short line is too easy to clone or clean off.');
  }
  for (const l of clean) {
    if (l.length > MAX_LINE_LEN) throw new Error(`Keep each line under ${MAX_LINE_LEN} characters.`);
  }
  const hex = String(color || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error('Pick a color from the dark palette.');
  const pal = DARK_PALETTE.find((p) => p.hex.toLowerCase() === hex);
  if (!pal) throw new Error('That color is not allowed — only dark palette colors protect your work.');
  if (hexLuminance(hex) > MAX_LUMINANCE) {
    throw new Error('That color is too light — dark colors only, so the mark can\'t be washed out.');
  }
  return { lines: clean.slice(0, 3), colorHex: pal.hex };
}

function buildMarkSvg({ lines, colorHex }) {
  let texts = '';
  lines.forEach((line, li) => {
    const size = LINE_SIZES[Math.min(li, LINE_SIZES.length - 1)];
    STAMP_ANGLES.forEach((a, ai) => {
      const cx = Math.round(MARK_W / 2 + (ai - 1) * 70 + li * 24);
      const cy = Math.round(MARK_H / 2 + (li - (lines.length - 1) / 2) * size * 1.25 + (ai - 1) * 34);
      texts += `<text x="${cx}" y="${cy}" text-anchor="middle" ` +
        `font-family="DejaVu Sans, sans-serif" font-weight="900" font-size="${size}" ` +
        `fill="${colorHex}" transform="rotate(${a} ${cx} ${cy})">${escapeXml(line)}</text>`;
    });
  });
  return `<svg width="${MARK_W}" height="${MARK_H}" xmlns="http://www.w3.org/2000/svg">${texts}</svg>`;
}

// Share of canvas pixels covered in dark opaque ink.
async function inkCoverage(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const ch = info.channels;
  let ink = 0;
  for (let i = 0; i < px; i++) {
    const o = i * ch;
    if (ch === 4 && data[o + 3] < 128) continue;
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (lum < 150) ink++;
  }
  return ink / px;
}

async function buildMarkBuffer({ lines, color }) {
  const { lines: clean, colorHex } = validateBuilderInput({ lines, color });
  const png = await sharp(Buffer.from(buildMarkSvg({ lines: clean, colorHex })))
    .png().toBuffer();
  const coverage = await inkCoverage(png);
  if (coverage < MIN_INK_COVERAGE) {
    throw new Error(
      `That mark is too sparse to protect your work (covers ${(coverage * 100).toFixed(1)}% of the canvas, ` +
      `minimum ${(MIN_INK_COVERAGE * 100).toFixed(0)}%). Add longer lines — your full signature plus studio name works best.`);
  }
  return { buffer: png, coverage, lines: clean, colorHex };
}

// Build the mark and save it as the artist's default custom watermark.
// Throws on any validation/coverage failure — no weak mark is ever saved.
async function buildAndSave({ artistId, lines, color }) {
  const { buffer } = await buildMarkBuffer({ lines, color });
  const rel = defaultMarkRel(artistId);
  const abs = path.join(config.uploadDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

module.exports = {
  DARK_PALETTE, MAX_LUMINANCE, MIN_INK_COVERAGE, MARK_W, MARK_H,
  validateBuilderInput, buildMarkBuffer, buildAndSave, inkCoverage,
  defaultMarkRel, defaultMarkAbs, defaultMarkExists, hexLuminance,
};
