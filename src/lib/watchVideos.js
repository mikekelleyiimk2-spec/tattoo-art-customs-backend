// Confirmed Public YouTube videos for the /watch page and the landing
// videos strip (owner order 2026-10-21: put the commercials ON the website
// so site traffic turns into YouTube views — embedded plays count).
//
// Every ID below is tied to a Public video in our records; titles and
// channel ownership were re-verified via the YouTube oEmbed endpoint on
// 2026-10-21. NEVER add an ID that is not confirmed Public in our records.
//
// TAC channel = Tattoo Art Customs (@tattooartcustoms-s8f)
// Rook channel = Rook 98 (@rook9860)
// TAC/Rook content belongs on TAC (adult) surfaces only — never embed
// these on Little Inkers kid-facing pages.

const TAC_CHANNEL_URL = 'https://www.youtube.com/@tattooartcustoms-s8f';
const ROOK_CHANNEL_URL = 'https://www.youtube.com/@rook9860';

// Commercials / channel ads on the Tattoo Art Customs channel.
// YuHDG8Kmd58 "Color It Before You Ink It" — live + Public per
// memory/2026-10-07.md (also the video the owner ordered run as an
// organic ad). tMjOMH980ec — verified Public per memory/2026-10-06.md.
// The five #Shorts ads were uploaded Public to the TAC channel on
// 2026-10-20 (20-Shorts batch, memory/2026-10-20.md).
const COMMERCIALS = [
  { id: 'YuHDG8Kmd58', title: 'Color It Before You Ink It — Tattoo Art Customs x Little Inkers', vertical: false },
  { id: 'tMjOMH980ec', title: 'Every Style. One Shop. — 50+ Tattoo Styles, 12 Categories | Tattoo Art Customs', vertical: false },
  { id: 'loGD7VxS9_0', title: 'One Design. Halfway Around the World. 🌍 Custom Tattoos, Anywhere #Shorts', vertical: true },
  { id: 'Y1_kyEZellM', title: 'Your Next Tattoo Is Already Drawn 🎨 4,700+ Designs, Customs in 48 Hours #Shorts', vertical: true },
  { id: 'k58RUFJ0jhc', title: 'Artists: Your Art, Your Prices, Weekly PayPal Payouts 💸 Join Tattoo Art Customs #Shorts', vertical: true },
  { id: 'yiU67irWyvY', title: 'Color It BEFORE You Ink It 🎨➡️🖋️ Little Inkers × Tattoo Art Customs #Shorts', vertical: true },
  { id: 'wLwViSpWdDg', title: 'TESTERS WANTED 📱 Get Our New Apps FREE Before They Launch #Shorts', vertical: true },
];

// Design showcase Shorts on the Tattoo Art Customs channel — uploaded
// Public 2026-10-20 (memory/2026-10-20.md upload report lists each
// title + URL on the TAC channel).
const DESIGN_SHORTS = [
  { id: '542UWAQxWg8', title: 'phase2 batch273 mosaic10 windmill - Original Tattoo Design ($75) | Tattoo Art Customs', vertical: true },
  { id: 'qqYXF_n8t9I', title: 'Yuki — Japanese Girl with Koi - Original Tattoo Design ($75) | Tattoo Art Customs', vertical: true },
  { id: '3RfdcoOgenA', title: 'Aza the Hope Bird - Original Tattoo Design ($75) | Tattoo Art Customs', vertical: true },
  { id: 'q4sWAbZPhaw', title: 'Mango - Original Tattoo Design ($75) | Tattoo Art Customs', vertical: true },
];

// The same commercial on the Rook 98 channel — live + Public per
// memory/2026-10-07.md.
const ROOK_VIDEOS = [
  { id: 'uX-gjIuzcLY', title: 'Color It Before You Ink It — Tattoo Art Customs x Little Inkers', vertical: false },
];

// Landing page strip: the feature commercial + three ad Shorts.
const LANDING_FEATURE = COMMERCIALS[0];
const LANDING_SHORTS = [COMMERCIALS[2], COMMERCIALS[3], COMMERCIALS[4]];

module.exports = {
  TAC_CHANNEL_URL,
  ROOK_CHANNEL_URL,
  COMMERCIALS,
  DESIGN_SHORTS,
  ROOK_VIDEOS,
  LANDING_FEATURE,
  LANDING_SHORTS,
};
