// Tracked links. /go/<code> counts the click (people only, not link checkers) and sends them on with ?ref=ce_<code>
// so the product's site can report a signup. The code belongs to a Conversations reply or to an emailed person.
import { db } from '../lib/db.mjs';
import { isHuman, logEvent, targetFor } from '../lib/track.mjs';

export const config = { path: '/go/:slug' };

const go = location => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

export default async (req, context) => {
  const slug = (context?.params?.slug || new URL(req.url).pathname.split('/').pop() || '').toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return new Response('Link not found', { status: 404 });

  const conv = await db.one('conversations', { slug }).catch(() => null);
  if (conv?.target) {
    if (isHuman(req)) await db.update('conversations', { id: conv.id }, { clicks: (conv.clicks || 0) + 1 }).catch(() => {});
    return go(conv.target);
  }

  const p = await db.one('prospects', { link_slug: slug }).catch(() => null);
  const product = p && await db.one('products', { id: p.product_id }).catch(() => null);
  if (!p || !product?.site) return new Response('Link not found', { status: 404 });
  if (isHuman(req, p.last_sent_at)) {
    const at = new Date().toISOString();
    await db.update('prospects', { id: p.id }, { clicks: (p.clicks || 0) + 1, ...(p.first_click_at ? {} : { first_click_at: at }) }).catch(() => {});
    await logEvent('click', p);
  }
  return go(targetFor(product, p, slug));
};
