#!/usr/bin/env node
// Website Studio build worker. Runs on your computer every 10 minutes (see install-worker.ps1).
// It asks Client Engine for the next job (build, fix, revise, edit, blog), has Claude Code do the
// work in a locked-down folder (file tools only: no shell, no web), checks the result, deploys it
// to Cloudflare Pages, backs the source up, and reports back. No npm install needed.
//
//   node agency-worker.mjs            run up to `maxJobs` jobs, then exit
//   node agency-worker.mjs --check    check the setup and exit

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const CFG_PATH = process.env.WORKER_CONFIG || path.join(HERE, 'config.json');
const LOGS = path.join(HERE, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const logFile = path.join(LOGS, new Date().toISOString().slice(0, 10) + '.log');
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)}  ${a.join(' ')}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); };

function loadConfig() {
  if (!fs.existsSync(CFG_PATH)) { log('config.json not found. Copy config.example.json to config.json and fill it in.'); process.exit(1); }
  const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  return { maxJobs: 2, claude: 'claude', model: '', sitesDir: path.join(HERE, 'sites'), claudeTimeoutMin: 45, ...c, site: String(c.site || '').replace(/\/+$/, '') };
}

// ---- helpers ------------------------------------------------------------------------------
export function run(cmd, args, { cwd, env, timeoutMs = 20 * 60_000, input } = {}) {
  return new Promise(resolve => {
    // On Windows, npx and claude are .cmd shims, which need the shell; quote anything with spaces.
    const argv = WIN ? args.map(a => (/[\s&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)) : args;
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, shell: WIN, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { err += '\n[timed out]'; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function api(cfg, action, body = {}) {
  const res = await fetch(cfg.site + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-key': cfg.appKey }, body: JSON.stringify({ action, ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${action}: ${data.error || res.status}`);
  return data;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const exists = p => fs.existsSync(p);
async function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(p, out); } else out.push(p);
  }
  return out;
}

async function copyDir(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(a, b); else if (!exists(b)) await fsp.copyFile(a, b);
  }
}

// ---- images: client uploads and photos from their old site, resized to WebP -----------------
async function prepareImages(job, work) {
  const raw = path.join(work, 'raw'), img = path.join(work, 'site', 'assets', 'img');
  await fsp.mkdir(img, { recursive: true });
  const all = [
    ...job.uploads.map(u => ({ url: u.url, name: 'upload-' + u.name })),
    ...(job.logo ? [{ url: job.logo, name: 'current-logo' + (path.extname(new URL(job.logo).pathname) || '.png') }] : []),
    ...job.oldImages.map((u, i) => ({ url: u, name: `current-site-${i + 1}${path.extname(new URL(u).pathname) || '.jpg'}` })),
  ];
  const made = [];
  for (const f of all) {
    const safe = f.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
    const src = path.join(raw, safe);
    try { if (!exists(src)) await download(f.url, src); } catch (e) { log(`  image skipped (${safe}): ${e.message}`); continue; }
    const ext = path.extname(safe).toLowerCase();
    if (ext === '.svg') { await fsp.copyFile(src, path.join(img, safe)); made.push(safe); continue; }
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic'].includes(ext)) { log(`  not an image, left out: ${safe}`); continue; }
    const base = safe.replace(/\.[a-z0-9]+$/, '');
    const out = path.join(img, base + '.webp');
    if (!exists(out)) {
      const r = await run('npx', ['--yes', 'sharp-cli@6', '-i', src, '-o', img.split(path.sep).join('/') + '/', '-f', 'webp', '-q', '78', 'resize', '1600', '--withoutEnlargement'], { timeoutMs: 120_000 });
      if (r.code !== 0 || !exists(out)) { await fsp.copyFile(src, path.join(img, safe)); made.push(safe); continue; }
    }
    made.push(base + '.webp');
  }
  return made;
}

// ---- the instructions Claude Code gets -------------------------------------------------------
function jobText(job, images, problems) {
  const common = `Read GUIDE.md and BRIEF.md in this folder first. Work only inside the site folder. GUIDE.md is the quality bar; BRIEF.md has the facts. Never invent facts about the business.
Images available in site/assets/img: ${images.length ? images.join(', ') : 'none (design without photos; do not use stock photos or hotlink anything)'}.`;
  const done = `When finished, write SUMMARY.md (one to three plain sentences for the client about what you did, no jargon).`;
  const T = {
    build: `Build the complete website described in BRIEF.md, every page, following GUIDE.md exactly. Use the mockup direction in BRIEF.md as the starting point for the home page. ${done}`,
    fix: `The site in the site folder failed our automatic checks. Fix every problem listed under "FIX THESE PROBLEMS" in BRIEF.md without changing anything else. ${done}`,
    revise: `The client reviewed the site and asked for changes, listed under "CHANGES REQUESTED NOW" in BRIEF.md. Make exactly those changes across the site, and nothing else. If a change would need facts you don't have, make the closest sensible change and say so in SUMMARY.md. ${done}`,
    edit: `The site is live. The client asked for the edit under "CHANGES REQUESTED NOW" in BRIEF.md. Make exactly that edit, and nothing else. ${done}`,
    blog: `Write one new article for the site's blog, following the "Blog articles" section of GUIDE.md and the target under "WRITE ONE ARTICLE NOW" in BRIEF.md. Add it to the blog index and sitemap.xml (create the blog index if it doesn't exist, and link it from the footer). Then write RESULT.json: {"title": "...", "path": "/blog/<slug>/"}. ${done}`,
  };
  return `# Your job: ${job.type}\n\n${common}\n\n${T[job.type] || T.build}${problems?.length ? `\n\n## Our checker found these problems in your work. Fix them all:\n${problems.map(p => '- ' + p).join('\n')}` : ''}\n`;
}

async function claude(cfg, work) {
  const args = ['-p', 'Read JOB.md in this folder and do what it says.', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Write,Edit,MultiEdit,Glob,Grep', '--output-format', 'json'];
  if (cfg.model) args.push('--model', cfg.model);
  const r = await run(cfg.claude, args, { cwd: work, timeoutMs: cfg.claudeTimeoutMin * 60_000 });
  let res = {};
  try { res = JSON.parse(r.out.trim().split('\n').pop()); } catch {}
  if (r.code !== 0 || res.is_error) throw new Error('Claude Code failed: ' + (res.result || r.err || r.out).toString().slice(0, 500));
  return res;
}

// ---- checks before deploying -----------------------------------------------------------------
export async function validate(siteDir, job) {
  const problems = [];
  const files = await walk(siteDir);
  const rel = f => '/' + path.relative(siteDir, f).split(path.sep).join('/');
  const set = new Set(files.map(rel));
  if (!set.has('/index.html')) return ['there is no site/index.html'];
  const htmls = files.filter(f => f.endsWith('.html'));
  for (const f of htmls) {
    let h = await fsp.readFile(f, 'utf8');
    const r = rel(f);
    if (!h.includes(`name="x-site-id"`)) { h = h.replace(/<head([^>]*)>/i, `<head$1>\n<meta name="x-site-id" content="${job.slug}">`); await fsp.writeFile(f, h); }
    if (!/<title>[^<]{5,}<\/title>/i.test(h)) problems.push(`${r}: missing or empty <title>`);
    if (!/<meta[^>]+name=["']viewport/i.test(h)) problems.push(`${r}: missing viewport meta tag`);
    if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30,}/i.test(h) && !/404/.test(r)) problems.push(`${r}: missing meta description`);
    if (/lorem ipsum|\{\{|\bTODO\b|\[(your|insert|add|placeholder)[^\]]*\]|example\.com|555-0100/i.test(h)) problems.push(`${r}: placeholder text left in`);
    for (const m of h.matchAll(/\b(?:href|src)=["']([^"'#?]+)/gi)) {
      const u = m[1];
      if (/^(https?:|mailto:|tel:|data:|\/\/|javascript:)/i.test(u)) {
        if (/^https?:/i.test(u) && /\.(jpe?g|png|webp|gif|svg)(\?|$)/i.test(u) && !/fonts\.(gstatic|googleapis)/.test(u)) problems.push(`${r}: hotlinked image ${u}; use files in /assets/img`);
        continue;
      }
      const target = u.startsWith('/') ? u : path.posix.join(path.posix.dirname(r), u);
      const want = path.posix.normalize(target);
      const ok = set.has(want) || set.has(want.replace(/\/?$/, '/index.html')) || set.has(want + '.html');
      if (!ok) problems.push(`${r}: broken link or missing file ${u}`);
    }
  }
  if (job.type === 'build' || job.type === 'fix') {
    if (!set.has('/sitemap.xml')) problems.push('no sitemap.xml');
    if (!set.has('/robots.txt')) problems.push('no robots.txt');
    if (!set.has('/404.html')) problems.push('no 404.html');
    const all = (await Promise.all(htmls.map(f => fsp.readFile(f, 'utf8')))).join('\n');
    if (!all.includes(job.form)) problems.push(`no contact form posting to ${job.form}`);
    if (!/href=["']tel:/i.test(all)) problems.push('no tap-to-call phone link');
  }
  const big = [];
  for (const f of files) { const s = (await fsp.stat(f)).size; if (s > 600_000) big.push(`${rel(f)} is ${Math.round(s / 1024)} KB (keep files under 600 KB)`); }
  return [...new Set([...problems, ...big])].slice(0, 40);
}

// ---- deploy and back up ----------------------------------------------------------------------
async function deploy(cfg, job, work) {
  const env = { CLOUDFLARE_API_TOKEN: cfg.cloudflareApiToken, CLOUDFLARE_ACCOUNT_ID: cfg.cloudflareAccountId };
  const create = await run('npx', ['--yes', 'wrangler@4', 'pages', 'project', 'create', job.project, '--production-branch', 'main'], { cwd: work, env, timeoutMs: 180_000 });
  if (create.code !== 0 && !/already exists|8000002/i.test(create.out + create.err)) log('  project create said:', (create.err || create.out).slice(0, 300));
  const d = await run('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', 'site', '--project-name', job.project, '--branch', 'main', '--commit-dirty=true'], { cwd: work, env, timeoutMs: 600_000 });
  if (d.code !== 0) throw new Error('Cloudflare deploy failed: ' + (d.err || d.out).slice(-600));
  return `https://${job.project}.pages.dev`;
}

async function backup(job, work) {
  const file = path.join(work, '..', `${job.slug}.tar.gz`);
  const r = await run('tar', ['-czf', file, '--exclude=raw', '--exclude=node_modules', '-C', work, '.'], { timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error('tar failed: ' + r.err.slice(0, 200));
  const res = await fetch(job.backup.url, { method: 'PUT', headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' }, body: await fsp.readFile(file) });
  await fsp.rm(file, { force: true });
  if (!res.ok) throw new Error('backup upload ' + res.status);
}

async function restore(job, work) {
  if (exists(path.join(work, 'site', 'index.html')) || !job.restore) return false;
  const file = path.join(work, '..', `${job.slug}.restore.tar.gz`);
  await download(job.restore, file);
  await fsp.mkdir(work, { recursive: true });
  const r = await run('tar', ['-xzf', file, '-C', work], { timeoutMs: 180_000 });
  await fsp.rm(file, { force: true });
  if (r.code !== 0) throw new Error('restore failed: ' + r.err.slice(0, 200));
  return true;
}

// ---- one job ----------------------------------------------------------------------------------
export async function doJob(cfg, job, { skipDeploy = false } = {}) {
  const work = path.join(cfg.sitesDir, job.slug);
  await fsp.mkdir(work, { recursive: true });
  if (await restore(job, work)) log('  restored the site from its backup');
  await copyDir(path.join(HERE, 'template'), work); // GUIDE.md and starter files; never overwrites
  await fsp.copyFile(path.join(HERE, 'template', 'GUIDE.md'), path.join(work, 'GUIDE.md')); // always the latest guide
  await fsp.writeFile(path.join(work, 'BRIEF.md'), job.brief);
  for (const f of ['SUMMARY.md', 'RESULT.json']) await fsp.rm(path.join(work, f), { force: true });
  const images = job.type === 'build' || job.type === 'revise' || job.type === 'edit' ? await prepareImages(job, work) : (await walk(path.join(work, 'site', 'assets', 'img'))).map(f => path.basename(f));

  let problems = [];
  for (let round = 1; round <= 3; round++) {
    await fsp.writeFile(path.join(work, 'JOB.md'), jobText(job, images, problems));
    log(`  Claude Code, round ${round}${problems.length ? ` (${problems.length} problems to fix)` : ''}`);
    const r = await claude(cfg, work);
    if (r.total_cost_usd) log(`  cost estimate $${Number(r.total_cost_usd).toFixed(2)}`);
    problems = await validate(path.join(work, 'site'), job);
    if (!problems.length) break;
    log('  checker:', problems.slice(0, 5).join(' | '));
  }
  if (problems.length) throw new Error('still failing checks after 3 rounds: ' + problems.slice(0, 6).join('; '));
  const summary = exists(path.join(work, 'SUMMARY.md')) ? (await fsp.readFile(path.join(work, 'SUMMARY.md'), 'utf8')).trim().slice(0, 600) : '';
  let result = {};
  try { result = JSON.parse(await fsp.readFile(path.join(work, 'RESULT.json'), 'utf8')); } catch {}
  const previewUrl = skipDeploy ? 'file://' + path.join(work, 'site', 'index.html') : await deploy(cfg, job, work);
  if (!skipDeploy) await backup(job, work).catch(e => log('  backup failed (site is still deployed):', e.message));
  return { previewUrl, summary, title: result.title, path: result.path };
}

// ---- main ----------------------------------------------------------------------------------------
async function check(cfg) {
  const ok = [];
  const v = await run(cfg.claude, ['--version'], { timeoutMs: 60_000 });
  ok.push(v.code === 0 ? `Claude Code: ${v.out.trim()}` : 'Claude Code: NOT FOUND. Install it (npm install -g @anthropic-ai/claude-code) and sign in by running "claude" once.');
  const t = await run('tar', ['--version'], { timeoutMs: 20_000 });
  ok.push(t.code === 0 ? 'tar: ok' : 'tar: NOT FOUND');
  ok.push(cfg.cloudflareApiToken && cfg.cloudflareAccountId ? 'Cloudflare: token and account set' : 'Cloudflare: missing cloudflareApiToken or cloudflareAccountId in config.json');
  try { await api(cfg, 'agency.list', { productId: 'websites' }); ok.push(`Client Engine: reached ${cfg.site}`); } catch (e) { ok.push(`Client Engine: ${e.message}`); }
  ok.forEach(l => log(l));
}

async function main() {
  const cfg = loadConfig();
  if (process.argv.includes('--check')) return check(cfg);
  const lock = path.join(HERE, '.lock');
  if (exists(lock) && Date.now() - fs.statSync(lock).mtimeMs < 3 * 3600_000) { log('another run is still going; exiting'); return; }
  fs.writeFileSync(lock, String(process.pid));
  try {
    for (let i = 0; i < cfg.maxJobs; i++) {
      const { job } = await api(cfg, 'jobs.claim');
      if (!job) { if (i === 0) log('no jobs waiting'); break; }
      log(`${job.type} for ${job.business} (${job.slug}), attempt ${job.attempts}`);
      try {
        const out = await doJob(cfg, job);
        await api(cfg, 'jobs.done', { id: job.id, ...out });
        log(`  done: ${out.previewUrl}`);
      } catch (e) {
        log('  failed:', e.message);
        await api(cfg, 'jobs.failed', { id: job.id, error: e.message }).catch(x => log('  could not report failure:', x.message));
      }
    }
  } finally { fs.rmSync(lock, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { log('worker error:', e.message); process.exit(1); });
