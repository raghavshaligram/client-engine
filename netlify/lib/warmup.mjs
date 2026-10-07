// Domain warm-up and the sending ramp.
// New inboxes spend 14 days only trading ordinary emails with each other (and replying), so mailbox
// providers see a sender that real people correspond with. Cold email then starts small and grows.
import { db } from './db.mjs';
import * as gmail from './gmail.mjs';

const DAY = 86_400_000;
export const WARM_DAYS = 14;
const iso = d => new Date(d).toISOString();
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];
const domainOf = e => String(e).split('@')[1] || '';

// What an inbox may do today.
export function senderPlan(s, now = new Date()) {
  const started = Date.parse(s.started_at || now);
  const day = Math.max(0, Math.floor((now.getTime() - started) / DAY));
  const warming = day < WARM_DAYS;
  const coldCap = warming ? 0 : Math.min(s.daily_cap, 5 + Math.floor((day - WARM_DAYS) / 3) * 2);
  const warmTarget = warming ? Math.min(15, 3 + day) : 8;
  return { day, warming, coldCap, warmTarget, coldFrom: iso(started + WARM_DAYS * DAY) };
}

// Ordinary, varied, link-free notes. No product talk, nothing that looks like marketing.
const FIRST = ['Sam', 'Priya', 'Alex', 'Jordan', 'Maya', 'Chris', 'Dana', 'Leo', 'Nina', 'Ravi', 'Emma', 'Omar'];
const TOPICS = [
  ['Thursday call', ['Are we still on for Thursday afternoon? I can do 2 or 3pm, whichever suits you.', 'Quick check that Thursday still works. If not, Friday morning is open on my side.']],
  ['notes from today', ['Thanks for the time earlier. I wrote up the three points we agreed and will send the full version tomorrow.', 'Good chat today. I have the notes and will tidy them up before the end of the week.']],
  ['timeline question', ['Do you have a rough date in mind for the first draft? Even a week range helps me plan.', 'Wanted to check the timeline before I block out next week. Is the end of the month still realistic?']],
  ['the document you mentioned', ['Could you resend the document you mentioned? I can only find the older version.', 'I think I have an outdated copy of the file. Would you mind sending the latest one when you get a minute?']],
  ['lunch next week', ['Are you free for lunch one day next week? Tuesday or Wednesday would be easiest for me.', 'It has been a while. Lunch next week? Happy to come to your side of town.']],
  ['quick question', ['Do you remember who handled the setup last time? I want to ask them a couple of things.', 'Small question: did we decide on the weekly or the monthly report? I have both written down.']],
  ['book recommendation', ['I finished the book you suggested. Really enjoyed the middle chapters. Any other recommendations?', 'Thanks again for the recommendation. I am halfway through and it has been great so far.']],
  ['follow up on Monday', ['Just following up on Monday. Did you get a chance to look at the plan?', 'Circling back on what we discussed Monday. No rush, whenever you have a moment.']],
  ['travel plans', ['Are you still travelling next week? Let me know if we should move our catch-up.', 'Heard you might be away later this month. Should we meet before you go?']],
  ['budget numbers', ['I updated the budget numbers with the new estimates. They came in a little under what we expected.', 'The revised numbers look better than last month. I will walk you through them when we talk.']],
];
const REPLIES = [
  'Thanks, that works for me.', 'Sounds good. Talk soon.', 'Got it, thank you!', 'Perfect, I will get back to you tomorrow.',
  'Thanks for checking. Yes, still on.', 'Appreciate it. Let me look and reply properly later today.', 'Great, see you then.',
  'Thanks! I will send it over shortly.', 'Good timing, I was about to write to you.', 'Yes, that is right. Thanks for confirming.',
];
const SIGNOFF = ['Thanks,', 'Best,', 'Cheers,', 'Talk soon,', 'Thanks again,'];

export function warmEmail(rand = Math.random) {
  const [subject, bodies] = pick(TOPICS, rand);
  const to = pick(FIRST, rand), me = pick(FIRST, rand);
  const subj = rand() < 0.5 ? subject : subject.charAt(0).toUpperCase() + subject.slice(1);
  return { subject: subj, body: `Hi ${to},\n\n${pick(bodies, rand)}\n\n${pick(SIGNOFF, rand)}\n${me}` };
}
export const warmReply = (rand = Math.random) => `${pick(REPLIES, rand)}\n\n${pick(FIRST, rand)}`;

export async function warmupTick({ senders, now = new Date(), rand = Math.random, timeLeft = () => 99999, window }) {
  const log = [];
  const names = Object.fromEntries((await db.select('products', { select: 'id,from_name' })).map(p => [p.id, p.from_name || '']));
  const nameOf = email => names[(senders.find(s => s.email === email) || {}).product_id] || '';
  const inboxes = senders.filter(s => s.mode !== 'browser');
  if (inboxes.length < 2) return inboxes.length ? ['warm-up needs at least two inboxes on different domains'] : [];
  const nowIso = iso(now);

  // 1. Replies that are due: rescue from spam if needed, reply, then mark read and archive.
  const due = await db.select('warmup', { filters: { replied_at: null, error: null, reply_after: ['lte', nowIso] }, order: 'reply_after.asc', limit: 8 });
  for (const w of due) {
    if (timeLeft() < 5000) break;
    try {
      const msg = await gmail.findByMessageId(w.to_addr, w.message_id);
      if (!msg) {
        if (now - Date.parse(w.sent_at) > 3 * 3600_000) await db.update('warmup', { id: w.id }, { error: 'never arrived' });
        continue;
      }
      const spam = (msg.labelIds || []).includes('SPAM');
      if (spam) await gmail.modify(w.to_addr, msg.id, ['INBOX', 'IMPORTANT'], ['SPAM']);
      await gmail.send(w.to_addr, { to: w.from_addr, subject: /^re:/i.test(w.subject) ? w.subject : 'Re: ' + w.subject, body: warmReply(rand), inReplyTo: w.message_id, threadId: msg.threadId, fromName: nameOf(w.to_addr) });
      await gmail.modify(w.to_addr, msg.id, [], ['UNREAD', 'INBOX']);
      await db.update('warmup', { id: w.id }, { replied_at: nowIso, landed_spam: spam });
      log.push(`warm-up: ${w.to_addr} replied to ${w.from_addr}${spam ? ' (rescued from spam)' : ''}`);
    } catch (e) { await db.update('warmup', { id: w.id }, { error: e.message.slice(0, 300) }); }
  }

  // 2. Tidy the senders' inboxes: mark the replies read and archive them.
  const tidy = await db.select('warmup', { filters: { cleaned: false, replied_at: ['lte', iso(now.getTime() - 10 * 60_000)] }, limit: 8 });
  for (const w of tidy) {
    if (timeLeft() < 4000) break;
    try {
      const t = await gmail.thread(w.from_addr, w.thread_id);
      for (const m of t.messages || []) if ((m.labelIds || []).some(l => l === 'UNREAD' || l === 'INBOX' || l === 'SPAM'))
        await gmail.modify(w.from_addr, m.id, (m.labelIds || []).includes('SPAM') ? ['IMPORTANT'] : [], ['UNREAD', 'INBOX', 'SPAM']);
    } catch {}
    await db.update('warmup', { id: w.id }, { cleaned: true });
  }

  // 3. New warm-up emails, paced across business hours like real ones.
  if (!window.open) return log;
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  for (const s of inboxes) {
    if (timeLeft() < 5000) break;
    const plan = senderPlan(s, now);
    const sent = await db.count('warmup', { from_addr: s.email, sent_at: ['gte', iso(today)] });
    const left = plan.warmTarget - sent;
    if (left <= 0 || rand() >= Math.min(1, left / window.slotsLeft)) continue;
    const others = inboxes.filter(o => o.email !== s.email && domainOf(o.email) !== domainOf(s.email));
    if (!others.length) continue;
    const to = pick(others, rand).email;
    const m = warmEmail(rand);
    try {
      const r = await gmail.send(s.email, { to, subject: m.subject, body: m.body, fromName: nameOf(s.email) });
      await db.insert('warmup', [{ from_addr: s.email, to_addr: to, subject: m.subject, message_id: r.messageIdHeader, thread_id: r.threadId, sent_at: nowIso, reply_after: iso(now.getTime() + (20 + rand() * 100) * 60_000) }]);
      log.push(`warm-up: ${s.email} wrote to ${to}`);
    } catch (e) { log.push(`warm-up: ${s.email} could not send: ${e.message}`); }
  }
  return log;
}

// Share of recent warm-up emails that landed in spam, per receiving inbox. Lower is better.
export async function warmupHealth() {
  const rows = await db.select('warmup', { select: 'from_addr,to_addr,landed_spam,replied_at,error', order: 'sent_at.desc', limit: 500 });
  const out = {};
  for (const r of rows) {
    const h = out[r.from_addr] ||= { sent: 0, replied: 0, spam: 0, lost: 0 };
    if (h.sent >= 50) continue;
    h.sent++; if (r.replied_at) h.replied++; if (r.landed_spam) h.spam++; if (r.error) h.lost++;
  }
  return out;
}

// DNS records a Google Workspace sending domain needs, checked through Google's public DNS.
export async function checkDomain(domain) {
  const q = async (name, type) => {
    const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`);
    const d = await r.json().catch(() => ({}));
    return (d.Answer || []).map(a => String(a.data).replace(/^"|"$/g, '').replace(/" "/g, ''));
  };
  const [mx, txt, dkim, dmarc] = await Promise.all([q(domain, 'MX'), q(domain, 'TXT'), q('google._domainkey.' + domain, 'TXT'), q('_dmarc.' + domain, 'TXT')]);
  const spf = txt.find(t => t.startsWith('v=spf1'));
  return [
    { record: 'MX', ok: mx.some(m => /google\.com\.?$/i.test(m)), found: mx.join(', '),
      fix: `MX record on ${domain}: smtp.google.com (priority 1), or the five aspmx records Google gave you.` },
    { record: 'SPF', ok: !!spf && spf.includes('_spf.google.com') && (spf.match(/v=spf1/g) || []).length === 1, found: spf || '',
      fix: `One TXT record on ${domain}: v=spf1 include:_spf.google.com ~all` },
    { record: 'DKIM', ok: dkim.some(t => t.includes('v=DKIM1')), found: dkim[0] ? dkim[0].slice(0, 40) + '…' : '',
      fix: `Workspace Admin > Apps > Google Workspace > Gmail > Authenticate email > Generate new record, add it as a TXT record at google._domainkey.${domain}, then press Start authentication.` },
    { record: 'DMARC', ok: dmarc.some(t => t.startsWith('v=DMARC1')), found: dmarc[0] || '',
      fix: `TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${domain}` },
  ];
}
