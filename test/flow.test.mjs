// End-to-end: import scraper rows, read websites, score, draft, approve, send, follow up, replies, brakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'svc';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.APP_KEY = 'secret-key-123';
process.env.ALLOW_PRIVATE = '1';

const db = fakeDb(), ai = fakeOpenAI();
installFetch({ db, ai, passthrough: true, testHosts: true });
const { default: handler, _actions: A } = await import('../netlify/functions/api.mjs');

// A tiny local "website" for the researcher to read.
const site = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/acme')) return res.end(`<html><head><title>Acme Plumbing | Austin Plumber</title><meta name="description" content="Family-owned plumber in Austin."></head>
    <body><h1>Same-day water heater replacement</h1><p>We have served Austin homeowners for twenty years with honest pricing and fast service.</p>
    <a href="mailto:bob@acme.test">Email Bob</a><span class="__cf_email__" data-cfemail="${cf('jobs@acme.test')}">x</span></body></html>`);
  if (req.url.startsWith('/busy')) return res.end(`<html><head><title>Busy HVAC</title></head><body><h1>Book online today</h1>
    <a href="tel:5125550100">Call</a><script src="https://widget.podium.com/x.js"></script><p>Heating and cooling repairs across central Texas since 1998.</p></body></html>`);
  res.statusCode = 404; res.end('nope');
});
function cf(email) { const key = 0x2a; return key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join(''); }
await new Promise(r => site.listen(0, '127.0.0.1', r));
const port = site.address().port;
const acmeSite = `http://acme.test:${port}/acme`, busySite = `http://busy.test:${port}/busy`;
test.after(() => site.close());

const mapsRow = o => ({ title: '', category: 'Plumber', address: '1 Main St, Austin, TX 78701, United States', website: '', phone: '(512) 555-0100', review_count: '120', review_rating: '4.7', emails: '', status: '', link: 'https://maps.google.com/x', ...o });

test('auth: wrong key is refused', async () => {
  const res = await handler(new Request('http://x/api', { method: 'POST', headers: { 'x-app-key': 'nope' }, body: '{"action":"setup.status"}' }));
  assert.equal(res.status, 401);
  const ok = await handler(new Request('http://x/api', { method: 'POST', headers: { 'x-app-key': 'secret-key-123' }, body: '{"action":"setup.status"}' }));
  assert.equal(ok.status, 200);
});

test('setup seeds the three products once', async () => {
  const s = await A['setup.status']();
  assert.deepEqual(s.products.map(p => p.id), ['keephoa', 'pdfmacro', 'ringsparrow']);
  await A['setup.status']();
  assert.equal(db.T.products.length, 3);
  await A['products.save']({ product: { id: 'ringsparrow', from_name: 'Raghav Shaligram', postal_address: 'PO Box 1, Austin, TX 78701' } });
  await A['senders.save']({ list: [{ email: 'Raghav@GetRingSparrow.co', product_id: 'ringsparrow', segment: 'trades', daily_cap: 2, warmed: true }] });
});

test('import cleans scraper rows', async () => {
  const rows = [
    mapsRow({ title: 'Acme Plumbing', website: acmeSite, emails: 'info@acme.test' }),
    mapsRow({ title: 'Busy HVAC', category: 'HVAC contractor', website: busySite, emails: 'jane@busy.test, noreply@busy.test' }),
    mapsRow({ title: 'Roto-Rooter Plumbing', website: 'https://rotorooter.com', emails: 'x@rotorooter.com' }),
    mapsRow({ title: 'No Site Co', emails: 'a@b.com' }),
    mapsRow({ title: 'Gmail Guy', website: 'https://gmailguy.com', emails: 'gmailguy@gmail.com' }),
    mapsRow({ title: 'Image Email', website: 'https://img.com', emails: 'logo@2x.png' }),
    mapsRow({ title: 'London Plumbers', website: 'https://lp.co.uk', emails: 'bob@lp.co.uk', address: '1 High St, London SW1, United Kingdom' }),
    mapsRow({ title: 'Acme Plumbing again', website: acmeSite, emails: 'info@acme.test' }),
  ];
  const r = await A['prospects.import']({ productId: 'ringsparrow', segment: 'trades', kind: 'maps', rows, sourceFile: 'results.csv' });
  assert.equal(r.added, 2, JSON.stringify(r));
  assert.equal(r.skipped['chain or franchise'], 1);
  assert.equal(r.skipped['no website'], 1);
  assert.equal(r.skipped["email is not on the business's own domain"], 1);
  assert.equal(r.skipped['not in the US'], 1);
  assert.equal(r.skipped['duplicate in file'], 1);
  // importing again adds nobody
  const again = await A['prospects.import']({ productId: 'ringsparrow', segment: 'trades', kind: 'maps', rows: rows.slice(0, 2), sourceFile: 'results.csv' });
  assert.equal(again.added, 0);
  assert.equal(again.skipped['already in the list'], 2);
  const busy = db.T.prospects.find(p => p.name === 'Busy HVAC');
  assert.equal(busy.email, 'jane@busy.test', 'prefers a named person over noreply');
});

test('researcher reads sites and scores', async () => {
  const r = await A['prospects.scan']({ productId: 'ringsparrow' });
  assert.equal(r.left, 0);
  const acme = db.T.prospects.find(p => p.name === 'Acme Plumbing');
  const busy = db.T.prospects.find(p => p.name === 'Busy HVAC');
  assert.equal(acme.status, 'scanned');
  assert.equal(acme.signals.small, true);
  assert.equal(acme.signals.chat, false);
  assert.match(acme.site_text, /water heater/);
  assert.equal(busy.signals.chat, true); assert.equal(busy.signals.booking, true); assert.equal(busy.signals.click_to_call, true);
  // acme: trade +3, busy +2, no chat/booking/tel +3, small +1, generic -1 = 8 ; busy: +3 +2 = 5
  assert.equal(acme.score, 8, acme.score_why);
  assert.equal(busy.score, 5, busy.score_why);
});

test('writer drafts the best prospect, checker passes it', async () => {
  const r = await A['draft.next']({ productId: 'ringsparrow' });
  assert.equal(r.prospect, 'Acme Plumbing');
  assert.ok(r.drafted);
  const m = db.T.messages[0];
  assert.equal(m.step, 1); assert.equal(m.check_score, 8);
  assert.ok(['missed', 'nomonthly', 'resell'].includes(m.angle));
  assert.equal(db.T.prospects.find(p => p.name === 'Acme Plumbing').status, 'drafted');
  const q = await A['queue.list']({ productId: 'ringsparrow' });
  assert.match(q.messages[0].footer, /PO Box 1/);
  assert.match(q.messages[0].footer, /Reply "no"/);
});

test('failing drafts are rewritten once, then dropped', async () => {
  const before = ai.calls.length;
  const bad = { skip: false, detail: 'x', subject: 'hi', body: 'We have 500 happy customers. Buy now at https://evil.example.com and https://x.com. No question here.' };
  const saved = { ...ai };
  ai.handle = fakeOpenAI({ writer: () => bad, checker: () => ({ score: 3, problems: ['invented customer count'] }) }).handle;
  const r1 = await A['draft.next']({ productId: 'ringsparrow' });
  assert.ok(r1.retry); assert.equal(r1.prospect, 'Busy HVAC');
  assert.ok(r1.feedback.some(f => /customer count/.test(f)));
  assert.ok(r1.feedback.some(f => /links/.test(f)));
  const r2 = await A['draft.next']({ productId: 'ringsparrow', prospectId: r1.prospectId, feedback: r1.feedback, attempt: 2 });
  assert.ok(r2.dropped);
  const busy = db.T.prospects.find(p => p.name === 'Busy HVAC');
  assert.equal(busy.status, 'skipped'); assert.match(busy.skip_reason, /failed checks twice/);
  ai.handle = saved.handle;
  assert.ok(ai.calls.length >= before);
});

test('writer may skip when there is no real detail', async () => {
  await A['prospects.update']({ id: db.T.prospects.find(p => p.name === 'Busy HVAC').id, patch: { status: 'scanned', skip_reason: null } });
  const saved = ai.handle;
  ai.handle = fakeOpenAI({ writer: () => ({ skip: true, skip_reason: 'site has nothing specific' }) }).handle;
  const r = await A['draft.next']({ productId: 'ringsparrow' });
  assert.equal(r.skipped, 'site has nothing specific');
  ai.handle = saved;
});

test('sending: needs approval, respects segment, cap, footer, and threads follow-ups', async () => {
  let n = await A['send.next']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(n.stop, 'empty', 'drafts are never sent until approved');
  const m = db.T.messages.find(x => x.status === 'draft');
  await A['message.save']({ id: m.id, body: m.body + '\nP.S. edited', status: 'approved' });
  assert.equal(db.T.messages.find(x => x.id === m.id).edited, true);
  n = await A['send.next']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(n.message.to, 'info@acme.test');
  assert.match(n.message.body, /PO Box 1/);
  assert.match(n.message.body, /Reply "no" and I won't email you again/);
  assert.equal(n.message.threadId, null);
  await A['send.done']({ messageId: m.id, sender: 'raghav@getringsparrow.co', gmailId: 'g1', threadId: 't1', messageIdHeader: '<a@x>' });
  const acme = db.T.prospects.find(p => p.name === 'Acme Plumbing');
  assert.equal(acme.status, 'contacted'); assert.equal(acme.step, 1); assert.equal(acme.sender, 'raghav@getringsparrow.co');
  const dueIn = (Date.parse(acme.next_due_at) - Date.now()) / 86400000;
  assert.ok(dueIn > 3.9 && dueIn < 4.1, 'RingSparrow follow-up due day 4, got ' + dueIn);

  // Make the follow-up due now and draft it: it threads.
  acme.next_due_at = new Date(Date.now() - 1000).toISOString();
  const saved = ai.handle;
  ai.handle = fakeOpenAI({ writer: () => ({ skip: false, detail: '', subject: '', body: 'One more thing: your list stays on your computer, not ours. Would that matter for you?\n\nRaghav' }) }).handle;
  const d = await A['draft.next']({ productId: 'ringsparrow' });
  ai.handle = saved;
  assert.ok(d.drafted, JSON.stringify(d));
  const f = db.T.messages.find(x => x.id === d.drafted);
  assert.equal(f.step, 2); assert.equal(f.subject, 'Re: missed calls at Acme');
  await A['message.save']({ id: f.id, status: 'approved' });
  n = await A['send.next']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(n.message.threadId, 't1'); assert.equal(n.message.inReplyTo, '<a@x>');
  await A['send.done']({ messageId: f.id, sender: 'raghav@getringsparrow.co', gmailId: 'g2', threadId: 't1', messageIdHeader: '<b@x>' });
  // cap of 2 reached
  n = await A['send.next']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(n.stop, 'cap');
});

test('sending refuses without name and postal address, and from unknown inboxes', async () => {
  await assert.rejects(A['send.next']({ sender: 'someone@else.com' }), /not set up/);
  await A['senders.save']({ list: [{ email: 'raghav@getringsparrow.co', product_id: 'ringsparrow', segment: 'trades', daily_cap: 2, warmed: true }, { email: 'r@getpdfmacro.com', product_id: 'pdfmacro', daily_cap: 10, warmed: true }] });
  const n = await A['send.next']({ sender: 'r@getpdfmacro.com' });
  assert.equal(n.stop, 'setup');
});

test('replies: interested stops the sequence; opt-out suppresses everywhere', async () => {
  const acme = db.T.prospects.find(p => p.name === 'Acme Plumbing');
  const w = await A['replies.watch']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(w.threads.length, 1); assert.deepEqual(w.knownIds.sort(), ['g1', 'g2']);
  const r = await A['replies.add']({ prospectId: acme.id, gmailId: 'r1', from: 'Bob <bob@acme.test>', subject: 'Re: missed calls', body: 'Sure, send the video.' });
  assert.equal(r.reply.label, 'interested'); assert.equal(r.reply.handled, false);
  assert.equal(db.T.prospects.find(p => p.id === acme.id).status, 'interested');
  const dup = await A['replies.add']({ prospectId: acme.id, gmailId: 'r1', from: 'x', subject: '', body: 'x' });
  assert.ok(dup.duplicate);

  // Same address in another product, then an opt-out.
  await A['prospects.import']({ productId: 'pdfmacro', segment: 'family', kind: 'maps', rows: [mapsRow({ title: 'Acme Law', category: 'Family law attorney', website: 'https://acmelaw.com', emails: 'bob@acmelaw.com' })], sourceFile: 'f.csv' });
  const law = db.T.prospects.find(p => p.email === 'bob@acmelaw.com');
  const o = await A['replies.add']({ prospectId: law.id, gmailId: 'r2', from: 'bob@acmelaw.com', subject: 'Re: hi', body: 'No thanks. Please remove me.' });
  assert.equal(o.reply.label, 'unsubscribe');
  assert.ok(db.T.suppression.find(s => s.email === 'bob@acmelaw.com'));
  assert.equal(db.T.prospects.find(p => p.id === law.id).status, 'done');
  // Re-importing that address is blocked.
  db.T.prospects = db.T.prospects.filter(p => p.id !== law.id);
  const again = await A['prospects.import']({ productId: 'pdfmacro', segment: 'family', kind: 'maps', rows: [mapsRow({ title: 'Acme Law', category: 'Family law attorney', website: 'https://acmelaw.com', emails: 'bob@acmelaw.com' })], sourceFile: 'f.csv' });
  assert.equal(again.added, 0); assert.equal(again.skipped['on the do-not-contact list'], 1);
});

test('reply labels: bounce, auto-reply, not now', async () => {
  const { quickLabel } = await import('../netlify/lib/brain.mjs');
  assert.equal(quickLabel({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: '' }), 'bounce');
  assert.equal(quickLabel({ from: 'a@b.com', subject: 'Automatic reply: hi', body: '' }), 'auto_reply');
  assert.equal(quickLabel({ from: 'a@b.com', subject: 'Re: hi', body: 'stop\n\nOn Tue...' }), 'unsubscribe');
  assert.equal(quickLabel({ from: 'a@b.com', subject: 'Re: hi', body: 'Not right now, maybe in spring' }), '');
});

test('brakes: a complaint pauses sending until resumed', async () => {
  const acme = db.T.prospects.find(p => p.name === 'Acme Plumbing');
  const saved = ai.handle;
  ai.handle = fakeOpenAI({ reader: () => ({ label: 'angry', summary: 'calls it spam', answer: '' }) }).handle;
  const r = await A['replies.add']({ prospectId: acme.id, gmailId: 'r3', from: 'bob@acme.test', subject: 'Re: x', body: 'This is spam. How did you get my address?' });
  ai.handle = saved;
  assert.equal(r.reply.label, 'angry');
  assert.match(r.brake, /spam or complaining/);
  const n = await A['send.next']({ sender: 'raghav@getringsparrow.co' });
  assert.equal(n.stop, 'paused');
  await A['products.resume']({ id: 'ringsparrow' });
  assert.equal(db.T.products.find(p => p.id === 'ringsparrow').paused, false);
});

test('KeepHOA registry import: one email + one follow-up, reason line in footer', async () => {
  await A['products.save']({ product: { id: 'keephoa', from_name: 'Raghav Shaligram', postal_address: 'PO Box 1, Austin, TX 78701' } });
  const rows = [
    { name: 'Maple Court HOA', email: 'treasurer@maplecourt.org', city: 'Denver', state: 'CO', units: '24', manager: 'Self Managed', self_managed: '' },
    { name: 'Big Towers Condo', email: 'board@acmepropertymanagement.com', city: 'Denver', state: '', units: '400', manager: 'Acme Property Management' },
    { name: '', email: 'x@y.com' },
    { name: 'No Email HOA', email: '' },
  ];
  const r = await A['prospects.import']({ productId: 'keephoa', segment: 'colorado', kind: 'registry', rows, sourceFile: 'co.csv', defaultState: 'CO' });
  assert.equal(r.added, 2, JSON.stringify(r));
  const maple = db.T.prospects.find(p => p.name === 'Maple Court HOA');
  const towers = db.T.prospects.find(p => p.name === 'Big Towers Condo');
  assert.equal(maple.status, 'scanned', 'registry rows skip the website step');
  assert.equal(maple.self_managed, true);
  assert.equal(maple.score, 7, maple.score_why); // +3 self-managed, +2 small (manager listed so no +2)
  assert.equal(towers.state, 'CO');
  assert.ok(towers.score < maple.score, towers.score_why);
  const q = await A['draft.next']({ productId: 'keephoa' });
  assert.equal(q.prospect, 'Maple Court HOA');
  const list = await A['queue.list']({ productId: 'keephoa' });
  const msg = list.messages.find(m => m.prospect.name === 'Maple Court HOA');
  assert.match(msg.footer, /CO public HOA registry/);
  // KeepHOA link carries a tracking tag; RingSparrow's does not.
  const { landingLink } = await import('../netlify/lib/brain.mjs');
  const kp = db.T.products.find(p => p.id === 'keephoa'), rp = db.T.products.find(p => p.id === 'ringsparrow');
  assert.match(landingLink(kp, 'colorado'), /utm_campaign=colorado/);
  assert.doesNotMatch(landingLink(rp, 'trades'), /utm_/);
  // Two emails, then done (no rest).
  await A['senders.save']({ list: [{ email: 'r@getkeephoa.com', product_id: 'keephoa', daily_cap: 10, warmed: true }] });
  await A['message.save']({ id: msg.id, status: 'approved' });
  let n = await A['send.next']({ sender: 'r@getkeephoa.com' });
  await A['send.done']({ messageId: n.message.id, sender: 'r@getkeephoa.com', gmailId: 'k1', threadId: 'kt1', messageIdHeader: '<k1@x>' });
  const after1 = db.T.prospects.find(p => p.id === maple.id);
  assert.equal(after1.status, 'contacted');
  assert.ok(Math.abs((Date.parse(after1.next_due_at) - Date.now()) / 86400000 - 7) < 0.1);
  after1.next_due_at = new Date(Date.now() - 1).toISOString();
  const d2 = await A['draft.next']({ productId: 'keephoa' });
  await A['message.save']({ id: d2.drafted, status: 'approved' });
  n = await A['send.next']({ sender: 'r@getkeephoa.com' });
  await A['send.done']({ messageId: n.message.id, sender: 'r@getkeephoa.com', gmailId: 'k2', threadId: 'kt1', messageIdHeader: '<k2@x>' });
  const after2 = db.T.prospects.find(p => p.id === maple.id);
  assert.equal(after2.status, 'done'); assert.equal(after2.next_due_at, null);
});

test('stats add up', async () => {
  const s = await A['stats']({ productId: 'ringsparrow' });
  assert.equal(s.totals.people, 1); assert.equal(s.totals.emails, 2);
  assert.equal(s.totals.replied, 1); assert.equal(s.totals.positive, 1);
  assert.equal(s.editRate, 100);
});
