// Automatic watermark pipeline for designer portfolio uploads.
//
// Choice 'site'  — the site's standard watermark images (colorful texture
//                  passes) + the site's solid-black anti-trace marks.
// Choice 'custom' — the artist's own uploaded watermark image as the texture
//                  pass + the SAME solid-black anti-trace marks (applied in
//                  both cases, per standing public-image rules).
//
// Placement (owner rule 2026-09-29): the black marks are aimed at the
// DENSEST linework regions of each design (density-aware), and both the
// mark positions and the texture-pass angles/offsets are randomized per
// design via a deterministic seeded RNG keyed on designId — stable output
// for a given design, unpredictable across designs. The goal is to cross
// as many lines as possible so the art can't be traced around the marks.
//
// The solid-black marks are silhouettes cut from the lettering regions of the
// site watermark images (bright areas -> opaque black), matching the house
// pipeline in ~/workspace/watermark/apply_user_watermark.py.
// Clean color + clean linework are never touched; only the generated
// watermarked linework is served publicly.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');

const SITE_WM_1 = 'watermarks/site-wm-1.jpg';
const SITE_WM_2 = 'watermarks/site-wm-2.jpg';
// Repo-bundled copies (committed) used when ASSET_DIR is a mounted volume
// that does not ship them yet.
const REPO_WM_DIR = path.join(__dirname, '..', '..', 'watermarks');

// Lettering crops (fractions of each site watermark image) used for the
// solid-black anti-trace marks.
const BLACK_CROPS = [
  { file: SITE_WM_1, left: 0.18, top: 0.30, w: 0.44, h: 0.32 },
  { file: SITE_WM_2, left: 0.42, top: 0.22, w: 0.32, h: 0.30 },
];
// Fallback positions (fractions of W/H) if density analysis fails.
const MARK_POSITIONS = [
  { x: 0.06, y: 0.36 },
  { x: 0.48, y: 0.60 },
];
const BLACK_THRESHOLD = 70;
// Mark width as a fraction of the artwork width.
const MARK_WIDTH_FRAC = 0.45;
// Coarse grid used for linework density analysis.
const DENSITY_GRID_N = 16;
// Minimum separation between mark centers, as a fraction of the grid span.
// Kept below the mark width (0.45) so both marks can still sit inside one
// dense region — they may slightly overlap, but never stack exactly.
const MARK_MIN_SEP_FRAC = 0.30;

// Deterministic seeded RNG keyed on an arbitrary string (xmur3 + mulberry32).
function seededRng(key) {
  const s = String(key);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function siteWmAbs(rel) {
  const fromAssets = path.join(config.assetDir, rel);
  if (fs.existsSync(fromAssets)) return fromAssets;
  const fromRepo = path.join(REPO_WM_DIR, path.basename(rel));
  return fs.existsSync(fromRepo) ? fromRepo : null;
}

// Build an opaque-black silhouette of a watermark image's lettering region:
// bright pixels become solid black, everything else transparent.
async function blackSilhouette(abs, crop, targetWidth) {
  const meta = await sharp(abs).metadata();
  const region = {
    left: Math.max(0, Math.round(meta.width * crop.left)),
    top: Math.max(0, Math.round(meta.height * crop.top)),
    width: Math.max(1, Math.round(meta.width * crop.w)),
    height: Math.max(1, Math.round(meta.height * crop.h)),
  };
  region.width = Math.min(region.width, meta.width - region.left);
  region.height = Math.min(region.height, meta.height - region.top);
  const { data, info } = await sharp(abs)
    .extract(region).greyscale().resize({ width: targetWidth })
    .raw().toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const rgba = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0;
    rgba[o + 3] = data[i] > BLACK_THRESHOLD ? 255 : 0;
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png().toBuffer();
}

// Linework density on a coarse grid: linework is dark lines on a light
// background, so a cell's density is its darkness. Returns a flat
// DENSITY_GRID_N x DENSITY_GRID_N array of 0..1 values, row-major.
async function lineDensityGrid(lineworkAbs) {
  const { data } = await sharp(lineworkAbs)
    .greyscale().resize(DENSITY_GRID_N, DENSITY_GRID_N, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const grid = new Array(DENSITY_GRID_N * DENSITY_GRID_N);
  for (let i = 0; i < grid.length; i++) grid[i] = (255 - data[i]) / 255;
  return grid;
}

// Pick top-left mark positions (fractions of W/H) over the densest linework
// regions. Deterministic for a given designId; unpredictable across designs.
// Marks keep a minimum center separation so they never stack.
function planMarkPositions({ designId, grid, count = BLACK_CROPS.length }) {
  const N = DENSITY_GRID_N;
  if (!Array.isArray(grid) || grid.length !== N * N) {
    return MARK_POSITIONS.slice(0, count);
  }
  const fw = Math.max(3, Math.round(N * MARK_WIDTH_FRAC));
  // Silhouette crops are wider than tall (~0.73 aspect); scale to the grid.
  const fh = Math.max(2, Math.round(fw * 0.73));
  const rng = seededRng('wmpos:' + designId);
  // Score every candidate top-left cell by the density under the footprint.
  const cands = [];
  for (let r = 0; r <= N - fh; r++) {
    for (let c = 0; c <= N - fw; c++) {
      let s = 0;
      for (let dr = 0; dr < fh; dr++) {
        for (let dc = 0; dc < fw; dc++) s += grid[(r + dr) * N + (c + dc)];
      }
      // Tiny seeded tie-break so uniform regions don't always pick (0,0).
      cands.push({ c, r, s: s + rng() * 0.5 });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const minSep = N * MARK_MIN_SEP_FRAC;
  const chosen = [];
  for (const cand of cands) {
    if (chosen.length >= count) break;
    const cx = cand.c + fw / 2, cy = cand.r + fh / 2;
    if (chosen.every((p) => Math.hypot(p.cx - cx, p.cy - cy) >= minSep)) {
      chosen.push({ ...cand, cx, cy });
    }
  }
  // Degenerate case (tiny/uniform grid): relax separation, take the best.
  for (const cand of cands) {
    if (chosen.length >= count) break;
    if (!chosen.includes(cand)) chosen.push({ ...cand, cx: cand.c + fw / 2, cy: cand.r + fh / 2 });
  }
  return chosen.slice(0, count).map((p) => {
    const jx = (rng() - 0.5) / N, jy = (rng() - 0.5) / N;
    const x = Math.min(Math.max(p.c / N + jx, 0), 1 - fw / N);
    const y = Math.min(Math.max(p.r / N + jy, 0), 1 - fh / N);
    return { x, y };
  });
}

// One watermark texture pass, rotated and offset per design (seeded).
// invert=true treats DARK ink as the visible part (on-site builder marks are
// dark-on-transparent); the default treats bright areas as visible.
async function texturePass(abs, baseW, baseH, scale, angle, dxFrac = 0, dyFrac = 0, invert = false) {
  const w = Math.max(50, Math.round(baseW * scale));
  // Luminance -> alpha: bright artwork/text in the watermark stays visible,
  // dark backgrounds turn transparent (same treatment as the house pipeline).
  // Inverted (builder marks): dark ink stays visible, light/transparent goes.
  const { data, info } = await sharp(abs).resize({ width: w }).raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const ch = info.channels;
  const rgba = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const o = i * ch, q = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const srcAlpha = ch === 4 ? data[o + 3] / 255 : 1;
    const cover = invert ? (255 - lum) : lum;
    rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b;
    rgba[q + 3] = Math.round(Math.min(255, cover * 1.15) * srcAlpha);
  }
  const withAlpha = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();
  const rotated = await sharp(withAlpha)
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  // A rotated texture can exceed the base — contain it so compositing
  // never fails, keeping the largest size that fits.
  const contained = await sharp(rotated)
    .resize({ width: baseW, height: baseH, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
  const tm = await sharp(contained).metadata();
  const left = Math.max(0, Math.round((baseW - (tm.width || baseW)) / 2 + dxFrac * baseW));
  const top = Math.max(0, Math.round((baseH - (tm.height || baseH)) / 2 + dyFrac * baseH));
  return { input: contained, left, top };
}

// Generate the public watermarked linework for a design. Returns the path
// relative to ASSET_DIR (suitable for designs.linework_wm_path).
//
// customInvert: set when the custom mark came from the on-site builder
// (dark ink on transparency) so its dark strokes render opaque instead of
// vanishing under the bright-is-visible mapping.
async function applyWatermarkedLinework({ designId, lineworkAbs, choice = 'site', customWatermarkAbs = null, customInvert = false }) {
  if (!fs.existsSync(lineworkAbs)) throw new Error('linework file not found: ' + lineworkAbs);
  const meta = await sharp(lineworkAbs).metadata();
  const W = meta.width || 1024;
  const H = meta.height || 1024;
  const overlays = [];
  const rng = seededRng('wmtex:' + designId);
  const jitter = (base, spread) => base + (rng() * 2 - 1) * spread;
  const off = () => (rng() - 0.5) * 0.10; // ±5% of canvas

  // 1) Watermark texture pass(es) — the designer's choice, with per-design
  //    randomized rotation and center offset (coverage stays full).
  const customOk = choice === 'custom' && customWatermarkAbs && fs.existsSync(customWatermarkAbs);
  const wm1 = siteWmAbs(SITE_WM_1);
  const wm2 = siteWmAbs(SITE_WM_2);
  const passes = [];
  if (customOk) {
    passes.push({ abs: customWatermarkAbs, scale: 1.35, angle: jitter(-18, 12), opacity: 0.42, invert: customInvert });
    passes.push({ abs: customWatermarkAbs, scale: 1.00, angle: jitter(22, 12), opacity: 0.30, invert: customInvert });
  } else {
    if (wm1) passes.push({ abs: wm1, scale: 1.35, angle: jitter(-18, 12), opacity: 0.42, invert: false });
    if (wm2) passes.push({ abs: wm2, scale: 1.15, angle: jitter(24, 12), opacity: 0.36, invert: false });
  }
  for (const p of passes) {
    const t = await texturePass(p.abs, W, H, p.scale, p.angle, off(), off(), p.invert);
    overlays.push({ input: t.input, left: t.left, top: t.top, opacity: p.opacity });
  }

  // 2) Solid-black anti-trace marks — ALWAYS from the site watermark images,
  //    in both choices. Placed over the densest linework regions.
  let grid = null;
  try { grid = await lineDensityGrid(lineworkAbs); } catch (e) { grid = null; }
  const positions = planMarkPositions({ designId, grid });
  for (let i = 0; i < BLACK_CROPS.length; i++) {
    const abs = siteWmAbs(BLACK_CROPS[i].file);
    if (!abs) continue;
    const pos = positions[i] || MARK_POSITIONS[i % MARK_POSITIONS.length];
    const left = Math.round(W * pos.x);
    const top = Math.round(H * pos.y);
    let mark = await blackSilhouette(abs, BLACK_CROPS[i], Math.round(W * MARK_WIDTH_FRAC));
    // Contain the mark in the remaining canvas so compositing never fails.
    const mMeta = await sharp(mark).metadata();
    if (left + mMeta.width > W || top + mMeta.height > H) {
      mark = await sharp(mark).resize({
        width: Math.max(10, W - left), height: Math.max(10, H - top),
        fit: 'inside', withoutEnlargement: true,
      }).png().toBuffer();
    }
    overlays.push({ input: mark, left, top });
  }

  const outRel = `designs/linework-wm/${designId}-auto.jpg`;
  const outAbs = path.join(config.uploadDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  await sharp(lineworkAbs).composite(overlays).jpeg({ quality: 88 }).toFile(outAbs);
  return outRel;
}

// Content-policy blur: a heavily blurred copy of the WATERMARKED linework,
// used as the public preview for 'explicit' pieces (sexual acts / highly
// offensive content). The watermark stays baked in underneath the blur.
// Age-verified opted-in viewers, the artist, admins, and buyers see the
// unblurred watermarked version instead.
async function applyBlurredVariant({ designId, watermarkedAbs }) {
  if (!watermarkedAbs || !fs.existsSync(watermarkedAbs)) {
    throw new Error('watermarked linework not found for blur: ' + watermarkedAbs);
  }
  const outRel = `designs/linework-wm/${designId}-blur.jpg`;
  const outAbs = path.join(config.uploadDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  await sharp(watermarkedAbs).blur(40).jpeg({ quality: 82 }).toFile(outAbs);
  return outRel;
}

module.exports = {
  applyWatermarkedLinework, applyBlurredVariant, SITE_WM_1, SITE_WM_2,
  seededRng, lineDensityGrid, planMarkPositions, MARK_POSITIONS, DENSITY_GRID_N,
};
