// Agency mode end to end: audit, cold email, reply, mockup, offer, payment, details form,
// build job, checks, owner OK, client review, changes, domain, live, Growth, site enquiries.
// Gmail, Dodo, Cloudflare, PageSpeed, DataForSEO and Supabase Storage are all faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { fakeDb, fakeOpenAI } from './fakes.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const WHSEC = 'whsec_' + Buffer.from('dodo-test-secret-0123456789').toString('base64');
Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k', ALLOW_PRIVATE: '1',
  GOOGLE_SA_EMAIL: 'engine@proj.iam.gserviceaccount.com', GOOGLE_SA_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
  DIGEST_TO: 'me@example.com', PSI_API_KEY: 'psi', DATAFORSEO_LOGIN: 'l', DATAFORSEO_PASSWORD: 'p',
  DODO_WEBHOOK_SECRET: WHSEC, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'cf', PUBLIC_URL: 'https://studio.test',
});

const closerScript = [];   // queue of closer answers for the next replies
const ai = fakeOpenAI({
  writer: () => ({ skip: false, detail: 'no HTTPS and PageSpeed 23', subject: 'your site on phones', body: "Hi Lone Star Plumbing,\n\nYour site loads without HTTPS, so Chrome marks it Not secure, and Google PageSpeed scores the mobile site 23 out of 100.\n\nMost people looking for a plumber are on a phone, so that can cost calls.\n\nWant me to put together a free mockup of a new home page for you? No cost and no call needed.\n\nRaghav" }),
  closer: () => closerScript.shift() || { intent: 'question', action: 'reply', reply: 'Happy to help.\n\nRaghav', confidence: 0.9 },
});
const db = fakeDb();

// ---- fake outside world ----
const G = { sent: [], threads: {} };
const PSI = { next: [] };
const CF = { domains: [], status: 'pending' };
const files = {};
const oldSite = `<html><head><title>Lone Star Plumbing</title></head><body><table><tr><td><table><tr><td>x</td></tr></table></td></tr></table><table></table><table></table>
<h1>Plumbing in Austin since 1998</h1><p>Family owned plumbers for water heaters, drain cleaning and repiping across Austin.</p><img src="/img/truck.jpg"><img src="/img/logo.png" alt="logo">
<script src="/js/jquery-1.8.3.min.js"></script><p>&copy; 2016 Lone Star Plumbing</p></body></html>`;
let previewHtml = '';
const local = http.createServer((q, r) => {
  if (q.url.startsWith('/old')) return r.end(oldSite);
  if (q.url.startsWith('/preview')) return r.end(previewHtml);
  r.statusCode = 404; r.end();
});
await new Promise(r => local.listen(0, '127.0.0.1', r));
const port = local.address().port;
test.after(() => local.close());

const real = globalThis.fetch;
const jsonRes = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const s = String(url), u = new URL(s);
  if (s.startsWith('https://fake.supabase.co/storage/v1/')) {
    const path = u.pathname.replace('/storage/v1', '');
    if (path.startsWith('/object/upload/sign/agency/')) { const p = path.replace('/object/upload/sign/agency/', ''); return jsonRes({ url: `/object/upload/sign/agency/${p}?token=t` }); }
    if (path.startsWith('/object/sign/agency/')) { const p = path.replace('/object/sign/agency/', ''); return jsonRes({ signedURL: `/object/sign/agency/${p}?token=d` }); }
    if (path.startsWith('/object/list/agency')) { const { prefix } = JSON.parse(init.body); return jsonRes(Object.keys(files).filter(f => f.startsWith(prefix)).map(f => ({ id: f, name: f.slice(prefix.replace(/\/?$/, '/').length), metadata: { size: 10 } }))); }
  }
  if (s.startsWith('https://fake.supabase.co/')) return db.handle(s, init);
  if (s.startsWith('https://api.openai.com/')) return ai.handle(s, init);
  if (u.host === 'oauth2.googleapis.com') return jsonRes({ access_token: 'at-' + JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64').toString()).sub, expires_in: 3600 });
  if (u.host === 'gmail.googleapis.com') {
    const inbox = (init.headers.Authorization || '').replace('Bearer at-', '');
    if (u.pathname.endsWith('/messages/send')) {
      const b = JSON.parse(init.body);
      const raw = Buffer.from(b.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
      const id = 'gm' + (G.sent.length + 1);
      const head = raw.split('\r\n\r\n')[0];
      const body = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
      G.sent.push({ inbox, raw, head, body, threadId: b.threadId, id });
      return jsonRes({ id, threadId: b.threadId || 'th' + G.sent.length });
    }
    let m = u.pathname.match(/messages\/(\w+)$/);
    if (m) return jsonRes({ id: m[1], payload: { headers: [{ name: 'Message-ID', value: `<${m[1]}@mail.gmail.com>` }] } });
    m = u.pathname.match(/threads\/(\w+)$/);
    if (m) return jsonRes(G.threads[m[1]] || { messages: [] });
  }
  if (u.host === 'www.googleapis.com' && u.pathname.includes('pagespeedonline')) {
    const r = PSI.next.shift() || { perf: 23, seo: 70, a11y: 80, lcp: 7800 };
    return jsonRes({ lighthouseResult: { categories: { performance: { score: r.perf / 100 }, seo: { score: r.seo / 100 }, accessibility: { score: r.a11y / 100 } }, audits: { 'largest-contentful-paint': { numericValue: r.lcp }, 'cumulative-layout-shift': { numericValue: 0.02 }, 'tap-targets': { score: 0 }, 'font-size': { score: 1 } } } });
  }
  if (u.host === 'api.dataforseo.com') {
    const body = JSON.parse(init.body)[0];
    if (u.pathname.includes('search_volume')) return jsonRes({ tasks: [{ status_code: 20000, result: body.keywords.map((k, i) => ({ keyword: k, search_volume: [880, 1300, 90][i] })) }] });
    return jsonRes({ tasks: [{ status_code: 20000, result: [{ keyword: 'water heater replacement cost austin', search_volume: 320, competition_index: 30 }, { keyword: 'plumber jobs', search_volume: 900 }, { keyword: 'tankless water heater austin', search_volume: 170, competition_index: 20 }] }] });
  }
  if (u.host === 'api.cloudflare.com') {
    if (init.method === 'POST') { CF.domains.push(JSON.parse(init.body).name); return jsonRes({ success: true, result: { status: 'initializing' } }); }
    return jsonRes({ success: true, result: { status: CF.status } });
  }
  if (u.host.endsWith('.pages.dev') || u.host === 'www.lonestarplumbing.test' || u.host === 'lonestarplumbing.test') {
    if (u.host.endsWith('.pages.dev') || CF.status === 'active') return new Response(previewHtml, { status: 200 });
    return new Response('old site', { status: 200 });
  }
  if (/^http:\/\/[a-z]+\.test:\d+/.test(s)) return real(s.replace(/^http:\/\/[a-z]+\.test:/, 'http://127.0.0.1:'), init);
  throw new Error('unexpected fetch ' + s);
};

const { actions: A } = await import('../netlify/lib/actions.mjs');
const AP = await import('../netlify/lib/autopilot.mjs');
const { agencyActions: X } = await import('../netlify/lib/agency/actions.mjs');
const T = await import('../netlify/lib/agency/ticks.mjs');
const D = await import('../netlify/lib/agency/deals.mjs');
const { htmlAudit, findings, agencyScore } = await import('../netlify/lib/agency/audit.mjs');
const { signWebhook, verifyWebhook } = await import('../netlify/lib/agency/dodo.mjs');
const { default: pages } = await import('../netlify/functions/agency-pages.mjs');
const { default: hook } = await import('../netlify/functions/agency-webhook.mjs');

const SENDER = 'raghav@getwebsitestudio.com';
const TUE_10AM_CT = new Date('2026-10-13T15:00:00Z');
const later = () => new Date(Date.now() + 3 * 86_400_000);
const page = (path, init) => pages(new Request('https://studio.test' + path, init));
const post = (path, body) => page(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const deal = () => db.T.deals[0];
const prospect = () => db.T.prospects.find(p => p.product_id === 'websites');
const lastTo = to => [...G.sent].reverse().find(m => m.head.includes('To: ' + to));
let msgN = 0;
function theyReply(text) {
  const p = prospect();
  const th = G.threads[p.thread_id] ||= { messages: [] };
  const id = 'their' + (++msgN);
  th.messages.push({ id, internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Mike <mike@lonestarplumbing.test>' }, { name: 'Subject', value: 'Re: your site on phones' }, { name: 'Message-ID', value: `<${id}@mail.example>` }], body: { data: Buffer.from(text).toString('base64url') } } });
  db.T.prospects.forEach(x => { x.replies_checked_at = null; });
  return id;
}
async function webhook(evt, { id = crypto.randomUUID(), secret = WHSEC } = {}) {
  const body = JSON.stringify(evt), ts = String(Math.floor(Date.now() / 1000));
  return hook(new Request('https://studio.test/hooks/dodo', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook({ id, timestamp: ts, body }, secret) }, body }));
}

test('audit reads an old site honestly', () => {
  const a = htmlAudit(oldSite, 'http://x.test/old');
  assert.equal(a.https, false); assert.equal(a.viewport, false); assert.equal(a.copyright_year, 2016); assert.equal(a.since_year, 1998);
  assert.equal(a.old_jquery, '1.8.3'); assert.equal(a.table_layout, true); assert.equal(a.logo, 'http://x.test/img/logo.png');
  assert.ok(a.images.includes('http://x.test/img/truck.jpg'));
  const f = findings(a, { performance: 23, seo: 70, lcp_s: 7.8, tap_targets_ok: false });
  assert.match(f[0].say, /HTTPS|mobile layout/);
  assert.ok(f.some(x => /PageSpeed scores the mobile site 23 out of 100, with the main content taking 7.8 seconds/.test(x.say)));
  const good = agencyScore({ extra: { audit: { https: true, viewport: true, modern: true, copyright_year: 2026 } }, signals: { booking: true, click_to_call: true } });
  assert.ok(good.score < 0, 'a modern site scores low: ' + good.score_why);
});

test('setup: agency product seeded, sending inbox', async () => {
  const s = await A['setup.status']();
  assert.ok(s.products.some(p => p.id === 'websites'));
  await A['products.save']({ product: { id: 'websites', from_name: 'Raghav Shaligram', postal_address: 'PO Box 1, Austin, TX' } });
  await A['senders.save']({ list: [{ email: SENDER, product_id: 'websites', daily_cap: 10, warmed: true }] });
  await X['agency.config.save']({ productId: 'websites', patch: { packages: [{ id: 'site', dodo_product: 'pdt_site' }, { id: 'growth', dodo_product: 'pdt_growth' }] } });
});

test('find, audit with PageSpeed and search volume, score, write, send', async () => {
  const r = await A['prospects.import']({ productId: 'websites', segment: 'trades', kind: 'maps', sourceFile: 'x.csv', rows: [
    { title: 'Lone Star Plumbing', category: 'Plumber', address: '12 Elm St, Austin, TX 78701, United States', website: `http://lonestarplumbing.test:${port}/old`, phone: '(512) 555-0199', emails: 'mike@lonestarplumbing.test', review_rating: '4.8', review_count: '88', open_hours: '{"Monday":["7AM-6PM"]}' },
  ] });
  assert.equal(r.added, 1);
  await AP.researchTick({ timeLeft: AP.budget(60000) });
  assert.equal(prospect().status, 'auditing', 'waits for PageSpeed before drafting');
  assert.equal(db.T.messages.length, 0);
  const log = await T.auditTick({ timeLeft: () => 60000 });
  assert.ok(log.some(l => /audited/.test(l)), log.join('\n'));
  const p = prospect();
  assert.equal(p.status, 'scanned'); assert.equal(p.extra.psi.performance, 23);
  assert.equal(p.extra.search_volume.total, 2270); assert.match(p.extra.search_volume.label, /plumbers in Austin/);
  assert.ok(p.score >= 5, p.score_why);
  await AP.researchTick({ timeLeft: AP.budget(60000) });
  const writerCall = ai.calls.find(c => c.sys.startsWith('You write short'));
  assert.match(writerCall.user, /WEBSITE AUDIT/); assert.match(writerCall.user, /PageSpeed scores the mobile site 23/); assert.match(writerCall.user, /about 2,270 searches a month/);
  assert.match(writerCall.user, /Mention one or two findings from the WEBSITE AUDIT/);
  const m = db.T.messages.find(x => x.product_id === 'websites');
  assert.equal(m.status, 'approved', 'autopilot is on for the agency: strong drafts approve themselves');
  const sent = await AP.sendTick({ now: TUE_10AM_CT, rand: () => 0 });
  assert.ok(sent.some(l => /sent to Lone Star/.test(l)), sent.join('\n'));
  assert.equal(prospect().status, 'contacted');
});

test('a "yes" reply: the closer sends the mockup link in the same thread', async () => {
  const theirId = theyReply('Sure, send it over.');
  closerScript.push({ intent: 'interested', action: 'send_mockup', reply: 'Here it is: {{MOCKUP_LINK}}\n\nIt uses your real services and reviews. What do you think?\n\nRaghav', confidence: 0.95 });
  await AP.repliesTick({ timeLeft: AP.budget(60000) });
  const r = db.T.replies.find(x => x.message_id === `<${theirId}@mail.example>`);
  assert.equal(r.label, 'pending'); assert.ok(deal(), 'deal created');
  assert.equal(prospect().status, 'replied', 'cold follow-ups stop');
  const log = await T.agencyTick({ timeLeft: () => 60000 });
  assert.ok(log.some(l => /mockup for Lone Star/.test(l)), log.join('\n'));
  assert.equal(deal().stage, 'mockup_sent'); assert.equal(deal().mockup.style, 'trades');
  const ob = db.T.outbox.find(o => o.deal_id === deal().id);
  assert.equal(ob.status, 'queued', 'released once the mockup existed');
  await D.sendOutbox({ now: later() });
  const sent = lastTo('mike@lonestarplumbing.test');
  assert.match(sent.body, new RegExp(`https://studio.test/m/${deal().slug}`));
  assert.match(sent.head, new RegExp(`In-Reply-To: <${theirId}@mail.example>`));
  assert.match(sent.head, /Subject: Re: your site on phones/);
  assert.equal(sent.threadId, prospect().thread_id);
  assert.equal(db.T.replies.find(x => x.id === r.id).handled, true);
});

test('the mockup page shows their business, and the offer page has a prefilled checkout', async () => {
  const m = await (await page(`/m/${deal().slug}`)).text();
  assert.match(m, /Lone Star Plumbing/); assert.match(m, /\(512\) 555-0199/); assert.match(m, /noindex/);
  assert.match(m, /4\.8 from 88 Google reviews/); assert.match(m, new RegExp(`/start/${deal().slug}`));
  assert.match(m, /\$497 one time/);
  const res = await page(`/start/${deal().slug}`);
  assert.match(res.headers.get('content-security-policy'), /img-src 'self' data: https:/);
  const o = await res.text();
  assert.match(o, /checkout\.dodopayments\.com\/buy\/pdt_site\?quantity=1&amp;email=mike%40lonestarplumbing\.test&amp;metadata_deal=/);
  assert.match(o, /redirect_url=https%3A%2F%2Fstudio\.test%2Fintake%2F/);
  assert.equal((await page('/m/nope-123')).status, 404);
});

test('guardrails: an invented price fails twice and the conversation comes to you', async () => {
  theyReply('Looks good. Could you do it for less?');
  closerScript.push({ intent: 'question', action: 'reply', reply: 'I can do $399.\n\nRaghav', confidence: 0.9 }, { intent: 'question', action: 'reply', reply: 'For you, $399.\n\nRaghav', confidence: 0.9 });
  await AP.repliesTick({ timeLeft: AP.budget(60000) });
  const before = G.sent.length;
  await T.agencyTick({ timeLeft: () => 60000 });
  assert.equal(deal().needs_human, true);
  assert.match(deal().human_reason, /price \$399 is not a package price/);
  const alert = G.sent.slice(before).find(m => m.head.includes('To: me@example.com'));
  assert.match(alert.head, /Subject: Needs you: Lone Star Plumbing/);
  assert.equal(db.T.outbox.filter(o => /\$399/.test(o.body)).length, 0, 'nothing invented was sent');
  // You answer, then hand it back.
  await X['agency.reply']({ id: deal().id, text: "The price is $497, and that includes hosting.\n\nRaghav" });
  await D.sendOutbox({ now: later() });
  assert.match(lastTo('mike@lonestarplumbing.test').body, /includes hosting/);
  await X['agency.handBack']({ id: deal().id });
  assert.equal(deal().needs_human, false);
});

test('lintReply catches raw links, early intake links and promises', () => {
  const product = db.T.products.find(p => p.id === 'websites');
  const d = { stage: 'talking', mockup: null };
  assert.ok(D.lintReply({ action: 'reply', reply: 'See https://evil.example' }, { deal: d, product }).some(p => /raw link/.test(p)));
  assert.ok(D.lintReply({ action: 'reply', reply: 'Form: {{INTAKE_LINK}}' }, { deal: d, product }).some(p => /not available/.test(p)));
  assert.ok(D.lintReply({ action: 'reply', reply: 'We guarantee first page of Google.' }, { deal: d, product }).some(p => /promise/.test(p)));
  assert.deepEqual(D.lintReply({ action: 'send_offer', reply: 'It is $497 one time: {{OFFER_LINK}}' }, { deal: d, product }), []);
});

test('payment webhook: verified, once only, starts the project', async () => {
  assert.equal(verifyWebhook({ id: 'a', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'v1,bad', body: '{}' }), false);
  const evt = { type: 'payment.succeeded', data: { payment_id: 'pay_1', total_amount: 49700, subscription_id: null, customer: { email: 'mike@lonestarplumbing.test' }, metadata: { deal: deal().slug } } };
  assert.equal((await webhook(evt, { secret: 'whsec_' + Buffer.from('wrong').toString('base64') })).status, 401);
  const before = G.sent.length;
  assert.equal((await webhook(evt, { id: 'evt_1' })).status, 200);
  assert.equal(await (await webhook(evt, { id: 'evt_1' })).text(), 'already handled');
  assert.equal(deal().stage, 'intake'); assert.equal(deal().amount_cents, 49700); assert.equal(prospect().status, 'won');
  assert.ok(G.sent.slice(before).some(m => /Subject: New client: Lone Star Plumbing/.test(m.head)));
  await D.sendOutbox({ now: new Date() });
  assert.match(lastTo('mike@lonestarplumbing.test').body, new RegExp(`Thank you, payment received[\\s\\S]*https://studio.test/intake/${deal().slug}`));
});

test('details form: prefilled, uploads, submit queues the build', async () => {
  const h = await (await page(`/intake/${deal().slug}?paid=1`)).text();
  assert.match(h, /Payment received/); assert.match(h, /Water heaters\nDrain cleaning/); assert.match(h, /value="\(512\) 555-0199"/);
  const up = await (await post(`/intake/${deal().slug}/upload`, { name: 'Logo FINAL.png', type: 'image/png', size: 1000 })).json();
  assert.match(up.path, new RegExp(`^intake/${deal().slug}/[a-z0-9]+-logo-final.png$`));
  assert.match(up.url, /^https:\/\/fake\.supabase\.co\/storage\/v1\/object\/upload\/sign\/agency\//);
  files[up.path] = 1;
  assert.equal((await post(`/intake/${deal().slug}`, { services: '' })).status, 400);
  const ok = await post(`/intake/${deal().slug}`, { business_name: 'Lone Star Plumbing', services: 'Water heaters\nDrain cleaning\nRepiping', enquiry_email: 'office@lonestarplumbing.test', domain: 'lonestarplumbing.test', pages: ['Home', 'Services', 'Contact'], files: [up.path] });
  assert.equal(ok.status, 200);
  assert.equal(deal().stage, 'building');
  assert.equal(db.T.jobs.filter(j => j.type === 'build').length, 1);
});

test('worker: claim gets a full brief and links; done moves to checks', async () => {
  const { job } = await X['jobs.claim']();
  assert.equal(job.type, 'build'); assert.equal(job.project, 's-' + deal().slug);
  assert.match(job.brief, /Repiping/); assert.match(job.brief, /office@lonestarplumbing\.test/);
  assert.match(job.brief, new RegExp(`Contact form endpoint: https://studio.test/f/${deal().slug}`));
  assert.match(job.brief, /x-site-id/);
  assert.equal(job.uploads.length, 1); assert.match(job.uploads[0].url, /object\/sign\/agency\/intake/);
  assert.equal(job.restore, null); assert.match(job.backup.url, /upload\/sign\/agency\/sites\//);
  assert.equal((await X['jobs.claim']()).job, null, 'one job at a time');
  previewHtml = `<html><head><title>Lone Star Plumbing | Austin plumber</title><meta name="viewport" content="width=device-width"><meta name="x-site-id" content="${deal().slug}"></head><body>new</body></html>`;
  await X['jobs.done']({ id: job.id, previewUrl: `https://${job.project}.pages.dev` });
  assert.equal(deal().stage, 'qa');
});

test('checks: failing PageSpeed triggers an automatic fix; passing goes to you first', async () => {
  PSI.next.push({ perf: 61, seo: 100, a11y: 95, lcp: 3000 });
  assert.equal(await (await import('../netlify/lib/agency/delivery.mjs')).qaDeal(deal()), 'fix');
  const fix = db.T.jobs.find(j => j.type === 'fix');
  assert.match(fix.input.problems[0], /performance is 61/);
  const { job } = await X['jobs.claim']();
  assert.equal(job.type, 'fix'); assert.match(job.brief, /FIX THESE PROBLEMS/);
  await X['jobs.done']({ id: job.id, previewUrl: deal().preview_url });
  PSI.next.push({ perf: 96, seo: 100, a11y: 98, lcp: 1200 });
  const before = G.sent.length;
  const log = await T.auditTick({ timeLeft: () => 60000 });
  assert.ok(log.some(l => /owner_check/.test(l)), log.join('\n'));
  assert.ok(G.sent.slice(before).some(m => /Subject: Site ready for your OK/.test(m.head)));
  await X['agency.ownerApprove']({ id: deal().id });
  assert.equal(deal().stage, 'client_review');
  await D.sendOutbox({ now: later() });
  assert.match(lastTo('mike@lonestarplumbing.test').body, new RegExp(`ready for you to look at: https://studio.test/review/${deal().slug}`));
});

test('client asks for changes on the review page, then approves; domain step', async () => {
  const h = await (await page(`/review/${deal().slug}`)).text();
  assert.match(h, /Open your site/); assert.match(h, /2 rounds of changes left/);
  await post(`/review/${deal().slug}`, { changes: 'Make the phone number bigger on the home page.' });
  assert.equal(deal().stage, 'building'); assert.equal(deal().revisions_used, 1);
  const { job } = await X['jobs.claim']();
  assert.equal(job.type, 'revise'); assert.match(job.brief, /Make the phone number bigger/);
  await X['jobs.done']({ id: job.id, previewUrl: deal().preview_url });
  PSI.next.push({ perf: 95, seo: 100, a11y: 98, lcp: 1300 });
  await T.auditTick({ timeLeft: () => 60000 });
  assert.equal(deal().stage, 'client_review', 'after your first OK, later rounds go straight to the client');
  await D.sendOutbox({ now: later() });
  assert.match(lastTo('mike@lonestarplumbing.test').body, /Your changes are done/);
  await post(`/review/${deal().slug}`, { approve: true });
  assert.equal(deal().stage, 'domain'); assert.equal(deal().domain, 'www.lonestarplumbing.test');
  assert.deepEqual(CF.domains, ['www.lonestarplumbing.test']);
  await D.sendOutbox({ now: later() });
  const instr = lastTo('mike@lonestarplumbing.test').body;
  assert.match(instr, new RegExp(`Value: s-${deal().slug}.pages.dev`)); assert.match(instr, /MX records/);
});

test('domain goes live; Growth starts; weekly article; monthly report data', async () => {
  deal().next_check_at = null;
  await T.agencyTick({ timeLeft: () => 60000 });
  assert.equal(deal().stage, 'domain', 'not live until Cloudflare says so');
  CF.status = 'active'; deal().next_check_at = null;
  await T.agencyTick({ timeLeft: () => 60000 });
  assert.equal(deal().stage, 'live');
  await D.sendOutbox({ now: later() });
  const live = lastTo('mike@lonestarplumbing.test').body;
  assert.match(live, /You're live: https:\/\/www\.lonestarplumbing\.test/); assert.match(live, /Growth is \$149 a month/);
  assert.equal((await webhook({ type: 'subscription.active', data: { subscription_id: 'sub_1', customer: { email: 'mike@lonestarplumbing.test' }, metadata: { deal: deal().slug } } })).status, 200);
  assert.equal(deal().growth_status, 'active');
  await T.agencyTick({ timeLeft: () => 60000 });
  const blog = db.T.jobs.find(j => j.type === 'blog');
  assert.equal(blog.input.keyword, 'water heater replacement cost austin', 'highest-volume keyword, junk filtered');
  await T.agencyTick({ timeLeft: () => 60000 });
  assert.equal(db.T.jobs.filter(j => j.type === 'blog').length, 1, 'one a week');
  const { job } = await X['jobs.claim']();
  assert.match(job.brief, /WRITE ONE ARTICLE NOW/);
  await X['jobs.done']({ id: job.id, title: 'What a water heater costs in Austin', path: '/blog/water-heater-cost-austin/' });
  assert.equal(deal().seo.published[0].title, 'What a water heater costs in Austin');
});

test('site contact form forwards enquiries to the client, with Reply-To', async () => {
  const pre = await page(`/f/${deal().slug}`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal((await post(`/f/${deal().slug}`, { name: 'Jo', email: 'jo@home.test', message: 'Leaking pipe', company: 'bot' })).status, 200);
  assert.equal(db.T.site_leads.length, 0, 'honeypot dropped');
  const r = await post(`/f/${deal().slug}`, { name: 'Jo', email: 'jo@home.test', phone: '555', message: 'Leaking pipe under the sink', page: '/contact/' });
  assert.equal(r.status, 200);
  await D.sendOutbox({ now: new Date() });
  const m = lastTo('office@lonestarplumbing.test');
  assert.match(m.head, /Reply-To: jo@home\.test/); assert.match(m.body, /Leaking pipe under the sink/);
});

test('"not interested" suppresses; digest has the agency section', async () => {
  await A['prospects.import']({ productId: 'websites', segment: 'trades', kind: 'maps', sourceFile: 'y.csv', rows: [
    { title: 'Other Roofing', category: 'Roofing contractor', address: '1 Main, Austin, TX 78701, United States', website: `http://other.test:${port}/old`, emails: 'amy@other.test', review_rating: '4.5', review_count: '40' } ] });
  const p2 = db.T.prospects.find(p => p.email === 'amy@other.test');
  Object.assign(p2, { status: 'contacted', sender: SENDER, thread_id: 'thX', last_sent_at: new Date().toISOString(), step: 1 });
  G.threads.thX = { messages: [{ id: 'n1', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'amy@other.test' }, { name: 'Subject', value: 'Re: x' }], body: { data: Buffer.from('We just redid our site, thanks anyway.').toString('base64url') } } }] };
  closerScript.push({ intent: 'not_interested', action: 'close', reply: '', confidence: 0.9 });
  await AP.repliesTick({ timeLeft: AP.budget(60000) });
  await T.agencyTick({ timeLeft: () => 60000 });
  assert.ok(db.T.suppression.some(s => s.email === 'amy@other.test'));
  assert.equal(db.T.deals.find(d => d.prospect_id === p2.id).stage, 'lost');
  const { text } = await AP.digestText();
  assert.match(text, /== Agency ==/); assert.match(text, /Clients: 1/); assert.match(text, /On Growth: 1/);
  const list = await X['agency.list']({ productId: 'websites' });
  assert.equal(list.totals.clients, 1); assert.equal(list.totals.revenue_cents, 49700);
});
