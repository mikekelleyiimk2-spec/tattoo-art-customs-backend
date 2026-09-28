// Rate limiting (spam protection) + honeypot helper for forms.
// Every public form includes <input name="website" class="hp"> (hidden via
// CSS); bots fill it, humans don't. checkHoneypot() rejects those posts.
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: 'Too many attempts — please wait a few minutes and try again.',
  standardHeaders: true, legacyHeaders: false,
});

const formLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: 'Too many submissions — please slow down.',
  standardHeaders: true, legacyHeaders: false,
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: 'Too many messages — please wait a moment.',
  standardHeaders: true, legacyHeaders: false,
});

function checkHoneypot(req, res, next) {
  if (req.body && req.body.website) {
    // Silently "succeed" so bots can't probe.
    return res.status(200).send('Thanks!');
  }
  next();
}

module.exports = { authLimiter, formLimiter, messageLimiter, checkHoneypot };
