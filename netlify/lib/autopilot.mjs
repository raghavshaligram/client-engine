// The autopilot: what runs on its own every 10 minutes, and the morning digest.
import { db } from './db.mjs';
import { actions, autopilotState, senders, AUTO_MIN_SCORE } from './actions.mjs';
import * as gmail from './gmail.mjs';
import { senderPlan, warmupTick } from './warmup.mjs';
export { warmupTick };

const iso = d => new Date(d).toISOString();
export const budget = ms => { const end = Date.now() + ms; return () => end - Date.now(); };

// US business hours, Central time: weekdays 8am to 5pm. Owners read email then.
export function businessWindow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const open = !['Sat', 'Sun'].includes(parts.weekday) && mins >= 8 * 60 && mins < 17 * 60;
  return { open, slotsLeft: open ? Math.max(1, Math.ceil((17 * 60 - mins) / 10)) : 0 };
}

async function notify(subject, body) {
  const to = process.env.DIGEST_TO;
  const from = (await senders()).find(s => s.mode !== 'browser');
  if (!to || !from || !gmail.serverGmailReady()) return false;
  await gmail.send(from.email, { to, subject, body, fromName: 'Client Engine' });
  return true;
}

// 1. Read new websites, 2. write drafts, 3. approve the strong ones for products that have graduated.
export async function researchTick({ timeLeft = budget(22000) } = {}) {
  const log = [];
  const products = await db.select('products', { order: 'id' });
  for (const p of products) {
    if (timeLeft() < 14000) break;
    if (!(await db.count('prospects', { product_id: p.id, status: 'new' }))) continue;
    const r = await actions['prospects.scan']({ productId: p.id, limit: 4 });
    log.push(`${p.name}: read ${r.scanned.length} sites, ${r.left} left`);
  }
  // Take turns, so one product can't use up every run.
  const start = Math.floor(Date.now() / 600000) % (products.length || 1);
  for (const p of [...products.slice(start), ...products.slice(0, start)]) {
    if (timeLeft() < 9000) break;
    if (p.paused) continue;
    let r = await actions['draft.next']({ productId: p.id });
    if (r.retry && timeLeft() > 7000) r = await actions['draft.next']({ productId: p.id, prospectId: r.prospectId, feedback: r.feedback, attempt: 2 });
    if (!r.done) log.push(`${p.name}: ${r.drafted ? 'drafted' : r.skipped ? 'skipped' : r.dropped ? 'dropped' : 'retry later'} ${r.prospect || ''}`);
  }
  for (const p of products) {
    const st = await autopilotState(p);
    if (!st.on || p.paused) continue;
    const rows = await db.update('messages', { product_id: p.id, status: 'draft', check_score: ['gte', AUTO_MIN_SCORE] },
      { status: 'approved', auto_approved: true, approved_at: iso(new Date()) });
    if (rows.length) log.push(`${p.name}: autopilot approved ${rows.length}`);
  }
  return log;
}

// Send: each server inbox spreads what's left of its daily cap over what's left of the business day.
export async function sendTick({ timeLeft = budget(14000), now = new Date(), rand = Math.random } = {}) {
  const log = [];
  const win = businessWindow(now);
  if (!win.open) return ['outside US business hours, not sending'];
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  for (const s of (await senders()).filter(x => x.mode !== 'browser')) {
    if (timeLeft() < 6000) break;
    const plan = senderPlan(s, now);
    if (plan.warming) continue;
    const sent = await db.count('messages', { sender: s.email, status: 'sent', sent_at: ['gte', iso(today)] });
    const left = plan.coldCap - sent;
    if (left <= 0) continue;
    if (rand() >= Math.min(1, left / win.slotsLeft)) continue;
    const n = await actions['send.next']({ sender: s.email });
    if (n.stop) { if (n.stop !== 'empty') log.push(`${s.email}: ${n.reason}`); continue; }
    try {
      const r = await gmail.send(s.email, n.message);
      await actions['send.done']({ messageId: n.message.id, sender: s.email, ...r });
      log.push(`${s.email}: sent to ${n.message.prospect}`);
    } catch (e) {
      await actions['send.failed']({ messageId: n.message.id, error: e.message });
      log.push(`${s.email}: failed for ${n.message.to}: ${e.message}`);
    }
  }
  return log;
}

// Replies: read the threads that haven't been checked for longest. Hot leads get an email to you right away.
export async function repliesTick({ timeLeft = budget(14000), perInbox = 15 } = {}) {
  const log = [], hot = [], brakes = [];
  const since = iso(Date.now() - 60 * 86_400_000);
  for (const s of (await senders()).filter(x => x.mode !== 'browser')) {
    const ps = await db.select('prospects', {
      select: 'id,name,email,thread_id,product_id', order: 'replies_checked_at.asc.nullsfirst', limit: perInbox,
      filters: { sender: s.email, thread_id: ['not.is', null], last_sent_at: ['gte', since], status: ['in', ['contacted', 'drafted', 'done', 'rest', 'replied', 'interested']] },
    });
    if (!ps.length) continue;
    const ids = ps.map(p => p.id);
    const known = new Set([
      ...(await db.select('replies', { select: 'gmail_id', filters: { prospect_id: ['in', ids] } })),
      ...(await db.select('messages', { select: 'gmail_id', filters: { prospect_id: ['in', ids], status: 'sent' } })),
    ].map(r => r.gmail_id));
    for (const p of ps) {
      if (timeLeft() < 4000) break;
      try {
        const t = await gmail.thread(s.email, p.thread_id);
        for (const m of t.messages || []) {
          if (known.has(m.id)) continue;
          const from = gmail.header(m, 'From');
          if (from.toLowerCase().includes(s.email)) continue;
          const r = await actions['replies.add']({
            prospectId: p.id, gmailId: m.id, from, subject: gmail.header(m, 'Subject'),
            body: gmail.stripQuoted(gmail.bodyText(m.payload)) || m.snippet || '', date: Number(m.internalDate) || null,
          });
          if (r.duplicate) continue;
          log.push(`${p.name}: ${r.reply.label}`);
          if (['interested', 'question'].includes(r.reply.label)) hot.push({ p, r: r.reply });
          if (r.brake) brakes.push(`${p.product_id}: ${r.brake}`);
        }
      } catch (e) { log.push(`${p.name}: ${e.message}`); }
      await db.update('prospects', { id: p.id }, { replies_checked_at: iso(new Date()) });
    }
  }
  for (const { p, r } of hot) {
    await notify(`Reply from ${p.name}: ${r.label}`,
      `${p.name} <${p.email}> replied:\n\n${r.body.slice(0, 1500)}\n\nDrafted answer:\n${r.answer || '(none)'}\n\nOpen Client Engine > Replies to send it.`).catch(() => {});
  }
  for (const b of brakes) await notify('Sending paused', `${b}\n\nOpen Client Engine, read it, then resume from Today.`).catch(() => {});
  return log;
}

// The 9am (India time) email: what needs you, and yesterday's numbers.
export async function digestText(now = new Date()) {
  const since = iso(now.getTime() - 86_400_000);
  const lines = [`Client Engine, ${now.toUTCString().slice(0, 16)}`, ''];
  let needsYou = 0;
  for (const s of await senders()) {
    const plan = senderPlan(s, now);
    lines.push(plan.warming ? `Inbox ${s.email}: warming up, day ${plan.day + 1} of 14.` : `Inbox ${s.email}: up to ${plan.coldCap} cold emails today (max ${s.daily_cap}).`);
  }
  lines.push('');
  for (const p of await db.select('products', { order: 'id' })) {
    const st = await autopilotState(p);
    const sent = await db.count('messages', { product_id: p.id, status: 'sent', sent_at: ['gte', since] });
    const waiting = await db.select('replies', { filters: { product_id: p.id, handled: false }, order: 'received_at.asc', limit: 20 });
    const drafts = await db.count('messages', { product_id: p.id, status: 'draft' });
    const ready = await db.count('prospects', { product_id: p.id, status: ['in', ['new', 'scanned']] });
    const won = await db.count('prospects', { product_id: p.id, status: 'won' });
    needsYou += waiting.length + (p.paused ? 1 : 0) + (st.on ? 0 : drafts);
    lines.push(`== ${p.name} ==`);
    if (p.paused) lines.push(`PAUSED: ${p.paused_reason}`);
    lines.push(`Sent in the last day: ${sent}. Customers so far: ${won}. People ready: ${ready}.`);
    lines.push(st.on ? `Autopilot on. Drafts waiting for you (scored under ${AUTO_MIN_SCORE}): ${drafts}.`
      : `Learning: you've approved ${st.approvedByYou} of ${st.needed} first emails. Drafts waiting: ${drafts}.`);
    if (waiting.length) {
      lines.push(`Replies to answer (${waiting.length}):`);
      for (const r of waiting) lines.push(`  - ${r.from_addr} [${r.label}]: ${String(r.body).split('\n')[0].slice(0, 120)}`);
    }
    if (ready < 20 && !p.paused) lines.push(`Running low on people. Add searches or a registry file.`);
    lines.push('');
  }
  return { text: lines.join('\n'), needsYou };
}

export async function digestTick() {
  const { text, needsYou } = await digestText();
  const ok = await notify(needsYou ? `${needsYou} thing${needsYou === 1 ? '' : 's'} need you today` : 'All running, nothing needs you', text);
  return [ok ? 'digest sent' : 'digest not sent: set DIGEST_TO and a server inbox'];
}
