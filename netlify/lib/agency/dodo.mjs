// Dodo Payments: checkout links and webhook signatures (Standard Webhooks: HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw body>", key = base64 of the secret after "whsec_").
import crypto from 'node:crypto';

export function checkoutLink(productId, { email, name, deal, redirect }) {
  const host = process.env.DODO_MODE === 'test' ? 'https://test.checkout.dodopayments.com' : 'https://checkout.dodopayments.com';
  const q = new URLSearchParams({ quantity: '1' });
  if (email) { q.set('email', email); }
  if (name) q.set('fullName', name);
  if (deal) q.set('metadata_deal', deal);
  if (redirect) q.set('redirect_url', redirect);
  return `${host}/buy/${encodeURIComponent(productId)}?${q}`;
}

export function verifyWebhook({ id, timestamp, signature, body }, secret = process.env.DODO_WEBHOOK_SECRET, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !id || !timestamp || !signature) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const want = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return String(signature).split(' ').some(part => {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

// For tests and for checking your setup: sign a body the way Dodo does.
export function signWebhook({ id, timestamp, body }, secret) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}
