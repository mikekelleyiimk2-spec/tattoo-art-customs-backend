// build-by-request.js — regenerate assets/catalog/by-request.json from the
// canonical handy list at ~/workspace/your_files/by-request-list-complete.md.
// Run after every character batch: node scripts/build-by-request.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(os.homedir(), 'workspace/your_files/by-request-list-complete.md');
const OUT = path.join(__dirname, '..', 'assets/catalog/by-request.json');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const items = [];
const imgDir = path.join(__dirname, '..', 'assets', 'by-request');
for (const l of lines) {
  const m = l.match(/^\d+\. \[( |✓)\] (.+)$/);
  if (!m) continue;
  const name = m[2].trim();
  const slug = name.toLowerCase()
    .replace(/\s*\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const done = m[1] === '✓';
  items.push({
    name, slug, done,
    // Watermarked preview exists only for generated characters.
    img: (done && fs.existsSync(path.join(imgDir, slug + '.jpg')))
      ? `/img/by-request/${slug}.jpg` : null,
  });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), items }, null, 1) + '\n');
console.log(`by-request.json: ${items.length} items (${items.filter(i => i.done).length} done)`);
