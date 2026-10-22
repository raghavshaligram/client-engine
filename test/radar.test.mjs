// Conversations: scan, dedupe, score threshold, drafts, caps, tracked links, signup and purchase attribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k',
  XAI_API_KEY: 'xai', PURCHASE_SECRET: 'buy-secret', URL: 'https://engine.example.app',
});
const db = fakeDb();
installFetch({ db, ai: fakeOpenAI() });
const inner = globalThis.fetch;
const G = { calls: [], background: [] };
const REDDIT = [
  { url: 'https://www.reddit.com/r/HOA/comments/abc123/new_treasurer_drowning_in_spreadsheets/', author: 'u/maplecourt_treas', text: 'Just became treasurer of our 24-home self-managed HOA. The last guy left a mess of spreadsheets. What do other small HOAs use?', posted_at: '2026-10-20', score: 92, reason: 'New treasurer asking for a tool' },
  { url: 'https://www.reddit.com/r/HOA/comments/def456/hoa_fees_too_high/', author: 'angryowner', text: 'Our fees went up again.', score: 30, reason: 'Complaint about fees, not the books' },
  { url: 'https://example.com/not-reddit', author: 'x', text: 'invented', score: 99, reason: 'wrong domain' },
];
globalThis.fetch = async (url, init = {}) => {
  const s = String(url);
  if (s.startsWith('https://api.x.ai/')) {
    const b = JSON.parse(init.body); const sys = b.input[0].content, user = b.input[1].content;
    G.calls.push({ sys: sys.slice(0, 30), tools: b.tools, user });
    let out;
    if (sys.startsWith('You find warm leads on Reddit')) out = { leads: REDDIT };
    else if (sys.startsWith('You find warm leads')) out = { leads: [] };
    else if (sys.startsWith('You write replies')) out = { replies: [{ i: 0, reply: 'I was in the same spot last year — what helped was one ledger per home. I built KeepHOA for exactly this: {{LINK}}', include_link: true }] };
    else out = {};
    return Response.json({ output_text: '```json\n' + JSON.stringify(out) + '\n```', usage: { input_tokens: 100, output_tokens: 50, server_side_tool_usage_details: { web_search_calls: b.tools ? 2 : 0 } } });
  }
  if (s.includes('/.netlify/functions/radar-scan-background')) { G.background.push(init); return new Response('', { status: 202 }); }
  return inner(url, init);
};

const { actions: A } = await import('../netlify/lib/actions.mjs');
const R = await import('../netlify/lib/radar.mjs');
const { default: go } = await import('../netlify/functions/go.mjs');
const { default: api } = await import('../netlify/functions/api.mjs');
const { default: bg } = await import('../netlify/functions/radar-scan-background.mjs');

test('KeepHOA has Conversations on with Reddit and forums; the others are off', async () => {
  const { products } = await A['setup.status']();
  const k = products.find(p => p.id === 'keephoa');
  assert.equal(k.radar.on, true);
  assert.deepEqual(Object.entries(k.radar.sources).filter(([, v]) => v).map(([k]) => k).sort(), ['forums', 'reddit']);
  assert.ok(k.radar.subreddits.includes('HOA'));
  assert.equal(products.find(p => p.id === 'pdfmacro').radar.on, false);
});

test('a scan keeps real Reddit posts scored 70+, drafts a reply, and never repeats a post', async () => {
  const n = await R.runScan({ trigger: 'test' });
  assert.equal(n, 1);
  const web = G.calls.filter(c => c.tools?.[0]?.type === 'web_search');
  assert.deepEqual(web.map(c => c.tools[0].filters.allowed_domains[0]).sort(), ['quora.com', 'reddit.com']);
  assert.match(web.find(c => c.tools[0].filters.allowed_domains[0] === 'reddit.com').user, /r\/HOA/);
  const c = db.T.conversations[0];
  assert.equal(c.product_id, 'keephoa'); assert.equal(c.platform, 'reddit'); assert.equal(c.score, 92);
  assert.equal(c.author, 'maplecourt_treas');
  assert.match(c.draft, /I built KeepHOA/); assert.doesNotMatch(c.draft, /—/, 'no em dashes');
  assert.equal(c.link_included, true);
  assert.match(c.target, /^https:\/\/keephoa\.com\/\?ref=ce_[a-z0-9]{8}$/);
  const drafter = G.calls.find(x => x.sys.startsWith('You write replies'));
  assert.match(drafter.user, /NEVER SAY:/);
  assert.match(drafter.user, /Do not say it processes payments/);
  // Second scan: same posts come back, nothing new.
  assert.equal(await R.runScan({ trigger: 'test' }), 0);
  assert.equal(db.T.conversations.length, 1);
  const k = db.T.products.find(p => p.id === 'keephoa');
  assert.match(k.radar.lastScanSummary, /0 new leads/);
  const st = await A['radar.status']();
  assert.ok(st.usage.webSearchCalls >= 8, 'usage recorded for the monthly cap');
  assert.match(st.scan.log.join('\n'), /Reddit: 2 found, 0 new/);
});

test('monthly caps stop a source', async () => {
  await A['radar.settings.save']({ settings: { monthlyWebSearchLimit: 1 } });
  const before = G.calls.length;
  await R.runScan({ trigger: 'test' });
  assert.equal(G.calls.length, before, 'no Grok calls once over the cap');
  assert.match((await R.scanStatus()).log.join('\n'), /monthly web search limit reached/);
  await A['radar.settings.save']({ settings: { monthlyWebSearchLimit: 600 } });
});

test('queue, edit, mark sent, daily count; skip and bring back', async () => {
  let q = await A['radar.queue']({ productId: 'keephoa' });
  assert.equal(q.rows.length, 1); assert.equal(q.dailyCap, 10);
  const row = q.rows[0];
  assert.equal(row.link, `https://engine.example.app/go/${row.slug}`);
  await A['radar.update']({ id: row.id, draft: row.draft.replace('one ledger per home', 'a ledger for each home') });
  await A['radar.update']({ id: row.id, status: 'sent' });
  q = await A['radar.queue']({ productId: 'keephoa' });
  assert.equal(q.rows.length, 0); assert.equal(q.sentToday.reddit, 1); assert.equal(q.counts.sent, 1);
  const sent = (await A['radar.queue']({ productId: 'keephoa', status: 'sent' })).rows[0];
  assert.match(sent.draft, /a ledger for each home/);
});

test('rewrite with a note', async () => {
  const id = db.T.conversations[0].id;
  const r = await A['radar.redraft']({ id, note: 'shorter, no link' });
  assert.ok(r.row.draft);
  assert.match(G.calls.at(-1).user, /Extra instruction for this reply: shorter, no link/);
});

test('tracked link counts people, not link-preview bots, and redirects with the ref', async () => {
  const c = db.T.conversations[0];
  const hit = ua => go(new Request(`https://engine.example.app/go/${c.slug}`, { headers: { 'user-agent': ua } }), { params: { slug: c.slug } });
  const r1 = await hit('Mozilla/5.0 (iPhone)');
  assert.equal(r1.status, 302); assert.equal(r1.headers.get('location'), c.target);
  await hit('Mozilla/5.0 (compatible; redditbot/1.0)');
  await hit('Slackbot-LinkExpanding 1.0');
  assert.equal(db.T.conversations[0].clicks, 1);
  assert.equal((await go(new Request('https://x/go/nope99'), { params: { slug: 'nope99' } })).status, 404);
});

test('signup and purchase webhooks credit the conversation (purchase secret only)', async () => {
  const c = db.T.conversations[0];
  const post = (body, secret) => api(new Request('https://x/api', { method: 'POST', headers: { 'x-purchase-secret': secret }, body: JSON.stringify(body) }));
  assert.equal((await post({ action: 'signup.record', ref: `ce_${c.slug}` }, 'wrong-secre')).status, 401);
  assert.equal((await post({ action: 'radar.queue' }, 'buy-secret')).status, 401, 'the purchase secret opens nothing else');
  assert.equal((await post({ action: 'signup.record', ref: `ce_${c.slug}` }, 'buy-secret')).status, 200);
  const res = await post({ action: 'purchase.record', ref: `ce_${c.slug}`, product: 'keephoa' }, 'buy-secret');
  assert.equal(res.status, 200); assert.equal((await res.json()).conversation, true);
  const row = db.T.conversations[0];
  assert.deepEqual([row.signups, row.purchases], [1, 1]);
  const st = await A['radar.stats']({ productId: 'keephoa' });
  assert.deepEqual(st.byPlatform.reddit, { found: 1, sent: 1, clicks: 1, signups: 1, purchases: 1 });
  assert.equal(st.best[0].id, row.id);
});

test('scan button hands off to the background function, which only this site can start', async () => {
  const r = await A['radar.scan']({ productId: 'keephoa' });
  assert.equal(r.started, true);
  const call = G.background[0];
  assert.equal(call.headers['x-radar-internal'], R.internalToken());
  assert.equal((await bg(new Request('https://x/.netlify/functions/radar-scan-background', { method: 'POST', body: '{}' }))).status, 403);
  const ok = await bg(new Request('https://x/.netlify/functions/radar-scan-background', { method: 'POST', headers: { 'x-radar-internal': R.internalToken() }, body: '{"productId":"keephoa","trigger":"t"}' }));
  assert.equal(ok, undefined, 'background functions return nothing');
  assert.equal((await R.scanStatus()).running, false);
});

test('scan is due on schedule only for products switched on', () => {
  const s = { scanEveryHours: 6 };
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(R.scanDue([{ radar: { on: false } }], s, now), false);
  assert.equal(R.scanDue([{ radar: { on: true, lastScanAt: '2026-10-22T09:00:00Z' } }], s, now), false);
  assert.equal(R.scanDue([{ radar: { on: true, lastScanAt: '2026-10-22T05:00:00Z' } }], s, now), true);
});

test('a scan done one site at a time reports the whole run', async () => {
  db.T.radar_seen = []; db.T.conversations = [];
  await A['radar.scanInline']({ productId: 'keephoa', platform: 'reddit', first: true });
  await A['radar.scanInline']({ productId: 'keephoa', platform: 'forums', last: true });
  const k = db.T.products.find(p => p.id === 'keephoa');
  assert.equal(k.radar.lastScanSummary, '1 new lead (Reddit 1, Forums 0)');
  assert.equal((await R.scanStatus()).running, false);
});

test('product settings save cleans the lists', async () => {
  const r = await A['products.save']({ product: { id: 'keephoa', radar: { on: true, sources: { reddit: true, x: 'yes' }, keywords: 'a\n\n b \n', subreddits: ['r/HOA', '/r/condo'], forumDomains: ['https://www.quora.com/topic/x'] } } });
  assert.deepEqual(r.product.radar.keywords, ['a', 'b']);
  assert.deepEqual(r.product.radar.subreddits, ['HOA', 'condo']);
  assert.deepEqual(r.product.radar.forumDomains, ['www.quora.com']);
  assert.equal(r.product.radar.sources.x, true); assert.equal(r.product.radar.sources.hn, false);
  assert.ok(r.product.radar.lastScanAt, 'scan history kept');
});
