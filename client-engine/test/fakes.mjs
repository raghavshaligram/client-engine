// In-memory stand-ins for Supabase (PostgREST) and OpenAI, installed by replacing global fetch.
import crypto from 'node:crypto';

const DEFAULTS = {
  products: { paused: false, angles: [], segments: [], rules: {} },
  prospects: { status: 'new', step: 0, score: 0, extra: {}, signals: {} },
  messages: { status: 'draft', edited: false },
  replies: { handled: false },
  suppression: {}, settings: {}, scrape_queries: {}, warmup: { cleaned: false, error: null, replied_at: null, landed_spam: null },
};
const KEYS = { products: ['id'], prospects: ['id'], messages: ['id'], replies: ['id'], suppression: ['email'], settings: ['key'], scrape_queries: ['id'], warmup: ['id'] };
const UNIQUE = { prospects: [['product_id', 'email']], replies: [['gmail_id']], scrape_queries: [['product_id', 'query']] };

export function fakeDb() {
  const T = Object.fromEntries(Object.keys(DEFAULTS).map(t => [t, []]));
  const cmpVal = (a, b) => {
    if (a === null || a === undefined) return NaN;
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && !/[-:T]/.test(String(b))) return na - nb;
    const da = Date.parse(a), dbb = Date.parse(b);
    if (!isNaN(da) && !isNaN(dbb)) return da - dbb;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  const test = (row, col, expr) => {
    const v = row[col];
    let neg = false;
    if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
    const i = expr.indexOf('.'); const op = expr.slice(0, i), val = expr.slice(i + 1);
    let r;
    if (op === 'eq') r = String(v) === val;
    else if (op === 'neq') r = String(v) !== val;
    else if (op === 'is') r = val === 'null' ? v === null || v === undefined : String(v) === val;
    else if (op === 'in') { const list = val.slice(1, -1).split(',').map(s => s.replace(/^"|"$/g, '')); r = list.includes(String(v)); }
    else if (['lt', 'lte', 'gt', 'gte'].includes(op)) {
      const c = cmpVal(v, val); if (isNaN(c)) r = false;
      else r = op === 'lt' ? c < 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : c >= 0;
    } else throw new Error('fake db: op ' + op);
    return neg ? !r : r;
  };
  const filterRows = (rows, params) => rows.filter(row => [...params].every(([k, v]) => ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k) || test(row, k, v)));
  const sortRows = (rows, order) => {
    if (!order) return rows;
    const keys = order.split(',').map(s => { const [c, d, n] = s.split('.'); return [c, d === 'desc' ? -1 : 1, n === 'nullsfirst' ? -1 : n === 'nullslast' ? 1 : (d === 'desc' ? -1 : 1)]; });
    return [...rows].sort((a, b) => {
      for (const [c, d, nulls] of keys) {
        const an = a[c] == null, bn = b[c] == null;
        if (an || bn) { if (an && bn) continue; return (an ? 1 : -1) * nulls; }
        const x = cmpVal(a[c], b[c]); if (x) return x * d;
      }
      return 0;
    });
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  const withDefaults = (t, r) => ({ ...clone(DEFAULTS[t]), ...(KEYS[t][0] === 'id' && !r.id ? { id: crypto.randomUUID() } : {}), created_at: new Date().toISOString(), ...r });
  const clash = (t, r) => {
    const k = KEYS[t][0];
    let hit = T[t].find(x => x[k] === r[k] && r[k] !== undefined);
    if (hit) return hit;
    for (const cols of UNIQUE[t] || []) {
      hit = T[t].find(x => cols.every(c => x[c] === r[c] && r[c] != null));
      if (hit) return hit;
    }
    return null;
  };
  async function handle(url, init) {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    if (!T[table]) return new Response(JSON.stringify({ message: `relation "${table}" does not exist` }), { status: 404 });
    const p = u.searchParams, prefer = init.headers?.Prefer || '';
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method || 'GET';
    const out = rows => new Response(JSON.stringify(clone(rows)), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET') {
      let rows = sortRows(filterRows(T[table], p), p.get('order'));
      const total = rows.length;
      const off = +(p.get('offset') || 0); rows = rows.slice(off, p.get('limit') ? off + +p.get('limit') : undefined);
      return new Response(JSON.stringify(clone(rows)), { status: 200, headers: { 'content-range': `0-${rows.length}/${total}` } });
    }
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body], res = [];
      for (const r of list) {
        const hit = clash(table, r);
        if (hit) {
          if (prefer.includes('ignore-duplicates')) continue;
          if (prefer.includes('merge-duplicates')) { Object.assign(hit, r); res.push(hit); continue; }
          return new Response(JSON.stringify({ message: 'duplicate key value violates unique constraint' }), { status: 409 });
        }
        const row = withDefaults(table, r); T[table].push(row); res.push(row);
      }
      return out(res);
    }
    if (method === 'PATCH') { const rows = filterRows(T[table], p); rows.forEach(r => Object.assign(r, body)); return out(rows); }
    if (method === 'DELETE') { const rows = filterRows(T[table], p); T[table] = T[table].filter(r => !rows.includes(r)); return out([]); }
    throw new Error('fake db method ' + method);
  }
  return { T, handle };
}

// OpenAI stand-in: returns canned JSON depending on which system prompt asked.
export function fakeOpenAI(behaviour = {}) {
  const calls = [];
  async function handle(url, init) {
    const req = JSON.parse(init.body);
    const sys = req.messages[0].content, user = req.messages[1].content;
    calls.push({ sys: sys.slice(0, 40), user });
    let out;
    if (sys.startsWith('You write short')) out = behaviour.writer ? behaviour.writer(user, calls) : {
      skip: false, detail: 'Same-day water heater replacement',
      subject: 'missed calls at Acme',
      body: 'Hi Acme Plumbing,\n\nYour site says you do same-day water heater replacement, so a missed call probably means a lost job.\n\nRingSparrow texts the caller back the moment you miss them, from your own number.\n\nWant me to send a 2-minute walkthrough?\n\nRaghav',
    };
    else if (sys.startsWith('You are a strict editor')) out = behaviour.checker ? behaviour.checker(user, calls) : { score: 8, problems: [] };
    else if (sys.startsWith('You read replies')) out = behaviour.reader ? behaviour.reader(user) : { label: 'interested', summary: 'wants video', answer: 'Here it is: https://ringsparrow.com' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { status: 200 });
  }
  return { calls, handle };
}

export function installFetch({ db, ai, passthrough, testHosts }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    if (s.startsWith('https://fake.supabase.co/')) return db.handle(s, init);
    if (s.startsWith('https://api.openai.com/')) return ai.handle(s, init);
    if (testHosts && /^http:\/\/[a-z]+\.test:/.test(s)) return real(s.replace(/^http:\/\/[a-z]+\.test:/, 'http://127.0.0.1:'), init);
    if (passthrough) return real(url, init);
    throw new Error('unexpected fetch ' + s);
  };
}
