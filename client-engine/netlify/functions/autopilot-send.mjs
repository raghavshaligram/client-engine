// Every 10 minutes: send within business hours, then read replies. Netlify gives scheduled functions 30 seconds.
import { sendTick, repliesTick, warmupTick, businessWindow, budget } from '../lib/autopilot.mjs';
import { senders } from '../lib/actions.mjs';

export const config = { schedule: '*/10 * * * *' };

export default async () => {
  const timeLeft = budget(26000);
  const log = [];
  try { log.push(...await sendTick({ timeLeft: () => timeLeft() - 16000 })); } catch (e) { log.push('send: ' + e.message); }
  try { log.push(...await warmupTick({ senders: await senders(), window: businessWindow(), timeLeft: () => timeLeft() - 8000 })); } catch (e) { log.push('warm-up: ' + e.message); }
  try { log.push(...await repliesTick({ timeLeft })); } catch (e) { log.push('replies: ' + e.message); }
  console.log(log.join('\n') || 'nothing to do');
  return new Response('ok');
};
