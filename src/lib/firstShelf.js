// The First Library Shelf (Brief #40, owner accepted 2026-10-25) —
// the first shelf seated inside the publication's Library (Dawnfold).
//
// ONE config place for the shelf: the titles below are the shelf's
// whole catalog. Every title is public domain in the United States
// (author died 70+ years ago / published before 1930) and free to
// read in full at Project Gutenberg — the read link is Gutenberg's
// own ebook page, so the shelf never hosts a copy it cannot prove.
//
// The repo carries no bundled public-domain book catalog for the web
// Library (the Library app's bundled books live in the app, and the
// repo's PD seed scripts seed tattoo *designs*, not books), so this
// first shelf is seated from this curated list, per the brief.
const FIRST_SHELF = [
  {
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    year: 1813,
    note: 'Elizabeth Bennet spars with Mr. Darcy — the sharpest comedy of manners in English, and still the funniest.',
    readUrl: 'https://www.gutenberg.org/ebooks/1342',
  },
  {
    title: 'Adventures of Huckleberry Finn',
    author: 'Mark Twain',
    year: 1884,
    note: 'Huck and Jim raft the Mississippi — the great American novel, in Twain\u2019s own river voice.',
    readUrl: 'https://www.gutenberg.org/ebooks/76',
  },
  {
    title: 'Alice\u2019s Adventures in Wonderland',
    author: 'Lewis Carroll',
    year: 1865,
    note: 'Down the rabbit hole: logic, nonsense, and the Mad Hatter\u2019s tea party.',
    readUrl: 'https://www.gutenberg.org/ebooks/11',
  },
  {
    title: 'The Adventures of Sherlock Holmes',
    author: 'Arthur Conan Doyle',
    year: 1892,
    note: 'Twelve cases for Holmes and Watson, starting with A Scandal in Bohemia.',
    readUrl: 'https://www.gutenberg.org/ebooks/1661',
  },
  {
    title: 'Frankenstein; Or, The Modern Prometheus',
    author: 'Mary Shelley',
    year: 1818,
    note: 'The original — a creator, his creature, and the question of who the monster is.',
    readUrl: 'https://www.gutenberg.org/ebooks/84',
  },
  {
    title: 'The Picture of Dorian Gray',
    author: 'Oscar Wilde',
    year: 1890,
    note: 'Wilde\u2019s only novel: beauty, youth, and the portrait that pays the price.',
    readUrl: 'https://www.gutenberg.org/ebooks/174',
  },
  {
    title: 'Tarzan of the Apes',
    author: 'Edgar Rice Burroughs',
    year: 1912,
    note: 'The 1912 original — the same public-domain Tarzan the gallery\u2019s PD designs are drawn from.',
    readUrl: 'https://www.gutenberg.org/ebooks/78',
  },
  {
    title: 'Moby Dick; Or, The Whale',
    author: 'Herman Melville',
    year: 1851,
    note: 'Call me Ishmael. Captain Ahab, the white whale, and the sea — the other great American novel.',
    readUrl: 'https://www.gutenberg.org/ebooks/2701',
  },
];

function firstShelf() {
  return FIRST_SHELF.map((t) => ({ ...t }));
}

module.exports = { FIRST_SHELF, firstShelf };
