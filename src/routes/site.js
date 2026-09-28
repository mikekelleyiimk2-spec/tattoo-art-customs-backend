// Public pages: home, gallery, design detail, terms, privacy.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireLogin, isActiveMember } = require('../middleware/auth');
const { premadePriceCents, customFullCents, isSaleWindow, lineworkOnlyPriceCents, LINEWORK_ONLY_DISCOUNT, salePriceActive } = require('../lib/pricing');

const router = express.Router();

// Wallet hub: one URL for the app + website that lands each user on their
// own money page — artists/shops get their payout settings, everyone else
// gets their site credit.
router.get('/wallet', requireLogin, (req, res) => {
  if (req.user.role === 'design_artist') return res.redirect('/artist#payouts');
  if (req.user.role === 'tattoo_shop') return res.redirect('/shop#payouts');
  res.redirect('/account#credit');
});

// ads.txt — required by Google AdSense so ad revenue is credited to us.
// Serves automatically once ADSENSE_PUBLISHER_ID is set.
router.get('/ads.txt', (req, res) => {
  const raw = (config.adsense.publisherId || '').trim();
  if (!raw) return res.status(404).type('text/plain').send('Not configured');
  const pubId = raw.replace(/^ca-pub-/i, 'pub-');
  res.type('text/plain').send(`google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`);
});

// robots.txt — allow all crawlers; point them at the sitemap.
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

// sitemap.xml — home, gallery, key pages, and every approved design.
router.get('/sitemap.xml', async (req, res) => {
  const base = config.baseUrl.replace(/\/$/, '');
  const urls = [
    { loc: `${base}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${base}/gallery`, changefreq: 'daily', priority: '0.9' },
    { loc: `${base}/membership`, changefreq: 'weekly', priority: '0.7' },
    { loc: `${base}/advertise`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${base}/about`, changefreq: 'monthly', priority: '0.5' },
    { loc: `${base}/raffle`, changefreq: 'weekly', priority: '0.6' },
    { loc: `${base}/terms`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${base}/privacy`, changefreq: 'monthly', priority: '0.3' },
  ];
  try {
    const designs = await db.all(
      `SELECT id FROM designs WHERE status = 'approved' AND listing_scope = 'gallery'
       AND members_only = 0 ORDER BY created_at DESC LIMIT 5000`);
    for (const d of designs) {
      urls.push({ loc: `${base}/design/${d.id}`, changefreq: 'weekly', priority: '0.8' });
    }
    // Public artist portfolios (include portfolio-only custom pieces).
    const artists = await db.all(
      `SELECT DISTINCT u.id FROM users u JOIN designs d ON d.artist_id = u.id
       WHERE u.role = 'design_artist' AND d.status = 'approved' LIMIT 5000`);
    for (const a of artists) {
      urls.push({ loc: `${base}/artists/${a.id}`, changefreq: 'weekly', priority: '0.7' });
    }
  } catch { /* sitemap still serves without design URLs */ }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>`;
  res.type('application/xml').send(xml);
});

function parseDesign(row) {
  if (!row) return null;
  let categories = [];
  try { categories = JSON.parse(row.categories || '[]'); } catch { /* keep empty */ }
  return { ...row, categories };
}

async function approvedDesigns(member = false) {
  // Main gallery: approved pre-designs only. Portfolio-only custom pieces
  // never appear here — they live on the artist's own portfolio page.
  // Member-exclusive designs are hidden from non-members everywhere.
  const rows = await db.all(
    `SELECT * FROM designs WHERE status = 'approved' AND listing_scope = 'gallery'
     AND (members_only = 0 OR ? = 1) ORDER BY created_at DESC`, [member ? 1 : 0]);
  return rows.map(parseDesign);
}

// Capture referral codes (?ref=CODE) into a cookie for checkout attribution.
router.use((req, res, next) => {
  if (req.query.ref) {
    res.cookie('ref_code', String(req.query.ref).slice(0, 32), {
      maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax',
    });
  }
  next();
});

router.get('/', async (req, res) => {
  const member = await isActiveMember(req.user);
  const designs = (await approvedDesigns(member)).slice(0, 12);
  res.render('site/index', {
    title: 'Tattoo Art Customs — Custom Tattoo Designs',
    designs, sale: await salePriceActive(req.user),
    premadePrice: premadePriceCents(new Date(), member), customPrice: customFullCents(new Date(), member),
    metaDescription: 'Browse hundreds of original tattoo designs. Custom designs $150 with 48-hour delivery. Design artists earn 60% commission.',
  });
});

router.get('/gallery', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const cat = (req.query.cat || '').trim().toLowerCase();
  const member = await isActiveMember(req.user);
  let designs = await approvedDesigns(member);
  const allCats = [...new Set(designs.flatMap((d) => d.categories))].sort();
  if (cat) designs = designs.filter((d) => d.categories.some((c) => c.toLowerCase() === cat));
  if (q) {
    designs = designs.filter((d) =>
      d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) ||
      d.categories.some((c) => c.toLowerCase().includes(q)));
  }
  res.render('site/gallery', {
    title: 'Design Gallery — Tattoo Art Customs',
    designs, allCats, q: req.query.q || '', cat: req.query.cat || '', sale: await salePriceActive(req.user),
    premadePrice: premadePriceCents(new Date(), member),
    metaDescription: 'Browse and search original tattoo designs by category.',
  });
});

router.get('/design/:id', async (req, res) => {
  const design = parseDesign(await db.get(
    "SELECT * FROM designs WHERE id = ? AND status = 'approved'", [req.params.id]));
  const member = await isActiveMember(req.user);
  if (!design || (design.members_only && !member)) {
    return res.status(404).render('error', { title: 'Not found', message: 'That design is not available.' });
  }
  const artist = design.artist_id
    ? await db.get('SELECT display_name FROM users WHERE id = ?', [design.artist_id])
    : null;
  // Portfolio custom pieces sell at the custom-design price (sale-aware);
  // pre-designs sell at the premade price. Members get the early sale entry.
  const isCustom = design.listing_type === 'custom';
  const price = isCustom ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member);
  let owned = false;
  if (req.user) {
    const o = await db.get(
      `SELECT id FROM orders WHERE buyer_id = ? AND design_id = ? AND status = 'paid' AND order_type = 'premade'`,
      [req.user.id, design.id]
    );
    owned = !!o;
  }
  res.render('site/design', {
    title: `${design.title} — Tattoo Art Customs`,
    design, artist, price, isCustom, sale: await salePriceActive(req.user), owned,
    // Linework-only purchase option (3% discount). Pieces with no color
    // version are linework-only automatically.
    lineworkPrice: lineworkOnlyPriceCents(price),
    lineworkDiscount: LINEWORK_ONLY_DISCOUNT,
    metaDescription: `${design.title} — original tattoo design. ${design.categories.join(', ')}.`,
    creditBalance: req.user ? await require('../lib/credits').getCreditBalance(req.user.id) : 0,
  });
});

// Public artist portfolio: bio + pieces (watermarked linework only).
// No login required.
router.get('/artists/:id', async (req, res) => {
  const artist = await db.get(
    "SELECT id, display_name, is_founding_artist FROM users WHERE id = ? AND role = 'design_artist'", [req.params.id]);
  if (!artist) return res.status(404).render('error', { title: 'Not found', message: 'That artist portfolio does not exist.' });
  const profile = await db.get('SELECT bio FROM artist_profiles WHERE user_id = ?', [artist.id]);
  const member = await isActiveMember(req.user);
  const rows = await db.all(
    `SELECT * FROM designs WHERE artist_id = ? AND status = 'approved'
     AND (members_only = 0 OR ? = 1) ORDER BY created_at DESC`, [artist.id, member ? 1 : 0]);
  const pieces = rows.map((d) => {
    const isCustom = d.listing_type === 'custom';
    return { ...d, price: isCustom ? customFullCents(new Date(), member) : premadePriceCents(new Date(), member), isCustom };
  });
  res.render('site/artist', {
    title: `${artist.display_name || 'Artist'} — Tattoo Art Customs`,
    artist, bio: profile ? profile.bio : '', pieces, sale: await salePriceActive(req.user),
    metaDescription: `${artist.display_name || 'Artist'} — tattoo design portfolio on Tattoo Art Customs.`,
  });
});

router.get('/terms', (req, res) => res.render('site/terms', {
  title: 'Terms of Service — Tattoo Art Customs',
  metaDescription: 'Tattoo Art Customs terms of service.',
}));

router.get('/privacy', (req, res) => res.render('site/privacy', {
  title: 'Privacy Policy — Tattoo Art Customs',
  metaDescription: 'Tattoo Art Customs privacy policy.',
}));

router.get('/about', (req, res) => res.render('site/about', {
  title: 'About — Tattoo Art Customs',
  metaDescription: 'About Tattoo Art Customs marketplace.',
}));

// Public early-subscriber raffle page: prizes + winners once drawn.
router.get('/raffle', async (req, res) => {
  const founding = require('../lib/founding');
  const status = await founding.getFoundingStatus();
  const winners = status.raffleDrawn ? await db.all(
    `SELECT r.prize_won, r.drawn_at, u.display_name
     FROM raffle_entries r JOIN users u ON u.id = r.user_id
     WHERE r.prize_won IS NOT NULL ORDER BY
       CASE r.prize_won WHEN 'grand' THEN 0 WHEN 'annual' THEN 1 ELSE 2 END`) : [];
  res.render('site/raffle', {
    title: 'Early Subscriber Raffle — Tattoo Art Customs',
    metaDescription: 'Tattoo Art Customs early-subscriber raffle: prizes, entry window, and winners.',
    ...status, winners,
  });
});

module.exports = router;
