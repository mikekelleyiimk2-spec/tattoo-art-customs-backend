'use strict';
// Original editorial copy for gallery category pages (SEO content depth,
// added 2026-10-12 for the AdSense "low value content" remediation).
//
// Category names on designs are content data (English, like design titles
// and descriptions), so these blurbs live here as data rather than in the
// i18n catalogs. Lookup order: exact category name, then the parent
// collection (the part before " > "), then null (the view falls back to a
// localized generic intro that names the category and its design count).
//
// Every blurb is original copy written for Tattoo Art Customs: what the
// collection holds, the styles and subjects in it, and how a design from
// it is typically placed and customized. Keep that standard for additions.

const BLURBS = {
  'Animals & Wildlife':
    'Wolves, lions, owls, koi, snakes and hundreds more — animal designs are the heart of this gallery because animals carry meaning people want on skin: loyalty, freedom, patience, protection. You will find black-and-grey realism portraits, bold traditional pieces, geometric and watercolor takes, and fine-line small pieces. Every design ships with the full-color art and the linework stencil, so your artist can size it for a forearm, shoulder, calf or full back piece.',
  'Objects & Mechanical':
    'Pocket watches, compasses, keys, typewriters, engines and clockwork — object tattoos are built on detail, and this collection is drawn for it. These designs pair well with banners, roses and script, and they hold up at almost any size because the linework is planned around real stencil transfer. Pick one as a standalone piece or use it as the anchor of a larger composition.',
  'Mythology & Fantasy':
    'Gods, dragons, phoenixes, valkyries, minotaurs and creatures from Greek, Norse, Egyptian and Japanese myth. Mythology designs give an artist a lot to work with — flowing hair, wings, armor and flame — so this collection leans large: chest pieces, sleeves and back pieces drawn with room for shading and background. Smaller emblem-style versions are here too if you want the symbol without the full scene.',
  'Characters / People':
    'Warriors, geishas, pin-up muses, cowboys, saints and original characters with a story in their face. Character work lives or dies on expression and proportion, and these designs are drawn as tattoo-ready portraits and full figures rather than flat illustrations. Bring one to your artist as-is, or order a custom variation with a different outfit, pose or expression.',
  'Flowers & Botanicals':
    'Roses, peonies, lilies, cherry blossoms, lavender, wildflowers and full botanical arrangements. Florals are the most versatile tattoos there are — they wrap shoulders, climb spines, fill gaps in sleeves and stand alone as delicate fine-line pieces. This collection covers traditional bold roses, black-and-grey botanicals, watercolor blooms and dotwork stems, most with matching linework that transfers cleanly at small sizes.',
  'Religious / Spiritual / Occult':
    'Angels, sacred hearts, crosses, praying hands, mandalas, tarot and occult symbols, drawn with respect for what they mean to the wearer. You will find traditional church-window color, black-and-grey realism, and fine-line minimal pieces side by side. If you need a design adjusted — a name, a date, a different saint or symbol — any of these can be ordered as a custom variation.',
  'Surreal / Bizarre':
    'Melting clocks, impossible staircases, animals in human clothes and scenes that should not exist — this is the gallery\'s weird corner, and it is deliberately strange. Surreal designs reward a second look, which makes them strong conversation pieces on forearms, thighs and calves. Abstract and dark-surrealism pieces sit alongside playful absurd ones, all drawn as clean, tattooable linework.',
  'Celestial / Cosmic':
    'Suns, moons, stars, planets, constellations and zodiac work. Celestial designs scale beautifully — a tiny crescent behind the ear or a full solar-system sleeve — and they layer well with florals, animals and script. This collection includes astrology-sign pieces, moon-phase bands, galaxy watercolor and geometric star charts, each with linework that stays readable as the tattoo ages.',
  'Nature / Scene Concepts':
    'Mountains, forests, ocean waves, deserts and full landscape scenes. Scene tattoos work best with room to breathe, so most of these are drawn wide for forearms, backs and legs, with horizon lines and framing built into the design. You will also find compact circular and diamond-framed scenes that keep the whole landscape inside a clean border.',
  'Skulls / Death / Gothic':
    'Sugar skulls, anatomical skulls, grim reapers, gothic arches, ravens and memento mori pieces. Skull work is a tattoo tradition in its own right, and this collection spans the full range — colorful Día de los Muertos art, black-and-grey realism, traditional bold skulls and delicate fine-line studies. Florals, clocks and candles appear throughout as classic pairings.',
  'Americana / Traditional':
    'Eagles, anchors, daggers, swallows, pin-up girls, playing cards and tall ships — the original American traditional vocabulary, drawn bold with heavy outlines and a limited, punchy palette. Traditional designs are made to age well: thick lines and solid color that still read clearly decades later. If you want the old-school look with a modern subject, order any gallery design redrawn in this style.',
  'Lettering / Symbols':
    'Script lettering, initials, Roman numerals, runes, alchemy marks, unalomes and small symbolic pieces. Lettering tattoos are personal by definition, so treat these designs as proven layouts: pick the style you love and have the word, name or date set in it as a custom order. Fine-line and bold traditional scripts are both here, sized for wrists, collarbones, fingers and ribs.',
  'Geometric / Abstract':
    'Sacred geometry, mandalas, dotwork, line patterns and abstract compositions. Geometric tattoos demand precision, and these designs are drawn on clean grids so the symmetry survives the stencil transfer to curved skin. You will find full mandala back pieces, small geometric animals, armband patterns and abstract filler that connects larger work into a sleeve.',
  'Portraits / Memorial':
    'Portrait designs and memorial pieces — faces, names, dates and symbols that keep someone close. Memorial tattoos deserve care, so these layouts leave clean space for the name and dates you add as a custom order. The collection includes black-and-grey portrait studies, angel and clock memorial compositions, paw-print pet memorials and traditional banner pieces.',
  'Dinosaurs / Prehistoric':
    'T-rex skulls, triceratops, raptors, ammonites, mammoths and fossil-style pieces. Dinosaur tattoos range from scientifically detailed black-and-grey studies to playful cartoon dinos, and both live here. Fossil and skeleton designs are naturally linework-friendly, which makes them a strong pick for a first tattoo that still looks sharp years on.',
  'Nautical / Ocean':
    'Anchors, tall ships, lighthouses, waves, octopuses, sea turtles and everything salt-water. Nautical is one of tattooing\'s oldest traditions — the anchor and swallow start here — and this collection mixes that traditional core with Japanese wave work, black-and-grey sea life and bright neo-traditional pieces. Most designs are drawn to wrap forearms and calves the way a wave wraps a hull.',
  'Anime / Manga':
    'Anime and manga-inspired original characters, chibi figures, and dynamic action poses drawn for skin. Bold outlines and flat color fields translate anime art to tattoos faithfully, and these designs are composed to hold those shapes at common sizes. You will find both cute small pieces and large dramatic panels; custom variations can adjust colors and outfits.',
  'Food & Drink':
    'Coffee cups, cocktails, fruit, chef knives, fast food and kitchen pieces — small, joyful tattoos with a lot of personality. Food designs are usually done small and bright, and this collection is drawn that way: clean shapes, readable at two inches, perfect for a first piece or a fun filler between larger work.',
  'Love / Hearts / Couples':
    'Anatomical hearts, traditional heart-and-banner pieces, lockets, matching couples designs and romantic symbols. The heart is tattooing\'s oldest love letter, and the layouts here leave the banner empty on purpose — add the name or word that matters as a custom order and it is set into the design before delivery.',
  'Military / Patriotic':
    'Eagles, flags, dog tags, rifles, unit-style insignia and memorial pieces for service members. These designs are drawn with the details veterans check first — correct silhouettes, clean flag folds, space for names, dates and unit numbers as custom additions. Traditional, black-and-grey and bold color versions are all represented.',
  'Horror':
    'Slashers, haunted houses, ghosts, creepy dolls, spiders and things that go bump in the night. Horror tattoos lean dark and detailed, and this collection delivers both black-and-grey nightmare fuel and bright neo-traditional horror icons. A note for placement: the darkest pieces read best with a little size, and the linework here is drawn with that in mind.',
  'Music':
    'Guitars, vinyl, microphones, boomboxes, musical notes and portraits of the instruments people actually play. Music designs make strong personal pieces — a first guitar, a favorite lyric in script, a genre emblem — and most here are composed for forearms, shoulders and chest placements where the shape of the instrument can follow the body.',
  'Tattoo Styles':
    'A style tour of the whole gallery: traditional, neo-traditional, blackwork, dotwork, fine line, Japanese irezumi, tribal, watercolor, realism and more, grouped so you can compare how the same subjects change from style to style. If you are still deciding how your tattoo should look, start here — then filter the gallery by the style you land on.',
  'Aliens / UFOs':
    'Flying saucers, grey aliens, abduction beams and cosmic cowboys. UFO tattoos are pure fun — usually bright, a little weird, and instantly readable. This small collection mixes retro 1950s sci-fi poster style with cute modern takes, all drawn with the bold shapes that keep a small tattoo legible.',
  'Fire & Smoke':
    'Flames, phoenixes rising, candles, campfires, dragons\' breath and smoke-formed figures. Fire is a classic gap-filler and sleeve connector because it flows around anything, and these designs are drawn to do exactly that — or to stand alone as torches, candles and burning hearts with clean, curling linework.',
  'Filler / Supporting Elements':
    'Stars, sparkles, webs, smoke, flowers, banners and the small pieces that turn separate tattoos into one connected sleeve. Filler is unglamorous and essential: these designs are drawn in the common traditional and blackwork vocabularies so they sit naturally next to the main pieces you already have.',
  'Mixed / Combination Concepts':
    'Two ideas in one tattoo: animals built from flowers, skulls with clockwork, landscapes inside silhouettes. Combination designs are where custom requests usually start, so if a pairing here is close but not exact, order it as a custom variation and the artist will merge the subjects you choose into one composition.',
  'Pinup':
    'Classic sailor-era pin-up girls and modern pin-up characters, drawn in the traditional style that made them famous. Bold lines, limited palettes and confident poses — pin-up is a cornerstone of American tattooing, and these pieces are composed for arms, legs and other long placements.',
  'Sci-Fi / Futuristic':
    'Robots, astronauts, cybernetics, space stations and neon futures. Sci-fi designs play well with geometric and dotwork shading, and this collection mixes retro ray-gun pulp with sleek modern tech. Circuit and biomechanical pieces here are drawn to flow with the body\'s lines.',
  'Wings':
    'Angel wings, bird wings, dragon wings and full wing back pieces, plus single-wing designs for shoulders and arms. Symmetry is everything in a wing piece, and these are drawn mirrored and measured so a back piece sits even across the shoulder blades.',
  'Crystals & Gems':
    'Cut gemstones, crystal clusters, geodes and raw mineral formations, often paired with flowers and moons. Gem designs shine in color — jewel tones are the point — but the facet linework is drawn carefully enough that black-and-grey versions hold their structure too.',
  'Circus / Carnival':
    'Clowns, jesters, fortune tellers, Ferris wheels and big-top scenes, from cheerful vintage poster style to the darker carnival corner. Circus imagery gives an artist color and motion to play with, and these designs use both.',
  'Gambling / Luck':
    'Dice, cards, roulette, lucky sevens, horseshoes and eight balls — the classic good-luck iconography of traditional tattooing. Luck pieces are usually bold and compact, made to sit on hands, arms and chests, and the banners on these are left ready for your own word or number.',
  'Gaming & Pixel Art':
    'Pixel-art characters, retro game icons, controllers and 8-bit hearts. Pixel designs transfer to skin surprisingly well because the grid is the stencil — these are drawn pixel-perfect so your artist can place them dot by dot, at sizes from a coin up to a full forearm panel.',
  'Ancient Civilizations':
    'Pyramids, hieroglyphs, Aztec and Mayan calendars, Roman eagles, Greek gods and ancient stone carving styles. Civilization pieces carry a lot of fine detail, and the designs here balance that detail against linework heavy enough to age well on skin.',
  'Angels & Demons':
    'Guardian angels, fallen angels, cherubs, demons and the eternal tug-of-war between them. This collection spans soft black-and-grey angel portraits, bold traditional cherubs and dark demon pieces, many composed as chest, back and shoulder work with room for clouds, rays and banners.',
  'Classic Tales':
    'Storybook scenes and beloved tale imagery — rabbits in waistcoats, workshops full of toys and pages straight out of childhood books, redrawn as original tattoo art. These pieces lean warm and illustrative, with the soft linework of a well-loved picture book.',
  'Fairy Tale & Storybook':
    'Castles, enchanted forests, fairy folk and storybook animals, drawn as gentle illustrative tattoos. Storybook designs suit soft color and fine lines, and this collection keeps both — small magical pieces alongside full scene work for arms and backs.',
  'Zodiac / Astrology':
    'All twelve signs as symbols, animals and figures, plus star charts and birth-sign compositions. Zodiac pieces are naturally personal — most people add their date or initials — so these layouts keep clean space for that custom touch, in styles from fine-line minimal to full traditional.',
  'Time / Clocks':
    'Pocket watches, hourglasses, grandfather clocks and clock faces set with roses, skulls and banners. Clock tattoos usually mark a time that matters — a birth, a loss, a beginning — and these designs leave the hands and face ready to be set to your moment as a custom detail.',
};

const byLower = new Map(Object.entries(BLURBS).map(([k, v]) => [k.toLowerCase(), v]));

function blurbFor(categoryName) {
  if (!categoryName) return null;
  const name = String(categoryName).trim();
  const exact = byLower.get(name.toLowerCase());
  if (exact) return exact;
  const parent = name.split(' > ')[0].trim();
  return byLower.get(parent.toLowerCase()) || null;
}

// Curated parent collections used for sitemap category URLs. Each name is a
// real, selectable gallery category value (verified against the live
// gallery's category list 2026-10-12).
const SITEMAP_CATEGORIES = [
  'Animals & Wildlife',
  'Mythology & Fantasy',
  'Flowers & Botanicals',
  'Surreal / Bizarre',
  'Cartoon / Pop Culture',
  'Sci-Fi / Futuristic',
  'Tattoo Styles',
  'Classic Tales',
  'Fairy Tale & Storybook',
  'Zodiac / Astrology',
  'Wings',
  'Vehicles',
  'Western',
  'Steampunk',
];

module.exports = { blurbFor, SITEMAP_CATEGORIES, BLURBS };
