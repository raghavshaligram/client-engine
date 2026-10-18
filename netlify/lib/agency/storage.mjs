// Supabase Storage, private bucket "agency": client uploads (logos, photos) and site backups.
// Nobody gets the service key: browsers and the build worker get short-lived signed links.

const BUCKET = 'agency';
const base = () => process.env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1';
const headers = () => ({ apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' });
const clean = p => String(p).replace(/\.\.+/g, '.').replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/^\/+/, '');

async function post(path, body, extra = {}) {
  const res = await fetch(base() + path, { method: 'POST', headers: { ...headers(), ...extra }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Storage: ' + (data.message || data.error || res.status));
  return data;
}

// A link the browser (or worker) can PUT one file to, valid for 2 hours.
export async function uploadUrl(path) {
  const p = clean(path);
  const d = await post(`/object/upload/sign/${BUCKET}/${p}`, {}, { 'x-upsert': 'true' });
  return { path: p, url: base() + d.url };
}

// A link to download one file, valid for `seconds`.
export async function downloadUrl(path, seconds = 6 * 3600) {
  const p = clean(path);
  const d = await post(`/object/sign/${BUCKET}/${p}`, { expiresIn: seconds });
  return base() + (d.signedURL || d.signedUrl);
}

export async function list(prefix) {
  const rows = await post(`/object/list/${BUCKET}`, { prefix: clean(prefix), limit: 100, sortBy: { column: 'name', order: 'asc' } });
  return (Array.isArray(rows) ? rows : []).filter(r => r.id || r.metadata).map(r => ({ path: clean(prefix).replace(/\/?$/, '/') + r.name, size: r.metadata?.size || 0, type: r.metadata?.mimetype || '' }));
}

export const safeName = n => String(n || 'file').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-60) || 'file';
