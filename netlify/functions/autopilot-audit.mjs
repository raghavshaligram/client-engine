// Every 5 minutes (offset): Google PageSpeed for prospects' sites, and checks on finished builds.
import { auditTick } from '../lib/agency/ticks.mjs';
import { budget } from '../lib/autopilot.mjs';

export const config = { schedule: '2-59/5 * * * *' };

export default async () => {
  let log;
  try { log = await auditTick({ timeLeft: budget(26000) }); } catch (e) { log = ['audit: ' + e.message]; }
  console.log(log.join('\n') || 'nothing to do');
  return new Response('ok');
};
