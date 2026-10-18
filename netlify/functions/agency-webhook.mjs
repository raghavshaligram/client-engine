// Dodo Payments webhook: a website purchase starts the client's project; a subscription
// starting or ending turns Growth on or off. Point Dodo at https://<your app>/hooks/dodo
import { db } from '../lib/db.mjs';
import { verifyWebhook } from '../lib/agency/dodo.mjs';
import { findDeal, sitePaid, growthChanged } from '../lib/agency/delivery.mjs';

export const config = { path: '/hooks/dodo' };

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.text();
  const h = k => req.headers.get(k);
  if (!verifyWebhook({ id: h('webhook-id'), timestamp: h('webhook-timestamp'), signature: h('webhook-signature'), body })) return new Response('bad signature', { status: 401 });
  let evt; try { evt = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
  const seen = await db.insertIgnore('webhook_events', [{ id: h('webhook-id'), type: evt.type }], 'id');
  if (!seen.length) return new Response('already handled');
  const d = evt.data || {};
  const deal = await findDeal({ slug: d.metadata?.deal, email: d.customer?.email });
  if (!deal) { console.log('no deal for', evt.type, d.customer?.email); return new Response('no matching deal'); }
  try {
    if (evt.type === 'payment.succeeded' && !d.subscription_id) await sitePaid(deal, { paymentId: d.payment_id, amount: d.total_amount, email: d.customer?.email });
    else if (evt.type === 'subscription.active' || evt.type === 'subscription.renewed') await growthChanged(deal, 'active', d.subscription_id);
    else if (/^subscription\.(cancelled|expired|failed|on_hold)$/.test(evt.type)) await growthChanged(deal, evt.type.split('.')[1], d.subscription_id);
  } catch (e) {
    await db.remove('webhook_events', { id: h('webhook-id') }); // let Dodo retry
    console.error(e); return new Response('error', { status: 500 });
  }
  return new Response('ok');
};
