// Tracked link from a Conversations reply: /go/<slug> counts the click and sends them to the product with ?ref=ce_<slug>.
import { db } from '../lib/db.mjs';

export const config = { path: '/go/:slug' };

const BOT = /bot|crawl|spider|preview|facebookexternalhit|slackbot|discordbot|twitterbot|embedly|whatsapp|telegram|linkedinbot|redditbot/i;

export default async (req, context) => {
  const slug = (context?.params?.slug || new URL(req.url).pathname.split('/').pop() || '').toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return new Response('Link not found', { status: 404 });
  let row = null;
  try { row = await db.one('conversations', { slug }); } catch {}
  if (!row?.target) return new Response('Link not found', { status: 404 });
  if (!BOT.test(req.headers.get('user-agent') || '')) {
    await db.update('conversations', { id: row.id }, { clicks: (row.clicks || 0) + 1 }).catch(() => {});
  }
  return new Response(null, { status: 302, headers: { location: row.target, 'cache-control': 'no-store' } });
};
