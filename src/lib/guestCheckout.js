// Shared guest-checkout helpers for PAID APP purchases (money-path fix
// 2026-10-15, extending the guest design checkout of b3fc9b0 / migration
// 089 to POST /buy-app/:slug/buy and POST /tac-android-pro/buy).
//
// A logged-out buyer pays via PayPal with just a delivery email — no
// account wall. The order row carries guest_email and buyer_id stays ''
// (the guest sentinel). The PayPal return URL and the emailed
// download-page link carry a stateless HMAC token (lib/updateTokens,
// purpose-scoped per purchase flow) proving the returning browser / link
// holder is the buyer. The download page re-mints the gated APK token on
// every visit, so the emailed page link is durable while the APK itself
// is never served on a public URL. Member flows are untouched.
const updateTokens = require('./updateTokens');
const { sendMail } = require('./mail');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isGuestOrder(order) {
  return !!order && !order.buyer_id && !!order.guest_email;
}

// Normalize a submitted guest delivery email; null when unusable.
function parseGuestEmail(raw) {
  const email = String(raw || '').trim().toLowerCase().slice(0, 160);
  return EMAIL_RE.test(email) ? email : null;
}

function tokenPurpose(scope) {
  return `guest-app-checkout:${scope}`;
}

function guestToken(orderId, scope) {
  return updateTokens.issue(orderId, tokenPurpose(scope));
}

// Returns the orderId (string) when the token is genuine for this scope,
// otherwise null.
function verifyGuestToken(token, scope) {
  return updateTokens.verify(String(token || ''), tokenPurpose(scope));
}

// Receipt + download-page link for a PAID guest app order, emailed to the
// checkout address. Mail failures never break the buyer's on-screen flow
// (payment is already captured when this runs) — log and move on.
async function sendGuestAppReceipt({ order, appName, downloadPageUrl }) {
  if (!isGuestOrder(order)) return false;
  const lines = [
    `Hi there,`,
    ``,
    `Thanks for your purchase — payment is complete.`,
    ``,
    `Your download for ${appName} is ready here:`,
    downloadPageUrl,
    ``,
    `Keep this email — it is your receipt and your way back to the download page.`,
    `If you have any trouble installing, just reply to this email.`,
    ``,
    `— Tattoo Art Customs`,
  ];
  try {
    await sendMail({
      to: order.guest_email,
      subject: `Your download is ready — ${appName} (Tattoo Art Customs)`,
      text: lines.join('\n'),
    });
    return true;
  } catch (e) {
    console.error('guest app receipt email failed:', e.message);
    return false;
  }
}

module.exports = { isGuestOrder, parseGuestEmail, guestToken, verifyGuestToken, sendGuestAppReceipt };
