// Client Engine server. One endpoint, POST /api {action, ...}. Every call needs the x-app-key header,
// except purchase.record, which product licence servers call with x-purchase-secret.
import { actions, authorised, purchaseAuthorised, json, fail } from '../lib/actions.mjs';
import { researchTick, sendTick, repliesTick, warmupTick, businessWindow, digestText, budget } from '../lib/autopilot.mjs';
import { senders } from '../lib/actions.mjs';

// "Run now" buttons on the Today screen: the same steps the schedules run.
const manual = {
  'autopilot.research': () => researchTick({ timeLeft: budget(22000) }),
  'autopilot.send': () => sendTick({ timeLeft: budget(20000) }),
  'autopilot.replies': () => repliesTick({ timeLeft: budget(22000) }),
  'autopilot.digest': async () => [(await digestText()).text],
  'autopilot.warmup': async () => warmupTick({ senders: await senders(), window: businessWindow(), timeLeft: budget(22000) }),
};

export const config = { path: '/api' };

export default async (req) => {
  if (req.method !== 'POST') return fail('POST only', 405);
  if (!process.env.APP_KEY) return fail('APP_KEY is not set in Netlify environment variables', 500);
  let body;
  try { body = await req.json(); } catch { return fail('Bad JSON'); }
  const ok = authorised(req) || (body.action === 'purchase.record' && purchaseAuthorised(req));
  if (!ok) return fail('Wrong app key', 401);
  if (manual[body.action]) { try { return json({ log: await manual[body.action]() }); } catch (e) { return fail(e.message, 500); } }
  const fn = actions[body.action];
  if (!fn) return fail('Unknown action: ' + body.action);
  try { return json(await fn(body)); }
  catch (e) { return fail(e.message || String(e), 500); }
};

export const _actions = actions; // for tests
