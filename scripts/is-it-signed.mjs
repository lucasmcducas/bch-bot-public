// Is the ExchangeLab output SIGNED, or does it still need our signature?
//
// This decides the shape of swap.mjs. The SDK's generateExchangeTx builds the
// p2pkh input with:
//     unlockingBytecode: { compiler, script: 'p2pkh_unlock',
//                          data: { keys: { privateKeys: { user_key: coin.key } } }, ... }
// and then encodeTransaction(result.transaction) -- with no signTransaction and
// no finalize step anywhere in the file. So either libauth's compiler emits a
// real signature inline, or the encoded transaction has a placeholder that a
// caller must fill.
//
// The two possibilities demand completely different code:
//   signed inline  -> swap.mjs just broadcasts
//   placeholder    -> swap.mjs must sign our p2pkh input via signExternalTransaction
//
// Do not infer it. Build with a throwaway key and look at the unlocking bytecode.
//
// A throwaway key: generated, used, discarded. It is not the wallet's key and
// signs nothing real.

import { ExchangeLab } from '@cashlab/cauldron';
import { NATIVE_BCH_TOKEN_ID, PayoutAmountRuleType, SpendableCoinType } from '@cashlab/common';
import { randomBytes } from 'node:crypto';
import { decodeTransactionBCH } from '@bitauth/libauth';

const CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const h2b = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

function realKey() {
  for (;;) {
    const k = randomBytes(32);
    const n = BigInt('0x' + k.toString('hex'));
    if (n > 0n && n < 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n) return new Uint8Array(k);
  }
}

const ex = new ExchangeLab();
const raw = (await (await fetch(`https://indexer.riften.net/cauldron/pool/active?token=${CATEGORY}`)).json()).active;
const pools = raw.map((p) => {
  const pr = { withdraw_pubkey_hash: h2b(p.owner_pkh) };
  return {
    version: '0', parameters: pr,
    outpoint: { index: p.tx_pos, txhash: h2b(p.txid) },
    output: {
      locking_bytecode: ex.generatePoolV0LockingBytecode(pr),
      token: { amount: BigInt(p.tokens), token_id: p.token_id },
      amount: BigInt(p.sats),
    },
  };
});

const key = realKey();
const trade = ex.constructTradeBestRateForTargetSupply(NATIVE_BCH_TOKEN_ID, CATEGORY, 100000n, pools, 1n);
const built = ex.createTradeTx(
  trade.entries,
  [{
    outpoint: { index: 0, txhash: h2b('00'.repeat(32)) },
    output: { locking_bytecode: h2b('76a914' + '00'.repeat(20) + '88ac'), amount: 1000000n },
    type: SpendableCoinType.P2PKH,
    key,                      // <-- a PRIVATE key, per the SDK's own field name
  }],
  [{ type: PayoutAmountRuleType.CHANGE, locking_bytecode: h2b('76a914' + '11'.repeat(20) + '88ac') }],
  null, 1n,
);

const tx = decodeTransactionBCH(built.txbin);
console.log(`${built.txbin.length} bytes, ${tx.inputs.length} inputs`);
console.log('--- unlocking bytecode per input ---');
tx.inputs.forEach((inp, i) => {
  const u = inp.unlockingBytecode;
  const bytes = u instanceof Uint8Array ? u : (u?.bytecode ?? u);
  const hex = bytes instanceof Uint8Array ? Buffer.from(bytes).toString('hex') : '(not bytes)';
  const len = hex === '(not bytes)' ? 0 : hex.length / 2;
  // A real p2pkh signature is DER: 0x30 <len> 0x02 <r> 0x02 <s>, ~71-73 bytes,
  // plus a 33-byte push of the pubkey. A placeholder is usually 0-length.
  const isDer = hex.startsWith('30');
  console.log(`  in[${i}] v${inp.outpointIndex}: ${len} bytes  DER-signature=${isDer}  ${hex.slice(0, 48)}${len > 24 ? '…' : ''}`);
});
console.log(`p2pkh input is index ${trade.entries.length} (pools occupy 0..${trade.entries.length - 1})`);
process.exit(0);
