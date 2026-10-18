// Generated pictures. Claude Code writes the list it wants (IMAGES.json); the worker makes them here,
// so the API key never reaches Claude Code or the site folder.
// Provider: Replicate when replicateApiToken is set, otherwise OpenAI when openaiApiKey is set.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const ASPECTS = { '16:9': [16, 9], '3:2': [3, 2], '4:3': [4, 3], '1:1': [1, 1], '3:4': [3, 4], '2:3': [2, 3], '4:5': [4, 5], '9:16': [9, 16], '21:9': [21, 9] };
export const provider = cfg => (cfg.replicateApiToken ? 'replicate' : cfg.openaiApiKey ? 'openai' : '');

// IMAGES.json: [{ "file": "hero.webp", "aspect": "16:9", "prompt": "...", "use": "home hero" }]
export function readPlan(work, max) {
  const p = path.join(work, 'IMAGES.json');
  if (!fs.existsSync(p)) return [];
  let list;
  try { list = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error('IMAGES.json is not valid JSON'); }
  if (!Array.isArray(list)) list = list.images || [];
  return list.slice(0, max).map(x => ({
    file: String(x.file || '').toLowerCase().replace(/\.(webp|jpe?g|png)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '.webp',
    aspect: ASPECTS[x.aspect] ? x.aspect : '16:9',
    prompt: String(x.prompt || '').trim().slice(0, 1800),
    use: String(x.use || ''),
  })).filter(x => /^[a-z0-9][a-z0-9-]*\.webp$/.test(x.file) && x.prompt.length > 20);
}

async function replicate(cfg, prompt, aspect) {
  const model = cfg.replicateModel || 'google/nano-banana-2';
  const H = { Authorization: `Bearer ${cfg.replicateApiToken}`, 'Content-Type': 'application/json' };
  let res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST', headers: { ...H, Prefer: 'wait=60' },
    body: JSON.stringify({ input: { prompt, aspect_ratio: aspect, output_format: 'jpg', resolution: '2K' } }),
  });
  let p = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${p.detail || p.title || ''}`.trim());
  for (let i = 0; i < 80 && !['succeeded', 'failed', 'canceled'].includes(p.status); i++) {
    await new Promise(r => setTimeout(r, 3000));
    p = await (await fetch(p.urls.get, { headers: H })).json();
  }
  if (p.status !== 'succeeded') throw new Error(`Replicate ${p.status}: ${p.error || 'timed out'}`);
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  const img = await fetch(url);
  if (!img.ok) throw new Error('download ' + img.status);
  return { bytes: Buffer.from(await img.arrayBuffer()), model };
}

async function openai(cfg, prompt, aspect) {
  const [w, h] = ASPECTS[aspect];
  const size = w > h ? '1536x1024' : w < h ? '1024x1536' : '1024x1024';
  const model = cfg.openaiImageModel || 'gpt-image-2';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.openaiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, quality: cfg.openaiImageQuality || 'high', n: 1 }),
    signal: AbortSignal.timeout(240_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${d.error?.message || ''}`.slice(0, 300));
  const it = d.data?.[0] || {};
  const bytes = it.b64_json ? Buffer.from(it.b64_json, 'base64') : Buffer.from(await (await fetch(it.url)).arrayBuffer());
  return { bytes, model };
}

// Crops to the exact aspect and writes WebP (sharp via npx; falls back to the original file).
async function toWebp(run, src, dest, aspect, width = 1800) {
  const [w, h] = ASPECTS[aspect];
  const height = Math.round(width * h / w);
  const r = await run('npx', ['--yes', 'sharp-cli@6', '-i', src, '-o', dest.split(path.sep).join('/'), '-f', 'webp', '-q', '80', 'resize', String(width), String(height), '--fit', 'cover'], { timeoutMs: 180_000 });
  if (r.code === 0 && fs.existsSync(dest)) { await fsp.rm(src, { force: true }); return dest; }
  const fallback = dest.replace(/\.webp$/, path.extname(src));
  await fsp.rename(src, fallback);
  return fallback;
}

export async function generateImages(cfg, work, run, log = () => {}, { max = 8, make } = {}) {
  const plan = readPlan(work, max);
  const dir = path.join(work, 'site', 'assets', 'img');
  await fsp.mkdir(dir, { recursive: true });
  const which = provider(cfg);
  const done = [], failed = [];
  for (const it of plan) {
    const dest = path.join(dir, it.file);
    if (fs.existsSync(dest)) { done.push(it.file); continue; }
    if (!which && !make) { failed.push(`${it.file}: no image key in config.json`); continue; }
    try {
      const { bytes, model } = make ? await make(it) : which === 'replicate' ? await replicate(cfg, it.prompt, it.aspect) : await openai(cfg, it.prompt, it.aspect);
      const raw = path.join(work, 'raw', 'gen-' + it.file.replace(/\.webp$/, '.png'));
      await fsp.mkdir(path.dirname(raw), { recursive: true });
      await fsp.writeFile(raw, bytes);
      const out = await toWebp(run, raw, dest, it.aspect);
      await fsp.appendFile(path.join(work, 'IMAGES.log'), `${new Date().toISOString()}  ${path.basename(out)}  ${model}  ${it.aspect}\n${it.prompt}\n\n`);
      done.push(path.basename(out));
      log(`  image ${path.basename(out)} (${model})`);
    } catch (e) { failed.push(`${it.file}: ${e.message}`); log(`  image failed ${it.file}: ${e.message}`); }
  }
  return { planned: plan.length, done, failed, provider: which };
}
