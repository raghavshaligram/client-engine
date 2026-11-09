// Owner finding: who is named on a studio's own site, which address to use, and falling back when a guess can't be confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';
import { readPeople, peopleLinks, chooseOwner } from '../netlify/lib/people.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k', ALLOW_PRIVATE: '1' });
const db = fakeDb();
installFetch({ db, ai: fakeOpenAI(), passthrough: true, testHosts: true });
const { actions: A } = await import('../netlify/lib/actions.mjs');

const TEAM = `<h1>Meet the studio</h1>
  <div class="card"><h3>Maya Fernhill</h3><span>Founder &amp; Creative Director</span></div>
  <div class="card"><h3>Tom Reyes</h3><p>Senior Designer</p></div>
  <div class="card"><h3>Ana Lopez</h3><p>Art Director</p></div>
  <div class="testimonial"><p>“They nailed our rebrand.”</p><p>Jo Banks, Founder at Quillnest</p></div>
  <blockquote>“Fast and kind” — Mark Lee, CEO</blockquote>
  <p>Our former owner Bill Stone retired in 2019.</p>`;

test('reads owners from cards, sentences and schema.org; ignores quotes, past owners and job titles', () => {
  const people = readPeople(`${TEAM}<p>Founder Jane Park leads strategy.</p>
    <script type="application/ld+json">{"@type":"Organization","founder":{"@type":"Person","name":"Maya Fernhill"}}</script>`, 'Fernhill Studio');
  const names = people.map(p => p.name).sort();
  assert.deepEqual(names, ['Ana Lopez', 'Jane Park', 'Maya Fernhill']);
  assert.equal(people.find(p => p.name === 'Maya Fernhill').rank, 0);
  assert.equal(people.find(p => p.name === 'Ana Lopez').rank, 1);
  assert.deepEqual(readPeople('<p>Fernhill was founded by Maya Fernhill in 2015.</p>').map(p => p.name), ['Maya Fernhill']);
  assert.deepEqual(readPeople('<p>Leo Grant, CEO at Brightco, said we were great.</p>', 'Fernhill Studio'), [], 'a client, not staff');
});

test('follows the site\'s own people pages, best first', () => {
  const links = peopleLinks('<a href="/work">Work</a><a href="/about-us">About</a><a href="https://other.com/team">x</a><a href="/team/">Our team</a><a href="/contact">Contact</a><a href="/">Home</a>', 'https://fernhill.co/');
  assert.deepEqual(links, ['https://fernhill.co/team/', 'https://fernhill.co/about-us', 'https://fernhill.co/contact']);
});

test('address: printed beats pattern beats guess; never one another person could own', () => {
  const people = readPeople(TEAM, 'Fernhill Studio');
  const base = { people, website: 'https://fernhill.co', businessName: 'Fernhill Studio' };
  assert.deepEqual(chooseOwner({ ...base, emails: ['maya.fernhill@fernhill.co', 'hello@fernhill.co'] }),
    { name: 'Maya Fernhill', title: 'Founder & Creative Director', email: 'maya.fernhill@fernhill.co', source: 'published' });
  const pat = chooseOwner({ ...base, emails: ['alopez@fernhill.co'] });
  assert.equal(pat.email, 'mfernhill@fernhill.co'); assert.equal(pat.source, 'pattern');
  const guess = chooseOwner({ ...base, emails: ['hello@fernhill.co'] });
  assert.equal(guess.email, 'maya@fernhill.co'); assert.equal(guess.source, 'guess');
  const two = readPeople('<h3>Maya Fernhill</h3><p>Founder</p><h3>Maya Ortiz</h3><p>Partner</p>');
  assert.equal(chooseOwner({ people: two, emails: [], website: 'https://fernhill.co' }).source, 'none', 'two Mayas: no guess');
});

// Two tiny studio sites: one prints the founder's address, one prints only hello@.
const site = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const [, who, page] = req.url.split('/');
  const home = `<title>${who} studio</title><h1>Brand identity for independent businesses</h1><p>A small design studio making brands, packaging and websites for independent businesses.</p><a href="/${who}/team">Team</a><a href="mailto:hello@${who}.test">hello@${who}.test</a>`;
  if (page === 'team') return res.end(TEAM + (who === 'fern' ? '<p>Write to Maya: <a href="mailto:maya@fern.test">maya@fern.test</a></p>' : ''));
  if (!page) return res.end(home);
  res.statusCode = 404; res.end('nope');
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const port = site.address().port;
test.after(() => site.close());
const row = who => ({ title: `${who[0].toUpperCase() + who.slice(1)} Design Studio`, category: 'Graphic designer', address: '1 Main St, Austin, TX 78701, United States',
  website: `http://${who}.test:${port}/${who}`, emails: `hello@${who}.test`, review_count: '12', review_rating: '5', status: '', link: 'x', phone: '' });

test('scan: printed owner address replaces hello@; a guess waits for the check and falls back if it fails', async () => {
  await A['setup.status']();
  const imp = await A['prospects.import']({ productId: 'nodstage', segment: 'design', kind: 'maps', rows: [row('fern'), row('oak')], sourceFile: 't.csv' });
  assert.equal(imp.added, 2, JSON.stringify(imp));
  // Without email checks, only a printed address is used.
  await A['prospects.scan']({ productId: 'nodstage' });
  const by = n => db.T.prospects.find(p => p.name.startsWith(n));
  assert.equal(by('Fern').email, 'maya@fern.test');
  assert.equal(by('Fern').extra.contact, 'Maya Fernhill');
  assert.equal(by('Fern').extra.email_guess, false);
  assert.match(by('Fern').score_why, /owner named on their site/);
  assert.equal(by('Oak').email, 'hello@oak.test', 'no guessing while checks are off');
  assert.equal(by('Oak').extra.contact, 'Maya Fernhill');

  // With checks on, a fresh studio gets a guessed address that must check out.
  await A['verify.next']({ limit: 10 });
  await A['prospects.import']({ productId: 'nodstage', segment: 'design', kind: 'maps', rows: [row('pine')], sourceFile: 't2.csv' });
  await A['prospects.scan']({ productId: 'nodstage' });
  assert.equal(by('Pine').email, 'maya@pine.test');
  assert.equal(by('Pine').extra.email_guess, true);
  assert.equal(by('Pine').verified, null);
  await A['verify.results']({ results: [{ id: by('Pine').id, reachable: 'risky' }] });
  assert.equal(by('Pine').email, 'hello@pine.test', 'catch-all can\'t confirm a guess: back to the printed address');
  assert.equal(by('Pine').verified, null, 'the printed address gets checked next');
  assert.match(by('Pine').extra.owner_guess_failed, /maya@pine.test \(risky\)/);
  assert.equal(by('Pine').extra.contact, 'Maya Fernhill', 'still greeted by name');
});
