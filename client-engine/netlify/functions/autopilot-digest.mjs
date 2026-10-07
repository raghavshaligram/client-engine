// 03:30 UTC = 9:00 am India time: the morning email.
import { digestTick } from '../lib/autopilot.mjs';

export const config = { schedule: '30 3 * * *' };

export default async () => {
  let log;
  try { log = await digestTick(); } catch (e) { log = ['digest: ' + e.message]; }
  console.log(log.join('\n'));
  return new Response('ok');
};
