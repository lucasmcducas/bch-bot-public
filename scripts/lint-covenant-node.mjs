#!/usr/bin/env node
// scripts/lint-covenant-node.mjs
//
// A Cauldron pool output is a p2sh32 covenant. Fulcrum -- which is what most
// public BCH Electrum nodes run -- does not index p2sh32 at all.
//
// Measured 2026-10-03 for one live covenant lock:
//
//   rostrum.cauldron.quest        9 unspent outputs   <- indexes p2sh32
//   bch.imaginary.cash            0
//   cashnode.bch.ninja            0
//   fulcrum.jettscythe.xyz        0
//
// The zeros are not "spent". They are "this node cannot see this script". Both
// look identical from the call site, and this cost an entire debugging session:
//
//   - The swap's pre-signing gate read its pool parents through
//     connect(w.network). Every parent came back null, every pool input was
//     logged "parent unknown", and the gate degraded to reporting that it could
//     read nothing -- on every run, without ever failing.
//   - A liveness test did the same and reported 13 live covenant positions as
//     spent: a clean, confident, completely false answer.
//
// The fix is one function name: connectToken() returns the token-aware client.
// So this bans the ambiguous spelling ONLY on code paths that touch covenants.
// A plain BCH P2PKH read through connect() is correct and stays allowed --
// banning it would be a rule so broad it teaches people to disable it, which is
// worse than no rule at all.
//
// A function is treated as covenant-aware when its name mentions a covenant or
// token concept, or when its body references the p2sh32/covenant surface.
// Within such a function, connect() is a finding; elsewhere it is fine.
//
// No dependency on purpose: same constraint as the other lints.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Print every scope considered and why it was kept or dropped. */
const DEBUG = process.argv.includes('--debug');

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
  }
  return out;
}

/** Blank out comments and string literals, preserving offsets and newlines. */
function codeOnly(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank)
    .replace(/`(?:\\.|[^`\\])*`/g, blank)
    .replace(/'(?:\\.|[^'\\])*'/g, blank)
    .replace(/"(?:\\.|[^"\\])*"/g, blank);
}

/**
 * Identifiers that exist only on the p2sh32 covenant path. Deliberately narrow:
 * an earlier version also matched `pool`, `token` and `script`, which flagged
 * runAttempt() in swap.mjs -- it reads token UTXOs out of the wallet's own
 * P2PKH addresses, which is correct with connect() and has nothing to do with
 * covenant indexing. A rule that wide teaches people to disable it.
 */
const COVENANT_SURFACE = /\boutpointTransactionHash\b|\boutpointIsUnspent\b|\bconnectToken\b|\bP2SH32\b|\bp2sh32\b|\btokenHasUnspent\b/;

const files = [
  ...jsFiles(join(ROOT, 'lib')),
  ...jsFiles(join(ROOT, 'scripts')),
].filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });

const problems = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  // The node lists live here; the distinction is defined here.
  if (rel === 'lib/network.mjs') continue;
  // These two name the identifiers in their own source and prose, and the proof
  // suite injects the defect as a string literal. Scanning either would make the
  // lint fail on its own fixtures.
  if (rel === 'scripts/lint-covenant-node.mjs') continue;
  if (/test-lints-/.test(rel) || rel.includes('testdata/')) continue;

  const raw = readFileSync(file, 'utf8');
  const src = codeOnly(raw);
  const rawLines = raw.split('\n');
  const srcLines = src.split('\n');

  // Walk function declarations and split the file into scopes. Nested function
  // declarations end the enclosing scope, so a helper inside a covenant-aware
  // function is judged on its own rather than inheriting the outer verdict --
  // otherwise a plain P2PKH helper called from a swap routine gets flagged for
  // the caller's sins.
  const declRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  const decls = [];
  let m;
  while ((m = declRe.exec(src)) !== null) {
    const indent = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    // Find the line holding the closing paren of the parameter list, so brace
    // counting can start after it.
    let parenDepth = 0, paramEnd = src.slice(0, m.index).split('\n').length;
    for (let k = m.index; k < src.length; k++) {
      if (src[k] === '(') parenDepth++;
      else if (src[k] === ')') {
        parenDepth--;
        if (parenDepth === 0) { paramEnd = src.slice(0, k).split('\n').length; break; }
      }
    }
    decls.push({
      name: m[1],
      startLine: src.slice(0, m.index).split('\n').length,
      paramEnd,
      // A declaration indented under another is nested.
      nested: /^\s+/.test(indent),
    });
  }

  for (let i = 0; i < decls.length; i++) {
    if (decls[i].nested) continue;
    const from = decls[i].startLine;

    // Bound the scope by its own closing brace, counting from the end of the
    // parameter list. Two traps: the `= {}` default in a destructured options
    // parameter is not the body, and braces inside strings have already been
    // blanked out by codeOnly(), so what is left really is structure.
    // Start counting on the line AFTER the parameter list, because
    // `function f(a, b) {` puts the body brace on the same line as the closing
    // paren. Counting from paramEnd and testing depth <= 0 saw zero depth on
    // entry and ended the scope immediately, which is why every function
    // reported a one-line body.
    let depth = 0, endLine = srcLines.length, opened = false;
    for (let ln = decls[i].paramEnd; ln < srcLines.length; ln++) {
      depth += (srcLines[ln].match(/\{/g) || []).length;
      depth -= (srcLines[ln].match(/\}/g) || []).length;
      if (depth > 0) opened = true;
      if (opened && depth <= 0) { endLine = ln; break; }
    }
    const body = srcLines.slice(from - 1, endLine).join('\n');

    // A function is covenant-aware if its NAME says so, or if the specific
    // p2sh32 surface appears. A generic body that merely mentions "pool" or
    // "token" in a comment is already blanked out by codeOnly(), so reaching
    // here means the code itself references the covenant API.
    // Only the body counts. A name like `checkTokenSwap` describes the caller's
    // intent, not which node the code ends up using.
    const isCovenant = COVENANT_SURFACE.test(body);
    if (DEBUG) {
      console.error(`  [debug] ${rel} ${decls[i].name}() lines ${from}-${endLine}`
        + ` nested=${decls[i].nested} covenant=${isCovenant}`
        + ` bodyLen=${body.length}`);
    }
    if (!isCovenant) continue;

    // Inside a covenant-aware function, the bare connect() is the bug.
    const callRe = /(?<![\w.$])connect\s*\(/g;
    let c;
    while ((c = callRe.exec(body)) !== null) {
      const absLine = from + body.slice(0, c.index).split('\n').length - 1;
      const before = body.slice(Math.max(0, c.index - 10), c.index);
      if (/connectToken\s*$/.test(before)) continue;
      problems.push({
        rel,
        line: absLine,
        fn: decls[i].name,
        text: rawLines[absLine - 1].trim(),
      });
    }
  }
}

if (problems.length === 0) {
  console.log('lint-covenant-node: clean (no covenant read through the ambiguous connect())');
  process.exit(0);
}

console.error(`\n${problems.length} covenant read(s) through the ambiguous connect():\n`);
for (const p of problems) {
  console.error(`  ${p.rel}:${p.line}  in ${p.fn}()`);
  console.error(`    ${p.text}`);
}
console.error('');
console.error('`connect()` returns whatever the network list holds, and for mainnet that');
console.error('is Fulcrum, which does not index p2sh32 Cauldron covenants. A covenant read');
console.error('through it returns null or an empty array -- indistinguishable from');
console.error('"spent". A live position then reports as dead, and a dead one cannot be');
console.error('confirmed.');
console.error('');
console.error('Use connectToken() for anything reading a CashToken or covenant output.');
console.error('Ordinary BCH P2PKH reads are correct with connect() and are not flagged.');
process.exit(1);
