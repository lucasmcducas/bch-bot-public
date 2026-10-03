// scripts/test-token-bounds.mjs — the CashTokens bounds must fail CLOSED.
//
// Without these checks a bad amount or a malformed category is not rejected at
// the boundary where the intent is still known: it travels into libauth's
// encoder, which may truncate, wrap, or silently produce a different token than
// the caller asked for. A wallet that reports success while spending a
// different amount is worse than one that refuses.
//
// Bounds are from the CHIP-2022-02 PREFIX_TOKEN definition:
//   - FT amount is minimally-encoded CompactSize, min 1, max 0xffffffffffffff7f
//   - category id is exactly 32 bytes / 64 hex chars
//   - NFT commitment is bounded; a category is committed to by one SHA256, so a
//     longer commitment cannot encode anything a 32-byte one could not
//
// Run: node scripts/test-token-bounds.mjs

import { createTokenOutput, createNftOutput } from '../lib/tokens.mjs';

let passed = 0;
let failed = 0;

function rejects(name, fn) {
  try {
    fn();
    failed += 1;
    console.log(`  FAIL ${name}  -- accepted a value it must refuse`);
  } catch (e) {
    passed += 1;
    console.log(`  ok   ${name}  -- ${e.message.slice(0, 62)}`);
  }
}

function accepts(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}  -- refused a valid value: ${e.message}`);
  }
}

const CATEGORY = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';
const MINE = 'bitcoincash:qpjfw956u6rc88n8ul4xxyu9fu2v94s2eylh9vtzhv';
const MAX = 0xffffffffffffff7fn;

console.log('fungible amounts\n');

accepts('the maximum amount is accepted', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: MAX }));
accepts('1 base unit is accepted', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: 1n }));
accepts('a decimal string is accepted', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: '182' }));

rejects('zero is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: 0n }));
rejects('a negative amount is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: -1n }));
rejects('one above the CashTokens maximum is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: MAX + 1n }));
rejects('a huge value is refused rather than wrapping', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: 2n ** 100n }));
rejects('a non-numeric amount is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY, amount: 'lots' }));

console.log('\ncategory ids\n');

rejects('a short category is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY.slice(0, 62), amount: 1n }));
rejects('a long category is refused', () =>
  createTokenOutput({ address: MINE, category: CATEGORY + 'ab', amount: 1n }));
rejects('a non-hex category is refused', () =>
  createTokenOutput({ address: MINE, category: 'z'.repeat(64), amount: 1n }));
rejects('an empty category is refused', () =>
  createTokenOutput({ address: MINE, category: '', amount: 1n }));
rejects('a non-string category is refused', () =>
  createTokenOutput({ address: MINE, category: 12345, amount: 1n }));

accepts('an uppercase category is accepted and normalised', () => {
  const o = createTokenOutput({ address: MINE, category: CATEGORY.toUpperCase(), amount: 1n });
  if (Buffer.from(o.token.category).toString('hex') !== CATEGORY) {
    throw new Error('uppercase category did not normalise to lowercase');
  }
});

console.log('\nNFT outputs\n');

accepts('capability none with no commitment is accepted', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'none', commitment: '' }));
accepts('capability minting with a 32-byte commitment is accepted', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'minting', commitment: 'ab'.repeat(32) }));

rejects('an unknown capability is refused', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'burning' }));
rejects('a reserved capability value is refused', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'nft-capability-7' }));
rejects('a non-hex commitment is refused', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'none', commitment: 'zzzz' }));
rejects('an oversized commitment is refused', () =>
  createNftOutput({ address: MINE, category: CATEGORY, capability: 'none', commitment: 'ab'.repeat(41) }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
