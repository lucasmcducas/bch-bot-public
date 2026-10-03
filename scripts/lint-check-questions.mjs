#!/usr/bin/env node
// scripts/lint-check-questions.mjs
//
// A check that asks the wrong question is the most expensive kind of bug there
// is: it reports success, on schedule, while the thing it guards is broken.
// Measured 2026-10-03 on the swap's stale-pool gate:
//
//   [3/4] building the unsigned swap...
//         pool inputs verified unspent (12/12)
//   [4/4] broadcasting...
//         rejected: Missing inputs
//
// Twelve of twelve verified, three times in a row, every one already consumed.
// The gate called scriptHasUnspent(lockingBytecode) -- "does this covenant hold
// ANY live coin" -- when it needed "is THIS outpoint live". A competing swap
// re-creates the covenant at a new position, so the lock stays non-empty
// forever: the weaker question is permanently true for an active pool AND for a
// position that no longer exists.
//
// The same shape appeared twice more the same night:
//
//   - test-swap-prevout-liveness.mjs read parents through a Fulcrum node that
//     does not index p2sh32, and reported 13 live covenant positions as spent.
//   - The gate's own precondition check reported "could not read anything" on
//     every run and nobody noticed, because inconclusive is quieter than fail.
//
// So this lint encodes the first of the three questions from the wiki:
//
//   1. What question does this check actually ask?
//
// Encoded as a mechanical, greppable rule: a function whose name asserts a
// POSITIVE property (IsUnspent, HasUnspent, IsValid, IsLive, HasInput, ...)
// must not be able to answer "yes" using only container-level evidence. If its
// body asks about a bare locking script with no txid/vout/outpoint parameter,
// the function cannot distinguish "this position exists" from "this container
// is non-empty", and it will pass forever on a dead position.
//
// No dependency on purpose: same constraint as lint-unused.mjs -- this must run
// in CI, in the AUR build, and on a machine with nothing but node.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Names that assert a positive about one specific thing. A function called
 * `isSpent` is fine -- it asserts the negative, and a container-level answer
 * still tells you something. A function called `isUnspent` is not: the whole
 * meaning of the name is "this exact thing", which container-level evidence
 * cannot supply.
 *
 * The prefix and the qualifier are ONE word, so there is no word boundary
 * between them -- `scriptHasUnspent` fails a `\b(?:is|has)...` pattern because
 * `h` is followed by `U`. Both orders occur in real names
 * (`scriptHasUnspent`, `hasUnspentOutput`), so match either, with the boundary
 * only on the outside.
 */
const QUALIFIER = 'Unspent|Valid|Live|Spendable|Available|Present';
const NOUN = 'Output|Input|Entry|Outpoint|Position|Coin';
const POSITIVE_NAME = new RegExp(
  `(?:(?:is|has)(?:${QUALIFIER})|(?:${QUALIFIER})(?:${NOUN}))\\b`,
  'i',
);

/** A specific-position parameter. If one exists, the question can be exact. */
const SPECIFIC_PARAM = /\b(?:txid|txId|tx_id|outpoint|vout|vOut|tx_pos|outpointIndex|outpointTransactionHash)\b/;

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

/** Extract a function body by brace matching from its declaration. */
function bodyOf(src, from) {
  const start = src.indexOf('{', from);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const files = [
  ...jsFiles(join(ROOT, 'lib')),
  ...jsFiles(join(ROOT, 'scripts')),
  join(ROOT, 'bin', 'bch-bot'),
].filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });

const problems = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = file.slice(ROOT.length + 1);

  // The proof suite injects the bad code as string literals. Scanning it would
  // make the lint fail on its own fixtures, which is the same class of mistake
  // as a test asserting against its own mock.
  if (/test-lints-/.test(rel) || rel.includes('testdata/')) continue;

  // Only exported function declarations: `export async function name(...)`.
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = decl.exec(src)) !== null) {
    const [, name, params] = m;
    if (!POSITIVE_NAME.test(name)) continue;

    const line = src.slice(0, m.index).split('\n').length;
    const body = bodyOf(src, m.index + m[0].length);

    if (!body) continue;

    // The exact question needs a specific position in the parameters. Without
    // one, the function can only answer at container granularity.
    if (SPECIFIC_PARAM.test(params)) continue;

    // It may still be exact if it derives the position from its arguments, or
    // delegates to something that is. Check for any use of a specific-position
    // identifier anywhere in the body.
    if (SPECIFIC_PARAM.test(body)) continue;

    // A narrow escape hatch, used deliberately and documented: a function that
    // only ever answers about a container is fine if it does not claim to be
    // about one thing. That is a different name, so the name check above
    // already excludes it -- so reaching here is a real finding.
    problems.push({
      file: rel,
      line,
      name,
      params: params.trim() || '(none)',
    });

    lines.length; // keep the split alive for clarity
  }
}

if (problems.length === 0) {
  console.log('lint-check-questions: clean (no container-scoped check is named as if it were exact)');
  process.exit(0);
}

console.error(`\n${problems.length} check(s) whose name promises a specific position but`);
console.error('whose signature cannot support that question:\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  ${p.name}(${p.params})`);
  console.error(`    the name asserts this exact thing is live/unspent/valid, but there is`);
  console.error(`    no txid/vout in scope, so the only available answer is about the`);
  console.error(`    whole container. A re-created or unrelated output elsewhere in that`);
  console.error(`    container makes it return true forever. Pass the position, or rename`);
  console.error(`    it so it says what it actually answers.`);
  console.error('');
}
console.error('A green check is a claim, not evidence. Before trusting one, prove it can');
console.error('return a positive for the data it claims to measure.');
process.exit(1);
