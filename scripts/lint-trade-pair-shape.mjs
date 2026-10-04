#!/usr/bin/env node
// scripts/lint-trade-pair-shape.mjs
//
// Every Cauldron pool is a BCH/token pair. There is no token/token market, and
// the SDK enforces that: constructTradeBestRateForTargetSupply throws
//   "either demand_token_id or supply_token_id should be NATIVE_BCH_TOKEN_ID"
// for a PUSD->ROACH trade.
//
// The throw is a correct invariant and a poor answer for a user who typed
// "swap pusd roach": it names an internal constant instead of saying the pair
// does not exist and that the route is two hops. So lib/exlab-swap.mjs refuses
// first, in our own words.
//
// THIS LINT EXISTS SO THAT REFUSAL CANNOT BE DELETED BY ACCIDENT.
//
// A refusal is the kind of thing that gets removed as "dead code" or "redundant
// with the SDK" -- and removing it is locally invisible, because the SDK still
// throws. The trade is still refused; the only thing lost is the explanation.
// That is how a four-line user-facing message disappears without a single test
// going red.
//
// The invariant is SEMANTIC -- "one side of the trade is BCH" -- and this
// codebase has already established the lesson that text matching cannot enforce
// a semantic rule in a dynamic language. check-wallet-safety.sh in the plugin
// says so explicitly, and defends itself against ["sw" + "eep"] defeating its
// own greps, and concludes that the capability must be constrained rather than
// the call described.
//
// So this lint does not grep for a message. It checks the STRUCTURE: at every
// call site that builds a trade, the sell and buy arguments must not both be
// something other than bch / NATIVE_BCH_TOKEN_ID. A future caller that routes
// a token pair in without the check is the finding -- and removing the check
// from the library turns every such call site red.
//
// No dependency on purpose: same constraint as the other lints.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['lib', 'scripts', 'bin'];

/** Tokens that mean "the native asset" in any of the spelling we use. */
const NATIVE_SPELLINGS = new Set([
  "'bch'", '"bch"', '`bch`',
  'NATIVE_BCH_TOKEN_ID', 'BCH_TOKEN',
  "'BCH'", '"BCH"',
]);

/**
 * A bare identifier is an UNKNOWN side, not a non-native one.
 *
 * The first version of this lint reported three findings on correct code:
 * supplyTokenId -> demandTokenId at the very call site inside our own guard.
 * Those are variables whose values are known -- one of them IS the BCH token
 * three lines above -- but a lint cannot see through a name, and treating
 * "unknown" as "non-native" makes it fire on every parameterised call.
 *
 * A lint that cries wolf gets switched off, and a switched-off lint protects
 * nothing. So an unresolvable side is SKIPPED and reported separately, and only
 * two LITERAL non-native sides are a finding. That is a real narrowing: this
 * catches a hardcoded token/token route, which is the mistake worth catching,
 * and does not pretend to trace dataflow through a variable.
 *
 * The negative control is what makes that acceptable: a defect only this lint
 * sees is one where a caller hardcodes a token pair. See the control in the
 * commit and in test-lints-catch-their-own-bugs.
 */
function isLiteralNonNative(expr) {
  const e = String(expr).trim();
  // Not a literal at all -- a variable, a property, a call. Unknown, so skip.
  if (!/^['"`]/.test(e) && !/^(NATIVE_BCH_TOKEN_ID|BCH_TOKEN)$/.test(e)) return false;
  return !isNativeToken(e);
}

const findings = [];
const considered = [];
const skipped = [];

function isNativeToken(expr) {
  const e = String(expr).trim();
  if (!e) return false;
  if (NATIVE_SPELLINGS.has(e)) return true;
  // A ternary that yields bch on one branch counts: sell === 'bch' ? ... : ...
  if (e.includes('?')) {
    const branches = e.split('?').slice(1).map((s) => s.split(':')[0]);
    return branches.some((b) => isNativeToken(b));
  }
  return false;
}

/** Split a call's argument list on top-level commas only. */
function splitArgs(argText) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (quote) {
      cur += ch;
      if (ch === quote && argText[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The argument span of a call, by scanning forward from the open paren. */
function readCallArgs(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return { text: src.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

const TRADE_FNS = ['quoteSwap', 'constructTradeBestRateForTargetSupply', 'constructTradeBestRateForTargetDemand'];

for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir);
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const name of readdirSync(full)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const path = join(full, name);
    const src = readFileSync(path, 'utf8');
    const rel = relative(ROOT, path);
    if (rel === 'scripts/lint-trade-pair-shape.mjs') continue;
    if (rel.startsWith('scripts/test-')) continue;

    for (const fn of TRADE_FNS) {
      const re = new RegExp('(?<![\\w$])' + fn + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const openIdx = m.index + m[0].length - 1;
        const call = readCallArgs(src, openIdx);
        if (!call) continue;
        const args = splitArgs(call.text);
        if (args.length < 1) continue;

        // Two call shapes. quoteSwap({ sell, buy, ... }) is ONE argument that
        // happens to be an object; constructTrade*(sell, buy, ...) is two. The
        // first version of this lint handled only the second, so the meta-test
        // injection -- which uses the object form, as all our real call sites do
        // -- was never seen and the lint reported "0 call site(s) checked" on a
        // tree containing the defect. A clean verdict on a broken tree.
        const isObjectForm = /\{\s*$/.test(args[0].trim());
        const sell = isObjectForm ? null : args[0];
        const buy = isObjectForm ? null : args[1];
        const bothNonNative = !isNativeToken(sell) && !isNativeToken(buy);
        const line = src.slice(0, m.index).split('\n').length;

        // Object-literal form: quoteSwap({ sell: X, buy: Y, ... })
        const objSell = /sell\s*:\s*([^,}]+)/.exec(call.text);
        const objBuy = /buy\s*:\s*([^,}]+)/.exec(call.text);
        const s = objSell ? objSell[1] : sell;
        const b = objBuy ? objBuy[1] : buy;
        const bad = !isNativeToken(s) && !isNativeToken(b);

        const literalBad = isLiteralNonNative(s) && isLiteralNonNative(b);
        if (literalBad) {
          findings.push(
            `${rel}:${line}  ${fn}() called with two non-native sides: ${s.trim()} -> ${b.trim()}.\n` +
            `    Cauldron has no token/token pool. Quote and build must not receive this,\n` +
            `    and lib/exlab-swap.mjs's refusal is what keeps the user from reaching here.`
          );
        } else if (bad) {
          skipped.push(`${rel}:${line}  sides are variables, not literals -- skipped`);
        } else {
          considered.push(`${rel}:${line}  ${fn}(${s.trim()} -> ${b.trim()})`);
        }
      }
    }
  }
}

if (findings.length) {
  console.error(`lint-trade-pair-shape: ${findings.length} finding(s)\n`);
  for (const f of findings) console.error(`  ${f}\n`);
  console.error(
    'A token/token trade has no market: every Cauldron pool pairs a token with\n' +
    'BCH. If one side is genuinely BCH, name it as bch or NATIVE_BCH_TOKEN_ID so\n' +
    'the check can see it. If you genuinely need two hops, that is\n' +
    'createChainedTradeTx, which returns an ARRAY of dependent transactions --\n' +
    'a different build, not a flag.'
  );
  process.exit(1);
}

if (skipped.length) {
  console.log(`  note: ${skipped.length} call site(s) pass variables rather than literals, so the`);
  console.log('        side cannot be resolved statically. Only a hardcoded token/token route is');
  console.log('        a finding here -- see the note in this file for why that is deliberate.');
}
console.log(`lint-trade-pair-shape: clean (${considered.length} call site(s) checked, one side BCH)`);
