// Tiny Supabase (PostgREST) client. No npm packages: plain fetch with the service key.

const base = () => {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set in Netlify environment variables');
  return url.replace(/\/+$/, '') + '/rest/v1/';
};
const headers = (extra = {}) => {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set in Netlify environment variables');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
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
  const res = await fetch(base() + table + (query ? '?' + query : ''), {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
