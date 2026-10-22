// Email checks: hand-out skips uncheckable providers, results skip invalid addresses and adjust scores, drafting waits for checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb, fakeOpenAI, installFetch } from './fakes.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', APP_KEY: 'k' });
const db = fakeDb();
installFetch({ db, ai: fakeOpenAI() });
const { actions: A } = await import('../netlify/lib/actions.mjs');

test('checks: invalid skipped, safe scores up, Yahoo marked unknown, drafting waits', async () => {
  await A['setup.status']();
  const rows = [
    { name: 'Gmail HOA', email: 'treasurer.a@gmail.com' }, { name: 'Dead HOA', email: 'gone.b@gmail.com' },
    { name: 'Yahoo HOA', email: 'board.c@yahoo.com' }, { name: 'Own HOA', email: 'treasurer@ownhoa.org' },
  ];
  await A['prospects.import']({ productId: 'keephoa', segment: 'virginia', kind: 'registry', rows, sourceFile: 't', defaultState: 'VA' });
  const n = await A['verify.next']({ limit: 10 });
  assert.deepEqual(n.emails.map(e => e.email).sort(), ['gone.b@gmail.com', 'treasurer.a@gmail.com', 'treasurer@ownhoa.org']);
  assert.equal(n.markedUnknown, 1);
  const by = e => db.T.prospects.find(p => p.email === e);
  assert.equal(by('board.c@yahoo.com').verified, 'unknown');
  // Checking is now on: nothing unchecked gets a first email.
  const before = by('treasurer.a@gmail.com').score;
  const d1 = await A['draft.next']({ productId: 'keephoa' });
  assert.equal(d1.prospect, 'Yahoo HOA', 'only the already-marked address is draftable');
  await A['verify.results']({ results: [
    { id: by('treasurer.a@gmail.com').id, reachable: 'safe' },
    { id: by('gone.b@gmail.com').id, reachable: 'invalid' },
    { id: by('treasurer@ownhoa.org').id, reachable: 'risky' },
  ] });
  assert.equal(by('gone.b@gmail.com').status, 'skipped');
  assert.match(by('gone.b@gmail.com').skip_reason, /does not exist/);
  assert.equal(by('treasurer.a@gmail.com').score, before + 1);
  assert.match(by('treasurer.a@gmail.com').score_why, /mailbox confirmed/);
  assert.match(by('treasurer@ownhoa.org').score_why, /may not take mail/);
  const d2 = await A['draft.next']({ productId: 'keephoa' });
  assert.equal(d2.prospect, 'Gmail HOA');
  assert.equal((await A['verify.next']({ limit: 10 })).emails.length, 0, 'nothing checked twice');
  const tot = db.T.settings.find(s => s.key === 'verify.totals').value;
  assert.deepEqual([tot.safe, tot.invalid, tot.risky], [1, 1, 1]);
});
