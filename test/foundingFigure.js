// Founding Figure interest page tests (HTTP phase — runs against the
// spawned app). The storage proof rides the same ops door house ops use
// live: signup over HTTP -> ops list shows the row -> duplicate signup
// stays one row -> ops remove -> list no longer shows it.
async function runHttpTests(ok, req) {
  console.log('founding figure page:');
  const EMAIL = 'founding-figure-test@test.local';
  const token = process.env.MUSE_SERVICE_TOKEN || '';
  const ops = (body, headers = {}) => req('POST', '/api/brambleforce/founding-figure-ops', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
  const opsList = async () => {
    const r = await ops({ action: 'list' }, { authorization: `Bearer ${token}` });
    return JSON.parse(r.text);
  };

  let r = await req('GET', '/brambleforce/founding-figure');
  ok(r.status === 200, 'founding figure page renders 200');
  ok(r.text.includes('The Founding Figure'), 'page carries the Founding Figure heading');
  ok(r.text.includes('not in production'), 'page is honest: the figure is not in production');
  ok(r.text.includes('nothing to buy on this page'), 'page states there is nothing to buy');
  ok(r.text.includes('/img/brambleforce/founding-tor.webp'), 'page shows the Tor dossier art');
  ok(r.text.includes('action="/brambleforce/founding-figure"'), 'page carries the interest form');
  ok(r.text.includes('name="website"'), 'interest form carries the honeypot field');
  ok(r.text.includes('href="/brambleforce/buy/game"'), 'page cross-links the game buy door');
  ok(r.text.includes('href="/merch"'), 'page cross-links the merch shop');

  r = await ops({ action: 'list' });
  ok(r.status === 401, 'ops door refuses a missing bearer token');

  r = await req('POST', '/brambleforce/founding-figure', { body: { email: EMAIL } });
  ok(r.status === 200 && r.text.includes('You are on the Founding Figure list'),
    'signup POST lands on the list with the success flash');

  let list = await opsList();
  ok(list.ok && list.signups.filter((s) => s.email === EMAIL).length === 1,
    'ops read-back: the signup row is in storage exactly once');

  r = await req('POST', '/brambleforce/founding-figure', { body: { email: EMAIL } });
  ok(r.status === 200 && r.text.includes('already on the Founding Figure list'),
    'duplicate signup is recognised, not re-added');
  list = await opsList();
  ok(list.signups.filter((s) => s.email === EMAIL).length === 1,
    'ops read-back: still exactly one row after the duplicate');

  r = await req('POST', '/brambleforce/founding-figure', { body: { email: 'not-an-email' } });
  ok(r.status === 200 && r.text.includes('Enter a valid email address'),
    'invalid email is refused with the plain flash');

  r = await ops({ action: 'remove', email: EMAIL }, { authorization: `Bearer ${token}` });
  const removed = JSON.parse(r.text);
  ok(removed.ok && removed.removed === true, 'ops remove deletes the test row');
  list = await opsList();
  ok(!list.signups.some((s) => s.email === EMAIL), 'ops read-back: the test row is gone');
}

module.exports = { runHttpTests };
