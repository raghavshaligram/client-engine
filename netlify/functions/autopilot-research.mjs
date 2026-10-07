// Every 10 minutes: read new websites, write drafts, approve strong drafts for products on autopilot.
import { researchTick, budget } from '../lib/autopilot.mjs';

export const config = { schedule: '5-59/10 * * * *' };

export default async () => {
  let log;
  try { log = await researchTick({ timeLeft: budget(25000) }); } catch (e) { log = ['research: ' + e.message]; }
  console.log(log.join('\n') || 'nothing to do');
  return new Response('ok');
};
