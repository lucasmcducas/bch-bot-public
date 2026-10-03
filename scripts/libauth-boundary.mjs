// Can our libauth (next.8) and Cashlab's (next.6) share a transaction?
//
// npm installed TWO copies: we pin next.8, @cashlab/common pins next.6, and it
// nested its own. Two libauth instances in one process is not automatically a
// problem -- they are pure functions over Uint8Array, not a shared registry --
// but "should be fine" is exactly the kind of claim that fails later inside a
// signature. So check the actual boundary: take a transaction built by Cashlab's
// libauth and validate it with OURS.
//
// Nothing is signed. This is a type-boundary check.

import { ExchangeLab } from '@cashlab/cauldron';
import { NATIVE_BCH_TOKEN_ID, PayoutAmountRuleType, SpendableCoinType } from '@cashlab/common';
import { decodeTransactionBCH } from '@bitauth/libauth';

const CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const hexToBin = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const exlab = new ExchangeLab();

const raw = (await (await fetch(`https://indexer.riften.net/cauldron/pool/active?token=${CATEGORY}`)).json()).active;
const pools = raw.map((p) => {
  const params = { withdraw_pubkey_hash: hexToBin(p.owner_pkh) };
  return {
    version: '0',
    parameters: params,
    outpoint: { index: p.tx_pos, txhash: hexToBin(p.txid) },
    output: {
      locking_bytecode: exlab.generatePoolV0LockingBytecode(params),
      token: { amount: BigInt(p.tokens), token_id: p.token_id },
      amount: BigInt(p.sats),
    },
  };
});

const trade = exlab.constructTradeBestRateForTargetSupply(NATIVE_BCH_TOKEN_ID, CATEGORY, 100000n, pools, 1n);

const { secp256k1 } = await import('node:crypto').then((m) => ({ secp256k1: null })).catch(() => ({ secp256k1: null }));
const { randomBytes } = await import('node:crypto');
let key;
for (;;) {
  const k = randomBytes(32);
  const n = BigInt('0x' + k.toString('hex'));
  if (n > 0n && n < 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n) { key = new Uint8Array(k); break; }
}

const built = exlab.createTradeTx(
  trade.entries,
  [{
    outpoint: { index: 0, txhash: hexToBin('00'.repeat(32)) },
    output: { locking_bytecode: hexToBin('76a914' + '00'.repeat(20) + '88ac'), amount: 1000000n },
    type: SpendableCoinType.P2PKH,
    key,
  }],
  [{ type: PayoutAmountRuleType.CHANGE, locking_bytecode: hexToBin('76a914' + '11'.repeat(20) + '88ac') }],
  null,
  1n,
);

console.log(`built ${built.txbin.length} bytes with Cashlab's own libauth (next.6)`);

// ---- THE BOUNDARY: our libauth, next.8 ----
try {
  const tx = decodeTransactionBCH(built.txbin);
  console.log(`OUR libauth decoded it: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`);
  let tok = 0;
  for (const o of tx.outputs) {
    if (o.token) {
      const cat = o.token.tokenId ?? o.token.category ?? '';
      console.log(`  out ${o.token.amount} tok ${String(cat).slice(0, 10)}...`);
      tok++;
    }
  }
  console.log(`  token outputs: ${tok}`);
  console.log('  RESULT: the two libauth versions agree on the wire format.');
} catch (e) {
  console.log(`OUR libauth FAILED to decode: ${String(e.message).slice(0, 200)}`);
  console.log('  RESULT: the versions disagree. Mixing them at this boundary is unsafe.');
}
process.exit(0);
