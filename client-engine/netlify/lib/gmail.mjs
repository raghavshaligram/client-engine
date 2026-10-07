// Gmail from the server, for inboxes on your own Google Workspace domains.
// Uses a service account with domain-wide delegation, so no sign-in ever expires and
// no Google app review is needed. Setup steps are in the README.
import crypto from 'node:crypto';

// gmail.modify lets warm-up rescue its own emails from spam and archive them. Must match the scopes in the Workspace admin.
export const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify';
const cache = new Map(); // inbox -> { token, until }

export function serverGmailReady() {
  return !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_KEY);
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function token(inbox) {
  const hit = cache.get(inbox);
  if (hit && hit.until > Date.now()) return hit.token;
  if (!serverGmailReady()) throw new Error('GOOGLE_SA_EMAIL and GOOGLE_SA_KEY are not set in Netlify');
  const key = process.env.GOOGLE_SA_KEY.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: process.env.GOOGLE_SA_EMAIL, sub: inbox, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google refused access to ${inbox}: ${data.error_description || data.error || res.status}. Check domain-wide delegation in the Workspace admin.`);
  cache.set(inbox, { token: data.access_token, until: Date.now() + (data.expires_in - 120) * 1000 });
  return data.access_token;
}

async function call(inbox, path, opts = {}) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + await token(inbox), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Gmail error ' + res.status);
  return data;
}

const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';

export function buildMime({ from, fromName, to, subject, body, inReplyTo, messageId }) {
  const h = [
    fromName ? `From: ${encWord(fromName)} <${from}>` : `From: ${from}`, `To: ${to}`, `Subject: ${encWord(subject)}`,
    `Message-ID: ${messageId}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  if (inReplyTo) h.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const b = Buffer.from(body.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return b64url(h.join('\r\n') + '\r\n\r\n' + b);
}

export async function send(inbox, m) {
  const messageId = `<${crypto.randomUUID()}@${inbox.split('@')[1]}>`;
  const raw = buildMime({ from: inbox, fromName: m.fromName, to: m.to, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo, messageId });
  const sent = await call(inbox, 'messages/send', { method: 'POST', body: JSON.stringify(m.threadId ? { raw, threadId: m.threadId } : { raw }) });
  let real = messageId;
  try {
    const meta = await call(inbox, `messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
    real = header(meta, 'Message-ID') || messageId;
  } catch {}
  return { gmailId: sent.id, threadId: sent.threadId, messageIdHeader: real };
}

export const thread = (inbox, id) => call(inbox, `threads/${id}?format=full`);

// Find a message in an inbox by its Message-ID header, including Spam.
export async function findByMessageId(inbox, messageId) {
  const q = encodeURIComponent('rfc822msgid:' + messageId.replace(/^<|>$/g, ''));
  const list = await call(inbox, `messages?q=${q}&includeSpamTrash=true&maxResults=1`);
  const id = list.messages?.[0]?.id;
  return id ? call(inbox, `messages/${id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`) : null;
}

export const modify = (inbox, id, addLabelIds = [], removeLabelIds = []) =>
  call(inbox, `messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds, removeLabelIds }) });

export const header = (msg, name) => (msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

export function bodyText(payload) {
  const dec = d => Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const walk = part => {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) return dec(part.body.data);
    for (const c of part.parts || []) { const t = walk(c); if (t) return t; }
    if (part.mimeType === 'text/html' && part.body?.data) return dec(part.body.data).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
    return '';
  };
  return walk(payload);
}

export const stripQuoted = t => t.split(/\r?\n(On .{5,200}wrote:|-{2,} ?Original Message|From: .+\r?\nSent: )/)[0]
  .split('\n').filter(l => !l.startsWith('>')).join('\n').trim();
