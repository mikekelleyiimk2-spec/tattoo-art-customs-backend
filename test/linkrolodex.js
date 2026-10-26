// Link Rolodex line — per-app privacy pages (2026-10-26).
// The coordinator (test/run.js) wires this in; do not run from here.
// The family endpoints themselves are covered by test/links.js; this
// file covers the two new apps' public privacy-policy pages (the URLs
// the Play listings point at).
async function runHttpTests(ok, req) {
  console.log('linkrolodex (privacy pages for the new rolodex apps):');
  const get = async (p) => {
    const r = await req('GET', p);
    return { status: r.status, text: r.text || '' };
  };

  const soc = await get('/privacy/social-rolodex');
  ok(soc.status === 200, 'social rolodex privacy page responds 200');
  ok(soc.text.includes('Social Link Rolodex'), 'social rolodex privacy page names the app');
  ok(soc.text.includes('com.usefulappz.socialrolodex'), 'social rolodex privacy page names the package');
  ok(soc.text.includes('no ads'), 'social rolodex privacy page states the no-ads rule');

  const master = await get('/privacy/master-rolodex');
  ok(master.status === 200, 'master rolodex privacy page responds 200');
  ok(master.text.includes('Master Rolodex'), 'master rolodex privacy page names the app');
  ok(master.text.includes('com.usefulappz.masterrolodex'), 'master rolodex privacy page names the package');
  ok(master.text.includes('disclosure'), 'master rolodex privacy page carries the affiliate disclosure rule');
}

module.exports = { runHttpTests };
