// Everything the app can do. Used by /api (the screen) and by the autopilot schedules.
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { SEED_PRODUCTS } from './products.mjs';
import { fromMapsRow, fromRegistryRow, lower } from './clean.mjs';
import { scanSite } from './scan.mjs';
import { score } from './score.mjs';
import { draftOnce, footer, readReply, pickAngle } from './brain.mjs';
import { serverGmailReady, send as gmailSend, thread as gmailThread, header } from './gmail.mjs';
import { senderPlan, warmupHealth, checkDomain } from './warmup.mjs';


const DAY = 86_400_000;
const now = () => new Date();
const iso = d => new Date(d).toISOString();
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const fail = (msg, status = 400) => json({ error: msg }, status);
const QUEUE_LIMIT = 60;
export const READY_TARGET = 150;   // the scraper only runs for products with fewer people than this ready
export const LEARN_APPROVALS = 50; // first emails you approve before a product may run on autopilot
export const LEARN_EDIT_RATE = 0.15;
export const AUTO_MIN_SCORE = 8;   // on autopilot, drafts the checker scored at least this send on their own

// Autopilot graduates a product once you've approved enough first emails without needing to edit them.
export async function autopilotState(p) {
  const mode = p.rules?.autopilot || 'auto';
  const mine = await db.select('messages', {
    select: 'edited', order: 'approved_at.desc', limit: 1000,
    filters: { product_id: p.id, step: 1, auto_approved: false, status: ['in', ['approved', 'sent']] },
  });
  const recent = mine.slice(0, 30);
  const editRate = recent.length ? recent.filter(m => m.edited).length / recent.length : 1;
  const on = mode === 'on' || (mode === 'auto' && mine.length >= LEARN_APPROVALS && editRate < LEARN_EDIT_RATE);
  return { mode, on, approvedByYou: mine.length, needed: LEARN_APPROVALS, editRate: recent.length ? Math.round(editRate * 100) : null };
}

export function purchaseAuthorised(req) {
  const want = process.env.PURCHASE_SECRET || '';
  const got = req.headers.get('x-purchase-secret') || '';
  return !!want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function authorised(req) {
  const want = process.env.APP_KEY || '';
  const got = req.headers.get('x-app-key') || '';
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const getProduct = async id => {
  const p = await db.one('products', { id });
  if (!p) throw new Error('Unknown product: ' + id);
  return p;
};

export async function suppressedSet(emails) {
  const set = new Set();
  for (let i = 0; i < emails.length; i += 150) {
    const rows = await db.select('suppression', { select: 'email', filters: { email: ['in', emails.slice(i, i + 150)] } });
    rows.forEach(r => set.add(r.email));
  }
  return set;
}

export async function suppress(email, reason) {
  await db.upsert('suppression', [{ email: lower(email), reason }], 'email');
  // Stop everything queued for this address in every product.
  const ps = await db.select('prospects', { select: 'id', filters: { email: lower(email) } });
  if (ps.length) {
    const ids = ps.map(p => p.id);
    await db.update('messages', { prospect_id: ['in', ids], status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'suppressed: ' + reason });
    await db.update('prospects', { id: ['in', ids] }, { status: 'done', skip_reason: reason, next_due_at: null });
  }
}

// ---- Learner stats -----------------------------------------------------------
async function angleStats(productId) {
  const sent = await db.select('messages', { select: 'angle,prospect_id', filters: { product_id: productId, status: 'sent', step: 1 } });
  const positive = await db.select('replies', { select: 'prospect_id,label', filters: { product_id: productId, label: ['in', ['interested', 'question']] } });
  const pos = new Set(positive.map(r => r.prospect_id));
  const stats = {};
  for (const m of sent) {
    const s = stats[m.angle || '?'] ||= { sent: 0, positive: 0 };
    s.sent++; if (pos.has(m.prospect_id)) s.positive++;
  }
  return stats;
}

// ---- Brakes ------------------------------------------------------------------
export async function checkBrakes(productId) {
  const recent = await db.select('messages', { select: 'prospect_id', filters: { product_id: productId, status: 'sent' }, order: 'sent_at.desc', limit: 100 });
  const angry = await db.select('replies', { select: 'id', filters: { product_id: productId, label: 'angry', handled: false }, limit: 1 });
  let reason = '';
  if (angry.length) reason = 'Someone replied calling it spam or complaining. Read it in Replies, then resume.';
  else if (recent.length >= 20) {
    const ids = [...new Set(recent.map(m => m.prospect_id))];
    const bounced = await db.select('replies', { select: 'prospect_id', filters: { prospect_id: ['in', ids], label: 'bounce' } });
    const rate = new Set(bounced.map(b => b.prospect_id)).size / ids.length;
    if (rate > 0.03) reason = `Bounce rate is ${(rate * 100).toFixed(1)}% over the last ${ids.length} people (limit 3%). Clean the list, then resume.`;
  }
  if (reason) await db.update('products', { id: productId }, { paused: true, paused_reason: reason });
  return reason;
}

export async function senders() {
  const row = await db.one('settings', { key: 'senders' });
  return row?.value || [];
}

// ---- Actions -----------------------------------------------------------------
export const actions = {
  async 'setup.status'() {
    const env = {
      APP_KEY: !!process.env.APP_KEY, SUPABASE_URL: !!process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_SA_EMAIL: !!process.env.GOOGLE_SA_EMAIL, GOOGLE_SA_KEY: !!process.env.GOOGLE_SA_KEY,
      DIGEST_TO: !!process.env.DIGEST_TO, PURCHASE_SECRET: !!process.env.PURCHASE_SECRET,
    };
    let products = [];
    try {
      products = await db.select('products', { order: 'id' });
      const have = new Set(products.map(p => p.id));
      const missing = SEED_PRODUCTS.filter(p => !have.has(p.id));
      if (missing.length) { await db.insert('products', missing); products = await db.select('products', { order: 'id' }); }
    } catch (e) {
      return { env, dbError: /relation|does not exist|schema cache/i.test(e.message) ? 'Tables not found. Run schema.sql in the Supabase SQL Editor.' : e.message };
    }
    return { env, products, senders: await senders(), googleClientId: process.env.GOOGLE_CLIENT_ID || '', model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' };
  },

  async 'products.save'({ product }) {
    const cur = await getProduct(product.id);
    const fields = ['name', 'site', 'price', 'buyer', 'pains', 'proof', 'offer', 'never_say', 'angles', 'segments', 'rules', 'from_name', 'postal_address'];
    const patch = { updated_at: iso(now()) };
    for (const f of fields) if (product[f] !== undefined) patch[f] = product[f];
    const [row] = await db.update('products', { id: cur.id }, patch);
    return { product: row };
  },

  async 'products.resume'({ id }) {
    await db.update('replies', { product_id: id, label: 'angry', handled: false }, { handled: true });
    const [row] = await db.update('products', { id }, { paused: false, paused_reason: null });
    return { product: row };
  },

  async 'senders.save'({ list }) {
    const before = Object.fromEntries((await senders()).map(s => [s.email, s]));
    const clean = (list || []).filter(s => s.email).map(s => ({
      // Warm-up clock: kept from before; "already warmed" inboxes skip straight to sending.
      started_at: s.warmed ? iso(now().getTime() - 30 * DAY) : before[lower(s.email)]?.started_at || iso(now()),
      email: lower(s.email), product_id: s.product_id, segment: s.segment || '',
      daily_cap: Math.max(1, Math.min(50, Number(s.daily_cap) || 10)),
      mode: s.mode === 'browser' ? 'browser' : 'server', // server = sends on its own via Workspace
    }));
    await db.upsert('settings', [{ key: 'senders', value: clean, updated_at: iso(now()) }], 'key');
    return { senders: clean };
  },

  async 'prospects.import'({ productId, segment, kind, rows, sourceFile, defaultState }) {
    const product = await getProduct(productId);
    if (!Array.isArray(rows) || rows.length > 500) throw new Error('Send between 1 and 500 rows per request');
    const skipped = {}, out = [];
    const opts = { productId, segment, sourceFile, defaultState, needOwnDomain: !!product.rules?.need_own_domain_email };
    for (const row of rows) {
      const r = kind === 'registry' ? fromRegistryRow(row, opts) : fromMapsRow(row, opts);
      if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; continue; }
      out.push(r.prospect);
    }
    // Same email twice in one file: keep the first.
    const seen = new Set(), unique = [];
    for (const p of out) { if (seen.has(p.email)) { skipped['duplicate in file'] = (skipped['duplicate in file'] || 0) + 1; continue; } seen.add(p.email); unique.push(p); }
    const blocked = await suppressedSet(unique.map(p => p.email));
    const fresh = unique.filter(p => { if (blocked.has(p.email)) { skipped['on the do-not-contact list'] = (skipped['on the do-not-contact list'] || 0) + 1; return false; } return true; });
    for (const p of fresh) {
      Object.assign(p, score(p, product));
      // Registry rows have no website to read, so they're ready to draft straight away.
      p.status = kind === 'registry' ? 'scanned' : 'new';
    }
    const added = fresh.length ? await db.insertIgnore('prospects', fresh, 'product_id,email') : [];
    const dupes = fresh.length - added.length;
    if (dupes) skipped['already in the list'] = dupes;
    return { added: added.length, skipped };
  },

  async 'prospects.list'({ productId, status, segment, limit = 200, offset = 0 }) {
    const filters = { product_id: productId, segment: segment || undefined };
    if (status) filters.status = status.includes(',') ? ['in', status.split(',')] : status;
    const rows = await db.select('prospects', {
      select: 'id,name,email,website,phone,category,city,state,segment,source,rating,reviews,units,self_managed,score,score_why,status,skip_reason,step,angle,detail,signals,extra,last_sent_at,next_due_at,rest_until,created_at',
      filters, order: 'score.desc,created_at.asc', limit: Math.min(500, limit), offset,
    });
    const counts = {};
    for (const st of ['new', 'scanned', 'drafted', 'contacted', 'replied', 'interested', 'won', 'rest', 'done', 'skipped'])
      counts[st] = await db.count('prospects', { product_id: productId, status: st });
    return { rows, counts };
  },

  async 'prospects.update'({ id, patch }) {
    const allowed = ['status', 'skip_reason', 'segment', 'email', 'name', 'detail'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    if (patch.test_call !== undefined) {
      const cur = await db.one('prospects', { id });
      clean.extra = { ...(cur.extra || {}), test_call: patch.test_call };
    }
    if (clean.email) clean.email = lower(clean.email);
    const [row] = await db.update('prospects', { id }, clean);
    return { prospect: row };
  },

  // Read up to 4 websites per request (the browser keeps calling until none are left).
  async 'prospects.scan'({ productId, limit = 4 }) {
    const product = await getProduct(productId);
    const batch = await db.select('prospects', { filters: { product_id: productId, status: 'new' }, order: 'created_at.asc', limit: Math.min(6, limit) });
    const results = await Promise.all(batch.map(async p => {
      let patch = { status: 'scanned' };
      if (p.website) {
        try {
          const s = await scanSite(p.website);
          patch.signals = s.signals; patch.site_text = s.site_text;
        } catch (e) {
          patch.extra = { ...(p.extra || {}), scan_error: e.message };
        }
      }
      Object.assign(patch, score({ ...p, ...patch }, product));
      await db.update('prospects', { id: p.id }, patch);
      return { id: p.id, name: p.name, score: patch.score, error: patch.extra?.scan_error };
    }));
    const left = await db.count('prospects', { product_id: productId, status: 'new' });
    return { scanned: results, left };
  },

  async 'prospects.rescore'({ productId, offset = 0 }) {
    const product = await getProduct(productId);
    const rows = await db.select('prospects', { filters: { product_id: productId, status: ['in', ['new', 'scanned']] }, order: 'created_at.asc', limit: 200, offset });
    if (rows.length) await db.upsert('prospects', rows.map(p => ({ id: p.id, product_id: p.product_id, email: p.email, ...score(p, product) })), 'id');
    return { done: rows.length, more: rows.length === 200 };
  },

  // The writer. Each call drafts one email: due follow-ups first, then the best-scoring new prospect.
  async 'draft.next'({ productId, prospectId, feedback, attempt = 1 }) {
    const product = await getProduct(productId);
    const r = product.rules || {};
    const queued = await db.count('messages', { product_id: productId, status: ['in', ['draft', 'approved']] });
    if (!prospectId && queued >= QUEUE_LIMIT) return { done: true, reason: `${queued} emails already waiting in the queue` };

    let p = prospectId ? await db.one('prospects', { id: prospectId }) : null;
    if (!p) {
      const nowIso = iso(now());
      const due = await db.select('prospects', { filters: { product_id: productId, status: 'contacted', next_due_at: ['lte', nowIso] }, order: 'next_due_at.asc', limit: 1 });
      const back = due.length ? [] : await db.select('prospects', { filters: { product_id: productId, status: 'rest', rest_until: ['lte', nowIso] }, limit: 1 });
      const fresh = due.length || back.length ? [] : await db.select('prospects', {
        filters: { product_id: productId, status: 'scanned', score: ['gte', r.min_score ?? 0] }, order: 'score.desc,created_at.asc', limit: 1,
      });
      p = due[0] || back[0] || fresh[0];
    }
    if (!p) return { done: true, reason: 'nobody left to write to at or above the minimum score' };

    const isRest = p.status === 'rest';
    const step = isRest ? p.step : p.step + 1;
    const previous = step > 1 ? await db.select('messages', { select: 'body,subject', filters: { prospect_id: p.id, status: 'sent' }, order: 'step.asc' }) : [];
    const angle = p.angle || pickAngle(product.angles || [], await angleStats(productId));
    const out = await draftOnce({ product, prospect: p, step: Math.min(step, r.steps || step), angle, previous, fromName: product.from_name, problems: feedback });

    if (out.skip) {
      await db.update('prospects', { id: p.id }, { status: 'skipped', skip_reason: out.skip_reason });
      return { prospect: p.name, skipped: out.skip_reason };
    }
    if (out.failed) {
      if (attempt < 2) return { prospect: p.name, retry: true, prospectId: p.id, feedback: out.problems };
      await db.update('prospects', { id: p.id }, { status: isRest ? 'done' : step > 1 ? 'contacted' : 'skipped', skip_reason: 'draft failed checks twice: ' + out.problems.slice(0, 3).join('; '), next_due_at: step > 1 ? null : p.next_due_at });
      return { prospect: p.name, dropped: out.problems };
    }
    const subject = step === 1 ? out.subject : (previous[0]?.subject ? 'Re: ' + previous[0].subject.replace(/^re:\s*/i, '') : out.subject);
    const [msg] = await db.insert('messages', [{
      prospect_id: p.id, product_id: productId, step, angle, subject, body: out.body,
      status: 'draft', check_score: out.check_score, check_notes: out.check_notes,
    }]);
    await db.update('prospects', { id: p.id }, {
      status: 'drafted', angle, detail: step === 1 ? out.detail : p.detail, next_due_at: null, rest_until: null,
      extra: isRest ? { ...(p.extra || {}), checkin: true } : p.extra,
    });
    return { prospect: p.name, drafted: msg.id };
  },

  async 'queue.list'({ productId }) {
    const msgs = await db.select('messages', { filters: { product_id: productId, status: ['in', ['draft', 'approved']] }, order: 'created_at.asc', limit: 200 });
    const ids = [...new Set(msgs.map(m => m.prospect_id))];
    const ps = ids.length ? await db.select('prospects', { select: 'id,name,email,website,city,state,segment,score,score_why,detail,site_text,source,extra', filters: { id: ['in', ids] } }) : [];
    const byId = Object.fromEntries(ps.map(p => [p.id, p]));
    const product = await getProduct(productId);
    return { messages: msgs.map(m => ({ ...m, prospect: byId[m.prospect_id], footer: footer(product, byId[m.prospect_id] || {}) })) };
  },

  async 'message.save'({ id, subject, body, status }) {
    const cur = await db.one('messages', { id });
    if (!cur || !['draft', 'approved'].includes(cur.status)) throw new Error('That email has already been sent or removed');
    const patch = {};
    if (body !== undefined && body !== cur.body) { patch.body = body; patch.edited = true; }
    if (subject !== undefined && subject !== cur.subject) { patch.subject = subject; patch.edited = true; }
    if (status) patch.status = status;
    if (status === 'approved') { patch.approved_at = iso(now()); patch.auto_approved = false; }
    const [row] = await db.update('messages', { id }, patch);
    if (status === 'rejected') {
      await db.update('prospects', { id: cur.prospect_id }, cur.step === 1
        ? { status: 'skipped', skip_reason: 'rejected by you' }
        : { status: 'done', skip_reason: 'follow-up rejected by you' });
    }
    return { message: row };
  },

  async 'message.redraft'({ id }) {
    const cur = await db.one('messages', { id });
    if (!cur || !['draft', 'approved'].includes(cur.status)) throw new Error('That email has already been sent or removed');
    await db.remove('messages', { id });
    const p = await db.one('prospects', { id: cur.prospect_id });
    await db.update('prospects', { id: p.id }, { status: cur.step === 1 ? 'scanned' : 'contacted', next_due_at: cur.step === 1 ? null : iso(now()) });
    return { prospectId: p.id };
  },

  async 'queue.approveAll'({ productId, minScore = 8 }) {
    const rows = await db.update('messages', { product_id: productId, status: 'draft', check_score: ['gte', minScore] }, { status: 'approved', approved_at: iso(now()), auto_approved: false });
    return { approved: rows.length };
  },

  // ---- Sending (the browser does the actual Gmail send) ----
  async 'send.next'({ sender }) {
    const s = (await senders()).find(x => x.email === lower(sender));
    if (!s) throw new Error(`${sender} is not set up as a sending inbox. Add it in Settings.`);
    const product = await getProduct(s.product_id);
    if (product.paused) return { stop: 'paused', reason: product.paused_reason };
    if (!product.from_name || !product.postal_address) return { stop: 'setup', reason: `Add your name and postal address to ${product.name} on the Products screen first. Every email must carry them.` };
    const plan = senderPlan(s);
    if (plan.warming) return { stop: 'warming', reason: `${s.email} is warming up (day ${plan.day + 1} of 14). Cold emails start ${new Date(plan.coldFrom).toDateString()}.` };
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const sentToday = await db.count('messages', { sender: s.email, status: 'sent', sent_at: ['gte', iso(today)] });
    if (sentToday >= plan.coldCap) return { stop: 'cap', reason: `${s.email} has sent ${sentToday} today, its cap today is ${plan.coldCap} (rising toward ${s.daily_cap}).` };

    // Follow-ups must come from the inbox that sent the first email.
    const approved = await db.select('messages', { filters: { product_id: product.id, status: 'approved' }, order: 'step.desc,created_at.asc', limit: 50 });
    for (const m of approved) {
      const p = await db.one('prospects', { id: m.prospect_id });
      if (!p || p.status !== 'drafted') { await db.update('messages', { id: m.id }, { status: 'rejected', error: 'prospect no longer waiting' }); continue; }
      if (p.sender && p.sender !== s.email) continue;
      if (!p.sender && s.segment && p.segment !== s.segment) continue;
      if ((await suppressedSet([p.email])).size) { await suppress(p.email, 'do-not-contact list'); continue; }
      return {
        message: {
          id: m.id, to: p.email, subject: m.subject, body: m.body + '\n' + footer(product, p),
          threadId: m.step > 1 ? p.thread_id : null, inReplyTo: m.step > 1 ? p.last_message_id : null,
          fromName: product.from_name, prospect: p.name,
        },
        sentToday, cap: plan.coldCap,
      };
    }
    return { stop: 'empty', reason: 'No approved emails waiting for this inbox.' };
  },

  async 'send.done'({ messageId, sender, gmailId, threadId, messageIdHeader }) {
    const m = await db.one('messages', { id: messageId });
    if (!m) throw new Error('Unknown message');
    const product = await getProduct(m.product_id);
    const r = product.rules || {};
    const sentAt = now();
    await db.update('messages', { id: m.id }, { status: 'sent', sender: lower(sender), gmail_id: gmailId, thread_id: threadId, sent_at: iso(sentAt) });
    const p = await db.one('prospects', { id: m.prospect_id });
    const step = Math.max(p.step, m.step);
    const checkin = !!p.extra?.checkin; // a 90-day check-in is the very last email, whatever happens
    const last = checkin || step >= (r.steps || 1);
    const gap = ((r.gaps || [])[step] ?? 0) - ((r.gaps || [])[step - 1] ?? 0);
    await db.update('prospects', { id: p.id }, {
      step, status: last ? (r.rest_days && !checkin ? 'rest' : 'done') : 'contacted',
      sender: lower(sender), thread_id: threadId || p.thread_id, last_message_id: messageIdHeader || p.last_message_id,
      last_sent_at: iso(sentAt),
      next_due_at: last ? null : iso(sentAt.getTime() + Math.max(1, gap) * DAY),
      rest_until: last && r.rest_days && !checkin ? iso(sentAt.getTime() + r.rest_days * DAY) : null,
    });
    return { ok: true };
  },

  async 'send.failed'({ messageId, error }) {
    const m = await db.one('messages', { id: messageId });
    await db.update('messages', { id: messageId }, { status: 'failed', error: String(error).slice(0, 500) });
    if (/invalid to|recipient address rejected|invalid email/i.test(error)) {
      const p = await db.one('prospects', { id: m.prospect_id });
      await suppress(p.email, 'invalid address');
    } else {
      await db.update('prospects', { id: m.prospect_id }, { status: m.step === 1 ? 'scanned' : 'contacted', next_due_at: iso(now()) });
    }
    return { ok: true };
  },

  // ---- Replies ----
  async 'replies.watch'({ sender }) {
    const since = iso(now().getTime() - 60 * DAY);
    const ps = await db.select('prospects', {
      select: 'id,thread_id,email,name', order: 'last_sent_at.desc', limit: 300,
      filters: { sender: lower(sender), thread_id: ['not.is', null], last_sent_at: ['gte', since], status: ['in', ['contacted', 'drafted', 'done', 'rest', 'replied', 'interested']] },
    });
    const known = ps.length ? await db.select('replies', { select: 'gmail_id', filters: { prospect_id: ['in', ps.map(p => p.id)] } }) : [];
    const ours = ps.length ? await db.select('messages', { select: 'gmail_id', filters: { prospect_id: ['in', ps.map(p => p.id)], status: 'sent' } }) : [];
    return { threads: ps, knownIds: [...known, ...ours].map(r => r.gmail_id).filter(Boolean) };
  },

  async 'replies.add'({ prospectId, gmailId, from, subject, body, date }) {
    const p = await db.one('prospects', { id: prospectId });
    if (!p) throw new Error('Unknown prospect');
    if (await db.one('replies', { gmail_id: gmailId })) return { duplicate: true };
    const product = await getProduct(p.product_id);
    const read = await readReply({ product, prospect: p, reply: { from, subject, body } });
    const quiet = ['auto_reply'].includes(read.label);
    const [row] = await db.insert('replies', [{
      prospect_id: p.id, product_id: p.product_id, gmail_id: gmailId, from_addr: from, subject,
      body: String(body).slice(0, 8000), label: read.label, answer: read.answer,
      handled: quiet || ['bounce', 'unsubscribe'].includes(read.label),
      received_at: date ? iso(date) : iso(now()),
    }]);
    if (read.label === 'bounce') await suppress(p.email, 'bounced');
    else if (read.label === 'unsubscribe') await suppress(p.email, 'asked not to be emailed');
    else if (read.label === 'angry') await suppress(p.email, 'complained');
    else if (!quiet) {
      await db.update('messages', { prospect_id: p.id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they replied' });
      const status = read.label === 'not_now' ? 'rest' : read.label === 'interested' ? 'interested' : read.label === 'wrong_person' ? 'done' : 'replied';
      await db.update('prospects', { id: p.id }, { status, next_due_at: null, rest_until: status === 'rest' ? iso(now().getTime() + 90 * DAY) : null });
    }
    const brake = ['bounce', 'angry'].includes(read.label) ? await checkBrakes(p.product_id) : '';
    return { reply: row, brake };
  },

  async 'replies.list'({ productId, all }) {
    const filters = { product_id: productId || undefined };
    if (!all) filters.handled = false;
    const rows = await db.select('replies', { filters, order: 'received_at.desc', limit: 200 });
    const ids = [...new Set(rows.map(r => r.prospect_id))];
    const ps = ids.length ? await db.select('prospects', { select: 'id,name,email,thread_id,last_message_id,sender,status,product_id', filters: { id: ['in', ids] } }) : [];
    const byId = Object.fromEntries(ps.map(p => [p.id, p]));
    return { replies: rows.map(r => ({ ...r, prospect: byId[r.prospect_id] })) };
  },

  // Answer a reply from the server inbox that emailed them, in the same thread.
  async 'reply.send'({ id, answer }) {
    const r = await db.one('replies', { id });
    if (!r) throw new Error('Unknown reply');
    const p = await db.one('prospects', { id: r.prospect_id });
    const product = await getProduct(p.product_id);
    if (!String(answer || '').trim()) throw new Error('Write an answer first.');
    const t = await gmailThread(p.sender, p.thread_id);
    const theirs = (t.messages || []).find(m => m.id === r.gmail_id) || {};
    const subj = header(theirs, 'Subject') || r.subject || '';
    await gmailSend(p.sender, {
      to: p.email, subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj, body: `${answer.trim()}\n\n${product.from_name}`,
      inReplyTo: header(theirs, 'Message-ID') || null, threadId: p.thread_id, fromName: product.from_name,
    });
    const [row] = await db.update('replies', { id }, { handled: true, answer });
    return { reply: row };
  },

  async 'reply.done'({ id, answer }) {
    const [row] = await db.update('replies', { id }, { handled: true, answer: answer ?? undefined });
    return { reply: row };
  },

  async 'prospect.won'({ id }) {
    const [row] = await db.update('prospects', { id }, { status: 'won', next_due_at: null });
    await db.update('messages', { prospect_id: id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they bought' });
    return { prospect: row };
  },

  async 'suppress.add'({ email, reason }) { await suppress(email, reason || 'added by you'); return { ok: true }; },
  async 'suppress.list'() { return { rows: await db.select('suppression', { order: 'created_at.desc', limit: 1000 }) }; },

  async 'senders.status'() {
    const health = await warmupHealth();
    return { senders: (await senders()).map(s => ({ ...s, plan: senderPlan(s), warmup: health[s.email] || null })) };
  },

  async 'dns.check'({ domain }) {
    const d = lower(domain).replace(/^.*@/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error('Not a domain: ' + domain);
    if (/^(pdfmacro|keephoa|ringsparrow)\.com$/.test(d)) throw new Error(`${d} is a product domain. Cold email goes from separate sending domains.`);
    return { domain: d, checks: await checkDomain(d) };
  },

  async 'autopilot.status'() {
    const out = {};
    for (const p of await db.select('products', { order: 'id' })) out[p.id] = await autopilotState(p);
    return { products: out, serverGmail: serverGmailReady(), digestTo: !!process.env.DIGEST_TO };
  },

  async 'autopilot.mode'({ productId, mode }) {
    if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto, on or off');
    const p = await getProduct(productId);
    await db.update('products', { id: productId }, { rules: { ...(p.rules || {}), autopilot: mode } });
    return { state: await autopilotState({ ...p, rules: { ...(p.rules || {}), autopilot: mode } }) };
  },

  // ---- Nightly scraper plan ----
  async 'scrape.plan.list'({ productId }) {
    return { rows: await db.select('scrape_queries', { filters: { product_id: productId }, order: 'segment.asc,query.asc', limit: 2000 }) };
  },

  async 'scrape.plan.save'({ productId, segment, types = [], cities = [] }) {
    await getProduct(productId);
    const rows = [];
    for (const c of cities.map(s => s.trim()).filter(Boolean)) for (const t of types.map(s => s.trim()).filter(Boolean))
      rows.push({ product_id: productId, segment, query: `${t} in ${c}` });
    if (!rows.length) throw new Error('Add at least one business type and one city');
    const added = await db.insertIgnore('scrape_queries', rows, 'product_id,query');
    return { added: added.length, total: rows.length };
  },

  async 'scrape.plan.remove'({ id }) { await db.remove('scrape_queries', { id }); return { ok: true }; },

  // Called by the nightly scraper on your computer. Only hands out searches for products
  // that are running low on people to email, so Google sees as little traffic as possible.
  async 'scrape.next'({ limit = 6 }) {
    const out = [];
    const cutoff = iso(now().getTime() - 90 * DAY);
    for (const p of await db.select('products', { order: 'id' })) {
      if (p.paused) continue;
      const ready = await db.count('prospects', { product_id: p.id, status: ['in', ['new', 'scanned']] });
      if (ready >= READY_TARGET) continue;
      const fresh = await db.select('scrape_queries', { filters: { product_id: p.id, last_run_at: null }, order: 'created_at.asc', limit });
      const old = fresh.length < limit ? await db.select('scrape_queries', { filters: { product_id: p.id, last_run_at: ['lt', cutoff] }, order: 'last_run_at.asc', limit: limit - fresh.length }) : [];
      for (const q of [...fresh, ...old]) out.push({ id: q.id, productId: p.id, segment: q.segment, query: q.query });
      if (out.length >= limit) break;
    }
    const pick = out.slice(0, limit);
    if (pick.length) await db.update('scrape_queries', { id: ['in', pick.map(q => q.id)] }, { last_run_at: iso(now()) });
    return { queries: pick };
  },

  // A product's licence server (PayPal/Dodo webhook) reports a purchase: mark the buyer as won.
  async 'purchase.record'({ email, product }) {
    const e = lower(email);
    if (!e) throw new Error('email required');
    const ps = await db.select('prospects', { select: 'id,product_id,status', filters: { email: e, product_id: product || undefined } });
    for (const p of ps) {
      await db.update('prospects', { id: p.id }, { status: 'won', next_due_at: null });
      await db.update('messages', { prospect_id: p.id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they bought' });
    }
    return { matched: ps.length };
  },

  async 'stats'({ productId }) {
    const product = await getProduct(productId);
    const sent = await db.select('messages', { select: 'prospect_id,step,angle,sent_at,sender,edited', filters: { product_id: productId, status: 'sent' }, limit: 10000 });
    const replies = await db.select('replies', { select: 'prospect_id,label', filters: { product_id: productId }, limit: 10000 });
    const ps = await db.select('prospects', { select: 'id,segment,score,status', filters: { product_id: productId, step: ['gte', 1] }, limit: 10000 });
    const byP = Object.fromEntries(ps.map(p => [p.id, p]));
    const labels = {};
    for (const r of replies) (labels[r.prospect_id] ||= new Set()).add(r.label);
    const people = [...new Set(sent.map(m => m.prospect_id))];
    const has = (id, l) => labels[id]?.has(l);
    const positive = id => has(id, 'interested') || has(id, 'question');
    const replied = id => ['interested', 'question', 'not_now', 'wrong_person', 'angry', 'unsubscribe'].some(l => has(id, l));
    const group = keyFn => {
      const g = {};
      for (const id of people) {
        const k = keyFn(id); const row = g[k] ||= { people: 0, replied: 0, positive: 0, won: 0, bounced: 0 };
        row.people++; if (replied(id)) row.replied++; if (positive(id)) row.positive++;
        if (byP[id]?.status === 'won') row.won++; if (has(id, 'bounce')) row.bounced++;
      }
      return g;
    };
    const firstAngle = Object.fromEntries(sent.filter(m => m.step === 1).map(m => [m.prospect_id, m.angle]));
    const band = s => (s >= 8 ? '8+' : s >= 5 ? '5-7' : s >= 3 ? '3-4' : 'under 3');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const perSender = {};
    for (const m of sent) if (new Date(m.sent_at) >= today) perSender[m.sender] = (perSender[m.sender] || 0) + 1;
    const edits = sent.filter(m => m.step === 1).slice(-50);
    return {
      paused: product.paused, paused_reason: product.paused_reason,
      totals: { emails: sent.length, ...group(() => 'all').all },
      byAngle: group(id => firstAngle[id] || '?'),
      bySegment: group(id => byP[id]?.segment || '?'),
      byScore: group(id => band(byP[id]?.score ?? 0)),
      sentToday: perSender,
      editRate: edits.length ? Math.round(100 * edits.filter(m => m.edited).length / edits.length) : null,
      angleStats: await angleStats(productId),
    };
  },
};

