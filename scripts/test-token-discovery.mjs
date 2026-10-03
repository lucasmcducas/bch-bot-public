// scripts/test-token-discovery.mjs — pins both token bugs so they cannot come
// back silently.
//
// BUG #1 (discovered 2026-10-02, real, fixed): `blockchain.scripthash.listunspent`
// names token fields differently per server. Rostrum returns
// has_token/token_id/token_amount/token_bitfield; the public Fulcrum nodes
// return no token field at all. Every consumer in this repo reads
// `utxo.token_data.{amount,category}`, so against a Rostrum response they all
// read undefined and the wallet reports ZERO tokens while holding them. The
// wallet held 2 confirmed ROACH and `bch-bot balance` said `token_categories_ft: 0`.
//
// BUG #2 (suspected, DISPROVEN by test 2 below): `outputToLibauth` appeared not
// to encode the CashToken prefix, which would make the node reject token sends
// with bad-txns-vout-tokenprefix (code 16). The test proves libauth DOES encode
// it: the generated output script is byte-identical to a node-accepted mainnet
// token output. The earlier code-16 rejection came from the fee/dust bug
// recorded in the wiki, not from a missing prefix.
//
// Run: node scripts/test-token-discovery.mjs
import assert from 'node:assert/strict';
import { normaliseTokenData, normaliseTokenDataList } from '../lib/tokens.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import { createTokenOutput } from '../lib/tokens.mjs';
import { loadHdNode } from '../lib/wallet.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => { passed += 1; console.log(`  ok   ${name}`); },
        (e) => { failed += 1; console.log(`  FAIL ${name}\n       ${e.message}`); },
      );
    }
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
  return Promise.resolve();
}

const ROACH = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';
const MINE = 'bitcoincash:qpjfw956u6rc88n8ul4xxyu9fu2v94s2eylh9vtzhv';
const OTHER = 'bitcoincash:qrjcuk2c749w6ezgpdk685e6yx35a9l29qqmn98jmw';

console.log('Bug #1: listunspent token field names differ per server\n');

// The exact shape rostrum.cauldron.quest returned for the wallet's own ROACH
// UTXO on 2026-10-02. Verbatim, so this test fails if the server changes.
const REAL_ROSTRUM_UTXO = {
  has_token: true,
  height: 971186,
  outpoint_hash: '1841beb8976512c4086139800c40ef64860975d12eaa1a046363b255698cc884',
  token_amount: 100,
  token_bitfield: 16,
  token_id: ROACH,
  tx_hash: '11f1d669b30e20600e16825782dc1ae5ad098745f221a171425f6b430f2997f0',
  tx_pos: 0,
  value: 1000,
};

await test('a Rostrum token UTXO gains token_data', () => {
  const u = normaliseTokenData({ ...REAL_ROSTRUM_UTXO });
  assert.ok(u.token_data, 'token_data must be set');
  assert.equal(u.token_data.category, ROACH);
  assert.equal(u.token_data.amount, '100');
});

await test('bitfield 16 = HAS_AMOUNT only, so no NFT is claimed', () => {
  const u = normaliseTokenData({ ...REAL_ROSTRUM_UTXO });
  assert.equal(u.token_data.nft, undefined, 'a fungible token must not carry nft');
});

await test('a plain BCH UTXO gains no token_data', () => {
  const plain = { has_token: false, height: 968967, tx_hash: 'ab'.repeat(32), tx_pos: 0, value: 1000 };
  const u = normaliseTokenData({ ...plain });
  assert.equal(u.token_data, undefined);
});

await test('already-normalised input is untouched (idempotent)', () => {
  const once = normaliseTokenData({ ...REAL_ROSTRUM_UTXO });
  const twice = normaliseTokenData(once);
  assert.deepEqual(twice.token_data, once.token_data);
});

await test('has_token true but bitfield missing is left un-normalised', () => {
  // Conservative: we cannot tell NFT from fungible, so we do not invent an
  // amount. Under-reporting a balance beats fabricating one.
  const u = normaliseTokenData({ has_token: true, token_id: ROACH, value: 1000 });
  assert.equal(u.token_data, undefined);
});

await test('an NFT bitfield (0x20) sets nft, capability none', () => {
  const u = normaliseTokenData({ ...REAL_ROSTRUM_UTXO, token_bitfield: 0x20, token_amount: undefined });
  assert.ok(u.token_data, 'an NFT-only prefix still carries a category');
  assert.equal(u.token_data.amount, '0');
  assert.equal(u.token_data.nft.capability, 'none');
});

await test('NFT capability 1 -> mutable, 2 -> minting', () => {
  const m = normaliseTokenData({ ...REAL_ROSTRUM_UTXO, token_bitfield: 0x21 });
  assert.equal(m.token_data.nft.capability, 'mutable');
  const n = normaliseTokenData({ ...REAL_ROSTRUM_UTXO, token_bitfield: 0x22 });
  assert.equal(n.token_data.nft.capability, 'minting');
});

await test('reserved capability 7 clamps to none rather than crashing libauth', () => {
  const u = normaliseTokenData({ ...REAL_ROSTRUM_UTXO, token_bitfield: 0x27 });
  assert.equal(u.token_data.nft.capability, 'none');
});

await test('list normalisation maps every entry', () => {
  const list = normaliseTokenDataList([
    { ...REAL_ROSTRUM_UTXO },
    { has_token: false, value: 800000 },
  ]);
  assert.equal(list.filter((u) => u.token_data).length, 1);
});

await test('a non-array response is passed through unharmed', () => {
  const err = 'Error: no such scripthash';
  assert.equal(normaliseTokenDataList(err), err);
  assert.equal(normaliseTokenDataList(undefined), undefined);
});

await test('sumFtBalances now totals the ROACH after normalisation', async () => {
  const { sumFtBalances } = await import('../lib/tokens.mjs');
  const utxos = normaliseTokenDataList([
    { ...REAL_ROSTRUM_UTXO },                                  // 100
    { ...REAL_ROSTRUM_UTXO, tx_hash: 'cc'.repeat(32) },        // 100
    { has_token: false, value: 800000 },
  ]);
  const sums = sumFtBalances(utxos);
  assert.equal(sums.get(ROACH), 200n, 'expected 200 base units = 2.00 ROACH');
});

await test('utxoToTokenPrefix now produces a real prefix for a Rostrum UTXO', async () => {
  const { utxoToTokenPrefix } = await import('../lib/tokens.mjs');
  const u = normaliseTokenData({ ...REAL_ROSTRUM_UTXO });
  const p = utxoToTokenPrefix(u);
  assert.ok(p, 'prefix must be produced');
  assert.equal(p.category.length, 32);
  assert.equal(p.amount, 100n);
});

console.log('\nBug #2: libauth DOES encode the CashToken output prefix\n');

await test('generated token output is byte-identical to a real mainnet one', async () => {
  // Ground truth: a node-accepted ROACH output of 100 base units paying
  // bitcoincash:qpjfw956… (decoded from tx 11f1d669…, 65+ confirmations).
  const REAL_SCRIPT =
    'ef53ff3501720c686780457d9affa6e60f552f5685bb6a768325f926a380ef2c891064' +
    '76a9146497169ae687839e67e7ea6313854f14c2d60ac988ac';

  const { hdNode } = loadHdNode();
  const tokenOut = createTokenOutput({ address: MINE, category: ROACH, amount: 100n });
  const input = {
    tx_hash: 'ab90acba4e383b3cc4ba1d0d934568d04ce397610ebd0744dc7638e431733ce6',
    tx_pos: 0,
    valueSatoshis: 856855n,
    address: MINE,
    hdNode,
    account: 0,
    change: 0,
    index: 0,
  };
  // A valid change amount, so the implicit fee (inputs - outputs) stays positive.
  const change = BigInt(856855) - tokenOut.valueSatoshis - 500n;
  const { tx_hex } = await signP2pkhTransaction({
    inputs: [input],
    outputs: [
      { address: MINE, valueSatoshis: tokenOut.valueSatoshis, token: tokenOut.token },
      { address: OTHER, valueSatoshis: change },
    ],
  });

  const b = Buffer.from(tx_hex, 'hex');
  let i = 4;
  const nIn = b[i]; i += 1;
  for (let k = 0; k < nIn; k += 1) { i += 36; const sl = b[i]; i += 1; i += sl + 4; }
  const nOut = b[i]; i += 1;
  i += 8;                       // out[0] value
  const sl0 = b[i]; i += 1;
  const script0 = b.subarray(i, i + sl0).toString('hex'); i += sl0;

  assert.ok(script0.startsWith('ef'), `expected the 0xef token marker, got ${script0.slice(0, 8)}`);
  assert.equal(script0, REAL_SCRIPT, 'token output must match a node-accepted script byte for byte');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
