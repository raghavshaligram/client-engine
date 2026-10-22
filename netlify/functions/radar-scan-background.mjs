// Background function (the "-background" name gives it up to 15 minutes): the slow Grok searches.
// Only this site can start it: the Conversations screen and the hourly schedule.
import { isInternal, startScan, finishScan, runScan } from '../lib/radar.mjs';

export default async (req) => {
  if (!isInternal(req)) return new Response('Forbidden', { status: 403 });
  let opts = {};
  try { opts = await req.json(); } catch {}
  if (!(await startScan(opts.trigger || 'background'))) return;
  try { await runScan(opts); await finishScan(); }
  catch (e) { await finishScan(e.message); }
};
