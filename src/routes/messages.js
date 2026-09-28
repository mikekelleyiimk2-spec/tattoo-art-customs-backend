// On-site messaging between customers, artists, and shops.
// Every message is screened for off-site contact info; flagged messages
// are held for admin review instead of being delivered.
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { messageLimiter, checkHoneypot } = require('../middleware/rateLimit');
const { screenText } = require('../lib/screening');

const router = express.Router();
router.use(requireLogin);

async function userConversations(userId) {
  return db.all(
    `SELECT c.*, MAX(m.created_at) AS last_at
     FROM conversations c
     JOIN conversation_participants p ON p.conversation_id = c.id
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE p.user_id = ?
     GROUP BY c.id ORDER BY last_at DESC`, [userId]);
}

router.get('/', async (req, res) => {
  res.render('messages/inbox', {
    title: 'Messages — Tattoo Art Customs',
    conversations: await userConversations(req.user.id), metaDescription: '',
  });
});

router.get('/:id', async (req, res) => {
  const part = await db.get(
    'SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!part) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
  const messages = await db.all(
    `SELECT m.*, u.display_name AS sender_name FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? AND m.screened = 0 ORDER BY m.created_at`, [req.params.id]);
  res.render('messages/thread', { title: 'Messages — Tattoo Art Customs', conv, messages, metaDescription: '' });
});

// Start a conversation (e.g. "Message about this design" / custom request).
router.post('/start', messageLimiter, checkHoneypot, async (req, res) => {
  const toUserId = String(req.body.to_user_id || '');
  const subject = String(req.body.subject || '').trim().slice(0, 120) || 'New conversation';
  const toUser = await db.get('SELECT id FROM users WHERE id = ?', [toUserId]);
  if (!toUser || toUserId === req.user.id) return res.redirect('/messages');
  const convId = await db.insert('conversations', { subject, created_at: db.now() });
  await db.insert('conversation_participants', { conversation_id: convId, user_id: req.user.id });
  await db.insert('conversation_participants', { conversation_id: convId, user_id: toUserId });
  res.redirect(`/messages/${convId}`);
});

router.post('/:id', messageLimiter, checkHoneypot, async (req, res) => {
  const part = await db.get(
    'SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!part) return res.status(404).render('error', { title: 'Not found', message: 'Conversation not found.' });
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.redirect(`/messages/${req.params.id}`);
  const screen = screenText(body);
  if (!screen.ok) {
    // Hold the message for admin review; do not deliver it.
    const msgId = await db.insert('messages', {
      conversation_id: req.params.id, sender_id: req.user.id, body,
      screened: 1, flags: JSON.stringify(screen.flags), created_at: db.now(),
    });
    await db.insert('review_queue', {
      item_type: 'message', item_id: msgId,
      reason: 'Contact info detected: ' + screen.flags.map((f) => f.label).join(', '),
      status: 'open', created_at: db.now(),
    });
    req.session.flash = 'Your message was held for review — it looks like it contains contact info or off-site links. All communication must stay on the site.';
  } else {
    await db.insert('messages', {
      conversation_id: req.params.id, sender_id: req.user.id, body,
      screened: 0, flags: '[]', created_at: db.now(),
    });
  }
  res.redirect(`/messages/${req.params.id}`);
});

module.exports = router;
