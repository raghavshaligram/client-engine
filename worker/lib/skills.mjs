// The design skills every build uses (see ../skills.json). Downloaded once per pinned commit into
// worker/vendor/, then copied into each site's .claude/skills so Claude Code finds them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function copyTree(from, to, skip = []) {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, []);
    else if (e.isFile()) await fsp.copyFile(a, b);
  }
}

export function readManifest(here) {
  return JSON.parse(fs.readFileSync(path.join(here, 'skills.json'), 'utf8')).skills;
}

// Downloads each skill's repo at its pinned commit (a GitHub tarball) and keeps only the skill folder.
export async function ensureSkills(here, run, log = () => {}) {
  const vendor = path.join(here, 'vendor');
  const out = [];
  for (const s of readManifest(here)) {
    const dir = path.join(vendor, `${s.name}@${s.commit.slice(0, 12)}`);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      log(`  downloading skill ${s.name} (${s.repo} @ ${s.commit.slice(0, 7)})`);
      const tmp = path.join(vendor, '_dl-' + s.name);
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });
      const res = await fetch(`https://codeload.github.com/${s.repo}/tar.gz/${s.commit}`);
      if (!res.ok) throw new Error(`could not download skill ${s.name}: ${res.status}`);
      const tgz = path.join(tmp, 'src.tar.gz');
      await fsp.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
      const r = await run('tar', ['-xzf', 'src.tar.gz'], { cwd: tmp, timeoutMs: 180_000 });
      if (r.code !== 0) throw new Error(`could not unpack skill ${s.name}: ${r.err.slice(0, 200)}`);
      const top = (await fsp.readdir(tmp, { withFileTypes: true })).find(e => e.isDirectory());
      const src = path.join(tmp, top.name, ...s.path.split('/'));
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`skill ${s.name}: no SKILL.md at ${s.path}`);
      await fsp.rm(dir, { recursive: true, force: true });
      await copyTree(src, dir);
      for (const d of s.drop || []) await fsp.rm(path.join(dir, ...d.split('/')), { recursive: true, force: true });
      await fsp.rm(tmp, { recursive: true, force: true });
    }
    out.push({ ...s, dir });
  }
  return out;
}

export async function installSkills(skills, work) {
  const base = path.join(work, '.claude', 'skills');
  for (const s of skills) {
    const dest = path.join(base, s.name);
    if (fs.existsSync(path.join(dest, 'SKILL.md'))) continue;
    await copyTree(s.dir, dest);
  }
  // Scripts lose their executable bit in tarballs on some systems.
  for (const f of ['impeccable/scripts/impeccable']) { try { fs.chmodSync(path.join(base, f), 0o755); } catch {} }
  return base;
}

// What Claude Code may run: the skills' own scripts, nothing else.
export const SKILL_COMMANDS = [
  'Bash(node .claude/skills/design-taste-frontend/scripts/*)',
  'Bash(python3 .claude/skills/ui-ux-pro-max/scripts/search.py *)',
  'Bash(python .claude/skills/ui-ux-pro-max/scripts/search.py *)',
  'Bash(py -3 .claude/skills/ui-ux-pro-max/scripts/search.py *)',
  'Bash(sh .claude/skills/impeccable/scripts/impeccable *)',
  'Bash(.claude/skills/impeccable/scripts/impeccable *)',
  'Bash(.claude/skills/impeccable/scripts/impeccable.cmd *)',
  'Bash(node .claude/skills/avoid-ai-writing/scripts/*)',
  'Bash(node .claude/skills/avoid-ai-writing/detector/*)',
];
