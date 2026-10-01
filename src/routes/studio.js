// Design Studio — subscribers combine multiple paid-for premade designs into one sheet.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { resolveStoredPath } = require('../lib/storage');
const { requireLogin, requireAnySubscription, isAdminRole } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { combine } = require('../lib/combine');

const router = express.Router();
router.use(requireLogin, requireAnySubscription());

// Designs this user has paid for (premade orders only).
async function ownedDesigns(userId) {
  const rows = await db.all(
    `SELECT DISTINCT d.id, d.title, d.color_path, d.linework_path, d.linework_wm_path
     FROM orders o JOIN designs d ON d.id = o.design_id
     WHERE o.buyer_id = ? AND o.status = 'paid' AND o.order_type = 'premade' AND o.design_id IS NOT NULL
     ORDER BY d.title`,
    [userId]
  );
  return rows.map((d) => ({ ...d, thumb: `/img/designs/${String(d.linework_wm_path).split('/').pop()}` }));
}

router.get('/', async (req, res) => {
  const combos = await db.all('SELECT * FROM combos WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.render('studio/index', { title: 'Design Studio — Tattoo Art Customs', combos, metaDescription: '' });
});

router.get('/combine', async (req, res) => {
  const designs = await ownedDesigns(req.user.id);
  res.render('studio/combine', {
    title: 'Combine designs — Design Studio',
    designs,
    metaDescription: '',
    result: null,
  });
});

router.post('/combine', formLimiter, checkHoneypot, async (req, res) => {
  try {
    const designs = await ownedDesigns(req.user.id);
    const byId = new Map(designs.map((d) => [d.id, d]));
    let ids = req.body.design_ids || [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = [...new Set(ids)].slice(0, 6);
    if (ids.length < 2) throw new Error('Pick at least 2 designs to combine.');
    const picked = ids.map((id) => byId.get(id)).filter(Boolean);
    if (picked.length !== ids.length) throw new Error('You can only combine designs you have paid for.');
    const layout = ['row', 'stack', 'grid'].includes(req.body.layout) ? req.body.layout : 'row';
    const style = req.body.style === 'linework' ? 'linework' : 'color';
    const background = req.body.background === 'black' ? 'black' : 'white';
    const name = String(req.body.name || '').slice(0, 80) || `Combo — ${new Date().toLocaleDateString()}`;

    const buffer = await combine(picked, { layout, style, background });

    const id = db.newId();
    const dir = path.join(config.uploadDir, 'combos', req.user.id);
    fs.mkdirSync(dir, { recursive: true });
    const relPath = path.join('combos', req.user.id, `combo-${id}.jpg`);
    fs.writeFileSync(path.join(config.uploadDir, relPath), buffer);

    await db.insert('combos', {
      id, user_id: req.user.id, name,
      design_ids: JSON.stringify(ids), layout, style, background,
      output_path: relPath, created_at: db.now(),
    });

    const combo = await db.get('SELECT * FROM combos WHERE id = ?', [id]);
    res.render('studio/combine', {
      title: 'Combine designs — Design Studio',
      designs,
      metaDescription: '',
      result: combo,
    });
  } catch (e) {
    req.session.flash = e.message || 'Could not combine those designs.';
    return res.redirect('/studio/combine');
  }
});

// Owner-only download of a saved combination.
router.get('/combos/:id/download', async (req, res) => {
  const combo = await db.get('SELECT * FROM combos WHERE id = ?', [req.params.id]);
  if (!combo || (combo.user_id !== req.user.id && !isAdminRole(req.user.role))) {
    return res.status(404).render('error', { title: 'Not found', message: 'Combination not found.' });
  }
  const abs = resolveStoredPath(combo.output_path);
  if (!abs) {
    return res.status(404).render('error', { title: 'Not found', message: 'File is missing.' });
  }
  res.download(abs, `${combo.name.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60) || 'combo'}.jpg`);
});

router.post('/combos/:id/delete', formLimiter, checkHoneypot, async (req, res) => {
  const combo = await db.get('SELECT * FROM combos WHERE id = ?', [req.params.id]);
  if (combo && (combo.user_id === req.user.id || isAdminRole(req.user.role))) {
    const delAbs = resolveStoredPath(combo.output_path);
    if (delAbs) { try { fs.unlinkSync(delAbs); } catch { /* gone */ } }
    await db.query('DELETE FROM combos WHERE id = ?', [combo.id]);
    req.session.flash = 'Combination deleted.';
  }
  res.redirect('/studio');
});

module.exports = router;
