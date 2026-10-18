// What the agency runs on its own, every few minutes.
// agencyTick: answer replies, make mockups, move deals along, send queued messages.
// auditTick:  the slow Google PageSpeed checks (prospect sites before emailing, finished builds before the client sees them).
import { db } from '../db.mjs';
import { score } from '../score.mjs';
import { handleReply, touch, sendOutbox, nextSendTime, iso, getProduct, escalate } from './deals.mjs';
import { writeMockup } from './mockup.mjs';
import { stageChecks, qaDeal } from './delivery.mjs';
import { pageSpeed } from './audit.mjs';
import { localVolume, seoReady } from './seo.mjs';

export async function makeMockup(deal) {
  const p = await db.one('prospects', { id: deal.prospect_id });
  const mockup = await writeMockup(p, deal.mockup_notes || '');
  const stage = deal.stage === 'mockup_queued' ? 'mockup_sent' : deal.stage;
  await touch(deal, { mockup, stage }, deal.mockup_notes ? 'mockup updated' : 'mockup made');
  const held = await db.select('outbox', { filters: { deal_id: deal.id, status: 'held', hold_for: 'mockup' } });
  for (const m of held) await db.update('outbox', { id: m.id }, { status: 'queued', hold_for: null, send_at: iso(nextSendTime(new Date(Date.now() + (2 + Math.random() * 4) * 60_000))) });
  return p.name;
}

export async function agencyTick({ timeLeft = () => 99999 } = {}) {
  const log = [];
  const pending = await db.select('replies', { filters: { label: 'pending', handled: false }, order: 'received_at.asc', limit: 3 });
  for (const r of pending) {
    if (timeLeft() < 15000) break;
    try { log.push(`reply from ${r.from_addr}: ${await handleReply(r)}`); }
    catch (e) {
      log.push(`reply ${r.id}: ${e.message}`);
      const tries = (Number(String(r.answer || '').match(/^retry (\d)/)?.[1]) || 0) + 1;
      if (tries >= 3) {
        await db.update('replies', { id: r.id }, { label: 'needs_you', handled: false, answer: null });
        const p = await db.one('prospects', { id: r.prospect_id });
        const deal = await db.one('deals', { prospect_id: r.prospect_id });
        if (deal) await escalate(deal, p, 'the AI hit an error answering: ' + e.message).catch(() => {});
      } else await db.update('replies', { id: r.id }, { answer: `retry ${tries}` });
    }
  }
  const queued = await db.select('deals', { filters: { mockup: null, stage: ['in', ['mockup_queued', 'mockup_sent', 'offer_sent', 'intake', 'building']] }, order: 'updated_at.asc', limit: 5 });
  for (const d of queued) {
    if (timeLeft() < 12000) break;
    const held = await db.count('outbox', { deal_id: d.id, status: 'held', hold_for: 'mockup' });
    if (!held && d.stage !== 'mockup_queued') continue;
    try { log.push(`mockup for ${await makeMockup(d)}`); } catch (e) { log.push(`mockup ${d.slug}: ${e.message}`); }
  }
  if (timeLeft() > 8000) log.push(...await stageChecks({ timeLeft: () => timeLeft() - 4000 }));
  log.push(...await sendOutbox({ timeLeft }));
  return log;
}

// One prospect: PageSpeed + local search volume, then rescore. Run three at once.
async function auditProspect(p, product) {
  const extra = { ...(p.extra || {}) };
  const url = extra.audit?.final_url || p.website;
  const [psi, vol] = await Promise.all([
    pageSpeed(url, { timeout: 20000 }),
    seoReady() ? localVolume(p.category, p.city, p.state).catch(() => null) : null,
  ]);
  const tries = (extra.psi_tries || 0) + 1;
  if (psi && psi.error && tries < 3) {
    await db.update('prospects', { id: p.id }, { extra: { ...extra, psi_tries: tries, psi_error: psi.error } });
    return `${p.name}: PageSpeed ${psi.error}, retry later`;
  }
  if (psi && !psi.error) extra.psi = psi;
  if (vol) extra.search_volume = vol;
  extra.psi_tries = tries;
  const s = score({ ...p, extra }, product);
  await db.update('prospects', { id: p.id }, { extra, ...s, status: 'scanned' });
  return `${p.name}: audited, score ${s.score}`;
}

export async function auditTick({ timeLeft = () => 99999 } = {}) {
  const log = [];
  const qa = await db.select('deals', { filters: { stage: 'qa', needs_human: false }, order: 'updated_at.asc', limit: 1 });
  if (qa[0] && timeLeft() > 24000) {
    try { log.push(`checks for ${qa[0].slug}: ${await qaDeal(qa[0])}`); } catch (e) { log.push(`checks ${qa[0].slug}: ${e.message}`); }
  }
  if (timeLeft() < 22000) return log;
  const products = (await db.select('products', { order: 'id' })).filter(p => p.rules?.agency && !p.paused);
  for (const product of products) {
    const batch = await db.select('prospects', { filters: { product_id: product.id, status: 'auditing' }, order: 'created_at.asc', limit: 3 });
    if (!batch.length) continue;
    log.push(...await Promise.all(batch.map(p => auditProspect(p, product).catch(e => `${p.name}: ${e.message}`))));
    break;
  }
  return log;
}
