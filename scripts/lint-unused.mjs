#!/usr/bin/env node
// scripts/lint-unused.mjs
//
// Fails when a file imports a binding it never uses.
//
// 39 unused imports had accumulated. Fifteen of them were in scripts/stake.mjs,
// which imports connect, loadHdNode, signP2pkhTransaction, buildStakeTransaction
// and signCovenantInput and uses NONE of them -- it exits with a "prerequisites
// not met" message before any of that code can run. Anyone reading the imports
// believes staking is wired. The imports are the lie.
//
// This is a check rather than a convention because unused imports are not a
// style question here: a list of imports that implies a capability the file does
// not have is a documentation bug, and documentation that contradicts the code
// is what the rest of this repo has been fixing.
//
// No dependency on purpose: this must run in CI, in the AUR build, and on a
// machine with nothing but node.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(full);
    // The CLI entry point has no extension.
    else if (name === 'bch-bot') out.push(full);
  }
  return out;
}

const IMPORT = /import\s*\{(?<body>[^}]*)\}\s*from\s*['"][^'"]+['"]/g;
const problems = [];

const files = [
  ...jsFiles(join(ROOT, 'lib')),
  ...jsFiles(join(ROOT, 'scripts')),
  join(ROOT, 'bin', 'bch-bot'),
].filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  IMPORT.lastIndex = 0;
  let m;
  while ((m = IMPORT.exec(src)) !== null) {
    const names = m.groups.body
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/).pop().trim())
      .filter(Boolean);
    const rest = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    for (const name of names) {
      // \b word boundary: matches the identifier as a whole token, so `foo`
      // does not count as a use of `foobar`.
      if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(rest)) {
        const line = src.slice(0, m.index).split('\n').length;
        problems.push({ file: file.replace(ROOT + '/', ''), line, name });
      }
    }
  }
}

if (problems.length > 0) {
  console.error('lint-unused: unused imports found\n');
  for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.name}`);
  console.error(`\n${problems.length} unused import(s). Remove them, or import the code that uses them.`);
  console.error('An import that names a capability the file does not have is a');
  console.error('documentation bug: it tells the reader the opposite of the truth.');
  process.exit(1);
}

console.log(`lint-unused: clean (${files.length} files checked, 0 unused imports)`);
