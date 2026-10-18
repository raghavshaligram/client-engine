// App-screen and worker actions for the agency (POST /api with the app key).
import { db } from '../db.mjs';
import { conversation, touch, queue, links, getProduct, iso, conf } from './deals.mjs';
import { claimJob, jobDone, jobFailed, toClient, sitePaid, startBuild } from './delivery.mjs';
import { makeMockup } from './ticks.mjs';

async function load(id) {
  const deal = await db.one('deals', { id });
  if (!deal) throw new Error('Unknown deal');
  const prospect = await db.one('prospects', { id: deal.prospect_id });
  return { deal, prospect, product: await getProduct(deal.product_id) };
}

const ORDER = ['talking', 'mockup_queued', 'mockup_sent', 'offer_sent', 'intake', 'building', 'qa', 'owner_check', 'client_review', 'domain', 'live', 'rest', 'lost'];

export const agencyActions = {
  async 'agency.list'({ productId }) {
    const deals = await db.select('deals', { filters: { product_id: productId || undefined }, order: 'updated_at.desc', limit: 300 });
    const ids = deals.map(d => d.prospect_id);
    const ps = ids.length ? await db.select('prospects', { select: 'id,name,email,city,state,website,category', filters: { id: ['in', ids] } }) : [];
    const byId = Object.fromEntries(ps.map(p => [p.id, p]));
    const jobs = await db.select('jobs', { select: 'deal_id,type,status', filters: { status: ['in', ['queued', 'running']] }, limit: 500 });
    const rows = deals.map(d => ({
      id: d.id, slug: d.slug, stage: d.stage, needs_human: d.needs_human, human_reason: d.human_reason, growth_status: d.growth_status,
      paid_at: d.paid_at, amount_cents: d.amount_cents, preview_url: d.preview_url, domain: d.domain, updated_at: d.updated_at,
      prospect: byId[d.prospect_id], links: links(d), job: jobs.find(j => j.deal_id === d.id) || null,
    })).sort((a, b) => (b.needs_human - a.needs_human) || (ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage)));
    const paid = deals.filter(d => d.paid_at);
    return {
      rows,
      totals: {
        talking: deals.filter(d => ['talking', 'mockup_queued', 'mockup_sent', 'offer_sent'].includes(d.stage)).length,
        clients: paid.length, live: deals.filter(d => d.stage === 'live').length, growth: deals.filter(d => d.growth_status === 'active').length,
        revenue_cents: paid.reduce((n, d) => n + (d.amount_cents || 0), 0), needs_you: deals.filter(d => d.needs_human).length,
      },
      worker: (await db.select('jobs', { select: 'claimed_at', filters: { claimed_at: ['not.is', null] }, order: 'claimed_at.desc', limit: 1 }))[0]?.claimed_at || null,
    };
  },

  async 'agency.deal'({ id }) {
    const { deal, prospect } = await load(id);
    const [convo, outbox, jobs] = await Promise.all([
      conversation(prospect),
      db.select('outbox', { filters: { deal_id: id, status: ['in', ['queued', 'held', 'failed']] }, order: 'send_at.asc' }),
      db.select('jobs', { filters: { deal_id: id }, order: 'created_at.desc', limit: 20 }),
    ]);
    return { deal, prospect, convo, outbox, jobs, links: links(deal) };
  },

  // You answer a conversation the AI handed to you. Goes out on the next agency tick (within 5 minutes), in the thread.
  async 'agency.reply'({ id, text }) {
    const { deal, prospect } = await load(id);
    if (!String(text || '').trim()) throw new Error('Write a message first');
    await queue({ deal, prospect, body: String(text).trim(), kind: 'owner', immediate: true });
    await db.update('replies', { prospect_id: prospect.id, handled: false }, { handled: true });
    await touch(deal, {}, 'you replied');
    return { ok: true };
  },

  async 'agency.handBack'({ id }) {
    const { deal, prospect } = await load(id);
    const [last] = await db.select('replies', { filters: { prospect_id: prospect.id, handled: false }, order: 'received_at.desc', limit: 1 });
    if (last) await db.update('replies', { id: last.id }, { label: 'pending', answer: null });
    await touch(deal, { needs_human: false, human_reason: null, pending_reply: !!last, auto_messages: 0 }, 'handed back to the AI');
    return { ok: true, willAnswer: !!last };
  },

  async 'agency.cancelMessage'({ outboxId }) { await db.update('outbox', { id: outboxId, status: ['in', ['queued', 'held', 'failed']] }, { status: 'cancelled' }); return { ok: true }; },
  async 'agency.retryMessage'({ outboxId }) { await db.update('outbox', { id: outboxId, status: 'failed' }, { status: 'queued', send_at: iso(Date.now()), error: null }); return { ok: true }; },

  async 'agency.ownerApprove'({ id }) {
    const { deal, prospect, product } = await load(id);
    if (deal.stage !== 'owner_check') throw new Error('This site is not waiting for your OK');
    await toClient(deal, prospect, product);
    return { ok: true };
  },

  async 'agency.ownerChanges'({ id, notes }) {
    const { deal } = await load(id);
    if (!String(notes || '').trim()) throw new Error('Say what to change');
    await db.insert('jobs', [{ deal_id: id, type: 'fix', input: { problems: String(notes).split('\n').map(s => s.trim()).filter(Boolean) } }]);
    await touch(deal, { stage: 'building' }, 'you asked for changes before the client sees it');
    return { ok: true };
  },

  async 'agency.markPaid'({ id }) {
    const { deal } = await load(id);
    return sitePaid(deal, { paymentId: 'manual', amount: null, email: deal.customer_email });
  },
  async 'agency.rebuild'({ id }) { const { deal } = await load(id); await startBuild(deal); return { ok: true }; },
  async 'agency.remakeMockup'({ id, notes }) {
    const { deal } = await load(id);
    await touch(deal, { mockup_notes: notes ?? deal.mockup_notes });
    return { name: await makeMockup(deal) };
  },
  async 'agency.lost'({ id }) { const { deal } = await load(id); await touch(deal, { stage: 'lost', needs_human: false }, 'marked lost by you'); return { ok: true }; },

  async 'agency.config.save'({ productId, patch }) {
    const product = await getProduct(productId);
    const c = conf(product);
    if (!c) throw new Error('Not an agency product');
    const next = { ...c };
    if (Array.isArray(patch.packages)) next.packages = c.packages.map(p => ({ ...p, ...(patch.packages.find(x => x.id === p.id) || {}) }));
    for (const k of ['review_first', 'revisions', 'delivery_days', 'max_auto_messages']) if (patch[k] !== undefined) next[k] = Math.max(0, Number(patch[k]) || 0);
    await db.update('products', { id: productId }, { rules: { ...product.rules, agency: next } });
    return { agency: next };
  },

  // ---- The build worker ----
  'jobs.claim': () => claimJob(),
  'jobs.done': args => jobDone(args),
  'jobs.failed': args => jobFailed(args),
};
