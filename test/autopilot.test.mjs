// Autopilot: business hours, search plan, research tick, graduation, server sending, replies, alerts, digest, purchases.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { fakeDb, fakeOpenAI } from './fakes.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k',
  ALLOW_PRIVATE: '1', GOOGLE_SA_EMAIL: 'engine@proj.iam.gserviceaccount.com',
  GOOGLE_SA_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'), // as pasted into Netlify
  DIGEST_TO: 'me@example.com', PURCHASE_SECRET: 'buy-secret',
});

const db = fakeDb(), ai = fakeOpenAI();
const G = { tokens: [], sent: [], threads: {} };
function gmailFake(url, init) {
  const u = new URL(url);
  if (u.host === 'oauth2.googleapis.com') {
    const jwt = new URLSearchParams(init.body).get('assertion');
    const [h, c, s] = jwt.split('.');
    const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    const claim = JSON.parse(Buffer.from(c, 'base64').toString());
    G.tokens.push({ ok, sub: claim.sub, scope: claim.scope });
    return Response.json(ok ? { access_token: 'at-' + claim.sub, expires_in: 3600 } : { error: 'invalid_grant' }, { status: ok ? 200 : 400 });
  }
  const inbox = (init.headers.Authorization || '').replace('Bearer at-', '');
  if (u.pathname.endsWith('/messages/send')) {
    const b = JSON.parse(init.body);
    const raw = Buffer.from(b.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const id = 'gm' + (G.sent.length + 1);
    G.sent.push({ inbox, raw, threadId: b.threadId, id });
    return Response.json({ id, threadId: b.threadId || 'th' + G.sent.length });
  }
  let m = u.pathname.match(/messages\/(\w+)$/);
  if (m) return Response.json({ id: m[1], payload: { headers: [{ name: 'Message-ID', value: `<${m[1]}@mail.gmail.com>` }] } });
  m = u.pathname.match(/threads\/(\w+)$/);
  if (m) return Response.json(G.threads[m[1]] || { messages: [] });
  return Response.json({ error: { message: 'unmocked ' + url } }, { status: 404 });
}
const real = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const s = String(url);
  if (s.startsWith('https://fake.supabase.co/')) return db.handle(s, init);
  if (s.startsWith('https://api.openai.com/')) return ai.handle(s, init);
  if (/googleapis\.com/.test(s)) return gmailFake(s, init);
  if (/^http:\/\/[a-z]+\.test:/.test(s)) return real(s.replace(/^http:\/\/[a-z]+\.test:/, 'http://127.0.0.1:'), init);
  throw new Error('unexpected fetch ' + s);
};

const site = http.createServer((q, r) => r.end('<title>Law Office of Ann Lee</title><h1>Family law and divorce in Austin</h1><p>Solo practice helping families through custody and divorce for fifteen years.</p>'));
await new Promise(r => site.listen(0, '127.0.0.1', r));
const port = site.address().port;
test.after(() => site.close());

const { actions: A } = await import('../netlify/lib/actions.mjs');
const AP = await import('../netlify/lib/autopilot.mjs');
const { default: handler } = await import('../netlify/functions/api.mjs');
const call = (body, headers) => handler(new Request('http://x/api', { method: 'POST', headers, body: JSON.stringify(body) }));
const SENDER = 'ann@getpdfmacro.com';
const TUE_10AM_CT = new Date('2026-10-13T15:00:00Z');

test('business hours are US Central, weekdays 8 to 5', () => {
  assert.deepEqual(AP.businessWindow(TUE_10AM_CT), { open: true, slotsLeft: 42 });
  assert.equal(AP.businessWindow(new Date('2026-10-17T15:00:00Z')).open, false, 'Saturday');
  assert.equal(AP.businessWindow(new Date('2026-10-13T23:30:00Z')).open, false, '6:30pm CT');
  assert.equal(AP.businessWindow(new Date('2026-10-13T12:59:00Z')).open, false, '7:59am CT');
});

test('setup', async () => {
  await A['setup.status']();
  await A['products.save']({ product: { id: 'pdfmacro', from_name: 'Raghav Shaligram', postal_address: 'PO Box 1, Austin, TX' } });
  const s = await A['senders.save']({ list: [{ email: SENDER, product_id: 'pdfmacro', daily_cap: 10, warmed: true }] });
  assert.equal(s.senders[0].mode, 'server', 'inboxes default to sending on their own');
});

test('search plan: generated, handed out once, only while a product runs low', async () => {
  const r = await A['scrape.plan.save']({ productId: 'pdfmacro', segment: 'family', types: ['family law attorney', 'divorce lawyer'], cities: ['Austin, TX', 'Denver, CO'] });
  assert.equal(r.added, 4);
  assert.equal((await A['scrape.plan.save']({ productId: 'pdfmacro', segment: 'family', types: ['divorce lawyer'], cities: ['Austin, TX'] })).added, 0, 'no duplicates');
  const n1 = await A['scrape.next']({ limit: 3 });
  assert.equal(n1.queries.length, 3);
  assert.ok(n1.queries.every(q => q.productId === 'pdfmacro' && q.segment === 'family'));
  const n2 = await A['scrape.next']({ limit: 3 });
  assert.equal(n2.queries.length, 1, 'searches already run are not repeated within 90 days');
  // A product with plenty of people ready gets no searches.
  for (let i = 0; i < 150; i++) db.T.prospects.push({ id: 'fill' + i, product_id: 'ringsparrow', email: `f${i}@x.com`, status: 'scanned', score: 0, step: 0, extra: {}, signals: {} });
  await A['scrape.plan.save']({ productId: 'ringsparrow', segment: 'trades', types: ['plumber'], cities: ['Austin, TX'] });
  assert.equal((await A['scrape.next']({ limit: 5 })).queries.length, 0);
  db.T.prospects = db.T.prospects.filter(p => !String(p.id).startsWith('fill'));
});

test('research tick reads sites and drafts; nothing auto-approved while learning', async () => {
  await A['prospects.import']({ productId: 'pdfmacro', segment: 'family', kind: 'maps', sourceFile: 'n.csv', rows: [
    { title: 'Law Office of Ann Lee', category: 'Family law attorney', address: '1 Main St, Austin, TX 78701, United States', website: `http://annlee.test:${port}/`, phone: '1', emails: 'ann@annlee.test', review_rating: '4.9', review_count: '20' },
  ] });
  const log = await AP.researchTick({ timeLeft: AP.budget(60000) });
  assert.ok(log.some(l => /read 1 sites/.test(l)), log.join('\n'));
  assert.ok(log.some(l => /drafted/.test(l)), log.join('\n'));
  const st = await A['autopilot.status']();
  assert.equal(st.products.pdfmacro.on, false);
  assert.equal(st.products.pdfmacro.approvedByYou, 0);
  assert.equal(db.T.messages.filter(m => m.status === 'approved').length, 0);
});

test('graduation: 50 approvals with few edits switches autopilot on', async () => {
  for (let i = 0; i < 50; i++) db.T.messages.push({ id: 'h' + i, product_id: 'pdfmacro', prospect_id: 'old' + i, step: 1, status: 'sent', auto_approved: false, edited: i < 3, approved_at: new Date(Date.now() - i * 1000).toISOString() });
  let st = (await A['autopilot.status']()).products.pdfmacro;
  assert.equal(st.on, true, JSON.stringify(st));
  assert.equal(st.editRate, 10);
  // Many recent edits keep it learning.
  db.T.messages.filter(m => m.id.startsWith('h')).slice(0, 10).forEach(m => { m.edited = true; });
  assert.equal((await A['autopilot.status']()).products.pdfmacro.on, false);
  db.T.messages.filter(m => m.id.startsWith('h')).slice(0, 10).forEach(m => { m.edited = false; });
  // You can also force it off.
  await A['autopilot.mode']({ productId: 'pdfmacro', mode: 'off' });
  assert.equal((await A['autopilot.status']()).products.pdfmacro.on, false);
  await A['autopilot.mode']({ productId: 'pdfmacro', mode: 'auto' });
  const log = await AP.researchTick({ timeLeft: AP.budget(60000) });
  assert.ok(log.some(l => /autopilot approved 1/.test(l)), log.join('\n'));
  const m = db.T.messages.find(x => x.status === 'approved');
  assert.equal(m.auto_approved, true);
});

test('drafts the checker scored under 8 still wait for you', async () => {
  const draft = { id: 'low', product_id: 'pdfmacro', prospect_id: 'x', step: 1, status: 'draft', check_score: 7 };
  db.T.messages.push(draft);
  await AP.researchTick({ timeLeft: AP.budget(60000) });
  assert.equal(draft.status, 'draft');
  db.T.messages = db.T.messages.filter(m => m.id !== 'low');
});

test('send tick: nothing outside business hours; inside, sends via Workspace delegation', async () => {
  assert.deepEqual(await AP.sendTick({ now: new Date('2026-10-17T15:00:00Z') }), ['outside US business hours, not sending']);
  assert.equal(G.sent.length, 0);
  // rand=0.99 with 10 left over 42 slots: skips this slot (pacing)
  assert.deepEqual(await AP.sendTick({ now: TUE_10AM_CT, rand: () => 0.99 }), []);
  const log = await AP.sendTick({ now: TUE_10AM_CT, rand: () => 0 });
  assert.ok(log.some(l => /sent to Law Office of Ann Lee/.test(l)), log.join('\n'));
  assert.equal(G.sent.length, 1);
  assert.ok(G.tokens[0].ok, 'service account JWT signature verifies');
  assert.equal(G.tokens[0].sub, SENDER, 'acts as the sending inbox');
  assert.match(G.tokens[0].scope, /gmail\.send/);
  assert.match(G.sent[0].raw, /To: ann@annlee\.test/);
  assert.match(G.sent[0].raw, /From: Raghav Shaligram <ann@getpdfmacro\.com>/);
  const body = Buffer.from(G.sent[0].raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /PO Box 1, Austin, TX/);
  assert.match(body, /Reply "no"/);
  const p = db.T.prospects.find(x => x.email === 'ann@annlee.test');
  assert.equal(p.status, 'contacted'); assert.equal(p.thread_id, 'th1'); assert.equal(p.last_message_id, '<gm1@mail.gmail.com>');
});

test('browser-mode inboxes are left to the browser', async () => {
  await A['senders.save']({ list: [{ email: SENDER, product_id: 'pdfmacro', daily_cap: 10, warmed: true, mode: 'browser' }] });
  db.T.messages.push({ id: 'b1', product_id: 'pdfmacro', prospect_id: 'nobody', step: 1, status: 'approved' });
  const before = G.sent.length;
  await AP.sendTick({ now: TUE_10AM_CT, rand: () => 0 });
  assert.equal(G.sent.length, before);
  db.T.messages = db.T.messages.filter(m => m.id !== 'b1');
  await A['senders.save']({ list: [{ email: SENDER, product_id: 'pdfmacro', daily_cap: 10, warmed: true }] });
});

test('replies tick: interested reply recorded, sequence stopped, you get an email right away', async () => {
  const b64 = s => Buffer.from(s).toString('base64url');
  G.threads.th1 = { messages: [
    { id: 'gm1', payload: { headers: [{ name: 'From', value: `Raghav <${SENDER}>` }] } },
    { id: 'rp1', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Ann Lee <ann@annlee.test>' }, { name: 'Subject', value: 'Re: redaction' }], body: { data: b64('Yes, send the video.\n\nOn Mon, Raghav wrote:\n> hi') } } },
  ] };
  const before = G.sent.length;
  const log = await AP.repliesTick({ timeLeft: AP.budget(60000) });
  assert.ok(log.some(l => /interested/.test(l)), log.join('\n'));
  const r = db.T.replies.find(x => x.gmail_id === 'rp1');
  assert.equal(r.body, 'Yes, send the video.');
  assert.equal(db.T.prospects.find(x => x.email === 'ann@annlee.test').status, 'interested');
  const alert = G.sent.slice(before).find(s => /To: me@example\.com/.test(s.raw));
  assert.ok(alert, 'hot lead alert emailed');
  assert.match(alert.raw, /Subject: Reply from Law Office of Ann Lee: interested/);
  // Second run: nothing new.
  assert.deepEqual(await AP.repliesTick({ timeLeft: AP.budget(60000) }), []);
});

test('digest lists what needs you', async () => {
  const { text, needsYou } = await AP.digestText();
  assert.ok(needsYou >= 1);
  assert.match(text, /== PDFMacro ==/);
  assert.match(text, /Replies to answer \(1\)/);
  assert.match(text, /Autopilot on/);
  const before = G.sent.length;
  assert.deepEqual(await AP.digestTick(), ['digest sent']);
  assert.match(G.sent[before].raw, /need(s)? you today/);
});

test('purchase webhook: secret required, marks the buyer as a customer', async () => {
  assert.equal((await call({ action: 'purchase.record', email: 'ann@annlee.test' }, { 'x-purchase-secret': 'wrong-secre' })).status, 401);
  assert.equal((await call({ action: 'prospects.list', productId: 'pdfmacro' }, { 'x-purchase-secret': 'buy-secret' })).status, 401, 'the purchase secret opens nothing else');
  const res = await call({ action: 'purchase.record', email: 'Ann@AnnLee.test', product: 'pdfmacro' }, { 'x-purchase-secret': 'buy-secret' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).matched, 1);
  assert.equal(db.T.prospects.find(x => x.email === 'ann@annlee.test').status, 'won');
});

test('manual run buttons work through /api', async () => {
  const res = await call({ action: 'autopilot.digest' }, { 'x-app-key': 'k' });
  assert.equal(res.status, 200);
  assert.match((await res.json()).log[0], /PDFMacro/);
});

test('answering a reply sends in the same thread from the server inbox', async () => {
  const r = db.T.replies.find(x => x.gmail_id === 'rp1');
  G.threads.th1.messages[1].payload.headers.push({ name: 'Message-ID', value: '<rp1@mail.gmail.com>' });
  const before = G.sent.length;
  await A['reply.send']({ id: r.id, answer: 'Here is the 2-minute video: https://pdfmacro.com' });
  const s = G.sent[before];
  assert.equal(s.inbox, SENDER); assert.equal(s.threadId, 'th1');
  assert.match(s.raw, /To: ann@annlee\.test/); assert.match(s.raw, /Subject: Re: redaction/); assert.match(s.raw, /In-Reply-To: <rp1@mail\.gmail\.com>/);
  assert.equal(db.T.replies.find(x => x.id === r.id).handled, true);
});
