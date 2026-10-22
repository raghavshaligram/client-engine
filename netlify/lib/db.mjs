// Tiny Supabase (PostgREST) client. No npm packages: plain fetch with the service key.

// Accepts the Project URL in any form people paste: with /rest/v1, without https://, or the dashboard link.
export function projectUrl(raw = process.env.SUPABASE_URL) {
  let url = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!url) throw new Error('SUPABASE_URL is not set in Netlify environment variables');
  const dash = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
}
const base = () => projectUrl() + '/rest/v1/';
const headers = (extra = {}) => {
  const key = String(process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set in Netlify environment variables');
  // New-style keys (sb_secret_...) go only on the apikey header; legacy service_role keys are JWTs and go on both.
  return key.startsWith('sb_') ? { apikey: key, 'Content-Type': 'application/json', ...extra }
    : { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
};

// filters: { col: value } -> eq ; { col: ['in', [..]] } ; { col: ['is', null] } ; { col: ['lt'|'lte'|'gt'|'gte'|'neq', v] }
function qs({ select = '*', filters = {}, order, limit, offset } = {}) {
  const p = new URLSearchParams();
  p.set('select', select);
  for (const [col, v] of Object.entries(filters)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      const [op, val] = v;
      if (op === 'in') p.append(col, `in.(${val.map(x => `"${String(x).replace(/"/g, '')}"`).join(',')})`);
      else if (op === 'is') p.append(col, `is.${val === null ? 'null' : val}`);
      else p.append(col, `${op}.${val}`);
    } else if (v === null) p.append(col, 'is.null');
    else p.append(col, `eq.${v}`);
  }
  if (order) p.set('order', order);
  if (limit) p.set('limit', String(limit));
  if (offset) p.set('offset', String(offset));
  return p.toString();
}

async function req(method, table, query, body, prefer) {
  let res;
  try {
    res = await fetch(base() + table + (query ? '?' + query : ''), {
      method,
      headers: headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (/not set in Netlify/.test(e.message)) throw e;
    throw new Error(`Can't reach Supabase at ${projectUrl()} (${e.cause?.code || e.message}). SUPABASE_URL should be the Project URL, like https://abcdefgh.supabase.co`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    throw new Error(`Database ${method} ${table}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (table, opts) => req('GET', table, qs(opts)),
  one: async (table, filters) => (await req('GET', table, qs({ filters, limit: 1 })))[0] || null,
  insert: (table, rows) => req('POST', table, '', rows, 'return=representation'),
  // Insert, skipping rows that clash with a unique key.
  insertIgnore: (table, rows, onConflict) =>
    req('POST', table, `on_conflict=${onConflict}`, rows, 'resolution=ignore-duplicates,return=representation'),
  upsert: (table, rows, onConflict) =>
    req('POST', table, `on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=representation'),
  update: (table, filters, patch) => req('PATCH', table, qs({ filters, select: '*' }), patch, 'return=representation'),
  remove: (table, filters) => req('DELETE', table, qs({ filters })),
  count: async (table, filters) => {
    const res = await fetch(base() + table + '?' + qs({ filters, select: '*', limit: 1 }), {
      headers: headers({ Prefer: 'count=exact', Range: '0-0' }),
    });
    const range = res.headers.get('content-range') || '*/0';
    return Number(range.split('/')[1]) || 0;
  },
};
