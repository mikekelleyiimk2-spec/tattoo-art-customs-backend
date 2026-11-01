// Cayli's Opinion on Everything — the gag app's backend (owner order
// 2026-10-31). The app holds NO credentials: it POSTs a question here,
// the question is stored, and the site mailer emails it to Cayli
// letterheaded as a Cayli's Opinion app question. Her reply is routed
// (Reply-To) to Mike's mk2 inbox, the standing Cayli route; the inbox
// watch files her answers back through the key-gated ingest endpoint
// so the app can show them and notify.
//
// HONEST DELIVERY: a question is only marked 'sent' when the mailer
// actually accepts it. While SMTP is unconfigured the row stays
// 'queued' and the API says so — queued questions flush automatically
// on the next ask/health call once the transport is ready.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { sendMail, transportReady } = require('../lib/mail');

const router = express.Router();

const CAYLI_EMAIL = 'Caylicradic@gmail.com';
const REPLY_TO = 'mikekelleyii.mk2@gmail.com';
const DAILY_CAP = 30;

const askLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10000 : 5,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many questions — give Cayli a breather and try again in a bit.' },
});

function letterhead(question, askerName) {
  const who = askerName ? askerName : 'Mike';
  const text = [
    "==================================================",
    "   CAYLI'S OPINION ON EVERYTHING",
    "   Cayli's Opinion app questions",
    "==================================================",
    '',
    'Hi Cayli — somebody wants your opinion:',
    '',
    `"${question}"`,
    '',
    `— asked by ${who}, via the Cayli's Opinion app`,
    '',
    'Just reply to this email and your answer goes straight back.',
    '',
  ].join('\n');
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;border:2px solid #5b2333;border-radius:14px;overflow:hidden">
  <div style="background:#5b2333;color:#f3d27a;padding:18px 22px;text-align:center">
    <div style="font-size:22px;font-weight:bold;letter-spacing:1px">Cayli&rsquo;s Opinion on Everything</div>
    <div style="font-size:13px;opacity:.85;margin-top:4px">Cayli&rsquo;s Opinion app questions</div>
  </div>
  <div style="padding:20px 22px;background:#fffaf2;color:#2b2b2b">
    <p>Hi Cayli — somebody wants your opinion:</p>
    <blockquote style="font-size:18px;font-style:italic;border-left:4px solid #c98a2d;margin:14px 0;padding:6px 14px">&ldquo;${escapeHtml(question)}&rdquo;</blockquote>
    <p style="color:#6b5a44">— asked by ${escapeHtml(who)}, via the Cayli&rsquo;s Opinion app</p>
    <p style="color:#6b5a44;font-size:13px">Just reply to this email and your answer goes straight back.</p>
  </div>
</div>`;
  return { text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function tryDeliver(row) {
  if (!transportReady()) return 'queued';
  const { text, html } = letterhead(row.question, row.asker_name);
  try {
    await sendMail({
      to: CAYLI_EMAIL,
      replyTo: REPLY_TO,
      subject: "Cayli's Opinion app questions — a new question for Cayli",
      text, html,
    });
    await db.query(
      "UPDATE cayli_opinion_questions SET status = 'sent', sent_at = ?, mail_error = NULL WHERE id = ?",
      [db.now(), row.id]);
    return 'sent';
  } catch (e) {
    await db.query(
      'UPDATE cayli_opinion_questions SET mail_error = ? WHERE id = ?',
      [String((e && e.message) || e).slice(0, 300), row.id]);
    return 'queued';
  }
}

async function flushQueued(limit = 10) {
  if (!transportReady()) return 0;
  const rows = await db.all(
    "SELECT * FROM cayli_opinion_questions WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
    [limit]);
  let sent = 0;
  for (const row of rows) {
    if ((await tryDeliver(row)) === 'sent') sent += 1;
  }
  return sent;
}

// Mail + queue state, for the app's honest status line.
router.get('/cayli-opinion/health', async (req, res) => {
  try {
    await flushQueued(3);
    const q = await db.get(
      "SELECT COUNT(*) AS n FROM cayli_opinion_questions WHERE status = 'queued'");
    res.json({ ok: true, mailReady: transportReady(), queued: q ? Number(q.n) : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'health check failed' });
  }
});

// Ask Cayli a question. Stores first, delivers if the mailer is live.
router.post('/cayli-opinion/ask', askLimiter, async (req, res) => {
  try {
    // House honeypot: bots fill the hidden field, humans never see it.
    if (req.body && req.body.website) return res.json({ ok: true, delivery: 'sent' });
    const question = String((req.body && req.body.question) || '').trim();
    const askerName = String((req.body && req.body.name) || '').trim().slice(0, 60);
    if (question.length < 3) {
      return res.status(400).json({ ok: false, error: 'Ask a real question first — at least a few words.' });
    }
    if (question.length > 800) {
      return res.status(400).json({ ok: false, error: 'That question is too long — keep it under 800 characters.' });
    }
    const today = await db.get(
      'SELECT COUNT(*) AS n FROM cayli_opinion_questions WHERE created_at > ?',
      [db.now() - 24 * 60 * 60 * 1000]);
    if (today && Number(today.n) >= DAILY_CAP) {
      return res.status(429).json({ ok: false, error: "Cayli's inbox has had a full day — try again tomorrow." });
    }
    const id = await db.insert('cayli_opinion_questions', {
      question,
      asker_name: askerName || null,
      status: 'queued',
      mail_error: null,
      created_at: db.now(),
      sent_at: null,
    });
    const row = await db.get('SELECT * FROM cayli_opinion_questions WHERE id = ?', [id]);
    const delivery = await tryDeliver(row);
    // Opportunistically flush anything older that was waiting too.
    flushQueued(5).catch(() => {});
    res.json({ ok: true, id, delivery });
  } catch (e) {
    console.error('[cayli-opinion] ask failed', e && e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong saving that question — try again.' });
  }
});

// Her answers, newest first, each with the question it answers.
router.get('/cayli-opinion/answers', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT a.id, a.answer, a.created_at AS answered_at,
              q.question, q.created_at AS asked_at
       FROM cayli_opinion_answers a
       LEFT JOIN cayli_opinion_questions q ON q.id = a.question_id
       ORDER BY a.created_at DESC LIMIT 100`);
    res.json({
      ok: true,
      answers: rows.map((r) => ({
        id: r.id,
        answer: r.answer,
        question: r.question || null,
        askedAt: r.asked_at || null,
        answeredAt: r.answered_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not load answers.' });
  }
});

// File one of Cayli's email answers into the store. Gated by a shared
// key (env CAYLI_OPINION_INGEST_KEY) because a fake answer is worse
// than no answer; with no key configured the door stays shut (503)
// rather than open. Used by the house inbox watch, never by the app.
router.post('/cayli-opinion/answers', async (req, res) => {
  const key = process.env.CAYLI_OPINION_INGEST_KEY || '';
  if (!key) return res.status(503).json({ ok: false, error: 'ingest_not_configured' });
  if (String(req.get('x-ingest-key') || '') !== key) {
    return res.status(403).json({ ok: false, error: 'bad key' });
  }
  try {
    const answer = String((req.body && req.body.answer) || '').trim();
    if (answer.length < 1) return res.status(400).json({ ok: false, error: 'Empty answer.' });
    let questionId = String((req.body && req.body.questionId) || '') || null;
    if (!questionId) {
      // Match the oldest unanswered question — her reply answers the
      // question she was last asked.
      const open = await db.get(
        `SELECT q.id FROM cayli_opinion_questions q
         LEFT JOIN cayli_opinion_answers a ON a.question_id = q.id
         WHERE a.id IS NULL ORDER BY q.created_at ASC LIMIT 1`);
      if (open) questionId = open.id;
    }
    const id = await db.insert('cayli_opinion_answers', {
      question_id: questionId,
      answer: answer.slice(0, 4000),
      created_at: db.now(),
    });
    res.json({ ok: true, id, questionId });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not file that answer.' });
  }
});

module.exports = router;
