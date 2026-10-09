// Portfolio share kit (shop toolset).
//
// One-tap portfolio posting helper: for a completed booking, the shop gets
// the finished design image, a pre-written caption, and share deep links.
// No external API keys needed — the shop posts from their own apps.
const db = require('../db');
const config = require('../config');

function buildCaption({ shopName, designTitle }) {
  return [
    `Fresh ink from ${shopName} 🖋️`,
    designTitle ? `Design: "${designTitle}"` : null,
    '',
    `Book your session: ${config.baseUrl}`,
    '#tattoo #tattooartist #inked #tattooartcustoms',
  ].filter((l) => l !== null).join('\n');
}

async function getShareKit(bookingId, shopUserId) {
  const booking = await db.get(
    'SELECT * FROM bookings WHERE id = ? AND shop_user_id = ?', [bookingId, shopUserId]);
  if (!booking) throw new Error('Booking not found.');
  const design = booking.design_id
    ? await db.get('SELECT id, title, color_path, linework_wm_path FROM designs WHERE id = ?', [booking.design_id])
    : null;
  const shop = await db.get('SELECT display_name FROM users WHERE id = ?', [shopUserId]);
  const shopName = (shop && shop.display_name) || 'the shop';
  const designTitle = (design && design.title) || '';
  const imgFile = design && (design.color_path || design.linework_wm_path)
    ? String(design.color_path || design.linework_wm_path).split('/').pop() : null;
  const caption = buildCaption({ shopName, designTitle });
  const designUrl = design ? `${config.baseUrl}/design/${design.id}` : config.baseUrl;
  return {
    booking, design, shopName, caption, designUrl,
    imgUrl: imgFile ? `/img/designs/${imgFile}` : null,
    shareLinks: {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(designUrl)}`,
      threads: `https://www.threads.com/intent/post?text=${encodeURIComponent(caption + '\n' + designUrl)}`,
      x: `https://x.com/intent/post?text=${encodeURIComponent(caption + '\n' + designUrl)}`,
    },
  };
}

module.exports = { getShareKit, buildCaption };
