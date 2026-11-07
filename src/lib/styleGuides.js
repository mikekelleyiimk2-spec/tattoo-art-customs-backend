'use strict';
// Long-form tattoo style guides (AdSense "low value content" remediation,
// 2026-11-03 owner order: every low-value verdict triggers a real content
// upgrade). One guide per major style in the catalog, served at
// /styles/:slug and indexed at /styles. Every guide is original editorial
// copy written for Tattoo Art Customs: what the style is, how it is drawn,
// where it sits best, how big it needs to be, how it ages, and how to choose
// a design in it. The short `notes` fields are reused on design pages so a
// design's own page carries tattooing guidance for its style, not just a
// price and a button.
//
// Style slugs are the values stored on designs.style. Keep GUIDES keys in
// sync with the catalog's real style values.

const GUIDES = {
  'traditional-old-school': {
    name: 'American Traditional (Old School)',
    summary:
      'The original American tattoo style: bold black outlines, a tight palette of red, green, yellow and brown, and imagery — eagles, anchors, swallows, daggers, roses — built to stay readable for a lifetime.',
    intro: [
      'American traditional, often called old school, is the style that built modern tattooing. It took shape in the early 1900s among sailors, soldiers and circus performers, and its look was dictated by the tools and inks of the time: thick black outlines, flat fields of color, and a short list of pigments that actually stayed in skin. The classic subject matter comes straight from that world — eagles, anchors, swallows, tall ships, daggers, snakes, pin-up girls, roses and playing cards, each one a symbol its wearer carried for luck, loyalty, faith or survival.',
      'The rules of the style are famous because they work: "bold will hold." A traditional tattoo is drawn to survive decades of sun, skin stretch and cell turnover. The heavy outline acts like a fence that keeps color where it was put, and the simple, high-contrast shading stays legible when fine detail in other styles has long since blurred together.',
    ],
    character: [
      'A traditional design is built on a strong black outline — noticeably thicker than in most other styles — with flat color laid in behind it and simple whip shading for depth. The palette is deliberately limited: black, red, golden yellow, green and brown, with skin left open as the highlight. Subjects are stylized rather than realistic, drawn at a slight remove from life so the silhouette reads from across the room. Negative space matters: traditional pieces breathe, with open skin between elements instead of background fill packed edge to edge.',
    ],
    placement: [
      'Traditional work sits happily almost anywhere flat enough to hold a bold shape: upper arms, forearms, calves, shoulders, chest and thighs are the classic canvases. Because the imagery is emblem-like, pieces are usually placed as single strong statements with skin around them, or collected over years into a patchwork sleeve where each design keeps its own outline and breathing room. Curved, high-motion areas like elbows and knees take traditional well because the bold shapes tolerate distortion better than detail-heavy work.',
    ],
    sizing: [
      'Bold linework buys size flexibility, but traditional still has a floor: most single-subject pieces want at least three to four inches so the color fields stay open and the shading has room to breathe. Cluster too much into a small space and a traditional design loses the simplicity that makes it work. Palm-sized and larger is the sweet spot for single emblems; full traditional sleeves and back pieces scale the same vocabulary up without changing its rules.',
    ],
    aging: [
      'This is the best-aging style in tattooing, full stop. Expect the black to soften slightly and the lines to thicken a fraction over the years — traditional is drawn expecting exactly that, so a ten- or twenty-year-old piece still reads clearly. Colors, red especially, may fade with sun exposure; sunscreen and the occasional touch-up keep them punchy. If your first priority is a tattoo that looks right at sixty, this is the style to beat.',
    ],
    choosing: [
      'In our gallery, traditional designs are ready to tattoo as drawn: pick a subject that means something to you, check the size range feels right for your spot, and bring the linework file to your artist. Want a classic subject made personal — a name in the banner, your ship, your unit, your number on the dice? Order it as a custom variation and the banner space is set with your text before delivery.',
    ],
    notes: {
      placement:
        'Traditional designs sit best on flatter canvases — upper arm, forearm, calf, shoulder, thigh — placed as a strong single emblem with a little open skin around it.',
      sizing:
        'Give a traditional piece at least three to four inches. The bold fields of color need room to stay open; palm-sized and up is the sweet spot.',
      aging:
        'The best-aging style there is: heavy outlines hold the color in, and a traditional piece still reads clearly after decades. Sunscreen keeps the reds punchy.',
    },
  },

  'neo-traditional': {
    name: 'Neo-Traditional',
    summary:
      'Traditional tattooing grown up: the same bold bones, but with a wider palette, softer shading, decorative detail and subjects that range from foxes and owls to full illustrated scenes.',
    intro: [
      'Neo-traditional is what happened when artists raised on American traditional got better machines, better inks and art-school training — and decided to keep the discipline while breaking the palette rules. The skeleton is the same: strong outlines, readable silhouettes, designs built to last. On top of that skeleton, neo-traditional layers richer color, smoother gradients, decorative flourishes like filigree and dotwork halos, and a much wider cast of subjects.',
      'Where old school sticks to flat red-green-gold, neo-traditional roams: deep jewel tones, muted earth colors, pastels, skin-tone shading and fine secondary linework inside the main shapes. The result reads like a vintage illustration — a storybook or art-nouveau poster that happens to live on skin.',
    ],
    character: [
      'Neo-traditional designs combine two line weights: a bold outer contour that guarantees readability, and finer interior lines for fur, feathers, hair and ornament. Color shading is blended rather than flat, with darker tones pushed to the edges to keep the shape modeled. Subjects lean natural and decorative — animals, birds, flowers, insects, lady heads, daggers wrapped in botanicals — often framed by dots, rays, beads or ornamental borders that finish the piece like a picture frame.',
    ],
    placement: [
      'The style loves a mid-sized canvas with some flow: forearms, upper arms, thighs, calves, shoulders and the side of the ribs. Its decorative framing makes it excellent for shaped placements — a piece built to wrap a shoulder cap or climb a forearm. Neo-traditional also bridges gaps well in patchwork collections, since its ornaments can be drawn to echo neighboring pieces.',
    ],
    sizing: [
      'Neo-traditional needs more room than old school because it carries more information: the decorative detail and blended shading want four inches at an absolute minimum, and most pieces are happiest at five to eight inches. Shrink a detailed neo-traditional design too far and the fine interior lines are the first casualty as the tattoo settles. If you love a design but your spot is small, ask for a simplified custom version rather than a tiny print of the full drawing.',
    ],
    aging: [
      'A well-drawn neo-traditional tattoo ages nearly as gracefully as traditional, provided the bold outer structure was respected — that contour is doing the long-term work. The finer interior lines and lightest pastel tones soften first; jewel tones and earth colors hold up well. Artists who know the style leave "sacrifice zones" — areas of open skin inside the design — so future softening has somewhere to go. A touch-up at the ten-year mark usually restores the decorative detail.',
    ],
    choosing: [
      'Browse this style when you want a piece with storybook richness that still behaves like a tattoo. Our neo-traditional designs ship with full color and linework, and because the style takes personalization so well — a pet\'s portrait in an ornamental frame, your flowers around a classic dagger — it is one of the most-ordered styles at the custom desk.',
    ],
    notes: {
      placement:
        'Neo-traditional shines on forearms, upper arms, thighs and shoulders — anywhere its ornamental framing has room to wrap and flow with the limb.',
      sizing:
        'This style carries a lot of detail: plan on four inches minimum, five to eight ideally, so the fine interior lines survive healing and time.',
      aging:
        'The bold outer contour keeps neo-traditional readable for decades; the lightest pastels and finest lines soften first and respond well to a touch-up.',
    },
  },

  'black-grey': {
    name: 'Black & Grey Realism',
    summary:
      'Photographic shading built from black ink and water: portraits, statues, animals and scenes rendered in smooth grey gradients with no linework doing the heavy lifting.',
    intro: [
      'Black and grey tattooing began with the single-needle work of 1970s Los Angeles — artists using one needle and diluted black ink to build the soft, smoky shading of a pencil drawing. Realism grew from that root: with finer needle groupings and greywash mixed to exact tones, artists learned to render photographs on skin — faces, hands, fabric, fur, chrome — using nothing but black ink at different dilutions.',
      'It remains one of the most technically demanding styles in tattooing. There are no outlines to hide behind: form comes entirely from value, the smooth graduation from deep black to bare skin. Portraits, religious imagery, memorial pieces, wildlife and classical statues are its home ground.',
    ],
    character: [
      'A black and grey realism design is a study in contrast. The deepest blacks anchor the piece; mid-tones are built in layered washes; highlights are usually not ink at all but your own skin left open, sometimes with a small amount of white ink for the final sparkle. Edges are mostly soft — a cheek, a cloud, a fold of cloth — with hard edges reserved for eyes, teeth, metal and the focal points where the artist wants your attention.',
    ],
    placement: [
      'Realism wants the flattest, calmest canvas you can give it: upper arms, forearms, thighs, calves, chest and the back. Curved or bony areas distort photographs, and high-motion skin (hands, feet, neck, elbows) fades soft shading fastest. Sun exposure is realism\'s enemy, so placements you can cover — or commit to sunscreening — keep the subtle tones alive longest. Portraits in particular belong somewhere the skin moves little, so the face stays itself.',
    ],
    sizing: [
      'Size is realism\'s non-negotiable. Photographic detail compressed too small does not stay photographic: the mid-tones merge, the face goes muddy, and within a few years the piece reads as a grey smudge. Portraits should rarely go under five to six inches tall; detailed scenes want six inches and up, and the best realism pieces are large — half sleeves, full backs, thigh panels. If the design you love will not fit your spot at a healthy size, the right move is a bigger placement or a simpler design, never a smaller print.',
    ],
    aging: [
      'Honest expectations matter here. Black and grey realism softens as it ages — that is the physics of fine pigment spread — and the lightest washes fade first. Well-built pieces plan for it: strong black structure underneath, contrast kept bold, highlights left as skin. A realism tattoo at ten years should look like a slightly softer photograph, not a different picture. Sunscreen is not optional for this style; UV eats grey tones faster than any other work, and a touch-up session every several years keeps the range full.',
    ],
    choosing: [
      'Our black and grey designs are drawn with their contrast structure planned for skin, and the linework file gives your artist the map while the color file shows the intended values. For portraits — a face you love, a pet, a memorial — custom orders are the way: send the clearest reference photos you have, because in realism the drawing can only be as good as the photograph it stands on.',
    ],
    notes: {
      placement:
        'Give realism flat, calm skin — upper arm, forearm, thigh, calf, chest or back — and a spot you can keep out of heavy sun. Faces distort on curved, mobile skin.',
      sizing:
        'Realism needs size: portraits at five to six inches minimum, scenes larger. Small realism blurs into grey within a few years — go bigger or simplify.',
      aging:
        'Expect gentle softening: the lightest grey washes fade first. Strong black structure and daily sunscreen keep a realism piece reading true for years.',
    },
  },

  'realism': {
    name: 'Color Realism',
    summary:
      'Full-color photographic tattooing: animals, eyes, flowers, food, film scenes and portraits rendered with blended color, soft edges and skin-tone highlights.',
    intro: [
      'Color realism applies the black and grey school of photographic shading to a full palette. Instead of outlines and flat fills, the image is built the way a photograph is: layered color, smooth transitions, reflected light, and highlights left as skin or laid in at the very end. Done well, a color realism piece looks less like a drawing of a tiger and more like the tiger, caught mid-breath.',
      'It is the youngest of the major styles — it had to wait for inks stable and varied enough to blend like paint — and it is still evolving fast. Wildlife, big cats, birds, ocean life, flowers, eyes, and scenes from film and games are where it shines brightest.',
    ],
    character: [
      'A color realism design has almost no visible linework. Form comes from color temperature as much as value: warm light against cool shadow, saturated focal points against muted backgrounds. Backgrounds are often soft, dark or smoky, which throws the subject forward and gives the piece its photographic depth. Because there is no outline fence, the drawing depends on strong value contrast underneath the color — a good realism design still reads in a black-and-white photo.',
    ],
    placement: [
      'Like its black and grey sibling, color realism wants flat, low-motion skin: upper arms, thighs, calves, chest and back. It is an especially poor candidate for hands, feet and necks, where fast cell turnover blurs the blends. Think about light, too: a placement you habitually cover at work but bare at the beach needs a sunscreen habit, because ultraviolet light attacks colored pigment unevenly and shifts the balance of the whole image.',
    ],
    sizing: [
      'Color realism needs room for its transitions: under four inches, gradients have nowhere to graduate. Most subjects want five inches and up; fur, feathers and scales — the textures this style is loved for — need size to register as texture rather than noise. Large-format pieces (sleeve panels, thigh pieces, back work) are where color realism earns its reputation, and artists will often recommend scaling a design up rather than simplifying it down.',
    ],
    aging: [
      'Color realism is higher-maintenance than outline-based styles, and any honest guide should say so. Without a black fence, colors settle and soften; light yellows, pinks and oranges fade fastest, and the image gradually loses the contrast it was built on. The defenses are a design with a strong dark value structure, a placement out of chronic sun, sunscreen, and periodic touch-ups to re-saturate the lights. Chosen with open eyes and cared for, it stays stunning — it just asks more of its owner than traditional work does.',
    ],
    choosing: [
      'In the gallery, judge color realism designs by their value structure first and their prettiness second: squint, and the subject should still read. Our realism pieces ship with the full-color art your artist matches against, plus linework for the stencil. For a portrait of a specific animal or person, order custom with your best photographs — realism is only ever as faithful as its reference.',
    ],
    notes: {
      placement:
        'Color realism belongs on flat, low-motion skin — upper arm, thigh, calf, chest, back — and out of chronic sun, which shifts colored pigment unevenly.',
      sizing:
        'Gradients need room: five inches and up for most subjects, more for fur, feather and scale textures to read as texture instead of noise.',
      aging:
        'The highest-maintenance major style: light colors fade first and blends soften. Strong dark structure underneath, sunscreen, and touch-ups keep it vivid.',
    },
  },

  'japanese-irezumi': {
    name: 'Japanese (Irezumi)',
    summary:
      'Centuries-old Japanese tattooing: dragons, koi, tigers, peonies and waves composed as full-body storytelling, with wind bars, clouds and water binding every element together.',
    intro: [
      'Irezumi is the traditional tattooing of Japan, with roots in the woodblock-print world of the Edo period. Its imagery is a complete visual language: dragons for wisdom and strength, koi for perseverance, tigers for courage, peonies for prosperity, cherry blossoms for the brevity of life, waves and wind for the forces nobody controls. In classical irezumi these are not decorations on a body — they are a single composed suit of imagery, planned across the back, sleeves and legs as one artwork.',
      'Even when a modern wearer takes a single piece — one dragon, one koi sleeve — the design grammar stays Japanese: bold black outlining, rich but disciplined color, and background elements (waves, clouds, wind bars, maple leaves, blossoms) that carry the subject and bind separate pieces into a whole.',
    ],
    character: [
      'An irezumi design flows. Subjects are drawn in motion — the dragon coils, the koi climbs the waterfall, the tiger descends through bamboo — and the background is as important as the figure: black wind bars (mikiri) frame the edges, grey-wash waves and clouds fill the field, and seasonal flowers set the scene. Color is symbolic and saturated: red peonies, orange koi, green dragons, pink blossom. Nothing floats in empty skin; the background is what makes Japanese work instantly recognizable across a room.',
    ],
    placement: [
      'Placement is composition in this style. Backs are the classic canvas — a full back piece (kame-no-koh) is irezumi\'s masterpiece format — followed by sleeves that run shoulder to wrist with the background continuous, chest panels (hikae) that frame the front, and leg suits. Single motifs work smaller — a koi on a forearm, a dragon head on a shoulder — but they are usually drawn as the seed of a larger suit, with background that can extend when you are ready.',
    ],
    sizing: [
      'Japanese work thinks big. A sleeve or back gives the background room to move and the subjects room to be drawn at the scale their detail deserves — scales, whiskers, claws, petals. Small irezumi exists (a single blossom, a small mask), but the style\'s power is in the large composition, and cramming a dragon into four inches produces a knot, not a dragon. If you are starting a suit, plan the whole map early: your artist designs the first piece so its background can grow into the next.',
    ],
    aging: [
      'Irezumi ages with dignity — it was engineered over centuries for exactly that. The bold black work holds the composition, the saturated colors are packed solid, and the grey background settles into a soft smokiness that suits the style. Pieces may need color refreshing after a decade or more, especially reds and oranges, but a Japanese suit at twenty years still announces itself. It is one of the safest choices for large, lifelong work.',
    ],
    choosing: [
      'Choose Japanese designs by subject and season: the flowers in the background should match the story (cherry blossom with spring subjects, maple with autumn). Our irezumi pieces come with full color and linework, and the custom desk draws a lot of them — tell us the subject pairing you want and whether you are starting a sleeve or back, and the background will be composed to extend later.',
    ],
    notes: {
      placement:
        'Irezumi is composed, not placed: backs, sleeves, chest panels and legs, with the background flowing across the whole area. Plan the full map before the first piece.',
      sizing:
        'This style thinks big — dragons and koi need scale for scales, whiskers and claws to read. Small single motifs work; full compositions want sleeves and backs.',
      aging:
        'Engineered over centuries to last: bold black structure and solid-packed color mean a Japanese piece still announces itself after twenty years.',
    },
  },
};

GUIDES['blackwork'] = {
  name: 'Blackwork',
  summary:
    'Black ink only, used at full strength: bold graphic shapes, heavy saturation, ornamental pattern and dark illustrative work with no grey wash and no color.',
  intro: [
    'Blackwork is an umbrella for everything done in pure black ink at full saturation — no greywash gradients, no color. Under it live tribal and neo-tribal, ornamental and decorative pattern work, dark illustrative and engraving-style pieces, bold graphic and abstract designs, and the heavy blackout work used to cover old tattoos or make a statement of pure shape.',
    'The style\'s roots run from the indigenous tattooing of Polynesia and Borneo through 1990s tribal to today\'s ornamental revival. What unites it is commitment: blackwork does not whisper. A blackwork piece is a silhouette first — it reads from across the street — and its detail lives in pattern, texture and the play between saturated black and open skin.',
  ],
  character: [
    'A blackwork design is built from solid black fields, confident linework, and texture made of dots, hatching or negative-space carving. Skin is the second ink: the shapes left untattooed inside a blackwork piece — a flower cut out of a black panel, a white line winding through a band — are drawn as deliberately as the black. Symmetry and repetition are common tools, especially in ornamental work that follows the body\'s own geometry: sternum pieces, back pieces, bands and sleeves built like architecture.',
  ],
  placement: [
    'Blackwork is the most placement-flexible style because it is shape-driven: it wraps limbs as bands and sleeves, mirrors itself across the sternum, spine and back, and fills awkward leftover spaces between other tattoos better than any other style. It is also the go-to for cover-ups, since solid black is the only thing that reliably buries an old tattoo. Mind the body\'s symmetry lines — ornamental blackwork looks its best centered and mirrored with intention.',
  ],
  sizing: [
    'Blackwork scales in both directions unusually well. A small, simple black symbol holds forever; a full blackwork sleeve is a major project of many sessions. The sizing rule is about pattern density: fine dot texture and thin negative-space lines need room, because tattooed black spreads slightly over the years and a one-millimeter white gap can close. If a design has fine reverse detail, your artist may scale it up or simplify the pattern — that advice is the style\'s physics, not upselling.',
  ],
  aging: [
    'Solid black is the most permanent thing in tattooing. Blackwork ages by softening at the edges: crisp borders relax a little, and very fine negative-space details can narrow as pigment settles. Bold shapes are effectively forever. Heavy black does absorb more sun heat and can look grey-blue in harsh light on some skin tones; moisturizer and sunscreen keep it deep. Of all styles, blackwork asks the least maintenance — which is part of its appeal.',
  ],
  choosing: [
    'Judge blackwork designs in silhouette: cover the detail and look at the shape. Our blackwork pieces ship as linework-forward files, since the drawing is the tattoo. For cover-ups, order custom and tell us what is underneath — size, darkness and placement of the old piece — because a cover-up design is engineered around the specific tattoo it has to bury.',
  ],
  notes: {
    placement:
      'Shape-driven and flexible: blackwork wraps limbs, mirrors across the sternum and spine, fills gaps between pieces, and is the reliable answer for cover-ups.',
    sizing:
      'Scales from a small bold symbol to a full sleeve. Fine dot texture and thin skin-colored gaps need extra room — black spreads slightly as it ages.',
    aging:
      'The lowest-maintenance style: solid black is forever. Edges soften a little and hairline negative-space detail can narrow over the years.',
  },
};

GUIDES['fine-line'] = {
  name: 'Fine Line',
  summary:
    'Delicate single-needle tattooing: hair-thin lines, tiny script, small botanicals and minimalist pieces with an airy, drawn-on-with-a-pen feel.',
  intro: [
    'Fine line tattooing uses single needles or very small groupings to lay down lines a fraction of the width of traditional work. It grew out of the single-needle black and grey tradition and bloomed with the minimalist movement: small flowers, tiny symbols, delicate script, micro illustrations and soft, sketch-like pieces that sit lightly on the skin.',
    'It is the style of understatement — a tattoo meant to be discovered at conversation distance rather than announced across the room. That subtlety is exactly its appeal, and it comes with honest trade-offs every buyer should understand before choosing it.',
  ],
  character: [
    'A fine line design is mostly air: thin black or grey lines, minimal or no shading, lots of open skin inside the piece. Where shading exists it is usually stippled dots or the faintest wash. Script in this style mimics handwriting or typewriter type at small sizes. The drawing must be economical — every line earns its place, because at this weight there is no fill to hide behind and no bold contour to carry a weak composition.',
  ],
  placement: [
    'Fine line favors protected, low-friction placements: inner forearm, wrist, ankle, collarbone, behind the ear, ribs, spine and the inner arm. It struggles where skin renews fast or rubs constantly — fingers, palms, feet and the sides of hands fade quickly and blur, and most honest artists will warn you or refuse those spots for fine work. Delicate skin that rarely sees sun keeps hairlines crisp longest.',
  ],
  sizing: [
    'Here is the fine line paradox: the style looks small, but too small is its enemy. Letters under about a quarter-inch tall close up as lines thicken with age; tiny details merge. Well-planned fine line pieces are small but not microscopic — most sit between one and four inches with breathing room between elements. If you want a lot of detail in a tiny footprint, the design has to be simplified for skin: fewer lines, more space. A good fine line artist will redraw, not just shrink.',
  ],
  aging: [
    'Let us be straight, because this style collects the most disappointed expectations online: fine lines soften and spread more noticeably than bold work, and the lightest lines can fade unevenly over five to ten years. That does not make fine line a bad choice — it makes it a choice with a maintenance plan. Pieces are designed expecting a touch-up, and owners who accept that keep them delicate for decades. If the idea of any future touch-up bothers you, choose a style with heavier linework instead.',
  ],
  choosing: [
    'Our fine line designs are drawn at honest sizes — the product notes and your artist can tell you the smallest safe scale for each piece. When ordering fine line as a custom, say the exact placement early: a design for a wrist and a design for a ribcage are drawn differently. And spell any script letter by letter in the brief; at this size, a typo is forever and very legible.',
  ],
  notes: {
    placement:
      'Fine line loves protected skin — inner forearm, wrist, ankle, collarbone, ribs. Fingers, palms and feet renew too fast and blur delicate lines.',
    sizing:
      'Small but not microscopic: one to four inches, with space between elements. Tiny letters and crowded detail close up as lines settle with age.',
    aging:
      'The most delicate style as it ages: hairlines soften and can fade unevenly over five to ten years. Beautiful — with a touch-up in its future.',
  },
};

GUIDES['watercolor'] = {
  name: 'Watercolor',
  summary:
    'Painterly tattooing that mimics wet pigment: splashes, drips, bleeds and translucent color washes, usually anchored by a black linework subject at the center.',
  intro: [
    'Watercolor tattooing borrows its moves from the paintbox: translucent washes of color, splatters and drips, edges that bloom where pigment met water. It rose in the 2010s as inks and techniques caught up with painters\' ambitions, and it remains the most "art studio" of the tattoo styles — pieces look like they were painted on the skin in one sitting, in a good way.',
    'The classic watercolor composition pairs freedom with an anchor: a subject drawn in solid linework — a bird, a flower, a fox, an anchor — with color splashing loosely behind and beyond it, escaping the lines on purpose. Fully abstract watercolor pieces exist too, all splash and gradient with no subject at all.',
  ],
  character: [
    'A watercolor design layers transparent-feeling color: light washes at the edges, saturated cores, deliberate drips running down, speckle and splatter at the borders. Crucially, the best watercolor tattoos are not actually structureless — under the splashes there is usually a sound drawing, and many artists quietly include soft black or dark tones at the core to give the color something to hold onto as years pass. What looks effortless is choreographed.',
  ],
  placement: [
    'Watercolor reads best on medium, relatively flat areas where the splash can spread: forearms, shoulders, upper arms, calves, thighs and the upper back. The loose edges forgive slight curvature better than geometric styles do. Because the style leans on light tones, placements with heavy sun exposure are its weak point — a watercolor piece on a beach-lifeguard forearm will need more defending than one on a ribcage.',
  ],
  sizing: [
    'Splashes need spread: most watercolor pieces want four inches and up so the washes can graduate from saturated to whisper-light instead of ending abruptly. The anchor subject can be modest — two to three inches — but the color field around it is part of the piece and part of its footprint. Very small watercolor tends to collapse into a colored smudge once healed; if your heart is set on small, keep the palette tight and the subject bold.',
  ],
  aging: [
    'Watercolor is the style where honesty matters most. Light, translucent tones are the first thing any tattoo loses, and a piece built only from pastel washes will fade toward invisibility faster than outline-based work. Well-built watercolor — with a linework anchor, some genuinely dark values, and saturated cores — ages into a softer version of itself and refreshes beautifully with a touch-up. Sunscreen is not a suggestion for this style; it is the difference between a five-year tattoo and a twenty-year one.',
  ],
  choosing: [
    'When browsing watercolor designs, look for the anchor: pieces whose subject is drawn solidly will outlast pure-splash pieces every time. Our watercolor designs note their core subject and splash colors, and the custom desk can rebuild a favorite gallery piece with a stronger anchor if you love the splash but want the longevity — just say so in the brief.',
  ],
  notes: {
    placement:
      'Watercolor wants a medium, flattish canvas — forearm, shoulder, calf, thigh, upper back — where the splash can spread, ideally out of heavy daily sun.',
    sizing:
      'Plan four inches and up so washes can fade out gradually. A solid anchor subject of two to three inches carries the piece as the color softens.',
    aging:
      'Light washes fade first — watercolor lives or dies on its anchor. Dark values and a linework core underneath keep it readable; sunscreen is essential.',
  },
};

GUIDES['geometric'] = {
  name: 'Geometric & Sacred Geometry',
  summary:
    'Precision-built tattooing: mandalas, sacred geometry, symmetry, pattern and line systems drawn on grids so the math survives the move to curved skin.',
  intro: [
    'Geometric tattooing builds images from pure structure: circles, triangles, hexagons, repeating patterns, and the interlocking diagrams known as sacred geometry — the Flower of Life, Metatron\'s cube, Sri Yantra and their kin. Alongside it sits the mandala tradition, radial designs radiating from a center point, borrowed from Hindu and Buddhist art and adapted into one of tattooing\'s most popular forms.',
    'The style appeals to people who like their tattoos to feel inevitable — every line where mathematics says it should be. Getting there is the hard part: the design must be drawn on a true grid, because skin stretches, curves and moves, and geometric work shows every millimeter of error that an organic design would forgive.',
  ],
  character: [
    'A geometric design is engineered: perfect circles, straight rules, mirrored halves, pattern repeats that tile without a seam. Line weights are usually uniform and crisp, with dotwork shading used to soften transitions without breaking the geometry. Subjects from nature — animals, flowers, faces — are often rebuilt from facets and symmetry, half geometric diagram, half living thing. The drawing is only half the art; the stencil transfer, done with the body in a natural stance, is the other half.',
  ],
  placement: [
    'Symmetry is the placement question. Centered pieces belong on the body\'s center lines — sternum, spine, chest, forehead of the back — where the design\'s mirror axis matches the body\'s. Radial mandalas sit beautifully on shoulders, elbows, knees and the center of the back. Long geometric bands wrap forearms and calves. Avoid placing strict geometry over areas that twist hard (the waist, the wrist\'s working side) unless the design is built to move with them.',
  ],
  sizing: [
    'Geometry scales by pattern density. A simple bold emblem — a triangle, an eye, a small mandala — works at two inches. Dense sacred-geometry pieces with fine internal patterns need four to six inches minimum, or the interior structure crowds into texture as lines settle with age. Large-scale geometry (full back mandalas, chest pieces) is where the style is most spectacular, and those pieces are planned as single compositions, not enlarged small ones.',
  ],
  aging: [
    'Crisp lines soften slightly in every tattoo, and in geometric work softening shows as a loss of machined perfection rather than readability — the piece still reads, it just becomes hand-made around the edges. Bold-line geometry ages best; pieces built from hairline patterns blur toward each other fastest. A good geometric artist builds in margin: line spacing chosen with a decade in mind, not just the fresh photo.',
  ],
  choosing: [
    'Our geometric designs are drawn on grids, and the linework files carry the symmetry exactly — your artist\'s job is the careful transfer, so pick someone who tattoos straight lines happily. Custom geometric orders should state the placement up front: a sternum mandala and a forearm mandala are engineered differently, and telling us the canvas lets us draw for it.',
  ],
  notes: {
    placement:
      'Match the design\'s symmetry to the body\'s: centered pieces on sternum, spine and chest; radial mandalas on shoulders, elbows and mid-back.',
    sizing:
      'Simple emblems work at two inches; dense sacred-geometry patterns need four to six so interior lines don\'t crowd together as they settle.',
    aging:
      'Geometric work stays readable but loses machined crispness at the edges over time. Bold lines and generous line spacing age the most gracefully.',
  },
};

GUIDES['dotwork'] = {
  name: 'Dotwork',
  summary:
    'Images built entirely from dots: shading, gradients and whole pictures stippled point by point, from soft grey fog to dense black pattern.',
  intro: [
    'Dotwork — also called stippling — builds tone the way old engravings and pointillist paintings do: dot by dot. Where dots pack tight, the tattoo is dark; where they scatter, it fades to skin. With nothing but dots, artists render soft photographic gradients, geometric patterns, ornamental texture and whole illustrative scenes with a distinctive grainy, hand-made surface no machine-blended shading can copy.',
    'Dotwork has deep roots in geometric and ornamental tattooing — sacred geometry and mandalas stippled into being — and in the last decade it has become a full illustrative style of its own, used for animals, landscapes, skulls, space scenes and anything else that benefits from its soft, atmospheric shading.',
  ],
  character: [
    'A dotwork design has a texture you can feel with your eyes: gradients are grain, shadows are weather. Artists vary dot size, spacing and density to sculpt form, often combining stippled fields with solid linework or blackwork shapes for contrast. Because each dot is placed individually, dotwork is slow, deliberate tattooing — a stippled sleeve is a serious investment of chair time, which wearers tend to regard as part of the piece\'s meaning.',
  ],
  placement: [
    'Dotwork is forgiving about placement because its soft gradients hide minor distortion that would wreck hard geometry. Forearms, upper arms, calves, thighs, shoulders and backs all take it well, and stippled texture fills background space in larger compositions beautifully. One caution: dotwork over very mobile skin (hands, feet) can blur its fine grain faster than elsewhere.',
  ],
  sizing: [
    'Dots need density room. A gradient squeezed too small becomes a grey patch — the dots merge and the texture that makes the style special disappears. Most dotwork pieces start around three inches; detailed stippled scenes want five and up. The rule of thumb your artist will give you: if the design\'s finest dots would land closer together than a pinhead apart at your chosen size, scale up or accept a bolder, simpler stipple.',
  ],
  aging: [
    'Dotwork ages gently. Individual dots spread a fraction as skin ages — which, in a field of dots, reads as the gradient softening rather than detail being lost. That is why stipple is chosen for shading that must stay smooth for decades. Very fine, sparse dot fields can lighten unevenly and may want a refresh; dense fields are close to permanent. Overall, dotwork sits near the top of the longevity table.',
  ],
  choosing: [
    'Our dotwork designs are drawn dot-density first — the file shows exactly how the gradient is built, so your artist can follow the same construction on skin. If you are planning a large stippled piece, the custom desk can design it in sections sized to your sessions; mention the placement and total area in the brief so the density is drawn for the real canvas.',
  ],
  notes: {
    placement:
      'Soft stippled gradients forgive curvature — arms, calves, thighs, shoulders and backs all work. Hands and feet blur the fine grain fastest.',
    sizing:
      'Gradients need room to stay grainy instead of merging into grey: three inches minimum for simple work, five and up for detailed stippled scenes.',
    aging:
      'One of the gentlest-aging styles: dots soften into the gradient rather than losing detail. Sparse fine fields may want a refresh after some years.',
  },
};

// 'stipple' is the same technique as dotwork (the catalog carries both
// style values); its guide URL redirects to the dotwork guide rather than
// duplicating the page.
const GUIDE_REDIRECTS = {
  stipple: 'dotwork',
  // Style-vocabulary aliases (AdSense pass 2026-11-07): the catalog stores
  // designs under more style names than it has guides — the nightly design
  // pipeline alone uses 40+. Mapping each stored variant onto the guide
  // that genuinely covers it means every design page can carry its style's
  // tattooing notes instead of none. Only true synonyms / parent styles
  // are mapped here — never a stretch.
  traditional: 'traditional-old-school',
  'old-school': 'traditional-old-school',
  polynesian: 'tribal',
  japanese: 'japanese-irezumi',
  'neo-japanese': 'japanese-irezumi',
  neojap: 'japanese-irezumi',
  'color-realism': 'realism',
  'black-and-grey': 'black-grey',
  'black-and-grey-realism': 'black-grey',
  'black-grey-realism': 'black-grey',
  'ignorant-style': 'minimalist',
  sketch: 'fine-line',
  pixelated: 'new-school',
  'pixel-art': 'new-school',
  anime: 'new-school',
  'dark-anime': 'new-school',
  graffiti: 'new-school',
  ornamental: 'mandala',
  'carved-wood': 'blackwork',
  carvedwood: 'blackwork',
  'stained-glass': 'geometric',
  'stained-shard': 'geometric',
  'x-ray-dissection': 'blackwork',
  blueprint: 'geometric',
  'circuit-bloom': 'geometric',
  circuitbloom: 'geometric',
  topographic: 'geometric',
  mosaic: 'geometric',
  origami: 'geometric',
  'cross-stitch': 'dotwork',
  'smoke-form': 'black-grey',
  surrealism: 'realism',
  'ascii-art': 'new-school',
  bioluminescent: 'watercolor',
  // Orphan-batch / pipeline spelling variants (AdSense DO-NOW pass
  // 2026-11-07): the restored-catalog ingest stored style tokens in
  // forms the guide index never knew — squashed compounds, abbreviations
  // and cut-line family names. Each maps to the guide that genuinely
  // covers the same drawing approach, so those design pages carry real
  // tattooing notes instead of none.
  fineline: 'fine-line',
  celticnorse: 'tribal',
  'celtic-norse': 'tribal',
  celtic: 'tribal',
  carvedstone: 'blackwork',
  xray: 'blackwork',
  etching: 'blackwork',
  cybersigilism: 'fine-line',
  'stick-poke': 'dotwork',
  'frost-fractal': 'geometric',
  'dark-surrealism': 'realism',
  biomech: 'black-grey',
  biomechanical: 'black-grey',
  psychedelic: 'new-school',
  'funny-ironic': 'new-school',
  illustrative: 'realism',
};

GUIDES['tribal'] = {
  name: 'Tribal',
  summary:
    'Bold black flowing shapes rooted in indigenous tattoo traditions — Polynesian, Māori, Samoan, Bornean and Haida — and the sharp, sweeping tribal style that swept the 1990s.',
  intro: [
    'Tribal is the oldest tattoo language on earth. The word covers the indigenous traditions of Polynesia, Samoa (where tatau gave tattooing its name), the Māori tā moko, Borneo and the Haida, among others — systems in which pattern carries genealogy, rank, protection and identity. In the 1990s a distilled version — bold black interlocking blades and flames flowing over shoulders and arms — became the decade\'s defining tattoo and introduced a generation to tattooing.',
    'Both meanings live under this name today, and a good guide should be honest about the difference: traditional Polynesian and Māori work is a cultural language with rules and meanings that belong to those cultures, while the 90s abstract tribal is a decorative style of pure form. Many wearers choose the second; those drawn to the first do best working with artists from or deeply trained in those traditions.',
  ],
  character: [
    'Tribal design is pure black shape: tapered blades, crescents, spirals (koru), waves and woven bands, drawn so the negative-space skin between shapes is as sharp as the black itself. Traditional systems build with repeated motifs in bands that follow the body\'s musculature; abstract tribal flows in sweeping, symmetrical compositions that wrap a shoulder or climb a back. There is no shading and no color — form is everything.',
  ],
  placement: [
    'Tribal is body architecture: it is drawn to flow with muscle groups, which is why shoulders, upper arms, chests, backs and calves are its classic ground. Bands wrap arms and legs; large pieces follow the lats, traps and shoulder blades. Placement and design are one decision in tribal — the same motif straightened on a forearm and curved over a deltoid are two different tattoos, and the drawing should be made for the body it will live on.',
  ],
  sizing: [
    'Tribal reads at any size but lives large: its sweeping shapes want room to move, and most pieces start at four inches and go up to full backs and torsos. Small tribal exists — a band, a single spiral — but the tight interior negative space in dense patterns needs scale, because black spreads slightly with age and skin-thin gaps between blades can close over the years.',
  ],
  aging: [
    'Solid black shapes are essentially permanent; tribal is among the longest-lived work you can wear. Aging shows at the fine points and narrow skin-gaps, which soften first. Bold, well-spaced tribal looks nearly unchanged at twenty years. If a design\'s beauty depends on hairline gaps, scale it up — that single choice decides how it reads in old age.',
  ],
  choosing: [
    'Our tribal gallery includes both abstract flowing work and pattern-based designs; each listing notes its family so you know what you are looking at. For body-flow pieces, custom is the professional route: tell us the exact body part and whether the piece should mirror or wrap, and the design is drawn to that anatomy rather than stretched to fit it later.',
  ],
  notes: {
    placement:
      'Tribal is drawn for anatomy — shoulders, upper arms, chest, back and calves — flowing with the muscle. The design and the body part are one decision.',
    sizing:
      'Lives large: sweeping shapes want four inches and up, and dense patterns need scale so the skin-gaps between black shapes stay open as ink settles.',
    aging:
      'Among the most permanent work there is. Fine points and hairline gaps soften first; bold, well-spaced tribal barely changes in twenty years.',
  },
};

GUIDES['new-school'] = {
  name: 'New School',
  summary:
    'Tattooing turned cartoon: exaggerated proportions, graffiti energy, candy color and characters that burst off the skin with thick outlines and wild perspective.',
  intro: [
    'New school exploded out of the 1990s when tattooers raised on cartoons, graffiti, comic books and video games started treating skin like an animation cel. Where traditional tattooing simplifies, new school exaggerates: characters lean, stretch and burst toward the viewer, proportions warp for effect, and the color palette goes full candy store — hot pink, lime, electric blue, purple — laid in smooth, airbrushed gradients.',
    'It is the most playful major style and the one most at home with pop culture: game characters, cartoon mashups, food with faces, animals in costumes, anything that benefits from being louder and rounder than life.',
  ],
  character: [
    'A new school design is built like a cartoon frame: a heavy, varied outline (thick on the silhouette, thinner inside), exaggerated perspective, highlights and drop shadows that pop the subject off the skin, and backgrounds of stars, bubbles, drips and rays. Color does the heavy lifting — complementary brights pushed against each other, blended smoothly, with white highlights for shine. Nothing in new school is subtle, and that is the brief.',
  ],
  placement: [
    'New school wants a stage: forearms, upper arms, calves, thighs and shoulders, where a character can be composed mid-action with its background energy around it. The style\'s chunky shapes tolerate moderate curvature well. Because pieces are usually self-contained scenes, they also work as statement singles in a collection of otherwise different styles — new school is cheerful about neighbors.',
  ],
  sizing: [
    'Exaggeration needs elbow room: under three inches, a new school character loses the perspective and detail that sell the joke. Four to seven inches is the classic range, big enough for facial expression, costume detail and the background bursts. Large new school — full sleeves of mashed-up characters — is a thriving format, usually built character by character with the background unifying them at the end.',
  ],
  aging: [
    'The bold outlines give new school a longer life than its candy colors suggest. The brights are what fade — hot pinks, light blues and lime greens soften fastest, especially in sun — while the black structure keeps the character readable. Many owners treat a color refresh at eight to twelve years as part of the deal, and the style refreshes exceptionally well because its shapes stay put. Sunscreen meaningfully delays the fade.',
  ],
  choosing: [
    'New school is the custom desk\'s playground: original characters, pets as superheroes, your favorite snack with an attitude. In the gallery, judge pieces by silhouette and expression first — if it reads at arm\'s length and makes you grin, it is doing its job. Tell us the character and the gag in the brief, and we will build the burst around it.',
  ],
  notes: {
    placement:
      'Give new school a stage — forearm, upper arm, calf, thigh, shoulder — where the character and its background burst have room to perform.',
    sizing:
      'Four to seven inches is the classic range: smaller and the exaggerated perspective, expressions and costume detail get lost.',
    aging:
      'Outlines hold for the long haul; the candy brights fade first and refresh beautifully. Sunscreen delays the fade by years.',
  },
};

GUIDES['minimalist'] = {
  name: 'Minimalist',
  summary:
    'The least ink that can carry the meaning: tiny symbols, single-line drawings, small icons and quiet marks chosen for personal significance over spectacle.',
  intro: [
    'Minimalist tattooing strips a design to its essential gesture: one continuous line for a face, three strokes for a mountain range, a dot-and-line constellation, a word of two letters. It overlaps fine line technique but is defined by concept rather than needle — the question a minimalist design answers is "how little can this be, and still be it?"',
    'People choose minimalist tattoos for private meanings: a date, a place\'s coordinates, a pet reduced to an ear outline, a symbol only they can decode. It is also the gentlest entry into tattooing — small, quick, discreet at work — which is why it is so many people\'s first piece.',
  ],
  character: [
    'A minimalist design is mostly decision: what to leave out. Lines are usually a single consistent weight, color is rare (and when present, a single flat accent), and composition is stark — the symbol, the skin, nothing else. Because there is no shading or fill to carry the piece, the drawing\'s proportions do all the work; a minimalist design lives or dies on whether its few lines are exactly right.',
  ],
  placement: [
    'Anywhere discreet is minimalist\'s home turf: wrist, ankle, collarbone, behind the ear, inner arm, ribs, hip, finger (with the usual finger-fade warning). Small flat areas suit it best. Think ahead about visibility: minimalist pieces are often chosen to be hideable for work, and the inner forearm, ankle and ribcage all cover easily while still being showable on your terms.',
  ],
  sizing: [
    'Minimalist means conceptually minimal, not necessarily tiny — most pieces run half an inch to three inches. The floor is set by physics: lines placed too close merge as ink settles, and micro text closes up. If your symbol has interior detail (a tiny animal with facial features, a detailed icon), it needs a little more room than the pure idea suggests. Your artist scaling a minimalist piece up by half an inch is protecting it, not upselling it.',
  ],
  aging: [
    'Simple bold-enough lines age quietly and well; hairline-minimal pieces share fine line\'s future — softening over five to ten years and possibly a touch-up. The minimalist advantage is that a touch-up is a ten-minute job, and the design\'s simplicity means a refresh restores it completely. Choose line weight with the decade in mind and minimalist work is a low-maintenance pleasure.',
  ],
  choosing: [
    'Our minimalist gallery pieces state their minimum recommended size, and the linework is drawn at a weight that survives. For a personal symbol — coordinates, a tiny portrait outline, a coded mark — custom orders are quick and inexpensive to draw; describe the meaning in the brief and we will reduce it to its lines with you.',
  ],
  notes: {
    placement:
      'Discreet spots are home: wrist, ankle, collarbone, behind the ear, inner arm, ribs. Fingers fade fast — go in warned if that\'s the spot.',
    sizing:
      'Half an inch to three inches is typical, but interior detail sets the floor: lines too close together merge as the ink settles with age.',
    aging:
      'Simple lines age quietly; the finest minimalist work softens over five to ten years and refreshes completely in one short touch-up.',
  },
};

GUIDES['trash-polka'] = {
  name: 'Trash Polka',
  summary:
    'Controlled chaos from Würzburg: photorealistic black and grey smashed against bold red graphic elements, splashes, brush strokes and typography.',
  intro: [
    'Trash Polka was created by German artists Simone Pfaff and Volko Merschinsky in Würzburg, and it remains one of the few tattoo styles with named inventors and a manifesto: realism and trash — the photorealistic and the graphic, the ordered and the chaotic — composed into deliberate collision. Black and grey realistic imagery crashes into abstract red shapes, brush strokes, splatters, geometric fragments and bold typography.',
    'The palette is strict: black, grey and red. That discipline is what makes the chaos read as design instead of noise — every trash polka piece is a composed argument between control and explosion, usually across a very large canvas.',
  ],
  character: [
    'A trash polka design layers two languages. The realism layer — a face, a skull, an animal, architecture — is rendered in smooth black and grey. Over and through it runs the graphic layer: saturated red blocks and streaks, black brush strokes, splatter, halftone dots, and often words set in strong type. Elements overlap and interrupt each other on purpose; the composition is balanced like a collage poster, with the red placed to pull the eye along a planned path.',
  ],
  placement: [
    'Trash polka is a large-format style: full sleeves, backs, chest-to-leg compositions, whole limbs. Its compositions are planned as total fields, not single motifs, and they follow the body\'s long lines — a design might start at the shoulder and detonate down the arm. Small trash polka exists but loses the style\'s defining scale contrast; most wearers commit a whole region.',
  ],
  sizing: [
    'Think in regions, not inches: a forearm composition, a half sleeve, a back. The realism elements need the same size realism always needs (faces five inches and up), and the graphic elements need field around them to read as strokes rather than clutter. Trash polka is usually built across multiple sessions, sometimes designed in full first and sometimes grown piece by piece with the composition held in the artist\'s plan.',
  ],
  aging: [
    'The black and grey realism softens as realism does; the red is the variable — red pigment is famously individual, holding brilliantly on some skin and fading faster on others, and it is the element most likely to want refreshing. The graphic boldness of the style works in its favor: even softened, the composition reads, because the design was built on strong shapes rather than delicate detail.',
  ],
  choosing: [
    'Trash polka is specialist work — choose an artist who tattoos the style, not one willing to try it. Our trash polka designs are composed pieces with the realism and graphic layers balanced; for a full-region composition, order custom and name the region and the subject, and expect a design meant to be tattooed at scale, in sessions.',
  ],
  notes: {
    placement:
      'A large-format style: sleeves, backs and whole limbs, composed as a total field that follows the body\'s long lines. Small versions lose the point.',
    sizing:
      'Plan by region, not inches — and realism elements inside it still obey realism\'s rules: faces and focal subjects five inches and up.',
    aging:
      'The composition survives softening because it is built on bold shapes. Red is the variable element and the most likely to want a refresh.',
  },
};

GUIDES['mandala'] = {
  name: 'Mandala',
  summary:
    'Radial designs blooming from a center point — petals, dots, lace and geometry in perfect symmetry, from a two-inch accent to a full back.',
  intro: [
    'Mandala means "circle" in Sanskrit, and the mandala — a radial pattern organized around a center — is one of humanity\'s oldest sacred diagrams, used in Hindu and Buddhist practice as a map of the universe and a tool of meditation. As tattooing, mandalas keep that sense of ordered calm: concentric rings of petals, dots, teardrops and lace, mirrored perfectly around the center point.',
    'Modern mandala tattooing blends the sacred diagram with ornamental and dotwork technique, and ranges from small, simple centerpieces to enormous multi-session back and sternum compositions layered with flowers, jewels and geometric frames.',
  ],
  character: [
    'A mandala design is built in rings: a defined center (a dot, a flower, a gem), then successive bands of pattern — petals, stippled gradients, line lace, scallops — each ring echoing or contrasting the last. Symmetry is total: the design is drawn once as a wedge and mirrored around the circle. Line weights are usually fine to medium, with dotwork shading giving the rings their soft depth; some mandalas incorporate a lotus, an unalome, or an animal or moon at the center.',
  ],
  placement: [
    'Mandalas belong on the body\'s natural centers and round surfaces: the sternum (the classic under-breast placement), center of the upper back, shoulders, elbows, knees, the solar plexus, and the thigh. Placement precision matters — a mandala two centimeters off the sternum\'s center reads as a mistake, so the stencil is set with the body standing naturally and checked in a mirror before a single line is tattooed.',
  ],
  sizing: [
    'A simple mandala reads at two inches; a layered, detailed one needs four to six to keep its rings distinct, and full back or sternum compositions run far larger. The constraint is ring spacing: as ink settles over the years, tightly packed rings crowd, so detailed mandalas must be sized so each band keeps its air. When in doubt, bigger and airier beats smaller and denser, every time.',
  ],
  aging: [
    'Mandalas age like the geometric family they belong to: they stay readable and keep their calm, with the finest dotwork rings softening first. Well-spaced rings age gracefully; over-dense ones blur toward a single texture — still pretty, less diagram. Bold-centered mandalas with graduated detail (boldest at the core, finest at the rim) are drawn for the decade view and reward it.',
  ],
  choosing: [
    'Our mandala designs are drawn as true radial files — the symmetry in the linework is exact, so your artist\'s transfer is the only variable. For sternum and back compositions, order custom with the placement named: a mandala engineered for the sternum\'s curve differs from a flat back piece, and we draw for the body you name.',
  ],
  notes: {
    placement:
      'Centers and round surfaces: sternum, mid-back, shoulder, elbow, knee, thigh. Centering must be exact — the stencil is set standing, checked in a mirror.',
    sizing:
      'Simple mandalas read at two inches; layered ones need four to six so the rings keep their spacing as the ink settles over the years.',
    aging:
      'Fine dotwork rings soften first; well-spaced mandalas stay calm and readable for decades. Airy beats dense for longevity.',
  },
};

GUIDES['chicano'] = {
  name: 'Chicano',
  summary:
    'Fine-line black and grey born in the barrios and penitentiaries of the Southwest: payasas, lowriders, lettering, Catholic imagery and portraits in pencil-soft shading.',
  intro: [
    'Chicano tattooing grew from the Mexican-American communities of California and the Southwest, drawn first with whatever was at hand — guitar-string needles, ink made from ashes — in the pinto (prison) and barrio traditions. Its fine single-needle lines and whisper-soft black and grey shading come directly from those handmade tools, and its imagery is a culture\'s diary: payasas (clown girls), lowriders, Virgen de Guadalupe portraits, praying hands, rosaries, Aztec warriors and calendars, and elaborate script lettering.',
    'What began as identity written on skin under hard circumstances became one of the most influential styles in the world — modern fine-line black and grey realism descends from it directly.',
  ],
  character: [
    'A Chicano design is drawn like a pencil masterpiece: ultra-fine lines, shading built in smooth single-needle gradients, almost no hard outline anywhere. Faces carry the style — the payasa\'s painted tears, a portrait\'s gaze — surrounded by smoke, roses, dice, cards and filigree lettering. Script is a pillar of the style: names, neighborhoods and mottos in ornate, flowing letterforms that are artworks in themselves.',
  ],
  placement: [
    'Chicano work traditionally claims large, flat territory: full backs for scenes and portraits, chest pieces, sleeves of portraits and lettering, and forearms for script and single figures. The soft shading needs calm skin and protection from the sun to keep its pencil-drawn delicacy; it is fine-line work, with fine-line\'s placement cautions about hands and other high-turnover skin.',
  ],
  sizing: [
    'Portraits and payasas need realism\'s sizes — five inches and up for a face to hold its expression as the shading settles. Lettering can run smaller but the ornate scripts need height per letter to stay open; a name across a forearm is the classic format for a reason. Full Chicano scenes are large-format projects, planned as compositions rather than collected piece by piece.',
  ],
  aging: [
    'As fine-line black and grey, Chicano work softens with time — the smoke gets smokier. Strong pieces are built with enough deep black in the structure to survive it, and the style\'s community has always treated touch-ups as normal upkeep. Sunscreen matters enormously: nothing eats soft grey gradients like UV. Worn with care, a Chicano piece keeps its soul — the expression, the lettering, the story — for life.',
  ],
  choosing: [
    'Choose Chicano designs for the story they tell, and choose the artist for their fine-line hand — this style forgives nothing. Our gallery\'s Chicano pieces come with linework maps your artist can follow for the shading structure. For names and mottos in Chicano script, order custom and spell every letter in the brief twice; the lettering is the tattoo.',
  ],
  notes: {
    placement:
      'Large, flat, sun-protected territory: backs, chests, sleeves, forearms. It is fine-line work — hands and other fast-renewing skin fade it quickly.',
    sizing:
      'Faces and payasas need five inches and up to hold their expression; ornate script needs real height per letter to stay open as it settles.',
    aging:
      'Softens like all fine-line grey work: the smoke gets smokier. Deep black structure, sunscreen and normal touch-ups keep its soul intact.',
  },
};

GUIDES['optical-illusion'] = {
  name: 'Optical Illusion',
  summary:
    'Tattoos that trick the eye: impossible geometry, 3D cubes and holes, rippling patterns and double images that move, flip or deepen as you look.',
  intro: [
    'Optical illusion tattoos are built on the drawing tricks of op art and M.C. Escher: geometry that cannot exist, cubes that flip inside out, skin that appears to open onto machinery or sky, patterns that ripple when you move your eyes. The tattoo does not merely depict something — it does something to the viewer, which is why illusion pieces stop people mid-scroll and mid-sidewalk.',
    'The style divides into families: impossible objects (Penrose triangles, infinite stairs), 3D effects (cubes, spheres and holes shaded to sit on or in the body), pattern fields (waves, moiré, warp grids), and double images (the face that is also a vase, the skull inside the butterfly).',
  ],
  character: [
    'An illusion design is engineering wearing art\'s clothes. The geometry must be exact — an impossible cube with one angle off is just a broken cube — and the shading must obey a single consistent light source or the 3D effect collapses. Line work is typically bold and clean, color either absent or used as one more trick (a red that advances, a blue that recedes). The drawing is done flat, but it is designed for a specific body geometry: the best illusion pieces use the limb itself as part of the trick.',
  ],
  placement: [
    'Flatter, broader skin keeps illusions honest: forearms, calves, shoulders, upper arms, chest and back. Wrapping an illusion around a sharply curving area can either destroy it or — if the design was drawn for that curve — supercharge it, like a warp grid flowing over a shoulder. Talk placement with the design in hand; illusion is the style where "where exactly?" changes the drawing itself.',
  ],
  sizing: [
    'Illusion needs the viewer\'s eye to have room to be fooled: most pieces want three inches and up, and pattern fields want more so the repeat can establish its rhythm before it warps. Tiny illusions read as ordinary small tattoos — the trick needs scale to trigger. 3D holes and objects especially gain from size, since their shading gradients need distance to blend.',
  ],
  aging: [
    'Illusions age on their geometry: as lines soften slightly, a precision trick can lose a degree of its snap, though a well-built one keeps working — the brain completes the effect generously. Bold-lined illusions outlast hairline ones; shading-based 3D softens fastest and may want a refresh to restore the depth. Choose designs whose trick survives a little softness — the great ones do.',
  ],
  choosing: [
    'In our gallery, illusion designs state the flat area they were drawn for. If you have a specific curve in mind — over the shoulder, around the calf — a custom order lets us draw the warp to your body\'s actual geometry, which is when this style goes from clever to uncanny.',
  ],
  notes: {
    placement:
      'Broad, flatter skin keeps the trick honest — forearm, calf, shoulder, chest, back. Drawn-for-the-curve illusions are the exception that supercharges it.',
    sizing:
      'The trick needs scale to trigger: three inches minimum, more for pattern fields. Tiny illusions read as ordinary small tattoos.',
    aging:
      'Bold-lined illusions keep working as they soften; shading-based 3D loses depth first and refreshes well. Precision tricks want margin in the drawing.',
  },
};

// Slugs that have a full guide page, in index display order.
const GUIDE_SLUGS = [
  'traditional-old-school', 'neo-traditional', 'japanese-irezumi',
  'black-grey', 'realism', 'blackwork', 'fine-line', 'watercolor',
  'geometric', 'dotwork', 'mandala', 'tribal', 'new-school',
  'minimalist', 'chicano', 'trash-polka', 'optical-illusion',
];

function guideForStyle(slug) {
  const key = String(slug || '').toLowerCase();
  return GUIDES[key] || null;
}

function redirectForStyle(slug) {
  const key = String(slug || '').toLowerCase();
  return GUIDE_REDIRECTS[key] || null;
}

// Style-specific tattooing notes for design pages: returns the guide's
// short notes plus the guide URL slug, or null when the style has no guide.
function notesForStyle(slug) {
  const key = String(slug || '').toLowerCase();
  const target = GUIDE_REDIRECTS[key] || key;
  const g = GUIDES[target];
  if (!g) return null;
  return { ...g.notes, name: g.name, guideSlug: target };
}

function wordCountGuide(g) {
  const parts = [g.summary, ...g.intro, g.character, g.placement, g.sizing, g.aging, g.choosing];
  return parts.join(' ').split(/\s+/).length;
}

module.exports = { GUIDES, GUIDE_SLUGS, GUIDE_REDIRECTS, guideForStyle, redirectForStyle, notesForStyle, wordCountGuide };
