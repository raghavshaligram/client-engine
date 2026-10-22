// Email link tracking: per-person codes, the /go redirect, scanner filtering, signups and purchases credited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k', PURCHASE_SECRET: 'buy', TRACK_DOMAIN: 'https://Go.GetKeepHOA.com/' });
const db = fakeDb();
installFetch({ db, ai: fakeOpenAI() });
const { actions: A } = await import('../netlify/lib/actions.mjs');
const T = await import('../netlify/lib/track.mjs');
const { default: go } = await import('../netlify/functions/go.mjs');

await A['setup.status']();
const product = db.T.products.find(p => p.id === 'keephoa');
db.T.prospects.push({ id: 'p1', product_id: 'keephoa', segment: 'virginia', email: 'treas@gmail.com', name: 'Maple Court HOA', status: 'contacted', step: 3, angle: 'handoff', clicks: 0, link_slug: null, first_click_at: null, signed_up_at: null, last_sent_at: new Date(Date.now() - 3600_000).toISOString(), next_due_at: new Date().toISOString() });
const p = () => db.T.prospects.find(x => x.id === 'p1');
const hit = (code, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', method = 'GET') => go(new Request(`https://go.getkeephoa.com/go/${code}`, { method, headers: { 'user-agent': ua } }), { params: { slug: code } });

test('each person gets one code, and their link uses the tracking domain', async () => {
  const link = await T.linkFor(product, p());
  assert.match(link, /^https:\/\/go\.getkeephoa\.com\/go\/[a-z0-9]{8}$/);
  assert.equal(await T.linkFor(product, { ...p() }), link, 'same code next time');
  assert.equal(T.trackDomain(), 'go.getkeephoa.com');
});

test('without a tracking domain the link goes straight to the product, tagged with ref', async () => {
  const saved = process.env.TRACK_DOMAIN; delete process.env.TRACK_DOMAIN;
  const link = await T.linkFor(product, p());
  assert.equal(new URL(link).searchParams.get('ref'), 'ce_' + p().link_slug);
  assert.ok(!link.includes('netlify'), 'never the shared netlify.app domain');
  process.env.TRACK_DOMAIN = saved;
});

test('the redirect counts people, not scanners, and passes the ref on', async () => {
  const code = p().link_slug;
  const r = await hit(code);
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('location')).searchParams.get('ref'), 'ce_' + code);
  await hit(code, 'Mozilla/5.0 (compatible; Microsoft SafeLinks)');
  await hit(code, '');
  await hit(code, undefined, 'HEAD');
  assert.equal(p().clicks, 1); assert.ok(p().first_click_at);
  assert.deepEqual(db.T.link_events.map(e => [e.kind, e.step, e.angle]), [['click', 3, 'handoff']]);
  // A click within 2 minutes of sending is a security scanner opening it on arrival.
  p().last_sent_at = new Date().toISOString();
  await hit(code);
  assert.equal(p().clicks, 1);
  assert.equal((await hit('zzzzzzzz')).status, 404);
});

test('a signup through the link stops follow-ups and is credited', async () => {
  db.T.messages.push({ id: 'm1', prospect_id: 'p1', product_id: 'keephoa', step: 4, status: 'draft' });
  const r = await A['signup.record']({ ref: 'ce_' + p().link_slug });
  assert.equal(r.prospects, 1);
  assert.equal(p().status, 'signed_up'); assert.equal(p().next_due_at, null); assert.ok(p().signed_up_at);
  assert.equal(db.T.messages.find(m => m.id === 'm1').status, 'rejected');
  await A['signup.record']({ email: 'TREAS@gmail.com', product: 'keephoa' });
  assert.equal(db.T.link_events.filter(e => e.kind === 'signup').length, 1, 'counted once');
});

test('a purchase by ref makes them a customer', async () => {
  const r = await A['purchase.record']({ ref: 'ce_' + p().link_slug, product: 'keephoa' });
  assert.equal(r.matched, 1); assert.equal(p().status, 'won');
  assert.equal(db.T.link_events.filter(e => e.kind === 'purchase').length, 1);
});

test('results show clicks, signups and who clicked', async () => {
  db.T.messages.push({ id: 'm0', prospect_id: 'p1', product_id: 'keephoa', step: 1, angle: 'handoff', status: 'sent', sent_at: new Date().toISOString() });
  const st = await A['stats']({ productId: 'keephoa' });
  assert.equal(st.totals.clicked, 1); assert.equal(st.totals.signedUp, 1);
  assert.equal(st.clickers[0].email, 'treas@gmail.com'); assert.equal(st.clicksByStep['3'], 1);
  assert.equal(st.tracking.domain, 'go.getkeephoa.com');
});

test('emails with a link get the tracked one; emails without stay link-free', async () => {
  const { writeEmail } = await import('../netlify/lib/brain.mjs');
  const fake = globalThis.fetch;
  globalThis.fetch = async (u, i) => String(u).includes('openai') ? Response.json({ choices: [{ message: { content: JSON.stringify({ subject: 's', body: 'Hi. Look: {{LINK}}\nRaghav' }) } }] }) : fake(u, i);
  const d = await writeEmail({ product: { ...product, rules: { ...product.rules, links: [0, 0, 1] } }, prospect: p(), step: 3, angle: 'handoff', link: 'https://go.getkeephoa.com/go/abcdefgh' });
  globalThis.fetch = fake;
  assert.match(d.body, /https:\/\/go\.getkeephoa\.com\/go\/abcdefgh/);
  assert.deepEqual(d.lintProblems, []);
});
