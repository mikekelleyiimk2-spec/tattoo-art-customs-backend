// Contact-info screening for bios, shop profiles, and on-site messages.
// Owner rule: all contact stays through the site. Customers and design
// artists may post NO off-site contact info (email, address, phone, social
// media/DM info, personal websites, payment info). Verified + subscribed
// tattoo shops may post ONLY business location, appointment requirements,
// and business hours — everything else is still blocked.
//
// screenText() returns { ok, flags[] }. Callers decide: hard-block the
// submission, or accept + push to the admin review queue.
const PATTERNS = [
  { id: 'email', label: 'email address', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { id: 'phone', label: 'phone number', re: /(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?){2}\d{4}/ },
  { id: 'url', label: 'website link', re: /(https?:\/\/|www\.)[^\s/$.?#].[^\s]*/i },
  { id: 'social_handle', label: 'social media handle', re: /(^|\s)@[\w.]{2,30}\b/ },
  {
    id: 'social_ref', label: 'social media reference',
    re: /\b(instagram|ig\b|tiktok|facebook|fb\b|snapchat|discord|telegram|whatsapp|twitter|x\.com|youtube|onlyfans)\b/i,
  },
  {
    id: 'payment_info', label: 'payment info',
    re: /\b(paypal(\.me)?|venmo|cash\s?app|zelle|chime|varo|crypto|bitcoin|btc|eth\b|wallet|western union|moneygram)\b|\$[a-zA-Z][a-zA-Z0-9_-]*/i,
  },
  {
    id: 'street_address', label: 'street address',
    re: /\b\d{1,5}\s+[a-z0-9.'-]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|circle|cir|parkway|pkwy)\b/i,
  },
  { id: 'dm_me', label: '"DM me" solicitation', re: /\b(dm|pm)\s+me\b/i },
];

function screenText(text, options = {}) {
  const flags = [];
  const input = String(text || '');
  const allow = new Set(options.allow || []);
  for (const p of PATTERNS) {
    if (allow.has(p.id)) continue;
    if (p.re.test(input)) flags.push({ id: p.id, label: p.label });
  }
  return { ok: flags.length === 0, flags };
}

// Shop fields that verified+subscribed shops are allowed to fill. Anything
// else (bio-like free text with contact info) still goes through screenText.
const SHOP_ALLOWED_FIELDS = ['location', 'hours', 'appointment_requirements'];

module.exports = { screenText, SHOP_ALLOWED_FIELDS };
