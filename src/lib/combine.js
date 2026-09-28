// Design combiner: merges multiple owned designs into one sheet with sharp.
// Layouts: row (side-by-side), stack (vertical), grid (2 columns).
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');

const CELL = 1400;   // normalized cell dimension (px)
const GAP = 40;      // gap between designs (px)

function bgColor(background) {
  return background === 'black' ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

// Resolve the source file for a design in the requested style.
function sourceFile(design, style) {
  const rel = style === 'linework' ? design.linework_path : design.color_path;
  if (!rel) return null;
  const abs = path.join(config.assetDir, rel);
  return fs.existsSync(abs) ? abs : null;
}

async function combine(designs, { layout = 'row', style = 'color', background = 'white' } = {}) {
  if (!['row', 'stack', 'grid'].includes(layout)) throw new Error('Unknown layout.');
  if (!['color', 'linework'].includes(style)) throw new Error('Unknown style.');
  if (designs.length < 2 || designs.length > 6) throw new Error('Pick 2 to 6 designs to combine.');

  const bg = bgColor(background);
  const files = designs.map((d) => {
    const f = sourceFile(d, style);
    if (!f) throw new Error(`Files are missing for "${d.title}".`);
    return f;
  });

  let canvasW, canvasH, composites = [];

  if (layout === 'row') {
    // Each design normalized to CELL height, placed left to right.
    const thumbs = await Promise.all(files.map((f) =>
      sharp(f).resize({ height: CELL, withoutEnlargement: false }).toBuffer({ resolveWithObject: true })
    ));
    canvasH = CELL;
    canvasW = thumbs.reduce((w, t) => w + t.info.width, 0) + GAP * (thumbs.length - 1);
    let x = 0;
    composites = thumbs.map((t) => {
      const c = { input: t.data, left: x, top: 0 };
      x += t.info.width + GAP;
      return c;
    });
  } else if (layout === 'stack') {
    // Each design normalized to CELL width, stacked top to bottom.
    const thumbs = await Promise.all(files.map((f) =>
      sharp(f).resize({ width: CELL, withoutEnlargement: false }).toBuffer({ resolveWithObject: true })
    ));
    canvasW = CELL;
    canvasH = thumbs.reduce((h, t) => h + t.info.height, 0) + GAP * (thumbs.length - 1);
    let y = 0;
    composites = thumbs.map((t) => {
      const c = { input: t.data, left: 0, top: y };
      y += t.info.height + GAP;
      return c;
    });
  } else {
    // Grid: 2 columns, each cell CELL×CELL (contain), rows as needed.
    const cols = 2;
    const rows = Math.ceil(files.length / cols);
    canvasW = cols * CELL + GAP * (cols - 1);
    canvasH = rows * CELL + GAP * (rows - 1);
    const thumbs = await Promise.all(files.map((f) =>
      sharp(f).resize({ width: CELL, height: CELL, fit: 'contain', background: bg }).toBuffer()
    ));
    composites = thumbs.map((buf, i) => ({
      input: buf,
      left: (i % cols) * (CELL + GAP),
      top: Math.floor(i / cols) * (CELL + GAP),
    }));
  }

  return sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: bg } })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}

module.exports = { combine, sourceFile };
