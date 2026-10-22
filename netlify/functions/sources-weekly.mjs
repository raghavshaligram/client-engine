// Mondays 06:00 UTC: refresh the Virginia association list (new associations only; existing ones are skipped).
import { actions } from '../lib/actions.mjs';

export const config = { schedule: '0 6 * * 1' };

export default async () => {
  try {
    const r = await actions['source.virginia']({});
    console.log(`Virginia: ${r.total} associations, ${r.volunteers} with a volunteer's address, ${r.added} new`);
  } catch (e) { console.log(e.message); }
  return new Response('ok');
};
