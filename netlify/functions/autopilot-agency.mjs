// Every 5 minutes: the closer answers replies, mockups get made, deals move along, messages go out.
import { agencyTick } from '../lib/agency/ticks.mjs';
import { budget } from '../lib/autopilot.mjs';

export const config = { schedule: '*/5 * * * *' };

export default async () => {
  let log;
  try { log = await agencyTick({ timeLeft: budget(25000) }); } catch (e) { log = ['agency: ' + e.message]; }
  console.log(log.join('\n') || 'nothing to do');
  return new Response('ok');
};
