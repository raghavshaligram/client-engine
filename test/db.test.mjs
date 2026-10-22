import test from 'node:test';
import assert from 'node:assert/strict';
const { projectUrl } = await import('../netlify/lib/db.mjs');
const { explainDbError } = await import('../netlify/lib/actions.mjs');

test('project URL accepted in the forms people paste', () => {
  for (const u of ['https://abcd.supabase.co', 'https://abcd.supabase.co/', 'https://abcd.supabase.co/rest/v1', 'https://abcd.supabase.co/rest/v1/', 'abcd.supabase.co', ' "https://abcd.supabase.co" ', 'https://supabase.com/dashboard/project/abcd/settings/api'])
    assert.equal(projectUrl(u), 'https://abcd.supabase.co', u);
  assert.throws(() => projectUrl(''), /not set/);
});

test('new-style secret keys go only on the apikey header', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers); return new Response('[]', { status: 200 }); };
  const { db } = await import('../netlify/lib/db.mjs');
  process.env.SUPABASE_URL = 'https://abcd.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'sb_secret_abc';
  await db.select('products', {});
  assert.equal(seen[0].apikey, 'sb_secret_abc'); assert.equal(seen[0].Authorization, undefined);
  process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOi.legacy.jwt';
  await db.select('products', {});
  assert.equal(seen[1].Authorization, 'Bearer eyJhbGciOi.legacy.jwt');
});

test('database errors explained', () => {
  assert.match(explainDbError('Database GET products: relation "public.products" does not exist'), /can't see the tables/);
  assert.match(explainDbError("Database GET products: Could not find the table 'public.products' in the schema cache"), /can't see the tables/);
  assert.match(explainDbError('Database GET products: permission denied for table products'), /isn't allowed to use the tables/);
  assert.match(explainDbError('Database POST products: new row violates row-level security policy'), /public \(anon or publishable\) key/);
  assert.match(explainDbError('Database GET products: Invalid API key'), /didn't accept SUPABASE_SERVICE_KEY/);
});
