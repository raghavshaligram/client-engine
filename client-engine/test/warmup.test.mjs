// Warm-up: the ramp, inbox-to-inbox conversations, spam rescue, tidy-up, DNS check.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeDb } from './fakes.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k',
  GOOGLE_SA_EMAIL: 'sa@x.iam.gserviceaccount.com', GOOGLE_SA_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

// A small Gmail: one mailbox per inbox, real delivery between them, labels, threads, search by Message-ID.
const boxes = {}; let n = 0;
const box = e => (boxes[e] ||= []);
const spamFor = new Set(); // recipients whose next incoming email lands in spam
function deliver(from, to, raw, threadIdFromSender) {
  const head = raw.split('\r\n\r\n')[0];
  const h = k => (head.match(new RegExp(`^${k}: (.*)$`, 'mi')) || [])[1] || '';
  const mid = h('Message-ID'), irt = h('In-Reply-To');
  const sentId = 'm' + (++n);
  const sentThread = threadIdFromSender || 't' + n;
  box(from).push({ id: sentId, threadId: sentThread, labelIds: ['SENT'], mid, subject: h('Subject'), from });
  const parent = irt && box(to).find(m => m.mid === irt);
  const inId = 'm' + (++n);
  box(to).push({ id: inId, threadId: parent ? parent.threadId : 't' + n, labelIds: spamFor.delete(to) ? ['SPAM', 'UNREAD'] : ['INBOX', 'UNREAD'], mid, subject: h('Subject'), from });
  return { id: sentId, threadId: sentThread };
}
const asMsg = m => ({ id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], payload: { headers: [{ name: 'Message-ID', value: m.mid }, { name: 'Subject', value: m.subject }, { name: 'From', value: m.from }] } });
const DNS = {
  'good.co': { MX: ['1 smtp.google.com.'], TXT: ['"v=spf1 include:_spf.google.com ~all"'], 'google._domainkey': ['"v=DKIM1; k=rsa; p=MIIB"'], _dmarc: ['"v=DMARC1; p=none"'] },
  'bad.co': { MX: [], TXT: ['"v=spf1 include:sendgrid.net ~all"', '"v=spf1 include:_spf.google.com ~all"'], 'google._domainkey': [], _dmarc: [] },
};
const db = fakeDb();
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === 'fake.supabase.co') return db.handle(String(url), init);
  if (u.host === 'oauth2.googleapis.com') { const c = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64').toString()); return Response.json({ access_token: 'at:' + c.sub, expires_in: 3600 }); }
  if (u.host === 'dns.google') {
    const name = u.searchParams.get('name'), type = u.searchParams.get('type');
    const [sub, ...rest] = name.split('.'); const dom = DNS[name] ? name : rest.join('.').replace(/^_domainkey\./, '');
    const rec = DNS[name]?.[type] || (name.startsWith('google._domainkey.') ? DNS[name.replace('google._domainkey.', '')]?.['google._domainkey'] : name.startsWith('_dmarc.') ? DNS[name.replace('_dmarc.', '')]?._dmarc : []) || [];
    void sub; void dom;
    return Response.json({ Answer: rec.map(data => ({ data })) });
  }
  const inbox = (init.headers?.Authorization || '').replace('Bearer at:', '');
  const p = u.pathname.replace('/gmail/v1/users/me/', '');
  if (p === 'messages/send') {
    const b = JSON.parse(init.body); const raw = Buffer.from(b.raw, 'base64url').toString();
    const to = raw.match(/^To: (.*)$/m)[1].trim();
    return Response.json(deliver(inbox, to, raw, b.threadId));
  }
  if (p === 'messages' && u.searchParams.get('q')) {
    const want = '<' + u.searchParams.get('q').replace('rfc822msgid:', '') + '>';
    const m = box(inbox).find(x => x.mid === want && !x.labelIds.includes('SENT'));
    return Response.json(m ? { messages: [{ id: m.id }] } : {});
  }
  let m = p.match(/^messages\/(\w+)\/modify$/);
  if (m) {
    const msg = box(inbox).find(x => x.id === m[1]); const b = JSON.parse(init.body);
    msg.labelIds = [...new Set([...msg.labelIds.filter(l => !b.removeLabelIds.includes(l)), ...b.addLabelIds])];
    return Response.json(asMsg(msg));
  }
  m = p.match(/^messages\/(\w+)$/);
  if (m) { const msg = [...box(inbox)].find(x => x.id === m[1]); return msg ? Response.json(asMsg(msg)) : Response.json({ error: { message: 'nf' } }, { status: 404 }); }
  m = p.match(/^threads\/(\w+)$/);
  if (m) return Response.json({ messages: box(inbox).filter(x => x.threadId === m[1]).map(asMsg) });
  return Response.json({ error: { message: 'unmocked ' + p } }, { status: 404 });
};

const { actions: A } = await import('../netlify/lib/actions.mjs');
const W = await import('../netlify/lib/warmup.mjs');
const AP = await import('../netlify/lib/autopilot.mjs');
const DAY = 86_400_000;
const T0 = new Date('2026-10-13T15:00:00Z'); // a Tuesday, 10am Central
const OPEN = { open: true, slotsLeft: 1 }, CLOSED = { open: false, slotsLeft: 0 };

test('ramp: 14 days of warm-up only, then 5 a day rising by 2 every 3 days, up to your maximum', () => {
  const s = d => W.senderPlan({ started_at: new Date(T0 - d * DAY).toISOString(), daily_cap: 25 }, T0);
  assert.deepEqual([s(0).warming, s(0).coldCap, s(0).warmTarget], [true, 0, 3]);
  assert.deepEqual([s(13).warming, s(13).warmTarget], [true, 15]);
  assert.deepEqual([s(14).warming, s(14).coldCap, s(14).warmTarget], [false, 5, 8]);
  assert.equal(s(20).coldCap, 9);
  assert.equal(s(200).coldCap, 25, 'never above the maximum you set');
});

test('warm-up emails are varied and contain nothing promotional', () => {
  let seed = 1; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const mails = Array.from({ length: 60 }, () => W.warmEmail(rand));
  assert.ok(new Set(mails.map(m => m.body)).size > 40, 'bodies vary');
  for (const m of mails) {
    assert.doesNotMatch(m.body + m.subject, /https?:|www\.|pdfmacro|keephoa|ringsparrow|free trial|discount|offer|price|\$/i);
    assert.ok(m.body.split(/\s+/).length < 60);
  }
});

test('new inboxes refuse cold email until warm', async () => {
  await A['setup.status']();
  await A['products.save']({ product: { id: 'pdfmacro', from_name: 'Raghav Shaligram', postal_address: 'PO Box 1' } });
  await A['senders.save']({ list: [
    { email: 'raghav@getpdfmacro.com', product_id: 'pdfmacro', daily_cap: 25 },
    { email: 'raghav@getkeephoa.com', product_id: 'keephoa', daily_cap: 25 },
    { email: 'r@getpdfmacro.com', product_id: 'pdfmacro', daily_cap: 25 }, // same domain as the first: never paired with it
  ] });
  const n = await A['send.next']({ sender: 'raghav@getpdfmacro.com' });
  assert.equal(n.stop, 'warming');
  assert.match(n.reason, /day 1 of 14/);
  const st = await A['senders.status']();
  assert.equal(st.senders[0].plan.warming, true);
  // Saving again keeps the warm-up clock.
  const before = st.senders[0].started_at;
  await A['senders.save']({ list: st.senders.map(s => ({ ...s })) });
  assert.equal((await A['senders.status']()).senders[0].started_at, before);
});

test('warm-up: write, rescue from spam, reply, archive both sides', async () => {
  const S = (await A['senders.status']()).senders;
  spamFor.add('raghav@getkeephoa.com');
  const log1 = await W.warmupTick({ senders: S, now: T0, rand: () => 0, window: OPEN });
  const wrote = log1.filter(l => /wrote to/.test(l));
  assert.equal(wrote.length, 3, log1.join('\n'));
  assert.ok(!db.T.warmup.some(w => w.from_addr.split('@')[1] === w.to_addr.split('@')[1]), 'never between inboxes on the same domain');
  assert.equal(db.T.warmup.length, 3);
  // Nothing due yet.
  assert.deepEqual((await W.warmupTick({ senders: S, now: new Date(T0.getTime() + 5 * 60_000), rand: () => 0.99, window: CLOSED })), []);
  // Two hours later, outside business hours: replies still happen, no new emails.
  const later = new Date(T0.getTime() + 2 * 3600_000);
  const log2 = await W.warmupTick({ senders: S, now: later, rand: () => 0.5, window: CLOSED });
  assert.equal(log2.filter(l => /replied/.test(l)).length, 3, log2.join('\n'));
  assert.ok(log2.some(l => /rescued from spam/.test(l)));
  assert.equal(db.T.warmup.length, 3);
  for (const w of db.T.warmup) {
    const got = box(w.to_addr).find(m => m.mid === w.message_id && !m.labelIds.includes('SENT'));
    assert.ok(!got.labelIds.includes('SPAM') && !got.labelIds.includes('UNREAD') && !got.labelIds.includes('INBOX'), JSON.stringify(got.labelIds));
  }
  // Replies land in the senders' threads; the tidy step archives them.
  const tidyTime = new Date(later.getTime() + 15 * 60_000);
  await W.warmupTick({ senders: S, now: tidyTime, rand: () => 0.99, window: CLOSED });
  for (const w of db.T.warmup) {
    assert.equal(w.cleaned, true);
    const inThread = box(w.from_addr).filter(m => m.threadId === w.thread_id && !m.labelIds.includes('SENT'));
    assert.equal(inThread.length, 1, 'the reply threaded under the original');
    assert.ok(!inThread[0].labelIds.includes('INBOX') && !inThread[0].labelIds.includes('UNREAD'));
  }
  const health = await W.warmupHealth();
  assert.equal(health['raghav@getpdfmacro.com'].replied, 1);
  assert.equal(Object.values(health).reduce((a, h) => a + h.spam, 0), 1);
});

test('warm-up paces itself: stops at the day\'s target', async () => {
  const S = (await A['senders.status']()).senders;
  const target = W.senderPlan(S[0], T0).warmTarget;
  for (let i = 0; i < target + 4; i++) await W.warmupTick({ senders: S, now: new Date(T0.getTime() + i * 60_000), rand: () => 0, window: OPEN });
  const fromFirst = db.T.warmup.filter(w => w.from_addr === 'raghav@getpdfmacro.com').length;
  assert.equal(fromFirst, target, `stops at the day's target of ${target}`);
});

test('one inbox cannot warm up alone', async () => {
  assert.deepEqual(await W.warmupTick({ senders: [{ email: 'a@x.com', daily_cap: 10 }], now: T0, window: OPEN }), ['warm-up needs at least two inboxes on different domains']);
});

test('after 14 days, cold sending starts small', async () => {
  const old = new Date(Date.now() - 15 * DAY).toISOString();
  const list = (await A['senders.status']()).senders.map(s => ({ ...s }));
  db.T.settings.find(r => r.key === 'senders').value.forEach(s => { s.started_at = old; });
  void list;
  const n = await A['send.next']({ sender: 'raghav@getpdfmacro.com' });
  assert.equal(n.stop, 'empty', 'no longer warming');
  const digest = await AP.digestText();
  assert.match(digest.text, /raghav@getpdfmacro\.com: up to 5 cold emails today \(max 25\)/);
});

test('DNS check: tells you exactly what to add', async () => {
  const good = await A['dns.check']({ domain: 'good.co' });
  assert.ok(good.checks.every(c => c.ok), JSON.stringify(good.checks));
  const bad = await A['dns.check']({ domain: 'raghav@bad.co' });
  const by = Object.fromEntries(bad.checks.map(c => [c.record, c]));
  assert.equal(by.MX.ok, false); assert.equal(by.DKIM.ok, false); assert.equal(by.DMARC.ok, false);
  assert.equal(by.SPF.ok, false, 'two SPF records is an error');
  assert.match(by.DMARC.fix, /_dmarc\.bad\.co: v=DMARC1; p=none/);
  await assert.rejects(A['dns.check']({ domain: 'pdfmacro.com' }), /product domain/);
});
