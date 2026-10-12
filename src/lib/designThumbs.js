'use strict';
// On-demand grid thumbnails for public design previews (perf fix
// 2026-10-12). The full watermarked previews are served at source size —
// baked catalog files average ~200 KB and fresh uploads can exceed 1 MB —
// which made the gallery unusable on phones. Grid surfaces (website
// gallery, wishlist, app API) now point at /img/designs/thumb/<file>,
// which generates a 640px-wide JPEG (~25-40 KB) from the WATERMARKED
// preview on first request and caches it under UPLOAD_DIR. The design
// detail page keeps serving the full watermarked preview. Clean color /
// clean linework files are never touched here — sources are looked up
// only in the two watermarked-preview directories, same as the public
// /img/designs static mounts.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

const THUMB_WIDTH = 640;
const THUMB_QUALITY = 76;
const FILE_RE = /^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i;

function sourceDirs() {
  return [
    path.join(config.uploadDir, 'designs', 'linework-wm'),
    path.join(config.assetDir, 'designs', 'linework-wm'),
  ];
}

function findSource(file) {
  for (const dir of sourceDirs()) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Public URL for a design's grid thumbnail (same basename as the full
// preview, under the thumb/ prefix).
function designThumbUrl(file) {
  if (!file) return null;
  const base = path.basename(String(file));
  return FILE_RE.test(base) ? `/img/designs/thumb/${base}` : null;
}

const inflight = new Map();

// Returns the absolute path of the cached thumbnail for `file`, generating
// it on first use. Cache key includes source size + mtime, so a preview
// regenerated in place (re-approval) produces a fresh thumbnail. Returns
// null when the source is missing or not a readable image — callers fall
// back to the full preview.
async function ensureDesignThumb(file) {
  const base = path.basename(String(file || ''));
  if (!FILE_RE.test(base)) return null;
  const src = findSource(base);
  if (!src) return null;
  let st;
  try { st = fs.statSync(src); } catch { return null; }
  const cacheDir = path.join(config.uploadDir, 'cache', 'design-thumbs');
  const stem = base.replace(/\.[^.]+$/, '');
  const cachePath = path.join(cacheDir, `${stem}-${st.size}-${Math.round(st.mtimeMs)}.jpg`);
  if (fs.existsSync(cachePath)) return cachePath;
  if (inflight.has(cachePath)) return inflight.get(cachePath);
  const job = (async () => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cachePath}.tmp-${process.pid}`;
      await sharp(src)
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
        .toFile(tmp);
      fs.renameSync(tmp, cachePath);
      return cachePath;
    } catch (e) {
      console.error('design thumb generation failed for', base, e.message);
      return null;
    } finally {
      inflight.delete(cachePath);
    }
  })();
  inflight.set(cachePath, job);
  return job;
}

module.exports = { designThumbUrl, ensureDesignThumb, THUMB_WIDTH, THUMB_QUALITY };
