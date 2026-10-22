// Grok via the xAI Responses API (from Launch Radar). Records usage so monthly caps can stop spending.
import { db } from './db.mjs';

const BASE = () => (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, '');
export const month = () => new Date().toISOString().slice(0, 7);
const EMPTY = () => ({ month: month(), xPostsFetched: 0, webSearchCalls: 0, xSearchCalls: 0, inputTokens: 0, outputTokens: 0, requests: 0 });

export async function getUsage() {
  return (await db.one('settings', { key: 'radar.usage.' + month() }))?.value || EMPTY();
}

async function recordUsage(u) {
  const cur = await getUsage();
  const value = {
    ...cur,
    xPostsFetched: cur.xPostsFetched + u.xPostsFetched, webSearchCalls: cur.webSearchCalls + u.webSearchCalls,
    xSearchCalls: cur.xSearchCalls + u.xSearchCalls, inputTokens: cur.inputTokens + u.inputTokens,
    outputTokens: cur.outputTokens + u.outputTokens, requests: cur.requests + 1,
  };
  await db.upsert('settings', [{ key: 'radar.usage.' + month(), value, updated_at: new Date().toISOString() }], 'key');
}

export async function grok({ model, system, user, tools, maxTurns, timeoutMs = 240_000 }) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY is not set in Netlify environment variables');
  const payload = { model, input: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (tools?.length) payload.tools = tools;
  if (maxTurns) payload.max_turns = maxTurns;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE()}/responses`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
  } finally { clearTimeout(timer); }
  const raw = await res.text();
  if (!res.ok) throw new Error(`xAI ${res.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  const u = data.usage || {}, d = u.server_side_tool_usage_details || {};
  const usage = {
    xPostsFetched: Number(d.x_posts_fetched || 0), webSearchCalls: Number(d.web_search_calls || 0), xSearchCalls: Number(d.x_search_calls || 0),
    inputTokens: Number(u.input_tokens || 0), outputTokens: Number(u.output_tokens || 0),
  };
  await recordUsage(usage).catch(() => {});
  return { text: extractText(data), usage };
}

function extractText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) if (item.type === 'message')
    for (const c of item.content || []) if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') parts.push(c.text);
  return parts.join('\n').trim();
}

// First JSON object or array in a model reply (handles ```json fences and chatter).
export function parseJSON(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fenced?.[1], String(text)]) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const end = c.lastIndexOf(c[start] === '{' ? '}' : ']');
    if (end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch {}
  }
  return null;
}
