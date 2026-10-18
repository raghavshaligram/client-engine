// Deals: everything after a prospect replies. The closer (an AI that answers in the thread,
// sends the mockup and the offer, and hands anything unusual to you), the outbox that sends
// its messages inside the same Gmail thread, and the small helpers every stage uses.
import crypto from 'node:crypto';
import { db } from '../db.mjs';
import { ai, prospectFacts } from '../brain.mjs';
import * as gmail from '../gmail.mjs';
import { senders, suppress, checkBrakes } from '../actions.mjs';

const DAY = 86_400_000, MIN = 60_000;
export const iso = d => new Date(d).toISOString();
export const conf = product => product?.rules?.agency || null;
export const isAgency = product => !!conf(product);
export const PAID = ['intake', 'building', 'qa', 'owner_check', 'client_review', 'domain', 'live'];

export const publicUrl = () => (process.env.PUBLIC_URL || process.env.URL || '').replace(/\/+$/, '');
export function links(deal) {
  const b = publicUrl();
  return { mockup: `${b}/m/${deal.slug}`, offer: `${b}/start/${deal.slug}`, intake: `${b}/intake/${deal.slug}`, review: `${b}/review/${deal.slug}`, form: `${b}/f/${deal.slug}` };
}

export function slugify(name) {
  const base = String(name || 'site').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

export const firstName = full => String(full || '').trim().split(/\s+/)[0] || '';

export async function getProduct(id) { return db.one('products', { id }); }

export async function dealFor(prospect) {
  const hit = await db.one('deals', { prospect_id: prospect.id });
  if (hit) return hit;
  const [row] = await db.insertIgnore('deals', [{ prospect_id: prospect.id, product_id: prospect.product_id, slug: slugify(prospect.name), stage: 'talking', customer_email: prospect.email }], 'prospect_id');
  return row || db.one('deals', { prospect_id: prospect.id });
}

// Update a deal and add a line to its history in one go.
export async function touch(deal, patch = {}, note) {
  const log = Array.isArray(deal.log) ? deal.log : [];
  const next = { ...patch, updated_at: iso(Date.now()) };
  if (note) next.log = [...log, { at: iso(Date.now()), note: String(note).slice(0, 300) }].slice(-80);
  const [row] = await db.update('deals', { id: deal.id }, next);
  Object.assign(deal, row || next);
  return deal;
}

// Emails to you: escalations, new clients, sites waiting for your OK.
export async function notifyOwner(subject, body) {
  const to = process.env.DIGEST_TO;
  const from = (await senders()).find(s => s.mode !== 'browser');
  if (!to || !from || !gmail.serverGmailReady()) return false;
  try { await gmail.send(from.email, { to, subject, body, fromName: 'Client Engine' }); return true; } catch { return false; }
}

export async function escalate(deal, prospect, reason) {
  await touch(deal, { needs_human: true, human_reason: String(reason).slice(0, 400) }, 'handed to you: ' + reason);
  await notifyOwner(`Needs you: ${prospect.name}`, `${prospect.name} <${prospect.email}>\nStage: ${deal.stage}\nWhy: ${reason}\n\n${await transcript(prospect, 6)}\n\nOpen Client Engine > Agency to answer, or hand it back to the AI.`);
}

// ---- The conversation, oldest first -------------------------------------------
export async function conversation(prospect) {
  const [sent, replies, out] = await Promise.all([
    db.select('messages', { select: 'body,subject,sent_at', filters: { prospect_id: prospect.id, status: 'sent' }, order: 'sent_at.asc', limit: 20 }),
    db.select('replies', { select: 'body,received_at,label', filters: { prospect_id: prospect.id }, order: 'received_at.asc', limit: 40 }),
    db.select('outbox', { select: 'body,sent_at,kind', filters: { prospect_id: prospect.id, status: 'sent', to_addr: null }, order: 'sent_at.asc', limit: 40 }),
  ]);
  return [
    ...sent.map(m => ({ at: m.sent_at, who: 'US', text: m.body })),
    ...replies.filter(r => r.label !== 'auto_reply').map(r => ({ at: r.received_at, who: 'THEM', text: r.body })),
    ...out.map(m => ({ at: m.sent_at, who: 'US', text: m.body })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function transcript(prospect, last = 12) {
  const c = (await conversation(prospect)).slice(-last);
  return c.map(e => `[${e.who}, ${String(e.at).slice(0, 10)}]\n${String(e.text || '').slice(0, 1500)}`).join('\n\n');
}

// ---- Sending inside the thread --------------------------------------------------
// Replies to people go out 7am to 9pm US Central, any day: it's a conversation, not a cold email.
export function inWindow(d) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(d));
  return h >= 7 && h < 21;
}
export function nextSendTime(from = new Date(), rand = Math.random) {
  let t = new Date(from.getTime());
  for (let i = 0; i < 24 * 6 && !inWindow(t); i++) t = new Date(t.getTime() + 10 * MIN);
  return t;
}

// immediate: for messages the person is waiting on right now (after paying, after approving).
export async function queue({ deal, prospect, body, kind = 'reply', delay = [4, 14], hold = null, to = null, replyTo = null, subject = null, immediate = false, rand = Math.random }) {
  const wait = to || immediate ? 0 : (delay[0] + rand() * (delay[1] - delay[0])) * MIN;
  const at = to || immediate ? new Date(Date.now() + wait) : nextSendTime(new Date(Date.now() + wait), rand);
  const [row] = await db.insert('outbox', [{
    deal_id: deal?.id || null, prospect_id: prospect.id, kind, body, send_at: iso(at),
    status: hold ? 'held' : 'queued', hold_for: hold, to_addr: to, reply_to: replyTo, subject,
  }]);
  return row;
}

function fill(text, deal) {
  const l = links(deal);
  return text.replace(/\{\{MOCKUP_LINK\}\}/g, l.mockup).replace(/\{\{OFFER_LINK\}\}/g, l.offer)
    .replace(/\{\{INTAKE_LINK\}\}/g, l.intake).replace(/\{\{REVIEW_LINK\}\}/g, l.review)
    .replace(/\{\{PREVIEW_LINK\}\}/g, deal.preview_url || l.review);
}

export async function sendOutbox({ timeLeft = () => 99999, now = new Date(), limit = 6 } = {}) {
  const log = [];
  const due = await db.select('outbox', { filters: { status: 'queued', send_at: ['lte', iso(now)] }, order: 'send_at.asc', limit });
  for (const m of due) {
    if (timeLeft() < 4000) break;
    const p = await db.one('prospects', { id: m.prospect_id });
    const deal = m.deal_id ? await db.one('deals', { id: m.deal_id }) : null;
    try {
      if (!p?.sender) throw new Error('no sending inbox recorded for this person');
      const product = await getProduct(p.product_id);
      const body = (deal ? fill(m.body, deal) : m.body).trim();
      if (m.to_addr) {
        await gmail.send(p.sender, { to: m.to_addr, subject: m.subject || `Message from ${product.name}`, body, fromName: `${product.name} website`, replyTo: m.reply_to || undefined });
      } else {
        const [first] = await db.select('messages', { select: 'subject', filters: { prospect_id: p.id, step: 1 }, limit: 1 });
        const [last] = await db.select('replies', { select: 'message_id', filters: { prospect_id: p.id, message_id: ['not.is', null] }, order: 'received_at.desc', limit: 1 });
        const subj = (first?.subject || m.subject || product.name).replace(/^re:\s*/i, '');
        const r = await gmail.send(p.sender, {
          to: p.email, subject: 'Re: ' + subj, body, fromName: product.from_name,
          threadId: p.thread_id || null, inReplyTo: last?.message_id || p.last_message_id || null,
        });
        await db.update('prospects', { id: p.id }, { last_sent_at: iso(Date.now()), last_message_id: r.messageIdHeader || p.last_message_id, thread_id: p.thread_id || r.threadId });
        m.gmail_id = r.gmailId;
      }
      await db.update('outbox', { id: m.id }, { status: 'sent', sent_at: iso(Date.now()), gmail_id: m.gmail_id || null, body });
      log.push(`sent ${m.kind} to ${p.name}`);
    } catch (e) {
      await db.update('outbox', { id: m.id }, { status: 'failed', error: String(e.message).slice(0, 400) });
      log.push(`could not send ${m.kind} to ${p?.name}: ${e.message}`);
      if (deal && p) await escalate(deal, p, `an email could not be sent: ${e.message}`).catch(() => {});
    }
  }
  return log;
}

// ---- The closer ------------------------------------------------------------------
const STAGE_HELP = {
  talking: 'They replied to a cold email. Nothing has been sent yet besides the cold emails.',
  mockup_queued: 'Their mockup is being made and will be sent shortly.',
  mockup_sent: 'They have the mockup link ({{MOCKUP_LINK}}).',
  offer_sent: 'They have the mockup and the page with packages and checkout ({{OFFER_LINK}}).',
  rest: 'They said not now earlier.',
  intake: 'They PAID for the website. They have the details form ({{INTAKE_LINK}}). We build once they send it.',
  building: 'They PAID. We are building their site now (or applying their changes).',
  qa: 'They PAID. The site is built and going through our speed and mobile checks.',
  owner_check: 'They PAID. The site is built and waiting for a final check before they see it.',
  client_review: 'They PAID. Their site is ready for them to review at {{REVIEW_LINK}}.',
  domain: 'They PAID and approved the site. We are waiting for them to point their domain (one DNS change; instructions were emailed).',
  live: 'Their site is LIVE.',
  lost: 'They said no earlier.',
};

const ACTIONS = `Actions:
- "reply": answer them.
- "send_mockup": they want the free mockup (any yes, sure, ok, send it). Your reply must contain {{MOCKUP_LINK}} once and ask what they think.
- "revise_mockup": they want changes to the mockup before deciding. Put the changes in "notes"; your reply says you will send an updated version shortly and contains {{MOCKUP_LINK}}.
- "send_offer": they like it or ask about price or next steps. Your reply gives the price in one line, how it works (pay, a short form, about 7 days to a site they review) and contains {{OFFER_LINK}}.
- "not_now": they say maybe later, busy, wrong time. Reply briefly and kindly, no pitch.
- "close": they are not interested or say no. No reply is sent.
- "note": after payment, they send a detail for their site (hours, a service, a photo request). Put it in "notes"; reply confirming.
- "change_request": after they have seen their finished site, they want changes. Put the full list in "notes"; reply confirming.
- "escalate": a person must handle it (see the rules). Put why in "escalate_reason"; no reply is sent by you.`;

const CLOSER = `You answer emails for a small web design studio, writing as the founder, in an ongoing email thread with a local business owner.
The studio's offer, prices and facts are in the AGENCY FILE. Facts about the business and its current website are in PROSPECT. You may only state facts found there.
Rules:
- Answer what they actually asked, first. Short: usually 2 to 5 sentences, never over 140 words. Plain text, no bullet points, no em dashes, no exclamation marks.
- Sign off with the founder's first name only.
- Links: only these placeholders, written exactly: {{MOCKUP_LINK}}, {{OFFER_LINK}}, {{INTAKE_LINK}}, {{REVIEW_LINK}}. Never write any other URL.
- Prices: only the package prices in the AGENCY FILE. Never offer discounts, custom prices, payment plans or refunds.
- Never promise rankings, traffic, leads or revenue. Never claim past clients, reviews or a portfolio.
- If they ask whether this is automated or AI: answer honestly using the FAQ.
- If they ask for a call, offer to answer here by email first; if they insist on a call, escalate.
- Escalate when: they ask for a discount or custom price; they want something outside the packages (online store, logins, booking system, more than 5 pages, another language, logo design); legal, contract, invoice or refund questions; a complaint or frustration; they want a call; they mention a competitor's quote to negotiate; anything you are not sure is covered by the files; a message you do not understand.
- Never ask for passwords or login details.
${ACTIONS}
Return JSON: {"intent":"interested|question|not_now|not_interested|wrong_person|angry|unsubscribe|other","action":"...","reply":"...","notes":"","escalate_reason":"","confidence":0.0}`;

function agencyFile(product) {
  const c = conf(product);
  const pk = c.packages.map(p => `- ${p.name}: $${p.price}${p.kind === 'monthly' ? ' a month' : ' one time'}. ${p.summary}`).join('\n');
  return `AGENCY: ${product.name}
FOUNDER FIRST NAME: ${firstName(product.from_name) || 'the founder'}
PACKAGES:
${pk}
WHAT IS TRUE (the only claims you may make):
${product.proof}
FAQ:
${c.faq}
NEVER SAY:
${product.never_say}`;
}

const READER_CHECK = `You are a strict editor checking an email reply before it is sent in a conversation with a business owner.
Score 1-10. Deduct heavily for: any claim, price, timeline or promise not supported by the AGENCY FILE; not answering what they asked; inventing facts about their business; pushiness; more than one question; anything on the NEVER SAY list.
Return JSON: {"score": n, "problems": ["..."]}`;

export function lintReply(dec, { deal, product }) {
  const problems = [];
  const t = String(dec.reply || '');
  const c = conf(product);
  const needs = ['reply', 'send_mockup', 'revise_mockup', 'send_offer', 'note', 'change_request', 'not_now'];
  if (needs.includes(dec.action) && dec.action !== 'not_now' && !t.trim()) problems.push('reply is empty');
  if (/https?:\/\/|www\.[a-z]/i.test(t)) problems.push('contains a raw link; use the placeholders only');
  const used = t.match(/\{\{[A-Z_]+\}\}/g) || [];
  const allowed = new Set(['{{OFFER_LINK}}']);
  if (deal.mockup || ['send_mockup', 'revise_mockup'].includes(dec.action)) allowed.add('{{MOCKUP_LINK}}');
  if (PAID.includes(deal.stage)) allowed.add('{{INTAKE_LINK}}');
  if (deal.preview_url) allowed.add('{{REVIEW_LINK}}');
  for (const u of used) if (!allowed.has(u)) problems.push(`${u} is not available at this stage`);
  if (dec.action === 'send_mockup' && !used.includes('{{MOCKUP_LINK}}')) problems.push('send_mockup needs {{MOCKUP_LINK}}');
  if (dec.action === 'send_offer' && !used.includes('{{OFFER_LINK}}')) problems.push('send_offer needs {{OFFER_LINK}}');
  const prices = new Set(c.packages.map(p => p.price));
  for (const m of t.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)) if (!prices.has(Number(m[1].replace(/,/g, '')))) problems.push(`price $${m[1]} is not a package price`);
  if (/guarantee|first page of google|rank #?1|double your|triple your|more leads guaranteed|100%/i.test(t)) problems.push('makes a promise');
  if (/password|log ?in details|login details|credentials/i.test(t) && !/never|don't need|do not need/i.test(t)) problems.push('asks for login details');
  if ((t.match(/\b\w+\b/g) || []).length > 160) problems.push('too long');
  return problems;
}

export async function decide({ product, prospect, deal, latest, feedback }) {
  const c = conf(product);
  const user = `${agencyFile(product)}

PROSPECT:
${prospectFacts(prospect)}

DEAL STAGE: ${deal.stage}. ${STAGE_HELP[deal.stage] || ''}
${deal.mockup ? 'Their mockup exists.' : 'No mockup has been made yet.'}${deal.growth_status === 'active' ? ' They pay for Growth (small edits included).' : ''}
Changes used: ${deal.revisions_used} of ${c.revisions}.

CONVERSATION SO FAR (oldest first):
${await transcript(prospect, 12)}

THEIR NEWEST MESSAGE (answer this):
${String(latest.body || '').slice(0, 3000)}
${feedback?.length ? `\nYOUR LAST DRAFT FAILED THESE CHECKS, FIX THEM:\n- ${feedback.join('\n- ')}` : ''}`;
  const out = await ai(CLOSER, user, { temperature: 0.3 });
  const dec = {
    intent: String(out.intent || 'other'), action: String(out.action || 'escalate'), reply: String(out.reply || '').replace(/\s*[—–]\s*/g, ', ').trim(),
    notes: String(out.notes || '').trim(), escalate_reason: String(out.escalate_reason || '').trim(), confidence: Number(out.confidence) || 0,
  };
  if (!['reply', 'send_mockup', 'revise_mockup', 'send_offer', 'not_now', 'close', 'note', 'change_request', 'escalate'].includes(dec.action)) dec.action = 'escalate';
  return { dec, user };
}

async function checked({ product, prospect, deal, latest }) {
  let feedback;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { dec, user } = await decide({ product, prospect, deal, latest, feedback });
    if (['escalate', 'close'].includes(dec.action) || ['unsubscribe', 'angry'].includes(dec.intent)) return dec;
    if (dec.action === 'not_now' && !dec.reply) return dec;
    const problems = lintReply(dec, { deal, product });
    if (!problems.length) {
      const chk = await ai(READER_CHECK, `${user}\n\nDRAFT REPLY:\n${dec.reply}`, { temperature: 0 });
      const score = Number(chk.score) || 0;
      if (score >= 7) return { ...dec, check_score: score };
      problems.push(...(Array.isArray(chk.problems) ? chk.problems.map(String) : ['editor score ' + score]));
    }
    feedback = problems;
  }
  return { action: 'escalate', intent: 'other', escalate_reason: 'the AI could not write a reply that passed the checks: ' + (feedback || []).slice(0, 3).join('; ') };
}

// Called by the agency tick for each new reply the closer has not handled yet.
export async function handleReply(reply) {
  const prospect = await db.one('prospects', { id: reply.prospect_id });
  const product = await getProduct(prospect.product_id);
  const c = conf(product);
  const deal = await dealFor(prospect);
  const done = async (label, extra = {}) => {
    await db.update('replies', { id: reply.id }, { label, handled: true, ...extra });
    await touch(deal, { pending_reply: false });
    return label;
  };
  if (deal.needs_human) {
    await db.update('replies', { id: reply.id }, { label: 'needs_you', handled: false });
    await touch(deal, { pending_reply: false });
    await notifyOwner(`New message from ${prospect.name} (waiting for you)`, `${prospect.name} wrote:\n\n${String(reply.body).slice(0, 2000)}\n\nThis conversation is with you. Open Client Engine > Agency.`);
    return 'needs_you';
  }
  if (!PAID.includes(deal.stage) && deal.auto_messages >= c.max_auto_messages) {
    await escalate(deal, prospect, `the AI has already sent ${deal.auto_messages} messages without a sale`);
    await db.update('replies', { id: reply.id }, { label: 'needs_you', handled: false });
    await touch(deal, { pending_reply: false });
    return 'needs_you';
  }

  const dec = await checked({ product, prospect, deal, latest: reply });
  const reasonLow = dec.action !== 'escalate' && dec.action !== 'close' && dec.confidence < 0.6 ? `the AI was unsure (confidence ${dec.confidence})` : '';

  if (dec.intent === 'unsubscribe') { await suppress(prospect.email, 'asked not to be emailed'); await touch(deal, { stage: PAID.includes(deal.stage) ? deal.stage : 'lost' }, 'asked not to be emailed'); return done('unsubscribe'); }
  if (dec.intent === 'angry' && !PAID.includes(deal.stage)) {
    await suppress(prospect.email, 'complained');
    await db.update('replies', { id: reply.id }, { label: 'angry', handled: false });
    await touch(deal, { stage: 'lost', pending_reply: false }, 'complained');
    await checkBrakes(prospect.product_id);
    await notifyOwner(`Complaint from ${prospect.name}`, `${String(reply.body).slice(0, 2000)}\n\nThey are on the do-not-contact list now. Sending for ${product.name} is paused if the brakes tripped.`);
    return 'angry';
  }
  if (dec.action === 'escalate' || reasonLow) {
    await escalate(deal, prospect, dec.escalate_reason || reasonLow || 'the AI chose not to answer');
    await db.update('replies', { id: reply.id }, { label: 'needs_you', handled: false, answer: dec.reply || null });
    await touch(deal, { pending_reply: false });
    return 'needs_you';
  }
  if (dec.action === 'close') {
    if (!PAID.includes(deal.stage)) { await suppress(prospect.email, 'not interested'); await touch(deal, { stage: 'lost' }, 'said no'); }
    return done('not_interested');
  }

  const patch = { auto_messages: deal.auto_messages + 1 };
  let hold = null, kind = 'reply';
  if (dec.action === 'send_mockup' || dec.action === 'revise_mockup') {
    if (dec.action === 'revise_mockup' || !deal.mockup) {
      Object.assign(patch, { stage: PAID.includes(deal.stage) ? deal.stage : 'mockup_queued', mockup_notes: dec.action === 'revise_mockup' ? [deal.mockup_notes, dec.notes].filter(Boolean).join('\n') : deal.mockup_notes, mockup: dec.action === 'revise_mockup' ? null : deal.mockup });
      hold = 'mockup';
    } else if (!PAID.includes(deal.stage)) patch.stage = 'mockup_sent';
  }
  if (dec.action === 'send_offer' && !PAID.includes(deal.stage)) patch.stage = 'offer_sent';
  if (dec.action === 'not_now' && !PAID.includes(deal.stage)) {
    patch.stage = 'rest';
    await db.update('prospects', { id: prospect.id }, { status: 'rest', rest_until: iso(Date.now() + 90 * DAY), next_due_at: null });
  }
  if (dec.action === 'note') {
    const intake = deal.intake || {};
    patch.intake = { ...intake, notes: [intake.notes, dec.notes].filter(Boolean).join('\n') };
  }
  if (dec.action === 'change_request') {
    const r = await requestChanges(deal, prospect, product, dec.notes, 'email');
    if (r.escalated) { await db.update('replies', { id: reply.id }, { label: 'needs_you', handled: false }); await touch(deal, { pending_reply: false }); return 'needs_you'; }
  }
  if (!['rest', 'lost'].includes(patch.stage) && !PAID.includes(deal.stage)) await db.update('prospects', { id: prospect.id }, { status: 'interested', next_due_at: null });
  await touch(deal, patch, `${dec.action}: ${dec.reply.slice(0, 120)}`);
  if (dec.reply) await queue({ deal, prospect, body: dec.reply, kind, hold });
  const label = { send_mockup: 'interested', revise_mockup: 'interested', send_offer: 'interested', not_now: 'not_now' }[dec.action] || (dec.intent === 'question' ? 'question' : 'interested');
  return done(label, { answer: dec.reply });
}

// Changes after they've seen the finished site (from the review page or by email).
export async function requestChanges(deal, prospect, product, notes, via) {
  const c = conf(product);
  const text = String(notes || '').trim();
  if (!text) return { ok: false };
  if (deal.stage === 'live') {
    if (deal.growth_status !== 'active') { await escalate(deal, prospect, `asked for changes to their live site (no Growth plan): ${text.slice(0, 200)}`); return { escalated: true }; }
    await db.insert('jobs', [{ deal_id: deal.id, type: 'edit', input: { notes: text } }]);
    await touch(deal, {}, `edit requested (${via})`);
    return { ok: true, job: 'edit' };
  }
  if (deal.revisions_used >= c.revisions) { await escalate(deal, prospect, `asked for a round of changes beyond the ${c.revisions} included: ${text.slice(0, 200)}`); return { escalated: true }; }
  await db.update('jobs', { deal_id: deal.id, status: 'queued', type: 'revise' }, { status: 'failed', error: 'replaced by newer changes' });
  await db.insert('jobs', [{ deal_id: deal.id, type: 'revise', input: { notes: text } }]);
  await touch(deal, { stage: 'building', revisions_used: deal.revisions_used + 1 }, `changes requested (${via}), round ${deal.revisions_used + 1}`);
  return { ok: true, job: 'revise' };
}
