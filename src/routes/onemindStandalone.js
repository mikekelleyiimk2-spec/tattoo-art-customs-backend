// OneMind standalone host — onemind.onrender.com (owner order
// 2026-10-27 09:49 CDT: "just change the fucking domain name to
// onemind then build all other pages onemind/tac,
// onemind/poppyandziggy, onemind/ports, onemind/toolbox&plugs").
//
// HOW THIS WORKS WITHOUT BREAKING THE TIE:
// - The main service is NEVER renamed — a rename would kill every
//   live link, the Google OAuth redirect URI, and every app pointer
//   to tattoo-art-customs.onrender.com (a replug disaster).
// - Instead a SECOND Render service named "onemind" runs this same
//   repo with ONEMIND_STANDALONE=on, the same DATABASE_URL and the
//   same SESSION_SECRET. Same database = same accounts, same seats,
//   same ties. Sign-in here IS the OneMind sign-in (the Google door
//   carries a redirect URI for this host too).
// - This router mounts ONLY when the flag is on (see src/index.js);
//   the tattoo shop's service never loads it, so nothing about the
//   shop's behavior changes.
//
// THE SHAPE ON THIS HOST:
//   GET /              → OneMind itself: seated sessions go straight
//                        to the browser face (/onemind/table); new
//                        visitors go to the OneMind door (/onemind).
//                        On THIS host that is not a funnel — typing
//                        "onemind" IS asking for OneMind.
//   GET /tac           → the Tattoo Art Customs DOOR: its own page,
//                        its own look, one way in — the shop itself
//                        stays at its own address (its own house).
//   GET /poppyandziggy → the Poppy & Ziggy branch face.
//   GET /ports         → the KillinTime ports shelf.
//   GET /toolbox       → the Toolbox & Plugs branch face.
//   GET /little-inkers → the Little Inkers branch face (kid-safe).
// Every door is reachable directly, at its own address, wearing its
// own face — nobody passes through another place to reach it
// (arrival law, owner 2026-10-27 09:48 CDT).
const express = require('express');
const config = require('../config');
const rolodex = require('../lib/rolodex');

const router = express.Router();

const base = () => config.baseUrl.replace(/\/$/, '');
const SHOP = 'https://tattoo-art-customs.onrender.com';

function standaloneEnabled() {
  return String(process.env.ONEMIND_STANDALONE || '').trim().toLowerCase() === 'on';
}

// --- Root: OneMind itself ---------------------------------------------
function rootHandler(req, res) {
  if (res.locals.currentUser) return res.redirect(302, '/onemind/table');
  return res.redirect(302, '/onemind');
}
router.get('/', rootHandler);

// --- The TAC door -------------------------------------------------------
function tacDoorHandler(req, res) {
  res.render('onemind/door-tac', {
    layout: 'layout-onemind',
    title: 'Tattoo Art Customs — the Tattoo Shop | OneMind',
    metaDescription: 'Tattoo Art Customs: custom tattoo designs, a gallery of real artists, stencils and full-color work. The shop lives at its own address — this is its door.',
    canonical: `${base()}/tac`,
    shopUrl: SHOP,
  });
}
router.get('/tac', tacDoorHandler);

// --- Branch doors (same branch faces, at this host's addresses) --------
function poppyHandler(req, res) {
  res.render('onemind/branch-poppy', {
    layout: 'layout-li',
    title: 'Poppy & Ziggy — the Kids\' Cartoon | OneMind',
    metaDescription: 'Poppy & Ziggy: the cartoon where a coloring page comes to life. New episode every Friday at 5 PM CT, a fun Short every day. Kid-safe branch page — grown-ups, start here.',
    canonical: `${base()}/poppyandziggy`,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
}
router.get('/poppyandziggy', poppyHandler);

function littleInkersHandler(req, res) {
  res.render('onemind/branch-little-inkers', {
    layout: 'layout-li',
    title: 'Little Inkers — Free Coloring Fun for Kids | OneMind',
    metaDescription: 'Little Inkers: the free coloring show and app where coloring pages come to life — Color With Us every Wednesday and Saturday, new coloring pages every Monday. Kid-safe branch page.',
    canonical: `${base()}/little-inkers`,
    kidPartners: rolodex.queryLive({ kidSafe: true }),
    disclosureStandard: rolodex.disclosureStandard(),
  });
}
router.get('/little-inkers', littleInkersHandler);

function portsHandler(req, res) {
  res.render('onemind/door-ports', {
    layout: 'layout-onemind',
    title: 'Ports — KillinTime | OneMind',
    metaDescription: 'KillinTime Ports: classic games, licensed properly, brought to phones. Ports carry no ads, ever.',
    canonical: `${base()}/ports`,
  });
}
router.get('/ports', portsHandler);

function toolboxHandler(req, res) {
  res.render('onemind/door-toolbox', {
    layout: 'layout-onemind',
    title: 'Toolbox & Plugs | OneMind',
    metaDescription: 'The Useful Appz toolbox: the Affiliate Rolodex, Tester Hub, Money Watch, AI to AI, Connection Doctor, Service Plug — tools built from real wounds.',
    canonical: `${base()}/toolbox`,
  });
}
router.get('/toolbox', toolboxHandler);

module.exports = router;
module.exports.standaloneEnabled = standaloneEnabled;
module.exports.handlers = {
  rootHandler, tacDoorHandler, poppyHandler, littleInkersHandler, portsHandler, toolboxHandler,
};
