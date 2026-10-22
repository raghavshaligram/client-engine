// Everything the app can do. Used by /api (the screen) and by the autopilot schedules.
import crypto from 'node:crypto';
import { db, projectUrl } from './db.mjs';
import { linkFor, logEvent, prospectByRef, trackDomain } from './track.mjs';
import { SEED_PRODUCTS, RADAR_DEFAULTS } from './products.mjs';
import { fromMapsRow, fromRegistryRow, lower } from './clean.mjs';
import { scanSite } from './scan.mjs';
import { score } from './score.mjs';
import { draftOnce, footer, readReply, pickAngle } from './brain.mjs';
import { serverGmailReady, send as gmailSend, thread as gmailThread, header } from './gmail.mjs';
import { senderPlan, warmupHealth, checkDomain } from './warmup.mjs';
import { virginiaRows, texasRow, VIRGINIA_URL } from './sources.mjs';
import { radarSettings, saveRadarSettings, scanStatus, draftReplies, projectOf, scanProduct, startScan, finishScan, internalToken, siteUrl, PLATFORMS } from './radar.mjs';
import { getUsage } from './xai.mjs';


const DAY = 86_400_000;
const now = () => new Date();
const iso = d => new Date(d).toISOString();
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const fail = (msg, status = 400) => json({ error: msg }, status);
const QUEUE_LIMIT = 60;
export const UNCHECKABLE = /^(yahoo|ymail|rocketmail|aol|verizon|att|sbcglobal|bellsouth|hotmail|outlook|live|msn)\./i;
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

// Which kind of Supabase key the server was given, without revealing it.
export function keyKind(k = String(process.env.SUPABASE_SERVICE_KEY || '').trim()) {
  if (!k) return 'none';
  if (k.startsWith('sb_secret_')) return 'secret';
  if (k.startsWith('sb_publishable_')) return 'publishable';
  try { const role = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role; return role === 'service_role' ? 'service_role' : role === 'anon' ? 'anon' : 'unknown'; } catch { return 'unknown'; }
}

// Database errors in plain words, with the fix.
export function explainDbError(m) {
  if (/not set in Netlify/.test(m)) return m + '. Add it, then redeploy.';
  if (/relation .* does not exist|schema cache|Could not find the table/i.test(m)) return "Supabase is connected, but its API can't see the tables. Run all of schema.sql again (its last lines give the API access and reload it), in the same project SUPABASE_URL points to.";
  if (/permission denied/i.test(m)) return "Supabase is connected, but the API isn't allowed to use the tables. Run all of schema.sql again: its last lines grant that access.";
  if (/row-level security/i.test(m)) return 'That key is the public (anon or publishable) key. Use the secret key instead: Supabase > Project settings > API Keys > secret (sb_secret_...), or the legacy service_role key.';
  if (/Invalid API key|invalid.*jwt|JWS|JWT|Unauthorized|No API key/i.test(m)) return "Supabase didn't accept SUPABASE_SERVICE_KEY. Copy the secret key again from Project settings > API Keys (it must belong to the same project as SUPABASE_URL), then redeploy.";
  return m;
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

async function conversationByRef(ref) {
  const slug = String(ref || '').replace(/^(ce|lr)_/, '');
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return null;
  return db.one('conversations', { slug });
}

// People a signup or purchase belongs to: by tracked-link code, or by email address.
async function prospectsFor({ ref, email, product }) {
  const out = [];
  const byRef = await prospectByRef(ref);
  if (byRef) out.push(byRef);
  const e = lower(email);
  if (e) for (const p of await db.select('prospects', { filters: { email: e, product_id: product || undefined } })) if (!out.some(x => x.id === p.id)) out.push(p);
  return out;
}

async function getSource(name) { return (await db.one('settings', { key: 'source.' + name }))?.value || {}; }
async function setSource(name, patch) {
  const value = { ...(await getSource(name)), ...patch };
  await db.upsert('settings', [{ key: 'source.' + name, value, updated_at: iso(now()) }], 'key');
  return value;
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
      DIGEST_TO: !!process.env.DIGEST_TO, PURCHASE_SECRET: !!process.env.PURCHASE_SECRET, TRACK_DOMAIN: !!trackDomain(),
      XAI_API_KEY: !!process.env.XAI_API_KEY, BSKY_HANDLE: !!(process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD),
    };
    let products = [];
    try {
      products = await db.select('products', { order: 'id' });
      const have = new Set(products.map(p => p.id));
      const missing = SEED_PRODUCTS.filter(p => !have.has(p.id));
      if (missing.length) { await db.insert('products', missing); products = await db.select('products', { order: 'id' }); }
      // Conversations settings reach databases created before them.
      for (const p of products) if (RADAR_DEFAULTS[p.id] && !(p.radar && p.radar.sources)) {
        p.radar = { ...RADAR_DEFAULTS[p.id], ...(p.radar || {}) };
        await db.update('products', { id: p.id }, { radar: p.radar });
      }
      // Segments added in later versions reach databases created before them.
      const hoa = products.find(p => p.id === 'keephoa');
      if (hoa && !(hoa.segments || []).some(s => s.id === 'texas')) {
        const segments = [...(hoa.segments || []), { id: 'texas', name: 'Texas registry', ask: 'Want to see what the year-end handoff looks like?', landing: 'https://keephoa.com' }];
        await db.update('products', { id: 'keephoa' }, { segments });
        hoa.segments = segments;
      }
    } catch (e) {
      return { env, dbError: explainDbError(e.message), dbRaw: e.message, keyKind: keyKind(), dbHost: (() => { try { return new URL(projectUrl()).host; } catch { return ''; } })() };
    }
    // Tables added in later versions: if missing, the app keeps working but asks for schema.sql to be run again.
    const schemaUpdate = await db.select('link_events', { select: 'id', limit: 1 }).then(() => false, () => true);
    return { env, products, schemaUpdate, senders: await senders(), googleClientId: process.env.GOOGLE_CLIENT_ID || '', model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' };
  },

  async 'products.save'({ product }) {
    const cur = await getProduct(product.id);
    const fields = ['name', 'site', 'price', 'buyer', 'pains', 'proof', 'offer', 'never_say', 'angles', 'segments', 'rules', 'from_name', 'postal_address'];
    if (product.radar !== undefined) {
      const r = product.radar || {}, list = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
      product.radar = {
        ...(cur.radar || {}), on: !!r.on,
        sources: Object.fromEntries(PLATFORMS.map(k => [k, !!r.sources?.[k]])),
        keywords: list(r.keywords).slice(0, 40), subreddits: list(r.subreddits).map(x => x.replace(/^\/?r\//, '')).slice(0, 10),
        forumDomains: list(r.forumDomains).map(x => x.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).slice(0, 5),
        competitors: list(r.competitors).slice(0, 8), voice: String(r.voice || '').slice(0, 4000),
      };
      fields.push('radar');
    }
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
    for (const st of ['new', 'scanned', 'drafted', 'contacted', 'replied', 'interested', 'signed_up', 'won', 'rest', 'done', 'skipped'])
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
      const checking = !!(await db.one('settings', { key: 'verify.enabled' }))?.value;
      const fresh = due.length || back.length ? [] : await db.select('prospects', {
        filters: { product_id: productId, status: 'scanned', score: ['gte', r.min_score ?? 0], verified: checking ? ['not.is', null] : undefined },
        order: 'score.desc,created_at.asc', limit: 1,
      });
      p = due[0] || back[0] || fresh[0];
    }
    if (!p) return { done: true, reason: 'nobody left to write to at or above the minimum score' };

    const isRest = p.status === 'rest';
    const step = isRest ? p.step : p.step + 1;
    const previous = step > 1 ? await db.select('messages', { select: 'body,subject', filters: { prospect_id: p.id, status: 'sent' }, order: 'step.asc' }) : [];
    const angle = p.angle || pickAngle(product.angles || [], await angleStats(productId));
    const wantsLink = (r.links?.[Math.min(step, r.steps || step) - 1] ?? 0) > 0;
    const link = wantsLink ? await linkFor(product, p) : undefined;
    const out = await draftOnce({ product, prospect: p, step: Math.min(step, r.steps || step), angle, previous, fromName: product.from_name, problems: feedback, link });

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
      filters: { sender: lower(sender), thread_id: ['not.is', null], last_sent_at: ['gte', since], status: ['in', ['contacted', 'drafted', 'done', 'rest', 'replied', 'interested', 'signed_up']] },
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
    const read = await readReply({ product, prospect: p, reply: { from, subject, body }, link: await linkFor(product, p) });
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

  // Virginia's association list. The server downloads it weekly; if Virginia refuses the server,
  // the nightly job on your computer downloads it and sends the text here instead.
  async 'source.virginia'({ text }) {
    let body = text, how = 'uploaded from your computer';
    if (!body) {
      how = 'downloaded by the server';
      try {
        const res = await fetch(VIRGINIA_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClientEngine/1.0)' } });
        if (!res.ok) throw new Error('Virginia answered ' + res.status);
        body = await res.text();
      } catch (e) {
        await setSource('virginia', { last_error: e.message, last_try: iso(now()) });
        throw new Error('Could not download the Virginia list: ' + e.message + '. Your computer will try tonight.');
      }
    }
    const v = virginiaRows(body);
    let added = 0; const skipped = { ...v.skipped };
    for (let i = 0; i < v.rows.length; i += 400) {
      const r = await actions['prospects.import']({ productId: 'keephoa', segment: 'virginia', kind: 'registry', rows: v.rows.slice(i, i + 400), sourceFile: 'Virginia DPOR 0550', defaultState: 'VA' });
      added += r.added;
      for (const [k, n] of Object.entries(r.skipped)) skipped[k] = (skipped[k] || 0) + n;
    }
    const summary = { last_ok: iso(now()), last_error: null, total: v.total, volunteers: v.rows.length, added, how };
    await setSource('virginia', summary);
    return { ...summary, skipped };
  },

  // Texas certificates read overnight on your computer: only personal addresses become prospects.
  async 'source.texas'({ certs = [], done = 0, offset }) {
    const rows = certs.map(texasRow).filter(Boolean);
    const r = rows.length ? await actions['prospects.import']({ productId: 'keephoa', segment: 'texas', kind: 'registry', rows, sourceFile: 'Texas TREC certificates', defaultState: 'TX' }) : { added: 0, skipped: {} };
    const prev = await getSource('texas');
    await setSource('texas', {
      last_ok: iso(now()), offset: offset ?? prev.offset ?? 0,
      read: (prev.read || 0) + done, volunteers: (prev.volunteers || 0) + rows.length, added: (prev.added || 0) + r.added,
    });
    return { volunteers: rows.length, added: r.added, skipped: r.skipped };
  },

  async 'source.status'() {
    const va = await getSource('virginia'), tx = await getSource('texas');
    const stale = !va.last_ok || now() - Date.parse(va.last_ok) > 8 * DAY;
    return { virginia: { ...va, needsUpload: stale && !!va.last_error }, texas: tx };
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

  // A product's site reports a signup that arrived through a Conversations link (?ref=ce_<slug>).
  // Also credits the email that brought them (?ref=ce_<code>, or the same email address), and stops
  // that person's follow-ups: someone who signed up shouldn't get "last note" emails.
  async 'signup.record'({ ref, email, product }) {
    const row = await conversationByRef(ref);
    if (row) await db.update('conversations', { id: row.id }, { signups: (row.signups || 0) + 1 });
    const people = await prospectsFor({ ref, email, product });
    for (const p of people) {
      if (p.signed_up_at) continue;
      await db.update('prospects', { id: p.id }, { signed_up_at: iso(now()), next_due_at: null, ...(p.status === 'won' ? {} : { status: 'signed_up' }) });
      await db.update('messages', { prospect_id: p.id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they signed up' });
      await logEvent('signup', p);
    }
    return { matched: (row ? 1 : 0) + people.length, prospects: people.length };
  },

  // A product's licence server (PayPal/Dodo webhook) reports a purchase: mark the buyer as won,
  // and credit the conversation that brought them if the purchase carries its ref.
  async 'purchase.record'({ email, product, ref }) {
    const conv = await conversationByRef(ref);
    if (conv) await db.update('conversations', { id: conv.id }, { purchases: (conv.purchases || 0) + 1 });
    if (!lower(email) && !ref) throw new Error('email or ref required');
    const ps = await prospectsFor({ ref, email, product });
    for (const p of ps) {
      if (p.status !== 'won') await logEvent('purchase', p);
      await db.update('prospects', { id: p.id }, { status: 'won', next_due_at: null });
      await db.update('messages', { prospect_id: p.id, status: ['in', ['draft', 'approved']] }, { status: 'rejected', error: 'they bought' });
    }
    return { matched: ps.length, conversation: !!conv };
  },

  // ---- Conversations ----
  async 'radar.queue'({ productId, status = 'new' }) {
    const s = await radarSettings();
    const filters = { product_id: productId || undefined, status };
    const rows = await db.select('conversations', { filters, order: status === 'new' ? 'score.desc,created_at.desc' : 'sent_at.desc.nullslast,created_at.desc', limit: 200 });
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const sent = await db.select('conversations', { select: 'platform', filters: { status: 'sent', sent_at: ['gte', iso(today)] }, limit: 1000 });
    const sentToday = {}; for (const r of sent) sentToday[r.platform] = (sentToday[r.platform] || 0) + 1;
    const counts = {};
    for (const st of ['new', 'sent', 'skipped']) counts[st] = await db.count('conversations', { product_id: productId || undefined, status: st });
    return { rows: rows.map(r => ({ ...r, link: `${siteUrl()}/go/${r.slug}` })), sentToday, dailyCap: s.dailyCapPerPlatform, counts };
  },

  async 'radar.update'({ id, status, draft, skipReason }) {
    const patch = {};
    if (draft !== undefined) patch.draft = String(draft).slice(0, 4000);
    if (status === 'sent') { patch.status = 'sent'; patch.sent_at = iso(now()); }
    if (status === 'skipped') { patch.status = 'skipped'; patch.skip_reason = String(skipReason || '').slice(0, 120); }
    if (status === 'new') { patch.status = 'new'; patch.sent_at = null; patch.skip_reason = null; }
    const [row] = await db.update('conversations', { id }, patch);
    if (!row) throw new Error('That conversation is gone');
    return { row };
  },

  async 'radar.redraft'({ id, note }) {
    const row = await db.one('conversations', { id });
    if (!row) throw new Error('That conversation is gone');
    const p = projectOf(await getProduct(row.product_id));
    const d = (await draftReplies(p, await radarSettings(), [{ ...row, id: row.id }], note)).get(row.id);
    if (!d) throw new Error('Could not draft a reply, try again');
    const [updated] = await db.update('conversations', { id }, { draft: d.draft, link_included: d.linkIncluded });
    return { row: updated };
  },

  // ---- Email checks (nightly on your computer) ----
  // Hands out addresses to check. Yahoo, AOL, Verizon and Microsoft mailboxes can't be checked
  // from a home connection, so they're marked "unknown" here and never sent to the checker.
  async 'verify.next'({ limit = 300 }) {
    const out = [];
    const rows = await db.select('prospects', { select: 'id,email', filters: { status: ['in', ['new', 'scanned']], verified: null }, order: 'score.desc,created_at.asc', limit: Math.min(1000, limit * 2) });
    const skip = [];
    for (const r of rows) {
      if (UNCHECKABLE.test(r.email.split('@')[1] || '')) skip.push(r.id);
      else if (out.length < limit) out.push({ id: r.id, email: r.email });
    }
    for (let i = 0; i < skip.length; i += 150) await db.update('prospects', { id: ['in', skip.slice(i, i + 150)] }, { verified: 'unknown', verified_at: iso(now()) });
    await db.upsert('settings', [{ key: 'verify.enabled', value: true, updated_at: iso(now()) }], 'key');
    return { emails: out, markedUnknown: skip.length };
  },

  async 'verify.results'({ results = [] }) {
    const counts = {};
    const products = Object.fromEntries((await db.select('products', {})).map(p => [p.id, p]));
    for (const r of results.slice(0, 500)) {
      const v = ['safe', 'risky', 'unknown', 'invalid'].includes(r.reachable) ? r.reachable : 'unknown';
      counts[v] = (counts[v] || 0) + 1;
      const p = await db.one('prospects', { id: r.id });
      if (!p) continue;
      const patch = { verified: v, verified_at: iso(now()) };
      if (v === 'invalid') Object.assign(patch, { status: 'skipped', skip_reason: 'email address does not exist (checked)' });
      else Object.assign(patch, score({ ...p, verified: v }, products[p.product_id]));
      await db.update('prospects', { id: p.id }, patch);
    }
    const prev = (await db.one('settings', { key: 'verify.totals' }))?.value || {};
    for (const [k, n] of Object.entries(counts)) prev[k] = (prev[k] || 0) + n;
    await db.upsert('settings', [{ key: 'verify.totals', value: { ...prev, last: iso(now()) }, updated_at: iso(now()) }], 'key');
    return { counts };
  },

  // Starts a scan in the background function (up to 15 minutes). If the plan has no background
  // functions, the screen falls back to one product and one source per request.
  async 'radar.scan'({ productId, platforms }) {
    if (!process.env.XAI_API_KEY) throw new Error('Set XAI_API_KEY in Netlify environment variables first.');
    const r = await fetch(`${siteUrl()}/.netlify/functions/radar-scan-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-radar-internal': internalToken() },
      body: JSON.stringify({ productId, platforms, trigger: 'manual' }),
    }).catch(() => null);
    if (!r || (r.status !== 202 && !r.ok)) return { started: false, fallback: true };
    return { started: true };
  },

  async 'radar.scanInline'({ productId, platform, first, last }) {
    if (first) await startScan('manual, from the screen');
    const st = await scanStatus();
    const carry = first ? { added: 0, parts: [] } : (st.carry || { added: 0, parts: [] });
    const n = await scanProduct(await getProduct(productId), await radarSettings(), [platform], carry);
    await db.upsert('settings', [{ key: 'radar.scan', value: { ...(await scanStatus()), carry }, updated_at: iso(now()) }], 'key');
    if (last) await finishScan();
    return { added: n };
  },

  async 'radar.status'() {
    return { scan: await scanStatus(), usage: await getUsage(), settings: await radarSettings(), xai: !!process.env.XAI_API_KEY, bluesky: !!(process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD) };
  },

  async 'radar.settings.save'({ settings }) { return { settings: await saveRadarSettings(settings || {}) }; },

  async 'radar.stats'({ productId }) {
    const rows = await db.select('conversations', { select: 'id,platform,status,clicks,signups,purchases,draft,url,author,sent_at,score', filters: { product_id: productId || undefined }, limit: 5000 });
    const byPlatform = {};
    for (const r of rows) {
      const g = byPlatform[r.platform] ||= { found: 0, sent: 0, clicks: 0, signups: 0, purchases: 0 };
      g.found++; if (r.status === 'sent') g.sent++;
      g.clicks += r.clicks || 0; g.signups += r.signups || 0; g.purchases += r.purchases || 0;
    }
    const best = rows.filter(r => r.status === 'sent' && (r.clicks || r.signups || r.purchases))
      .sort((a, b) => (b.purchases * 100 + b.signups * 10 + b.clicks) - (a.purchases * 100 + a.signups * 10 + a.clicks)).slice(0, 8);
    return { byPlatform, best };
  },

  async 'stats'({ productId }) {
    const product = await getProduct(productId);
    const sent = await db.select('messages', { select: 'prospect_id,step,angle,sent_at,sender,edited', filters: { product_id: productId, status: 'sent' }, limit: 10000 });
    const replies = await db.select('replies', { select: 'prospect_id,label', filters: { product_id: productId }, limit: 10000 });
    const pf = { product_id: productId, step: ['gte', 1] };
    const ps = await db.select('prospects', { select: 'id,name,email,segment,score,status,clicks,first_click_at,signed_up_at', filters: pf, limit: 10000 })
      .catch(() => db.select('prospects', { select: 'id,segment,score,status', filters: pf, limit: 10000 }));   // before the tracking columns exist
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
        const k = keyFn(id); const row = g[k] ||= { people: 0, clicked: 0, replied: 0, positive: 0, signedUp: 0, won: 0, bounced: 0 };
        row.people++; if (replied(id)) row.replied++; if (positive(id)) row.positive++;
        if (byP[id]?.first_click_at) row.clicked++; if (byP[id]?.signed_up_at || byP[id]?.status === 'signed_up') row.signedUp++;
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
      tracking: { domain: trackDomain() || null },
      // Who clicked, newest first: warm people worth a personal note if they haven't replied.
      clickers: ps.filter(p => p.first_click_at).sort((a, b) => Date.parse(b.first_click_at) - Date.parse(a.first_click_at)).slice(0, 50)
        .map(p => ({ id: p.id, name: p.name, email: p.email, clicks: p.clicks, first_click_at: p.first_click_at, signed_up: !!p.signed_up_at, status: p.status, replied: replied(p.id) })),
      clicksByStep: await db.select('link_events', { select: 'step', filters: { product_id: productId, kind: 'click' }, limit: 10000 })
        .then(rows => rows.reduce((o, r) => ((o[r.step ?? '?'] = (o[r.step ?? '?'] || 0) + 1), o), {}), () => ({})),
    };
  },
};

