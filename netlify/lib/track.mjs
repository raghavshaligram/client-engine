// Email link tracking. Each person gets one short code. Their link is either
//   https://<TRACK_DOMAIN>/go/<code>  (counts clicks, then sends them on), or, with no tracking domain set,
//   the product page with ?ref=ce_<code>  (no click counts, but signups and purchases are still credited).
// Links on the shared netlify.app domain are never put in cold email: they hurt delivery.
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { landingLink } from './brain.mjs';

export const trackDomain = () => String(process.env.TRACK_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
export const newCode = () => [...crypto.randomBytes(8)].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

// Where the link finally lands: the product page, tagged so the product's site can report signups.
export function targetFor(product, prospect, code) {
  const u = new URL(landingLink(product, prospect.segment) || product.site);
  u.searchParams.set('ref', 'ce_' + code);
  return u.toString();
}

// The link to put in an email to this person. Falls back to the plain page if tracking can't be set up.
export async function linkFor(product, prospect) {
  const plain = landingLink(product, prospect.segment);
  if (!plain) return plain;
  let code = prospect.link_slug;
  if (!code) {
    code = newCode();
    try { await db.update('prospects', { id: prospect.id }, { link_slug: code }); prospect.link_slug = code; }
    catch { return plain; }   // the tracking columns aren't in the database yet (schema.sql not re-run)
  }
  const host = trackDomain();
  return host ? `https://${host}/go/${code}` : targetFor(product, prospect, code);
}

export async function logEvent(kind, prospect, extra = {}) {
  await db.insert('link_events', [{
    kind, product_id: prospect.product_id, prospect_id: prospect.id, step: prospect.step ?? null,
    angle: prospect.angle || null, segment: prospect.segment || null, ...extra,
  }]).catch(() => {});
}

export async function prospectByRef(ref) {
  const code = String(ref || '').replace(/^(ce|lr)_/, '');
  if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
  return db.one('prospects', { link_slug: code }).catch(() => null);
}

// Security scanners (Microsoft Safe Links, Mimecast, Proofpoint...) open every link the moment an email
// arrives. A "click" in the first 2 minutes after sending, a HEAD request, or a known bot is not a person.
const BOT = /bot|crawl|spider|preview|scan|safelinks|mimecast|proofpoint|barracuda|python|curl|wget|headless|facebookexternalhit|slackbot|whatsapp|telegram|linkedinbot/i;
export function isHuman(req, sentAt, now = Date.now()) {
  if (req.method === 'HEAD') return false;
  const ua = req.headers.get('user-agent') || '';
  if (!ua || BOT.test(ua)) return false;
  if (sentAt && now - Date.parse(sentAt) < 120_000) return false;
  return true;
}
