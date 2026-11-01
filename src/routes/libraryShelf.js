// The Library inside Dawnfold — front door + the First Library Shelf
// (Brief #40, owner accepted 2026-10-25).
//
//   GET /dawnfold/library              the Library front door: the
//                                      shelves, first shelf first.
//   GET /dawnfold/library/first-shelf  the First Library Shelf: its
//                                      public-domain titles seated
//                                      (src/lib/firstShelf.js).
//   GET /the-big-one/library[...]      pre-rename doors, 301 to the
//                                      Dawnfold doors (the pattern of
//                                      src/routes/thebigone.js).
//
// Everything here is additive: new routes, new templates, new lib —
// no other lane's files rewritten. The publication already promised
// these shelves ("the Library shelves behind the Documentary page" —
// views/site/thebigone.ejs); this is the door that promise opens.
const express = require('express');
const config = require('../config');
const { firstShelf } = require('../lib/firstShelf');

const router = express.Router();

router.get(['/the-big-one/library', '/the-big-one/library/first-shelf'], (req, res) => {
  const target = req.path.replace(/^\/the-big-one/, '/dawnfold');
  const qs = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(301, `${target}${qs}`);
});

function face(res, view, locals) {
  const base = config.baseUrl.replace(/\/$/, '');
  return res.render(view, {
    layout: 'layout-thebigone',
    canonical: `${base}${locals.path}`,
    ...locals,
  });
}

router.get('/dawnfold/library', (req, res) => {
  const titles = firstShelf();
  face(res, 'site/library-front', {
    path: '/dawnfold/library',
    title: 'The Library — Dawnfold',
    metaDescription: 'The Library inside Dawnfold: free public-domain shelves behind the paper. The First Library Shelf is seated — Austen, Twain, Carroll, Doyle, Shelley, Wilde, Burroughs, Melville — free to read, free forever.',
    firstShelfCount: titles.length,
    firstShelfPreview: titles.slice(0, 3),
    user: req.user || null,
    flash: res.locals.flash || null,
  });
});

router.get('/dawnfold/library/first-shelf', (req, res) => {
  face(res, 'site/library-first-shelf', {
    path: '/dawnfold/library/first-shelf',
    title: 'The First Library Shelf — Dawnfold',
    metaDescription: 'The First Library Shelf: eight public-domain classics seated in Dawnfold\u2019s Library — free to read in full at Project Gutenberg, free forever.',
    titles: firstShelf(),
    user: req.user || null,
    flash: res.locals.flash || null,
  });
});

module.exports = router;
