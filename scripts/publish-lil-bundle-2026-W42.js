// One-shot publish: Little Inkers weekly bundle 2026-W42 "Spooky Friends".
// Staged 2026-10-08 (owner order: next week's pack is Halloween) — 12
// pre-reviewed owner-artwork JPGs (watermarked, 700px wide, <500KB each).
//
// Run in the Render web-service shell AFTER the deploy carrying migration
// 086 + the bundles-endpoint query fix:
//
//   node scripts/publish-lil-bundle-2026-W42.js
//
// Uploads the 12 JPGs + bundle.json to the R2 public bucket under
// lil-bundles/2026-W42/, inserts the lil_bundles manifest row, then verifies
// every public URL returns HTTP 200. Safe to re-run: existing objects are
// skipped, the DB insert is skipped when the row exists, bundle.json is
// re-uploaded (PUT is idempotent).
const fs = require('fs');
const path = require('path');
const https = require('https');

const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

const BUNDLE_ID = '2026-W42';
const BUNDLE_TITLE = 'Spooky Friends';
const BUNDLE_THEME = 'Halloween';
const PUBLISHED_AT = 1791804960000; // Mon 2026-10-12 06:36:00 America/Chicago
const R2_PREFIX = `lil-bundles/${BUNDLE_ID}/`;

// design id / title / staged filename — from the staging manifest
// (promo-video/little-inkers/halloween-pack-2026-10-12/MANIFEST.md).
const DESIGNS = [
  ['2026-w42-black-cat', 'Midnight Cat', 'black-cat.jpg'],
  ['2026-w42-pixel-ghost', 'Pixel Ghost', 'pixel-ghost.jpg'],
  ['2026-w42-hanging-bat', 'Sleepy Bat', 'hanging-bat.jpg'],
  ['2026-w42-flying-bat', 'Moonlit Bat', 'flying-bat.jpg'],
  ['2026-w42-spider', 'Garden Spider', 'spider.jpg'],
  ['2026-w42-mummy', 'Silly Mummy', 'mummy.jpg'],
  ['2026-w42-skeleton', 'Dancing Skeleton', 'skeleton.jpg'],
  ['2026-w42-candy', 'Candy Jar', 'candy.jpg'],
  ['2026-w42-owl', 'Night Owl', 'owl.jpg'],
  ['2026-w42-moon', 'Starry Moon', 'moon.jpg'],
  ['2026-w42-wizard', 'Friendly Wizard', 'wizard.jpg'],
  ['2026-w42-sleepy-cat', 'Sleepy Kitty Moon', 'sleepy-cat.jpg'],
];

const ASSETS_DIR = path.join(__dirname, 'assets', 'lil-bundles-2026-W42');

function r2() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function objectExists(client, bucket, key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function putObject(client, bucket, key, body, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
  }));
}

function fetchOk(url, redirects = 3) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchOk(res.headers.location, redirects - 1));
      }
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes }));
      res.on('error', () => resolve({ status: 0, bytes: 0 }));
    }).on('error', () => resolve({ status: 0, bytes: 0 }));
  });
}

async function main() {
  for (const v of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BUCKET', 'R2_PUBLIC_URL']) {
    if (!process.env[v]) throw new Error(`missing env ${v}`);
  }
  const bucket = process.env.R2_PUBLIC_BUCKET;
  const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');

  await migrate();
  console.log('migrate: ok');

  const client = r2();
  const publicUrl = (file) => `${base}/${R2_PREFIX}${file}`;

  // 1. Upload the 12 page images.
  let uploaded = 0, skipped = 0;
  for (const [, , file] of DESIGNS) {
    const key = R2_PREFIX + file;
    if (await objectExists(client, bucket, key)) { skipped++; continue; }
    const abs = path.join(ASSETS_DIR, file);
    if (!fs.existsSync(abs)) throw new Error(`missing staged asset ${abs}`);
    await putObject(client, bucket, key, fs.readFileSync(abs), 'image/jpeg');
    uploaded++;
    console.log(`uploaded ${key}`);
  }
  console.log(`images: ${uploaded} uploaded, ${skipped} already present`);

  // 2. Write + upload bundle.json.
  const bundle = {
    id: BUNDLE_ID,
    title: BUNDLE_TITLE,
    theme: BUNDLE_THEME,
    publishedAt: PUBLISHED_AT,
    designs: DESIGNS.map(([id, title, file]) => ({
      id, title, file, imageUrl: publicUrl(file),
    })),
  };
  const bundleJson = JSON.stringify(bundle, null, 2);
  await putObject(client, bucket, R2_PREFIX + 'bundle.json', Buffer.from(bundleJson), 'application/json');
  console.log(`uploaded ${R2_PREFIX}bundle.json`);

  // 3. Manifest row.
  const existing = await db.get('SELECT id FROM lil_bundles WHERE id = ?', [BUNDLE_ID]);
  if (existing) {
    console.log(`db: row ${BUNDLE_ID} already present, insert skipped`);
  } else {
    await db.insert('lil_bundles', {
      id: BUNDLE_ID,
      title: BUNDLE_TITLE,
      theme: BUNDLE_THEME,
      design_count: DESIGNS.length,
      published_at: PUBLISHED_AT,
      file_url: publicUrl('bundle.json'),
      active: 1,
    });
    console.log(`db: inserted row ${BUNDLE_ID}`);
  }

  // 4. Verify every public URL.
  const urls = [...DESIGNS.map(([, , f]) => publicUrl(f)), publicUrl('bundle.json')];
  let bad = 0;
  for (const u of urls) {
    const r = await fetchOk(u);
    const ok = r.status === 200 && r.bytes > 0;
    if (!ok) { bad++; console.log(`VERIFY FAIL ${r.status} ${r.bytes}b ${u}`); }
  }
  console.log(`verify: ${urls.length - bad}/${urls.length} public URLs 200 OK`);
  if (bad) throw new Error(`${bad} public URLs failed verification`);

  console.log(`PUBLISH_OK bundle=${BUNDLE_ID} designs=${DESIGNS.length}`);
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => { console.error('PUBLISH_FAIL ' + (e.message || e)); process.exit(1); });
