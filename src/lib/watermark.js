// Automatic watermark pipeline for designer portfolio uploads.
//
// Choice 'site'  — the site's standard watermark images (colorful texture
//                  passes) + the site's solid-black anti-trace marks.
// Choice 'custom' — the artist's own uploaded watermark image as the texture
//                  pass + the SAME solid-black anti-trace marks (applied in
//                  both cases, per standing public-image rules).
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
// Where the two black marks land on the artwork (fractions of W/H).
const MARK_POSITIONS = [
  { x: 0.06, y: 0.36 },
  { x: 0.48, y: 0.60 },
];
const BLACK_THRESHOLD = 70;

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

async function texturePass(abs, baseW, baseH, scale, angle) {
  const w = Math.max(50, Math.round(baseW * scale));
  // Luminance -> alpha: bright artwork/text in the watermark stays visible,
  // dark backgrounds turn transparent (same treatment as the house pipeline).
  const { data, info } = await sharp(abs).resize({ width: w }).raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const ch = info.channels;
  const rgba = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const o = i * ch, q = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b;
    rgba[q + 3] = Math.min(255, Math.round(lum * 1.15));
  }
  const withAlpha = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();
  const rotated = await sharp(withAlpha)
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  // A rotated texture can exceed the base — contain it so compositing
  // never fails, keeping the largest size that fits.
  return sharp(rotated)
    .resize({ width: baseW, height: baseH, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
}

// Generate the public watermarked linework for a design. Returns the path
// relative to ASSET_DIR (suitable for designs.linework_wm_path).
async function applyWatermarkedLinework({ designId, lineworkAbs, choice = 'site', customWatermarkAbs = null }) {
  if (!fs.existsSync(lineworkAbs)) throw new Error('linework file not found: ' + lineworkAbs);
  const meta = await sharp(lineworkAbs).metadata();
  const W = meta.width || 1024;
  const H = meta.height || 1024;
  const overlays = [];

  // 1) Watermark texture pass(es) — the designer's choice.
  const customOk = choice === 'custom' && customWatermarkAbs && fs.existsSync(customWatermarkAbs);
  const wm1 = siteWmAbs(SITE_WM_1);
  const wm2 = siteWmAbs(SITE_WM_2);
  const passes = [];
  if (customOk) {
    passes.push({ abs: customWatermarkAbs, scale: 1.35, angle: -18, opacity: 0.42 });
    passes.push({ abs: customWatermarkAbs, scale: 1.00, angle: 22, opacity: 0.30 });
  } else {
    if (wm1) passes.push({ abs: wm1, scale: 1.35, angle: -18, opacity: 0.42 });
    if (wm2) passes.push({ abs: wm2, scale: 1.15, angle: 24, opacity: 0.36 });
  }
  for (const p of passes) {
    overlays.push({ input: await texturePass(p.abs, W, H, p.scale, p.angle), gravity: 'center', opacity: p.opacity });
  }

  // 2) Solid-black anti-trace marks — ALWAYS from the site watermark images,
  //    in both choices.
  for (let i = 0; i < BLACK_CROPS.length; i++) {
    const abs = siteWmAbs(BLACK_CROPS[i].file);
    if (!abs) continue;
    const left = Math.round(W * MARK_POSITIONS[i].x);
    const top = Math.round(H * MARK_POSITIONS[i].y);
    let mark = await blackSilhouette(abs, BLACK_CROPS[i], Math.round(W * 0.45));
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
  const outAbs = path.join(config.assetDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  await sharp(lineworkAbs).composite(overlays).jpeg({ quality: 88 }).toFile(outAbs);
  return outRel;
}

module.exports = { applyWatermarkedLinework, SITE_WM_1, SITE_WM_2 };
