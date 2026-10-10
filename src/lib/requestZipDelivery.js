// Automatic ZIP delivery for PAID request orders.
//
// Three staged request-only ZIP collections live in the private R2 bucket
// `tattoo-art-customs-private/zips/` (mirrored in assets/library/ for local
// fallback). When a customer's custom request order is confirmed PAID, the
// matching ZIP is delivered automatically: a download token is issued (the
// same bearer-token mechanism premade purchases use) and the buyer gets a
// receipt email carrying the private download link.
//
// Order-type → ZIP mapping (exactly one ZIP per type; see classifyRequestOrder):
//   1. request-only design order  (brief: Request-only design "TITLE" (ID: <id>))
//        → zips/Tattoo-Art-Customs-Request-Only-Designs-Linework-and-Color-31.zip
//   2. by-request character order (brief: By-request character "NAME"),
//      character is one of the 19 video-game franchises
//        → zips/video-game-characters-request-only.zip
//   3. by-request character order, any other listed character
//        → zips/By-Request-Designs.zip
//
// SAFETY (fail closed): if the brief does not parse, the design id is not a
// request-only design, or the character name is not on the by-request list,
// NOTHING is delivered. The order lands in request_zip_review and the owner
// gets an email with the order details. A wrong ZIP is never delivered.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mail');
const storage = require('./storage');

// R2 object keys (private bucket tattoo-art-customs-private) + the baked-in
// local mirror under assets/library/ used when R2 is not the active provider.
const REQUEST_ZIPS = {
  'request-only-31': {
    file: 'Tattoo-Art-Customs-Request-Only-Designs-Linework-and-Color-31.zip',
    label: 'Request-Only Designs — linework + full color (31 designs)',
  },
  'video-game': {
    file: 'video-game-characters-request-only.zip',
    label: 'Video Game Characters — linework + full color (19 games)',
  },
  'by-request': {
    file: 'By-Request-Designs.zip',
    label: 'By-Request Character Designs',
  },
};

function zipFileFor(zipKey) {
  const z = REQUEST_ZIPS[zipKey];
  return z ? z.file : null;
}

// The 19 video-game franchises in video-game-characters-request-only.zip,
// as lowercase match phrases against the by-request character name.
const VG_MATCH_PHRASES = [
  'donkey kong',
  'elden ring',
  'final fantasy',
  'gta',
  'grand theft auto',
  'half-life',
  'half life',
  'mario',
  'mega man',
  'megaman',
  'minecraft',
  'pac-man',
  'pacman',
  'portal',
  'punch-out',
  'punch out',
  'red dead',
  'tetris',
  'witcher',
  'zelda',
];

let byRequestCache = null;
function byRequestItems() {
  if (byRequestCache) return byRequestCache;
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'assets', 'catalog', 'by-request.json'), 'utf8');
    byRequestCache = JSON.parse(raw).items || [];
  } catch {
    byRequestCache = [];
  }
  return byRequestCache;
}

function isVideoGameCharacter(name) {
  const n = ` ${String(name || '').toLowerCase()} `;
  return VG_MATCH_PHRASES.some((p) => n.includes(` ${p} `) || n.includes(`(${p}`) || n.includes(`${p})`));
}

// Classify a paid custom order into exactly one ZIP.
// Returns { zipKey, zipFile, label, detail } on a confident match,
// { ambiguous: true, reason } when the mapping cannot be proven safe,
// or { notRequest: true } when this is not a request order at all.
async function classifyRequestOrder(order) {
  if (!order || order.order_type !== 'custom') return { notRequest: true };
  const brief = String(order.custom_brief || '');

  // Type 1: request-only design, prefilled as
  //   Request-only design "TITLE" (ID: <id>) — please deliver ...
  let m = brief.match(/Request-only design "(.+?)" \(ID: ([^)]+)\)/);
  if (m) {
    const designId = m[2].trim();
    let design = null;
    try {
      design = await db.get('SELECT id, title, request_only FROM designs WHERE id = ?', [designId]);
    } catch (e) { /* treat lookup failure as ambiguous below */ }
    if (design && Number(design.request_only) === 1) {
      return {
        zipKey: 'request-only-31',
        zipFile: zipFileFor('request-only-31'),
        label: REQUEST_ZIPS['request-only-31'].label,
        detail: `request-only design "${design.title}" (${design.id})`,
      };
    }
    return {
      ambiguous: true,
      reason: design
        ? `design id "${designId}" is not a request-only design (request_only=${design.request_only})`
        : `design id "${designId}" not found in the designs table`,
    };
  }

  // Types 2 & 3: by-request character, prefilled as
  //   By-request character "NAME" — please deliver ...
  m = brief.match(/By-request character "(.+?)"/);
  if (m) {
    const name = m[1].trim();
    const hit = byRequestItems().find(
      (i) => String(i.name || '').trim().toLowerCase() === name.toLowerCase());
    if (!hit) {
      return { ambiguous: true, reason: `character "${name}" is not on the by-request list` };
    }
    if (isVideoGameCharacter(hit.name)) {
      return {
        zipKey: 'video-game',
        zipFile: zipFileFor('video-game'),
        label: REQUEST_ZIPS['video-game'].label,
        detail: `by-request video-game character "${hit.name}"`,
      };
    }
    return {
      zipKey: 'by-request',
      zipFile: zipFileFor('by-request'),
      label: REQUEST_ZIPS['by-request'].label,
      detail: `by-request character "${hit.name}"`,
    };
  }

  return { notRequest: true };
}

// Where the ZIP bytes come from at download time. R2 presigned URL when the
// r2 provider is active (bucket stays private; the URL lives 15 minutes),
// otherwise the copy baked into the deploy at assets/library/<file>.
function zipStoredRef(zipFile) {
  if (storage.provider() === 'r2' && process.env.R2_PRIVATE_BUCKET) {
    return `r2://${process.env.R2_PRIVATE_BUCKET}/zips/${zipFile}`;
  }
  // Local/dev: relative to config.assetDir (repo: assets/library/<file>).
  return path.join('library', zipFile);
}

async function notifyOwner(order, reason) {
  const to = config.adminEmail;
  if (!to) {
    console.error('[request-zip] AMBIGUOUS mapping but no ADMIN_EMAIL configured — order held:', order.id, reason);
    return;
  }
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  const lines = [
    `A paid request order needs your call — the ZIP mapping was ambiguous,`,
    `so nothing was auto-delivered (fail-closed, as designed).`,
    ``,
    `Order: ${order.id} (${config.baseUrl}/admin/orders)`,
    `Buyer: ${buyer ? `${buyer.display_name || ''} <${buyer.email || 'no email'}>` : order.buyer_id}`,
    `Paid: $${(Number(order.amount_paid_cents || 0) / 100).toFixed(2)} via ${order.payment_method || 'unknown'}`,
    `Reason: ${reason}`,
    `Brief: ${String(order.custom_brief || '').slice(0, 300)}`,
    ``,
    `Resolve it in request_zip_review, then deliver the right ZIP manually`,
    `from the private library (R2: tattoo-art-customs-private/zips/).`,
  ];
  try {
    await sendMail({ to, subject: `Request-ZIP needs your call — order ${String(order.id).slice(0, 8)}`, text: lines.join('\n') });
  } catch (e) {
    console.error('[request-zip] owner notification failed:', e.message);
  }
}

// Fulfill a paid custom request order with its ZIP. Idempotent: a second
// call for the same order returns the existing delivery row. Returns the
// delivery row, { handedToOwner: true, reason } on ambiguous mappings, or
// null when the order is not a paid request order.
async function fulfillRequestZipOrder(order) {
  if (!order || order.order_type !== 'custom' || order.status !== 'paid') return null;
  const existing = await db.get('SELECT * FROM request_zip_deliveries WHERE order_id = ?', [order.id]);
  if (existing) return existing;
  const alreadyQueued = await db.get(
    'SELECT id FROM request_zip_review WHERE order_id = ? AND resolved_at IS NULL', [order.id]);

  const cls = await classifyRequestOrder(order);
  if (!cls || cls.notRequest) return null;

  if (cls.ambiguous) {
    if (!alreadyQueued) {
      await db.insert('request_zip_review', {
        order_id: order.id,
        reason: cls.reason,
        brief_snippet: String(order.custom_brief || '').slice(0, 500),
      });
      await notifyOwner(order, cls.reason);
      console.log('[request-zip] ambiguous mapping held for owner review:', order.id, '-', cls.reason);
    }
    return { handedToOwner: true, reason: cls.reason };
  }

  // Confident mapping — deliver. The token + email use the same digital
  // delivery mechanism as premade purchases.
  const { issueDownloadToken } = require('./fulfillment');
  const dl = await issueDownloadToken(order.id);
  const buyer = await db.get('SELECT email, display_name FROM users WHERE id = ?', [order.buyer_id]);
  const buyerEmail = (buyer && buyer.email) || '';
  const viewUrl = `${config.baseUrl}/orders/download/${dl.token}/view`;
  const orderUrl = `${config.baseUrl}/orders/${order.id}`;
  await db.insert('request_zip_deliveries', {
    order_id: order.id,
    zip_key: cls.zipKey,
    zip_file: cls.zipFile,
    buyer_email: buyerEmail,
    delivered_at: db.now(),
  });
  if (buyerEmail) {
    const first = String((buyer && buyer.display_name) || '').split(' ')[0] || 'there';
    const lines = [
      `Hi ${first},`,
      ``,
      `Thanks for your request order from Tattoo Art Customs!`,
      ``,
      `Request: ${cls.detail}`,
      `Order: ${String(order.id).slice(0, 8)}`,
      ``,
      `Your design collection is ready right now — ${cls.label}:`,
      viewUrl,
      ``,
      `This is a private link just for you and it expires in 24 hours.`,
      `You can generate a fresh link any time from your order page:`,
      orderUrl,
      ``,
      `Please don't share these files — they're licensed to you only.`,
      `— Tattoo Art Customs`,
    ];
    try {
      await sendMail({
        to: buyerEmail,
        subject: `Your request designs are ready (Tattoo Art Customs)`,
        text: lines.join('\n'),
      });
    } catch (e) {
      console.error('[request-zip] buyer receipt email failed:', e.message);
    }
  }
  console.log('[request-zip] delivered', cls.zipKey, 'for order', order.id);
  return db.get('SELECT * FROM request_zip_deliveries WHERE order_id = ?', [order.id]);
}

module.exports = {
  REQUEST_ZIPS,
  classifyRequestOrder,
  fulfillRequestZipOrder,
  zipStoredRef,
  zipFileFor,
};
