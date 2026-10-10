// Full-auto merch pipeline: turns a queued design into a live Printful product.
// Triggered by the admin sorter ("Merch" checkbox) via the merch_jobs table.
// The scheduler runs processMerchJobs() every 5 minutes.
//
// Pipeline per job:
//   1. Build print asset from the design's color image (sharp)
//   2. Git commit + push the asset
//   3. Poll until the public URL is live (Render deploy)
//   4. POST /store/products to Printful (Bella + Canvas 3001, Black, S-2XL)
//   5. Append catalog entry to merchCatalog.js with real sync variant IDs
//   6. Add i18n name/blurb keys across all locales
//   7. Git commit + push; mark job done
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');
const db = require('../db');
const config = require('../config');

const API_BASE = 'https://api.printful.com';
// Bella + Canvas 3001 catalog variant IDs, Black, S-2XL (verified 2026-10-10)
const BC3001_BLACK = { S: 4016, M: 4017, L: 4018, XL: 4019, '2XL': 4020 };
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function printfulApi(method, apiPath, body) {
  const key = (process.env.PRINTFUL_API_KEY || '').trim();
  if (!key) throw new Error('PRINTFUL_API_KEY not set');
  const res = await fetch(API_BASE + apiPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(key).toString('base64'),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.code !== 200) {
    throw new Error(`Printful ${method} ${apiPath}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.result;
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 120000 });
}

async function waitForUrl(url, timeoutMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error('Timed out waiting for deploy: ' + url);
}

async function runJob(job) {
  const log = [];
  const design = await db.get('SELECT * FROM designs WHERE id = ?', [job.design_id]);
  if (!design) throw new Error('Design not found: ' + job.design_id);

  const baseSlug = 'pf-tee-' + slug(design.title).replace(/-auto$/, '').slice(0, 40);
  const printSlug = baseSlug + '-print';
  log.push('slug=' + baseSlug);

  // 1. Build print asset from color image
  const colorRel = design.color_path || design.color_source;
  const colorAbs = path.join(config.assetDir, colorRel);
  if (!fs.existsSync(colorAbs)) throw new Error('Color image missing: ' + colorRel);
  const printDir = path.join(__dirname, '..', 'public', 'img', 'merch', 'print');
  fs.mkdirSync(printDir, { recursive: true });
  const printAbs = path.join(printDir, printSlug + '.png');
  // Trim 1.5% edges (removes stray borders), export PNG
  const meta = await sharp(colorAbs).metadata();
  const trim = Math.round(Math.min(meta.width, meta.height) * 0.015);
  await sharp(colorAbs)
    .extract({ left: trim, top: trim, width: meta.width - trim * 2, height: meta.height - trim * 2 })
    .png()
    .toFile(printAbs);
  // Thumbnail
  const thumbAbs = path.join(__dirname, '..', 'public', 'img', 'merch', baseSlug + '.webp');
  await sharp(printAbs).resize(600, 750, { fit: 'inside' }).webp({ quality: 85 }).toFile(thumbAbs);
  log.push('assets built');

  // 2. Commit + push assets
  git(`add "src/public/img/merch/print/${printSlug}.png" "src/public/img/merch/${baseSlug}.webp"`);
  git(`commit -m "Merch auto: print assets for ${baseSlug}"`);
  git('push origin main');
  log.push('assets pushed');

  // 3. Wait for deploy
  const publicUrl = `${config.baseUrl}/img/merch/print/${printSlug}.png`;
  await waitForUrl(publicUrl);
  log.push('deploy live');

  // 4. Create Printful product
  const prodName = `Tattoo Art Customs — ${design.title} Tee (Black)`;
  const createRes = await printfulApi('POST', '/store/products', {
    sync_product: { name: prodName },
    sync_variants: SIZES.map(s => ({
      retail_price: s === '2XL' ? '30.99' : '28.99',
      variant_id: BC3001_BLACK[s],
      files: [{ placement: 'front', url: publicUrl }],
    })),
  });
  const productId = createRes.id;
  log.push('printful product=' + productId);
  await new Promise(r => setTimeout(r, 2000));
  const detail = await printfulApi('GET', `/store/products/${productId}`);
  const vmap = {};
  for (const v of detail.sync_variants) {
    const sz = v.name.split('/').pop().trim();
    vmap[sz] = v.id;
  }
  log.push('variants=' + JSON.stringify(vmap));

  // 5. Catalog entry
  const key = baseSlug.replace(/-/g, '_');
  const entry = `  {
    id: '${baseSlug}',
    kind: 'pod',
    status: 'live',
    nameKey: 'merch.${key}_name',
    blurbKey: 'merch.${key}_blurb',
    image: '/img/merch/${baseSlug}.webp',
    printfulProduct: 'sync_${key}',
    syncVariants: { S: ${vmap.S}, M: ${vmap.M}, L: ${vmap.L}, XL: ${vmap.XL}, '2XL': ${vmap['2XL']} },
    sizes: ['S', 'M', 'L', 'XL', '2XL'],
    priceCents: { S: 2899, M: 2899, L: 2899, XL: 2899, '2XL': 3099 },
    open: true,
  },\n`;
  const catalogPath = path.join(__dirname, 'merchCatalog.js');
  let catalog = fs.readFileSync(catalogPath, 'utf8');
  const anchor = "  // --- Printful synced products (live 2026-10-09) ---";
  if (!catalog.includes(`id: '${baseSlug}'`)) {
    catalog = catalog.replace(anchor, entry + anchor);
    fs.writeFileSync(catalogPath, catalog);
  }
  log.push('catalog updated');

  // 6. i18n keys (12 locales, templated)
  const localesDir = path.join(__dirname, '..', 'locales');
  const templates = {
    'en': ['{n} Tee', '{d} on a premium black Bella + Canvas tee.'],
    'de': ['{n} T-Shirt', '{d} auf einem hochwertigen schwarzen Bella + Canvas T-Shirt.'],
    'es': ['Camiseta {n}', '{d} en una camiseta Bella + Canvas negra premium.'],
    'fr': ['T-shirt {n}', '{d} sur un t-shirt Bella + Canvas noir premium.'],
    'it': ['Maglietta {n}', '{d} su una maglietta Bella + Canvas nera premium.'],
    'pt-BR': ['Camiseta {n}', '{d} em uma camiseta Bella + Canvas preta premium.'],
    'ja': ['{n} Tシャツ', 'プレミアムなブラックのBella + Canvas Tシャツに{d}。'],
    'ko': ['{n} 티셔츠', '프리미엄 블랙 Bella + Canvas 티셔츠에 {d}.'],
    'zh-CN': ['{n} T恤', '高级黑色 Bella + Canvas T 恤上的{d}。'],
    'ru': ['Футболка {n}', '{d} на премиальной чёрной футболке Bella + Canvas.'],
    'th': ['เสื้อยืด {n}', '{d} บนเสื้อยืด Bella + Canvas สีดำระดับพรีเมียม'],
    'sv': ['{n} t-shirt', '{d} på en premium svart Bella + Canvas t-shirt.'],
  };
  const shortName = design.title.replace(/\s*\(.*?\)\s*/g, '').trim();
  for (const [loc, [nt, bt]] of Object.entries(templates)) {
    const p = path.join(localesDir, loc + '.json');
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.merch = d.merch || {};
    d.merch[key + '_name'] = nt.replace('{n}', shortName);
    d.merch[key + '_blurb'] = bt.replace('{d}', shortName + ' design');
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  }
  log.push('i18n updated');

  // 7. Commit + push catalog
  git('add src/lib/merchCatalog.js src/locales/');
  git(`commit -m "Merch auto: ${baseSlug} live (Printful ${productId})"`);
  git('push origin main');
  log.push('catalog pushed');

  return { productId, baseSlug, log };
}

async function processMerchJobs() {
  const jobs = await db.all(
    `SELECT * FROM merch_jobs WHERE status = 'pending' AND attempts < 3 ORDER BY created_at ASC LIMIT 3`);
  for (const job of jobs) {
    const now = Date.now();
    await db.query(`UPDATE merch_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`, [now, job.id]);
    try {
      const result = await runJob(job);
      await db.query(`UPDATE merch_jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(result), Date.now(), job.id]);
    } catch (e) {
      const failed = job.attempts + 1 >= 3;
      await db.query(`UPDATE merch_jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?`,
        [failed ? 'failed' : 'pending', JSON.stringify({ error: e.message }), Date.now(), job.id]);
    }
  }
}

module.exports = { processMerchJobs };
