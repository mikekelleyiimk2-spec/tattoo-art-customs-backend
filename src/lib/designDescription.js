// Design-page description builder (high-value pass, owner order 2026-10-26).
//
// A design page used to render whatever sat in designs.description — for
// most of the catalog that is empty, a stub ("Fine Line Lily design"), or
// the nightly ingest stamp ("Original X tattoo design "T". Full color
// with shading..."), the same two sentences on thousands of pages. This
// module decides what a page actually shows:
//
//   - A stored description that is genuinely the artist's own words
//     (specific, multi-sentence, not the stamp) is kept as-is.
//   - Anything else is replaced at render time by a description built
//     from the design's real record — title, categories, style,
//     color source, listing type — written the way an artist talks
//     about a piece: what it depicts, how it is drawn, how it wears,
//     and what the buyer receives.
//
// Variation is structural, not cosmetic: sentence frames, paragraph
// order, subject talk and wear guidance are all selected per design
// from a stable hash of the design id, and the subject/style sentences
// come from vocabularies keyed to that design's actual categories and
// style. Two designs with different records do not get the same text.

// The nightly ingest stamp (and close cousins). Anything matching this
// is boilerplate, never an artist's words.
const STAMP_RES = [
  /^Original .{0,60} tattoo design "/i,
  /Full color with shading and background plus matching clean linework included\.?$/i,
  /^.{0,80}design\.?$/i, // "Fine Line Lily design", "<title> design"
];

function isSubstantiveDescription(desc) {
  const d = String(desc || '').trim();
  if (d.length < 100) return false;
  if (STAMP_RES.some((re) => re.test(d))) return false;
  const sentences = (d.match(/[.!?]+(\s|$)/g) || []).length;
  if (sentences < 2 && d.length < 260) return false;
  return true;
}

// --- small helpers -----------------------------------------------------

function hashOf(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slugKey(s) {
  return normKey(s).replace(/\s+/g, '-');
}

function categoriesOf(design) {
  let cats = design && design.categories;
  if (typeof cats === 'string') {
    try { cats = JSON.parse(cats); } catch { cats = [cats]; }
  }
  if (!Array.isArray(cats)) cats = [];
  return cats.map((c) => String(c || '').trim()).filter(Boolean);
}

// --- style knowledge ---------------------------------------------------
// technique: how the style is drawn/inked (1-2 sentences, artist voice).
// wear: placement + sizing guidance class, expanded below.
const STYLE_INFO = {
  'fine-line': { name: 'fine line', wear: 'fine', technique: [
    'The whole piece is carried by single-weight line — no heavy outline to hide behind — so every curve has to be right before the needle touches skin.',
    'It is drawn with a light hand: hairline contours, minimal shading, and negative space doing as much work as the ink itself.' ] },
  'blackwork': { name: 'blackwork', wear: 'bold', technique: [
    'Blackwork lives on contrast: solid packed black against clean skin, with the shapes kept big and readable.',
    'The drawing leans on bold silhouettes and deliberate negative space — it reads from across the room, not just up close.' ] },
  'black-and-grey-realism': { name: 'black and grey realism', wear: 'realism', technique: [
    'Realism in black and grey is built from soft gradients rather than hard outline — the drawing is mapped in values, lightest grey to deep black.',
    'There is no bold outline to lean on; the form comes from patient layering of grey washes, which is what gives the finished piece its photographic depth.' ] },
  'black-grey-realism': { name: 'black and grey realism', wear: 'realism', technique: [
    'Realism in black and grey is built from soft gradients rather than hard outline — the drawing is mapped in values, lightest grey to deep black.',
    'There is no bold outline to lean on; the form comes from patient layering of grey washes, which is what gives the finished piece its photographic depth.' ] },
  'realism': { name: 'realism', wear: 'realism', technique: [
    'The drawing is mapped in values rather than outline, so the finished tattoo holds its depth the way a photograph holds light.',
    'Realism asks patience from everyone involved: the design is built in layered tones that an artist renders one pass at a time.' ] },
  'neo-japanese': { name: 'neo-Japanese', wear: 'bold', technique: [
    'Neo-Japanese takes the classic Japanese toolkit — bold contour, flat color fields, wind and water moving behind the subject — and loosens it with modern line weight and color choices.',
    'Background movement is part of the composition, not decoration: the subject is drawn to sit inside that flow and wrap the body part it lands on.' ] },
  'neojap': { name: 'neo-Japanese', wear: 'bold', technique: [
    'Neo-Japanese takes the classic Japanese toolkit — bold contour, flat color fields, wind and water moving behind the subject — and loosens it with modern line weight and color choices.',
    'Background movement is part of the composition, not decoration: the subject is drawn to sit inside that flow and wrap the body part it lands on.' ] },
  'japanese': { name: 'Japanese', wear: 'bold', technique: [
    'The composition follows the Japanese tradition: a strong central subject, background elements that move like wind or water, and lines drawn to flow with the body.',
    'Bold contour and deliberate color fields do the work — this is a style built to stay readable for decades.' ] },
  'traditional': { name: 'American traditional', wear: 'bold', technique: [
    'Traditional drawing rules apply: a bold outline you can read at arm\'s length, a limited palette laid in flat and solid, and shading kept simple and strong.',
    'This style was perfected on sailors and soldiers — the drawing is deliberately simple in structure so it survives a lifetime on skin.' ] },
  'traditional-old-school': { name: 'American traditional', wear: 'bold', technique: [
    'Traditional drawing rules apply: a bold outline you can read at arm\'s length, a limited palette laid in flat and solid, and shading kept simple and strong.',
    'This style was perfected on sailors and soldiers — the drawing is deliberately simple in structure so it survives a lifetime on skin.' ] },
  'old-school': { name: 'American traditional', wear: 'bold', technique: [
    'Traditional drawing rules apply: a bold outline you can read at arm\'s length, a limited palette laid in flat and solid, and shading kept simple and strong.',
    'This style was perfected on sailors and soldiers — the drawing is deliberately simple in structure so it survives a lifetime on skin.' ] },
  'neo-traditional': { name: 'neo-traditional', wear: 'bold', technique: [
    'Neo-traditional keeps the traditional bold outline but opens the palette up and lets the shading breathe — more detail, same backbone.',
    'The line weight varies on purpose: heavy where the form turns, fine where the detail lives.' ] },
  'watercolor': { name: 'watercolor', wear: 'soft', technique: [
    'The color is laid out the way pigment moves in water — blooms, splashes and edges that dissolve instead of stopping at an outline.',
    'A watercolor piece usually keeps a light line skeleton underneath so the washes have somewhere to live as they settle into the skin.' ] },
  'stipple': { name: 'stipple dotwork', wear: 'fine', technique: [
    'Every tone in this piece is built from individual dots — thousands of them — denser where the shadow deepens, sparse where the light catches.',
    'Dotwork rewards patience: the design is mapped as a field of points, and the image only resolves when you step back from it.' ] },
  'dotwork': { name: 'dotwork', wear: 'fine', technique: [
    'Every tone in this piece is built from individual dots — thousands of them — denser where the shadow deepens, sparse where the light catches.',
    'Dotwork rewards patience: the design is mapped as a field of points, and the image only resolves when you step back from it.' ] },
  'geometric': { name: 'geometric', wear: 'geo', technique: [
    'The drawing is constructed, not sketched: measured shapes, repeated rhythms and symmetry an artist can mirror-check against the body before a single line is inked.',
    'Precision is the whole game here — the design is built on a grid of relationships, so it scales cleanly without losing its rhythm.' ] },
  'ornamental': { name: 'ornamental', wear: 'geo', technique: [
    'Ornamental work is drawn like jewelry for the skin: filigree, dot accents and mirrored flourishes arranged to follow the body\'s own lines.',
    'The composition is symmetrical by design, meant to sit centered and frame the body part it decorates.' ] },
  'tribal': { name: 'tribal', wear: 'bold', technique: [
    'Tribal drawing is all flow and mass: sweeping black shapes with tapered points, drawn to wrap a muscle and move when it moves.',
    'The negative space is cut as carefully as the black — the gaps between shapes are what make the pattern read.' ] },
  'polynesian': { name: 'Polynesian tribal', wear: 'bold', technique: [
    'The pattern language is Polynesian: bands of geometric marks — teeth, waves, spearheads — arranged in rows that carry the composition around the body.',
    'Each band is drawn to sit in rhythm with the next, so the piece reads as one woven surface rather than separate symbols.' ] },
  'sketch': { name: 'sketch style', wear: 'fine', technique: [
    'It keeps the energy of the original drawing — construction lines, cross-hatching and loose strokes left visible instead of polished away.',
    'The looseness is deliberate and difficult: an artist has to know exactly which rough lines carry the form and ink only those.' ] },
  'surrealism': { name: 'surrealism', wear: 'soft', technique: [
    'Surrealist drawing follows dream logic: familiar elements combined in ways that should not work and do, with soft transitions where one form melts into another.',
    'The composition is balanced like a painting first and a tattoo second — your artist will talk placement in terms of the whole picture, not just the outline.' ] },
  'stained-shard': { name: 'stained shard', wear: 'panel', technique: [
    'The image is broken into shards the way stained glass is broken into panes — bold leading lines separate each segment, and every segment carries its own flat color or tone.',
    'Segmenting the drawing is what makes it tattooable at almost any size: each shard stays readable because the leading lines never let the colors bleed into each other visually.' ] },
  'stained-glass': { name: 'stained glass', wear: 'panel', technique: [
    'The image is built the way stained glass is built — bold leading lines separate each pane, and every pane carries its own flat color or tone.',
    'Segmenting the drawing is what makes it tattooable at almost any size: each pane stays readable because the leading lines never let the colors bleed into each other visually.' ] },
  'ignorant-style': { name: 'ignorant style', wear: 'bold', technique: [
    'Ignorant style is deliberately raw — naive line, flat fills, zero interest in polish. The looseness is the aesthetic, and it is harder to fake than it looks.',
    'The drawing reads like a great doodle from the back of a notebook: direct, funny or strange, and completely unbothered by realism.' ] },
  'minimalist': { name: 'minimalist', wear: 'fine', technique: [
    'Minimalism is subtraction: the subject is reduced to the fewest lines that still carry it, and everything else is left as clean skin.',
    'With so little ink on the skin, every line carries weight — the drawing has nowhere to hide a mistake, which is why it reads so clean.' ] },
  'pixel-art': { name: 'pixel art', wear: 'geo', technique: [
    'The image is built on a pixel grid, each square of color placed deliberately — a drawing style borrowed from early game art and translated to skin.',
    'Your artist inks it square by square, so the finished piece keeps that crisp digital mosaic feel instead of blurring into a normal gradient.' ] },
  'pixelated': { name: 'pixel art', wear: 'geo', technique: [
    'The image is built on a pixel grid, each square of color placed deliberately — a drawing style borrowed from early game art and translated to skin.',
    'Your artist inks it square by square, so the finished piece keeps that crisp digital mosaic feel instead of blurring into a normal gradient.' ] },
  'blueprint': { name: 'blueprint', wear: 'fine', technique: [
    'It is drawn like a technical blueprint: measured line, annotation-style detail and the subject broken down the way an engineer would diagram it.',
    'The charm is in the precision — dimension lines and exploded views turn a familiar subject into something you study.' ] },
  'mosaic': { name: 'mosaic', wear: 'geo', technique: [
    'The image is assembled from tile-like segments, each one a flat piece of the whole — the drawing plans every tile before your artist inks the first one.',
    'Broken into tiles, the picture gains a rhythm smooth shading never gives it: it shimmers a little as the light moves across the skin.' ] },
  'carved-wood': { name: 'carved wood', wear: 'bold', technique: [
    'The style imitates a woodcut print: forms are carved out of black with white line, and every highlight is a cut rather than a gradient.',
    'It has the grain and directness of a block print — bold, a little rough at the edges, and extremely durable as a tattoo.' ] },
  'carvedwood': { name: 'carved wood', wear: 'bold', technique: [
    'The style imitates a woodcut print: forms are carved out of black with white line, and every highlight is a cut rather than a gradient.',
    'It has the grain and directness of a block print — bold, a little rough at the edges, and extremely durable as a tattoo.' ] },
  'smoke-form': { name: 'smoke form', wear: 'soft', technique: [
    'The subject is formed out of drifting smoke — edges that curl, thin and vanish, with the solid form emerging where the smoke gathers.',
    'It is drawn in soft greys and whips of negative space, so the finished piece looks like it is still moving.' ] },
  'topographic': { name: 'topographic', wear: 'geo', technique: [
    'The drawing borrows the language of topo maps: contour lines that wrap and tighten around the form, turning a subject into terrain.',
    'Following the contour spacing is the whole craft — where the lines crowd, the form rises; where they spread, it falls away.' ] },
  'mycelium': { name: 'mycelium', wear: 'soft', technique: [
    'The composition grows the way mycelium grows — branching threads, clustered fruiting forms, an organic network instead of a single outline.',
    'It is drawn to spread naturally across the skin, following the body the way a fungal network follows the forest floor.' ] },
  'circuit-bloom': { name: 'circuit bloom', wear: 'geo', technique: [
    'Circuit traces and organic bloom are drawn growing out of each other — board traces branch, then flower; petals resolve into wiring.',
    'The style lives in that tension between the engineered and the grown, and the line work keeps both halves crisp.' ] },
  'circuitbloom': { name: 'circuit bloom', wear: 'geo', technique: [
    'Circuit traces and organic bloom are drawn growing out of each other — board traces branch, then flower; petals resolve into wiring.',
    'The style lives in that tension between the engineered and the grown, and the line work keeps both halves crisp.' ] },
  'bioluminescent': { name: 'bioluminescent', wear: 'soft', technique: [
    'The subject is drawn as if it generates its own light — deep shadow around it, with the glow picked out in bright, almost electric color.',
    'Getting the glow right is a value game: the darker the surrounding tones are laid in, the brighter the lit passages read.' ] },
  'x-ray-dissection': { name: 'x-ray dissection', wear: 'fine', technique: [
    'The drawing cuts the subject open on paper: surface on one side, the structure underneath on the other, rendered with clinical line and label-like detail.',
    'It rewards a close look — half the pleasure of the piece is in the interior detail most tattoos never show.' ] },
  'cross-stitch': { name: 'cross-stitch', wear: 'geo', technique: [
    'The image is rendered in cross-stitch — every tone a grid of small x-shaped marks, the way embroidery builds a picture one stitch at a time.',
    'Translated to skin, the grid gives the piece a handmade, textile warmth that smooth shading cannot imitate.' ] },
  'dark-anime': { name: 'dark anime', wear: 'bold', technique: [
    'Anime line with the brightness turned down: sharp contours, heavy shadow shapes and a moodier palette than the source style usually gets.',
    'The drawing keeps the clean cel-shaded structure of anime art, so it reads instantly even at small sizes.' ] },
  'anime': { name: 'anime', wear: 'bold', technique: [
    'Clean anime line and cel shading carry the piece — expressions and silhouettes do the storytelling.',
    'The structure is graphic and direct, which is why it holds up so well as a tattoo.' ] },
  'graffiti': { name: 'graffiti', wear: 'bold', technique: [
    'The drawing has wall energy: fat outlines, highlights popped like spray-paint shine, and forms that lean into each other.',
    'Color is laid in loud and flat, the way a good piece on a wall stays readable from a moving train.' ] },
  'origami': { name: 'origami', wear: 'geo', technique: [
    'The subject is folded, on paper, into planes — the drawing replaces curves with crisp facets, like the finished fold of an origami figure.',
    'Each facet takes a flat tone or a single gradient, so the piece reads as paper, light and shadow rather than flesh or fur.' ] },
  'ascii-art': { name: 'ASCII art', wear: 'geo', technique: [
    'The image is typeset, literally: built from characters and type marks arranged until a picture resolves out of the text.',
    'It is an unusual piece to tattoo and a striking one — the closer you look, the more it dissolves back into type.' ] },
  'postmodern': { name: 'postmodern', wear: 'general', technique: [
    'The drawing mixes its references on purpose — clashing eras and styles combined into one deliberate composition.',
    'It reads like a collage that knows exactly what it is doing: every borrowed element is placed, not pasted.' ] },
  'absurdist': { name: 'absurdist', wear: 'general', technique: [
    'The joke is structural: an ordinary subject drawn with total sincerity in a situation it has no business being in.',
    'Deadpan execution is what sells it — the drawing never winks, so the absurdity lands every time you look at it.' ] },
  'storybook': { name: 'storybook', wear: 'soft', technique: [
    'It is drawn the way classic storybook illustrations are drawn: warm line, gentle color and a scene that feels like a page mid-story.',
    'The softness is skilled work — edges are suggested more than stated, which gives the finished piece its storybook glow.' ] },
};

// Styles that are program markers or filler, never a drawing style.
const NOT_A_STYLE = new Set(['showcase', 'original', 'restored', 'little inkers', '']);

function styleInfoFor(design, cats) {
  const direct = slugKey(design.style || '');
  if (direct && !NOT_A_STYLE.has(direct) && STYLE_INFO[direct]) return STYLE_INFO[direct];
  // Categories sometimes carry the style ('fine-line', 'neojap', ...).
  for (const c of cats) {
    const k = slugKey(c);
    if (STYLE_INFO[k] && !NOT_A_STYLE.has(k)) return STYLE_INFO[k];
  }
  // Nightly ids embed the style as a token run: nightly-<style>-<subject>.
  const idTokens = String(design.id || '').toLowerCase().split('-');
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= idTokens.length; i++) {
      const cand = idTokens.slice(i, i + n).join('-');
      if (STYLE_INFO[cand] && !NOT_A_STYLE.has(cand)) return STYLE_INFO[cand];
    }
  }
  if (direct && !NOT_A_STYLE.has(direct)) {
    return { name: String(design.style).trim(), wear: 'general', technique: [] };
  }
  return null;
}

// --- wear guidance by class --------------------------------------------

const WEAR = {
  fine: [
    'Fine work like this ages best with a little room around it — forearm, inner arm, ankle, shoulder blade or ribs are classic placements, and your artist will want to size it so the smallest lines stay honest as the skin settles over the years; the detailed passages usually want to be at least palm-sized.',
    'Plan placement with the line weight in mind: skin that moves and stretches less — forearm, calf, shoulder blade — keeps delicate lines crisp longest, and going a touch larger than you first pictured almost always pays off.',
  ],
  bold: [
    'Bold drawing is the most forgiving kind of tattoo: it sits happily on an upper arm, thigh, calf, chest or back, and it scales from a palm-sized piece to a full panel without losing its punch.',
    'This is work built to be read from across the room, and it holds that read for decades — upper arm, thigh and calf are the classic homes for it, and it wraps a limb beautifully.',
  ],
  soft: [
    'Soft edges want flatter, calmer skin — back, thigh or the outer upper arm keep washes and dissolving edges where the artist put them, while high-stretch spots can pull a soft piece out of shape over time.',
    'Give soft work room: a larger placement lets the gradients breathe instead of crowding them, and flatter areas of the body keep the atmosphere of the piece intact.',
  ],
  geo: [
    'Pattern work reads best where the body offers a flat, centered canvas — sternum, spine, forearm, calf or chest — and a good artist will stencil it on and mirror-check the symmetry against your body before inking.',
    'Sizing matters more than usual here: the placement has to be big enough that the pattern\'s rhythm stays legible, and centered placements show the construction off best.',
  ],
  realism: [
    'Realism needs size — gradients cannot survive being shrunk, so think in panels: thigh, back, upper arm or chest, somewhere the tones have room to step from light to dark.',
    'Bring this one to an artist who does realism for a living and let them talk you into the larger placement; the depth in the drawing depends on it.',
  ],
  panel: [
    'Segmented work like this reads best on flatter ground — back, sternum, thigh or forearm — where the leading lines stay true instead of bending around a joint.',
    'Mid-to-large sizing suits it: each segment needs enough skin to hold its own color, and flat placements keep the pane structure crisp.',
  ],
  general: [
    'Talk placement over with your artist before you commit to a spot — the drawing scales well, and the right move is matching its proportions to the body part so the focal point lands where your eye wants it.',
    'It is a flexible composition: it can sit as a standalone piece on an arm or leg, or become the anchor of a larger collection over time.',
    'Placement is a conversation worth having at the shop: the composition is drawn to read upright and clear, and an artist will show you two or three spots where it sits better than the one you first pictured.',
    'Because the drawing is built around one strong focal point, it holds together at the sizes people actually get tattooed — and if you fall for it, it pairs naturally with a second piece down the road.',
  ],
};

// Craft talk for designs whose record carries no recognized style.
const GENERIC_CRAFT = [
  'The drawing is built on a clean, confident contour — the kind of line an artist can stencil faithfully — with the detail concentrated where the eye lands first.',
  'Composition does the heavy lifting here: the focal point is established early, supporting elements are kept quieter, and the whole piece reads in one glance before the details start rewarding a second look.',
  'It is drawn tattoo-first rather than illustration-first: shapes are kept honest at real tattoo sizes, and the linework is planned as a stencil, not just a picture.',
];

// --- subject talk by category ------------------------------------------

const SUBJECT_TALK = [
  { match: ['animal', 'wildlife', 'pet', 'dog', 'cat', 'bird', 'owl', 'wolf', 'fox', 'bear', 'deer', 'horse', 'fish', 'koi', 'snake', 'butterfly', 'insect', 'bee', 'dragonfly'], lines: [
    'Animals carry their meaning without a word of lettering — posture, eye and silhouette do all the talking, which is why the drawing spends its effort there.',
    'Creature pieces live or die on the anatomy of the focal animal, and this one is drawn to be read at a glance: strong silhouette first, detail second.' ] },
  { match: ['flower', 'floral', 'botanical', 'plant', 'rose', 'lily', 'sunflower', 'peony', 'garden', 'bloom'], lines: [
    'Botanical drawing is really drawing about movement — petals and stems give an artist natural lines to sweep across the skin, and this composition uses them.',
    'Flowers let a design be soft and structured at the same time: open blooms for the eye to land on, leaves and stems to carry it around the body part.' ] },
  { match: ['mythology', 'fantasy', 'dragon', 'wizard', 'fairy', 'myth', 'legend', 'phoenix', 'unicorn'], lines: [
    'Mythological subjects come with centuries of storytelling already attached — the drawing\'s job is to pick the one moment worth freezing, and this one commits to it.',
    'Fantasy subjects earn their keep in the details: scales, wings, weather and atmosphere are all drawn in, so the piece rewards a long look.' ] },
  { match: ['love', 'heart', 'couple', 'romance', 'wedding'], lines: [
    'Pieces about love and partnership have to walk a line — sentimental enough to mean it, drawn well enough to wear forever — and the composition here keeps both promises.',
    'The symbolism is worn openly in this one, which is the point: it is drawn for the person who will still mean it in thirty years.' ] },
  { match: ['skull', 'dark', 'horror', 'death', 'demon', 'occult', 'gothic', 'macabre'], lines: [
    'Dark subjects are a gift to a tattoo artist: bone, shadow and negative space give them the strongest contrasts in the craft to work with.',
    'The darkness here is drawn, not just themed — deep blacks and deliberate shadow shapes carry the mood.' ] },
  { match: ['religious', 'spiritual', 'angel', 'sacred', 'cross', 'prayer', 'faith'], lines: [
    'Sacred subjects ask for restraint in the drawing — reverence comes through in clean composition rather than clutter — and this piece keeps that discipline.',
    'It is drawn to be carried seriously: balanced, symbolic, and composed the way devotional art has always been composed.' ] },
  { match: ['zodiac', 'astrology', 'celestial', 'cosmic', 'moon', 'star', 'space', 'astronomy', 'planet'], lines: [
    'Celestial work gives an artist the whole sky to compose with — orbits, phases and constellations become the structure the subject hangs on.',
    'The night-sky elements are not filler here; they are the frame, drawn to give the central subject its sense of scale.' ] },
  { match: ['wing', 'feather', 'flight'], lines: [
    'Wings and feathers are pure movement on skin — rows of layered lines that can sweep a shoulder, a back or a ribcage and make the whole body part feel like it is in motion.',
    'Feather work lives in the layering: each vane is drawn to overlap the next, so the piece ripples when the body moves.' ] },
  { match: ['vehicle', 'car', 'truck', 'motorcycle', 'machine', 'mechanical'], lines: [
    'Machines make great tattoo subjects because they are already drawings — engineered lines, honest geometry, nothing wasted — and this piece keeps that mechanical clarity.',
    'Chrome, panel lines and mechanical detail give an artist exact structure to render, and the composition keeps the machine as the hero.' ] },
  { match: ['western', 'cowboy', 'desert', 'frontier'], lines: [
    'Western subjects carry dust and mythology in equal measure — the drawing leans into weathered line and sun-bleached simplicity.',
    'It is drawn with frontier economy: nothing decorative that does not earn its place.' ] },
  { match: ['steampunk', 'gear', 'clockwork'], lines: [
    'Steampunk lives in the joinery — gears meshing, brass and rivets, Victorian ornament bolted to machinery — and the drawing keeps every mechanism legible.',
    'The fun of the style is the engineering: each gear in the composition is placed to actually turn against its neighbor, at least on paper.' ] },
  { match: ['sci-fi', 'futuristic', 'robot', 'alien', 'ufo', 'cyber'], lines: [
    'Science-fiction subjects let a drawing break the rules of anatomy and gravity on purpose — this one builds its own logic and stays consistent with it.',
    'The future-tech detail is drawn clean and deliberate, so the piece reads as designed machinery rather than decoration.' ] },
  { match: ['cartoon', 'pop culture', 'pop-culture', 'character', 'gaming', 'pixel', 'video game', 'anime'], lines: [
    'Character pieces live on expression and silhouette — get those two right and the piece reads instantly, which is exactly where this drawing puts its effort.',
    'It is drawn with a fan\'s eye for the details that matter and an artist\'s eye for what survives translation to skin.' ] },
  { match: ['fairy tale', 'storybook', 'classic tale', 'fable', 'nursery'], lines: [
    'Storybook subjects carry their audience with them — everyone who sees it already knows the tale, so the drawing just has to honor the best-known moment of it.',
    'The composition is staged like an illustration from the story itself: one scene, clearly told.' ] },
  { match: ['nature', 'forest', 'ocean', 'sea', 'nautical', 'mountain', 'landscape', 'swamp', 'bayou', 'reef', 'lighthouse', 'bridge', 'cave'], lines: [
    'Landscape and nature subjects are really compositions about depth — foreground, distance and weather — and this drawing builds all three layers in.',
    'The scene is drawn to wrap: natural forms let a piece flow around an arm or leg without a hard edge anywhere.' ] },
  { match: ['portrait', 'memorial', 'face', 'people', 'woman', 'man', 'pin-up', 'pinup'], lines: [
    'Portrait-based work is the most demanding drawing there is — a face forgives nothing — and this composition is built around getting the features and the expression right.',
    'Memorial and portrait pieces are carried as much as worn; the drawing keeps the likeness central and everything else in support of it.' ] },
  { match: ['music', 'instrument', 'guitar', 'song'], lines: [
    'Music subjects draw well because instruments are beautiful objects to begin with — all curves, strings and polished geometry for an artist to render.',
    'The composition has rhythm in the literal sense: repeated curves and spacing that move the eye the way the music would.' ] },
  { match: ['gambling', 'luck', 'casino', 'dice', 'cards'], lines: [
    'Luck iconography is tattoo tradition at its oldest — dice, cards and charms drawn bold so the symbols read instantly.',
    'The piece leans into that tradition: strong symbols, no clutter, the charm of it worn right on the surface.' ] },
  { match: ['chess', 'game', 'board'], lines: [
    'Game pieces make quietly perfect tattoo subjects — carved forms everyone recognizes, arranged here into a composition about strategy rather than decoration.',
    'The drawing treats the pieces like sculpture: weight, shadow and position all matter.' ] },
  { match: ['pirate', 'ship', 'anchor', 'sailor'], lines: [
    'Nautical tradition is tattooing\'s own family history — ships, anchors and rope work were the original flash — and this piece draws proudly on that inheritance.',
    'The composition is built like classic sailor work: a strong central subject, banner space, and lines meant to survive sun and years.' ] },
  { match: ['crown', 'royalty', 'king', 'queen', 'royal'], lines: [
    'Regal subjects are drawn like jewelry — fine points, symmetry and ornament that has to be precise to read as precious.',
    'The composition is formal and centered, the way crown imagery has always been drawn: authority through symmetry.' ] },
  { match: ['mask', 'hands', 'gesture', 'eyes', 'eye'], lines: [
    'Expressive subjects like these live on a single strong gesture — the drawing strips everything else away so that gesture carries the whole piece.',
    'It is drawn with a performer\'s instinct: one clear expression, framed and held.' ] },
  { match: ['time', 'clock', 'hourglass'], lines: [
    'Time is the oldest tattoo metaphor there is, and clockwork gives it machinery to draw — gears, faces and hands arranged around the subject.',
    'The composition uses the clock elements as structure, not decoration: they frame the subject the way time frames everything.' ] },
  { match: ['key', 'lock', 'door', 'portal'], lines: [
    'Keys, locks and doorways are threshold symbols — the drawing treats them with the weight they carry, ornate where they should be and plain where it counts.',
    'The composition is built around the threshold itself: what is locked, what opens, and the moment between.' ] },
  { match: ['fire', 'smoke', 'flame'], lines: [
    'Fire and smoke are movement studies — the drawing has to suggest something that never sits still, using licking negative space and curling line.',
    'The flames here are drawn as structure: they shape the composition instead of decorating its edges.' ] },
];

function subjectTalkFor(cats) {
  const keys = cats.map(normKey);
  for (const entry of SUBJECT_TALK) {
    if (entry.match.some((m) => keys.some((k) => k.includes(m)))) return entry.lines;
  }
  return null;
}

// Categories that add no subject information.
const GENERIC_CATS = new Set(['restored', 'coloring pages', 'showcase', 'original', 'misc', 'other']);

function subjectCategory(cats, design) {
  const styleSlug = slugKey((design && design.style) || '');
  for (const c of cats) {
    if (GENERIC_CATS.has(normKey(c))) continue;
    const k = slugKey(c);
    // A category that is really a style name carries no subject.
    if (k === styleSlug || STYLE_INFO[k]) continue;
    return c;
  }
  return '';
}

// Clean a title for prose use: drop catalog artifacts and trailing
// style parentheticals ("Lily (Fine Line)", "Tiger (Traditional / Old School)").
function proseTitle(title) {
  let t = String(title || '').trim();
  t = t.replace(/^batch\s+/i, '');
  const paren = t.match(/\s*\(([^)]{2,40})\)\s*$/);
  if (paren && /style|school|line|work|traditional|realism|japanese|watercolor|geometric|tribal|color|colour|\//i.test(paren[1])) {
    t = t.slice(0, paren.index).trim();
  }
  return t || 'This design';
}

// --- the builder ---------------------------------------------------------

function buildParagraphs(design, artistName) {
  const title = proseTitle(design.title);
  const cats = categoriesOf(design);
  const seed = hashOf(design.id || title);
  const style = styleInfoFor(design, cats);
  const subjectLines = subjectTalkFor(cats);
  const catName = subjectCategory(cats, design);
  const hasColor = design.color_source !== 'none';
  const isCustomPiece = design.listing_type === 'custom';

  // Paragraph 1 — the piece itself.
  const openers = [
    `"${title}" is an original design${style ? ` drawn in a ${style.name} hand` : ''}, and it knows exactly what it is about.`,
    `Start with the drawing itself: "${title}"${style ? `, worked in ${style.name}` : ''}, composed around one clear focal point that reads the moment you see it.`,
    `"${title}"${style ? ` — ${style.name} work` : ''} — is built the way good tattoo art is built: a strong focal subject, deliberate line, and nothing in the composition that does not earn its place.`,
    `Some designs are decoration. "${title}" is a composition${style ? `, drawn in ${style.name}` : ''} — subject first, structure underneath, detail where it pays.`,
  ];
  let p1 = pick(openers, seed);
  if (subjectLines) p1 += ' ' + pick(subjectLines, seed >> 2);
  if (artistName) {
    p1 += ` It was drawn by ${artistName}, one of the independent artists selling original work through Tattoo Art Customs.`;
  } else if (catName) {
    p1 += ` It sits in the ${catName} shelf of the gallery, alongside the rest of the studio's original catalog.`;
  }

  // Paragraph 2 — the craft: technique + how it wears.
  let p2 = '';
  if (style && style.technique.length) p2 = pick(style.technique, seed >> 3);
  if (!p2) p2 = pick(GENERIC_CRAFT, seed >> 3);
  const wearLines = WEAR[(style && style.wear) || 'general'];
  const wear = pick(wearLines, seed >> 4);
  p2 = p2 ? `${p2} ${wear}` : wear;
  if (design.colorization_note && String(design.colorization_note).trim()) {
    p2 += ` A note from the studio on this one: ${String(design.colorization_note).trim()}`;
  }

  // Paragraph 3 — what the buyer receives / how the piece is offered.
  let p3;
  if (isCustomPiece) {
    p3 = 'This piece was drawn as a one-off commission, and it stays in the gallery as a portfolio example of the custom work the studio does. You cannot buy this exact drawing — it already belongs to the client it was made for — but you can request a design like it, drawn for you, through a custom order: describe what you loved about it, and an artist will draw your version.';
  } else if (hasColor) {
    p3 = pick([
      'Buy it and you receive two files: the finished full-color artwork and the matching clean linework — the pair a tattoo artist actually works from, stencil first, color reference beside it. The gallery only ever shows the linework preview, so the finished color stays the buyer\'s.',
      'What you are buying is the working pair: full-color finished art plus the clean linework stencil your artist will transfer to skin. The preview here is linework only by design — the color version is delivered privately after purchase.',
      'The purchase delivers the complete working set: the full-color original and its matching clean linework, ready to hand to your artist. Only the linework is ever shown publicly — buyers get the color, everyone else gets the outline.',
    ], seed >> 5);
  } else {
    p3 = pick([
      'This piece is delivered as clean linework — a ready-to-transfer stencil your artist can ink in straight black, build up in black and grey, or color in a palette of your choosing at the chair. Linework-only pieces are the most flexible thing in the gallery: the drawing is finished, the finish is up to you.',
      'You receive the clean linework file, ready to stencil. From there your artist has options — crisp black line as drawn, soft black-and-grey shading, or full color in whatever palette you agree on — because the underlying drawing was built to carry any of them.',
      'It ships as linework only, which is a feature, not a shortage: the stencil is the finished drawing, and your artist can take it in black, in black and grey, or into full color — three different tattoos waiting inside the same clean lines.',
    ], seed >> 5);
  }
  if (design.request_only && !isCustomPiece) {
    p3 += ' This one is offered by request: send the request and the studio will confirm availability and timing before you pay anything.';
  }
  if (Number(design.show_featured) === 1) {
    p3 += ' It is also one of the designs featured in the studio\'s Color With Us show series.';
  }
  const variation = pick([
    'And if it is almost right — a name worked in, different flowers, the composition flipped to fit the other arm — order it as a custom variation and an artist will redraw it to your notes.',
    'Like it but need it changed — colors swapped, an element added, sized for a specific spot? That is what the custom-variation order is for: the same drawing, reworked by an artist around your notes.',
  ], seed >> 6);

  // Rotate the assembly so pages do not all share one skeleton.
  const shape = seed % 3;
  if (shape === 0) return [p1, p2, `${p3} ${variation}`];
  if (shape === 1) return [p1, `${p3} ${variation}`, p2];
  return [p2, p1, `${p3} ${variation}`];
}

function coloringParagraphs(design) {
  const title = proseTitle(design.title);
  const cats = categoriesOf(design);
  const pack = cats.find((c) => normKey(c) !== 'coloring pages') || '';
  const p1 = `"${title}" is a coloring page${pack ? ` from the ${pack} pack` : ''} in the Little Inkers library — drawn for kids, with bold outlines and big, friendly shapes that small hands can actually finish. Every page in the pack follows the same episode of the Little Inkers show, so children can color the characters and scenes they just watched.`;
  const p2 = 'Print it out for crayons, markers or colored pencils — the lines are thick enough to forgive a wobble — or open it in the Little Inkers app and color it on screen. Pages like this one are how the studio\'s youngest artists start: same characters, same stories, their own colors.';
  return [p1, p2];
}

function descriptionParagraphs(design, artistName) {
  const stored = String((design && design.description) || '').trim();
  if (isSubstantiveDescription(stored)) {
    return stored.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  }
  const cats = categoriesOf(design);
  const isColoring = cats.some((c) => normKey(c) === 'coloring pages')
    || slugKey(design.style || '') === 'little-inkers';
  if (isColoring) return coloringParagraphs(design);
  return buildParagraphs(design, artistName);
}

// One-to-two sentence summary for meta tags / JSON-LD.
function descriptionSummary(design, artistName) {
  const paras = descriptionParagraphs(design, artistName);
  const first = paras[0] || '';
  const sentences = first.match(/[^.!?]+[.!?]+/g) || [first];
  let out = sentences.slice(0, 2).join(' ').trim();
  if (out.length > 300) out = `${out.slice(0, 297).trimEnd()}…`;
  return out;
}

module.exports = {
  isSubstantiveDescription,
  descriptionParagraphs,
  descriptionSummary,
};
