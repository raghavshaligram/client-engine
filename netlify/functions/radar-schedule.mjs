// Hourly: if a Conversations scan is due (Settings > scan every N hours), hand off to the background function.
import { db } from '../lib/db.mjs';
import { radarSettings, scanDue, internalToken, siteUrl } from '../lib/radar.mjs';

export const config = { schedule: '17 * * * *' };

export default async (req) => {
  if (!process.env.URL && req?.url) { try { process.env.URL = new URL(req.url).origin; } catch {} }
  if (!process.env.XAI_API_KEY) return new Response('XAI_API_KEY not set');
  const [products, s] = await Promise.all([db.select('products', { order: 'id' }), radarSettings()]);
  if (!scanDue(products, s)) return new Response('not due');
  await fetch(`${siteUrl()}/.netlify/functions/radar-scan-background`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-radar-internal': internalToken() },
    body: JSON.stringify({ trigger: 'schedule' }),
  });
  return new Response('started');
};
