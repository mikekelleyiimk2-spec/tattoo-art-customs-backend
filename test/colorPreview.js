// Watermarked finished-color previews + gallery featured row
// (Approval Batch #1 item 16). The pipeline produces a watermarked
// derivative of the finished color version; the clean color file is
// never public. runDbTests covers generation + selection; runHttpTests
// covers the gallery row and the serving mounts.
// The coordinator (test/run.js) wires this in; do not run from here.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('../src/db');
const config = require('../src/config');

async function colorJpeg(abs, rgb) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const svg = `<svg width="600" height="600"><rect width="600" height="600" fill="rgb(${rgb})"/>` +
    Array.from({ length: 24 }, (_, i) =>
      `<circle cx="${60 + (i * 71) % 480}" cy="${60 + (i * 97) % 480}" r="26" fill="black"/>`).join('') + `</svg>`;
  await sharp(Buffer.from(svg)).jpeg().toFile(abs);
}

async function runDbTests(ok) {
  console.log('colorPreview (watermarked color pipeline + featured selection):');
  const { applyWatermarkedColor } = require('../src/lib/watermark');
  const { generateColorPreview, featuredColorDesigns } = require('../src/lib/colorPreview');

  const artistId = await db.insert('users', {
    email: 'colorfeat@test.local', password_hash: 'x', role: 'design_artist', display_name: 'Color Feat',
  });
  const colorDir = path.join(process.env.ASSET_DIR, 'designs', 'color');
  async function seedDesign(title, file, sensitivity) {
    await colorJpeg(path.join(colorDir, file), '200,60,60');
    return db.insert('designs', {
      artist_id: artistId, title, status: 'approved', listing_scope: 'gallery',
      members_only: 0, sensitivity, categories: '[]',
      color_path: `designs/color/${file}`, color_source: 'designer', color_pending: 0,
      linework_path: '', linework_wm_path: 'designs/linework-wm/feat-wm.jpg',
      price_cents: 7500, created_at: Date.now(),
    });
  }
  const idA = await seedDesign('Feat Alpha', 'feat-alpha.jpg', 'normal');
  const idB = await seedDesign('Feat Beta', 'feat-beta.jpg', 'normal');
  const idC = await seedDesign('Feat Explicit', 'feat-explicit.jpg', 'explicit');
  const idD = await seedDesign('Feat Delta', 'feat-delta.jpg', 'normal');

  // 1. The watermark function itself: derivative exists, is a real image,
  //    and actually differs from an unwatermarked render of the source.
  const relA = await applyWatermarkedColor({ designId: idA, colorAbs: path.join(colorDir, 'feat-alpha.jpg'), choice: 'site' });
  ok(relA === `designs/color-wm/${idA}-color.jpg`, '[16] color watermark writes designs/color-wm/<id>-color.jpg');
  const outAbs = path.join(config.uploadDir, relA);
  ok(fs.existsSync(outAbs), '[16] watermarked color derivative exists on disk');
  const plainBuf = await sharp(path.join(colorDir, 'feat-alpha.jpg')).jpeg().toBuffer();
  ok(!fs.readFileSync(outAbs).equals(plainBuf), '[16] derivative is watermarked (differs from a clean render)');
  await db.update('designs', idA, { color_wm_path: relA }); // as the pipeline records it

  // 2. The pipeline: generateColorPreview records color_wm_path.
  const relB = await generateColorPreview(idB);
  ok(relB === `designs/color-wm/${idB}-color.jpg`, '[16] generateColorPreview returns the derivative path');
  const rowB = await db.get('SELECT color_wm_path FROM designs WHERE id = ?', [idB]);
  ok(rowB.color_wm_path === relB, '[16] designs.color_wm_path recorded');
  const relC = await generateColorPreview(idC);
  ok(!!relC, '[16] explicit design still gets a preview (exclusion happens at selection)');
  // Delta keeps NO preview for the selection checks below (its preview is
  // generated afterwards to prove admission works).

  // No color file -> no preview, no error.
  const idNone = await db.insert('designs', {
    artist_id: artistId, title: 'No Color Piece', status: 'approved', listing_scope: 'gallery',
    members_only: 0, sensitivity: 'normal', categories: '[]', color_path: '',
    linework_path: '', linework_wm_path: 'designs/linework-wm/feat-wm.jpg',
    price_cents: 7500, created_at: Date.now(),
  });
  ok(await generateColorPreview(idNone) === null, '[16] design without a color file yields no preview');

  // 3. Hearts: Beta 3, Alpha 1 — selection orders by the public counts.
  const now = Date.now();
  for (const [designId, n] of [[idA, 1], [idB, 3]]) {
    for (let i = 0; i < n; i++) {
      await db.query('INSERT INTO design_likes (design_id, voter_key, created_at) VALUES (?, ?, ?)',
        [designId, `user:feat${designId}-${i}`, now]);
    }
    await db.query('INSERT INTO design_like_counts (design_id, like_count) VALUES (?, ?)',
      [designId, n]);
  }
  let picks = await featuredColorDesigns();
  const pickIds = picks.map((p) => p.id);
  ok(pickIds.includes(idA) && pickIds.includes(idB), '[16] featured picks include previewed color designs');
  ok(pickIds.indexOf(idB) < pickIds.indexOf(idA), '[16] featured picks order by heart count (Beta 3 > Alpha 1)');
  ok(!pickIds.includes(idC), '[16] explicit-sensitivity design excluded from the featured row');
  ok(!pickIds.includes(idD), '[16] design with no watermarked preview excluded');
  ok(picks.every((p) => p.colorFile.endsWith('-color.jpg')), '[16] every pick references only the watermarked derivative');

  // 4. Generating Delta's preview admits it (0 hearts -> after the hearted).
  await generateColorPreview(idD);
  picks = await featuredColorDesigns();
  ok(picks.map((p) => p.id).includes(idD), '[16] newly generated preview joins the featured picks');
}

async function runHttpTests(ok, req) {
  console.log('colorPreview (gallery featured row + serving):');
  const Database = require('better-sqlite3');
  const tdb = new Database(process.env.SQLITE_PATH, { readonly: true });
  const rowA = tdb.prepare("SELECT id FROM designs WHERE title = 'Feat Alpha'").get();
  const rowB = tdb.prepare("SELECT id FROM designs WHERE title = 'Feat Beta'").get();
  tdb.close();

  const r = await req('GET', '/gallery');
  ok(r.status === 200, '[16] gallery loads');
  ok(r.text.includes('Featured in color'), '[16] gallery renders the featured-in-color row');
  const thumbB = `/img/designs/thumb/${rowB.id}-color.jpg`;
  const thumbA = `/img/designs/thumb/${rowA.id}-color.jpg`;
  ok(r.text.includes(thumbB) && r.text.includes(thumbA), '[16] row references the watermarked color thumbnails');
  ok(r.text.indexOf(thumbB) < r.text.indexOf(thumbA), '[16] row order follows heart counts');
  ok(!r.text.includes('feat-alpha.jpg') && !r.text.includes('feat-beta.jpg'),
    '[16] clean color filenames never appear in the gallery HTML');

  // The watermarked derivative is served; the clean color file is not.
  const img = await req('GET', `/img/designs/color/${rowA.id}-color.jpg`);
  ok(img.status === 200, '[16] watermarked color preview is served at /img/designs/color/');
  const clean = await req('GET', '/img/designs/feat-alpha.jpg');
  ok(clean.status !== 200, '[16] clean color file is NOT served publicly');
}

module.exports = { runDbTests, runHttpTests };
