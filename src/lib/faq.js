'use strict';
// Frequently asked questions (AdSense "low value content" remediation,
// 2026-11-03 owner order: every low-value verdict triggers a real content
// upgrade). Served at /faq. Every answer is drawn from copy already
// published on this site — the custom-design guide, the terms (design
// licenses, §8), the aftercare guide and the about page — so the FAQ never
// promises anything the rest of the site does not. If a policy changes,
// change it here too. Answers are first-party static copy and may contain
// simple <a> markup; the view renders them as HTML on that basis.

const FAQS = [
  {
    q: 'What exactly do I get when I buy a premade design?',
    a: [
      'Two files, delivered digitally after purchase: the finished full-color artwork, and the clean linework version of the same design. The color file is your reference for how the tattoo should look; the linework file is the working document — it is what your tattoo artist turns into a stencil and tattoos from. Keep both files safe after download, because together they are your purchase.',
      'Your purchase also includes the design\'s <a href="/terms#license">single-use tattoo license</a>, explained in the next answer. There is nothing physical to ship and nothing to wait for: premade designs are ready the moment you check out.',
    ],
  },
  {
    q: 'What does the single-use tattoo license mean?',
    a: [
      'It means the artwork is licensed to be tattooed on you, once. It is not an exclusive sale — the same design may be licensed to other buyers — and copyright stays with the artist and Tattoo Art Customs. You may not resell the files, share or redistribute them, give them to someone else to tattoo, or print the artwork on merchandise.',
      'Custom designs drawn to order carry the same license: yours to have tattooed once, with copyright remaining with the artist. The full wording lives in <a href="/terms#license">section 8 of our terms</a>.',
    ],
  },
  {
    q: 'Can I take a design I buy here to my own tattoo artist?',
    a: [
      'Yes — that is the normal way it works. Tattoo artists work from clean linework every day, and the linework file you receive is drawn to be stenciled directly. There is nothing unusual to explain to your artist: bring the linework for the stencil and the color artwork as the reference.',
      'If you do not already have an artist, the shops in our network work from these files as a matter of routine — the <a href="/guides/for-tattoo-shops">shops guide</a> explains what shops on the platform offer.',
    ],
  },
  {
    q: 'How do custom tattoo designs work?',
    a: [
      'Four steps. You write a brief describing the piece. You place the order and pay a deposit — custom designs are a flat price, half due up front and the balance on delivery. Your artist then draws the piece, and delivery is within 48 hours of the paid deposit. Finally you receive the finished full-color artwork and the linework, with the same single-use tattoo license as a premade design.',
      'The full walkthrough, including how to write a brief that gets you the drawing you actually want, is in our <a href="/guides/custom-design-process">custom design guide</a>. When you are ready, <a href="/orders/custom">start a custom order</a>.',
    ],
  },
  {
    q: 'What should I put in a custom design brief?',
    a: [
      'Five things. <strong>Subject:</strong> what the piece is, exactly — "a koi swimming upward, wrapped around a lotus" beats "something Japanese." <strong>Style:</strong> name an established style (traditional, realism, fine line, blackwork) or attach reference images with the feel you want — our <a href="/styles">style guides</a> can help you name it. <strong>Placement and size:</strong> where it goes and roughly how big, in inches, because size decides how much detail the drawing can hold. <strong>Meaning and must-haves:</strong> the elements that carry the meaning, and anything that must not appear. <strong>Text:</strong> any lettering spelled out letter by letter, with the font style you like — lettering typos are the most preventable disaster in tattooing, and the spelling check is yours.',
      'For portraits and pet pieces, attach the clearest, highest-resolution reference photos you have. Ten real minutes on the brief is the cheapest quality upgrade in the whole process.',
    ],
  },
  {
    q: 'What if my custom drawing misses the brief?',
    a: [
      'Say so — plainly and specifically. If something in the delivered drawing genuinely misses what the brief asked for (the wrong element, the wrong orientation), clear, specific feedback is what makes a revision quick. Vague feedback like "make it pop" helps nobody, on any platform, with any artist, so point at the exact thing that is off and what the brief said instead.',
      'This is also why the brief matters so much: the artist draws what is described, so the more precise the brief, the more precise the drawing. Our <a href="/guides/custom-design-process">custom design guide</a> walks through examples.',
    ],
  },
  {
    q: 'How fast do I receive my files?',
    a: [
      'Premade designs are delivered digitally after purchase — buy it, download it, book your artist. Custom designs are drawn to order: delivery is within 48 hours of the paid deposit, with the balance due on delivery. If you need a custom piece sooner than the standard window, rush options appear on the <a href="/orders/custom">custom order page</a> when they are available.',
    ],
  },
  {
    q: 'Can I buy just the linework?',
    a: [
      'Yes. Every premade design page offers a linework-only option at a discount, for buyers who only need the stencil file — some artists prefer to build their own color from linework, and blackwork and fine-line pieces are often tattooed from linework alone. Pieces that were drawn linework-only in the first place are sold that way automatically; the design page shows which version you are buying before you pay.',
    ],
  },
  {
    q: 'Can I print a design I bought on a T-shirt or other merchandise?',
    a: [
      'Not under the design license itself — the license covers one tattoo, and it does not include merchandise rights; copyright stays with the artist. The way to put a design you own on a shirt or poster is through the site\'s own merch service, <a href="/merch">Mike\'s Custom Tees</a>, which handles the artwork properly. Recurring characters are a separate case: buying a design or print gives you rights to that one picture only, never to the character in it.',
    ],
  },
  {
    q: 'What size should my tattoo be?',
    a: [
      'Bigger than your first instinct, usually. Detail needs room: lines that are packed too tightly at a small size blur together as the tattoo settles into the skin over the years, and no artist — however good — can repeal that. Every style has an honest floor: a traditional emblem might work at three inches, while a detailed neo-traditional or realism piece may need five to eight. Each of our <a href="/styles">style guides</a> states the sizes its style honestly needs, and our <a href="/guides/choosing-a-design">choosing-a-design guide</a> explains the size-versus-detail trade-off in full.',
      'If you love a detailed design but your spot is small, the right move is a simplified custom version drawn for that size — not a tiny print of the full drawing.',
    ],
  },
  {
    q: 'Which tattoo styles age best?',
    a: [
      'Styles built on bold black outlines and simple, high-contrast shading — American traditional above all, and blackwork — age the most gracefully, because the heavy outline keeps color in place and the shapes stay readable for decades. Fine line, minimalist and watercolor work is more delicate: it can age beautifully in protected placements, but the finest lines and lightest tones soften first and may want a touch-up over the years. Every <a href="/styles">style guide</a> has an honest aging section, including the parts some shops would rather not say out loud.',
    ],
  },
  {
    q: 'How do I take care of a new tattoo?',
    a: [
      'Keep it clean, lightly moisturized, and left alone. Wash gently with lukewarm water and a fragrance-free soap using only your fingertips, pat dry with a clean paper towel, and apply a very thin layer of aftercare balm — if it looks shiny and wet, you used too much. Expect flaking and itching around days four to seven; do not scratch or pick, because picking pulls ink out of skin that has not finished healing. No soaking — baths, pools, hot tubs and the ocean are off-limits for at least two weeks — and no direct sun while it heals; after it heals, sunscreen is what keeps the color bold for decades.',
      'That is the short version. The day-by-day timeline, the second-skin film rules, and the infection warning signs that mean you should see a doctor are all in the <a href="/guides/aftercare">complete aftercare guide</a>. Your own artist\'s instructions always win if they differ — they saw your skin and know what they used.',
    ],
  },
  {
    q: 'I have a sketch or a rough idea. Can you turn it into a tattoo design?',
    a: [
      'Two routes cover this. <a href="/doodle-to-tattoo">Doodle-to-tattoo</a> takes a sketch you already have — yours, your kid\'s, a napkin drawing you love — and redraws it professionally with proper linework and shading; the composition is already yours, so it is the fastest route of all. If the idea is looser — a theme, a character, a vibe — post it on the <a href="/by-request">by-request board</a> instead: designers browse the board, claim requests they want to draw, and you buy the finished design if it lands.',
    ],
  },
  {
    q: 'Can I sell my own tattoo designs here?',
    a: [
      'Yes — the marketplace is built on independent design artists. The <a href="/designers/guide">designer guide</a> covers everything you need: upload and file specs, the style requirements designs are held to, and how commissions and payouts work. Artists keep the copyright in their work; designs sold here are licensed to buyers under the same single-use tattoo license described above.',
    ],
  },
  {
    q: 'What is your refund policy?',
    a: [
      'All sales on the site are final, as stated in our <a href="/terms">terms</a>: digital designs are delivered as files and cannot be returned. That is exactly why the premade gallery shows you the artwork before you buy, and why the custom process is built around a careful brief and a deposit rather than full payment up front. If something is technically wrong with a delivery — a file that will not open, the wrong files — <a href="/contact">contact us</a> and we will sort the delivery out.',
    ],
  },
  {
    q: 'Do you tattoo people yourselves?',
    a: [
      'Tattoo Art Customs is the design marketplace: the artwork is drawn by the design artists here and tattooed by tattoo artists — a verified shop from our network or your own local artist, working from the linework file you receive. Shops also run their side of the business on the platform — storefronts, bookings and payments — which the <a href="/guides/for-tattoo-shops">shops guide</a> explains. We are built and run in-house in Abbeville, Louisiana, and the <a href="/about">about page</a> maps everything else the studio makes.',
    ],
  },
];

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// FAQPage structured data (plain-text answers, per schema.org rules).
function faqJsonLd(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url: `${base}/faq`,
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a.map(stripTags).join(' ') },
    })),
  };
}

module.exports = { FAQS, faqJsonLd };
