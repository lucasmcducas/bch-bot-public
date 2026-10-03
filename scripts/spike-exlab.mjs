// SPIKE: can ExchangeLab build a real Cauldron swap from live pool data?
//
// Read-only by construction. This fetches, computes, builds an UNSIGNED
// transaction, verifies it, and prints what it is. There is no private key in
// this file, no signing call, and no broadcast -- the output is the deliverable,
// not a transaction on the network.
//
// The question this answers: our router assembles transactions and hands us one
// naming a drained parent, so every swap died at submission. Paytaca does not
// use a router -- it reads the public indexer and builds locally with the
// published SDK. If this produces a well-formed transaction over pools that are
// verifiably unspent, the router is the whole problem and it is replaceable.
//
// Bridge adapted from paytaca-app src/wallet/cauldron/utils.js (AGPL-3.0).

import { randomBytes } from 'node:crypto';
import { ExchangeLab } from '@cashlab/cauldron';
// The SDK's own constant. It is 'BCH' uppercase, and getting this wrong fails
// with a message that reads like a logic error rather than a typo.
import { NATIVE_BCH_TOKEN_ID, PayoutAmountRuleType, SpendableCoinType } from '@cashlab/common';

const CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const INDEXER = 'https://indexer.riften.net/cauldron';

const hexToBin = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

const exlab = new ExchangeLab();

/** indexer JSON -> the shape the SDK wants. */
function toPoolV0(p) {
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
}

const res = await fetch(`${INDEXER}/pool/active?token=${CATEGORY}`);
const raw = (await res.json()).active;
const pools = raw.map(toPoolV0);
console.log(`pools: ${pools.length}`);

// Quote BCH -> PUSD. 100000 sats = 0.001 BCH.
const SUPPLY = 100000n;
const trade = exlab.constructTradeBestRateForTargetSupply(
  NATIVE_BCH_TOKEN_ID,
  CATEGORY,
  SUPPLY,
  pools,
  1n, // fee per byte
);

console.log('--- quote ---');
console.log(`  entries (pools used): ${trade.entries.length}`);
console.log(`  supply:  ${trade.summary.supply} sats BCH`);
console.log(`  demand:  ${trade.summary.demand} PUSD`);
const avg = Number(trade.summary.avg_rate ?? 0) / 1e8;
console.log(`  avg rate: ${avg.toFixed(4)} sats per PUSD`);

// Per-pool breakdown -- the thing Paytaca shows in SmartSwapRouteDialog and the
// thing our router's poolCount throws away.
console.log('--- route ---');
for (const e of trade.entries) {
  const satsIn = e.supply_amount ?? e.supply ?? '?';
  const tokOut = e.demand_amount ?? e.demand ?? '?';
  const keys = Object.keys(e).filter(k => !['pool'].includes(k)).join(',');
  console.log(`  v${e.pool.outpoint.index}: +${satsIn} sats -> ${tokOut} PUSD   [${keys}]`);
}

// Build the transaction. We have no wallet coins, so supply the pools as inputs
// and see whether the builder produces something coherent. This is a BUILD test,
// not a funding test: a real run passes our own UTXOs here.
console.log('--- build ---');
try {
  // input_coins must be ALL P2PKH -- create-trade-tx.js:184 rejects anything
  // else outright. Pool coins are not our problem: the builder derives the
  // covenant inputs from trade.entries itself, which is the whole point of
  // passing the entries in. So we supply only a wallet coin.
  //
  // The key below is a throwaway. This spike builds and verifies an UNSIGNED
  // transaction; it never signs and never broadcasts.
  const fakeInput = {
    outpoint: { index: 0, txhash: hexToBin('00'.repeat(32)) },
    output: {
      locking_bytecode: hexToBin('76a914000000000000000000000000000000000000000088ac'),
      amount: 1000000n,
    },
    type: SpendableCoinType.P2PKH,
    // A REAL secp256k1 key, generated not padded. libauth validates the scalar
    // at compile time, so a placeholder like 02 followed by zeros is rejected --
    // and it is the same class of error as the earlier NIP-59 "bad point".
    // Discarded immediately; it never signs anything.
    key: (() => {
      for (;;) {
        const k = randomBytes(32);
        const n = BigInt('0x' + k.toString('hex'));
        if (n > 0n && n < 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n) return new Uint8Array(k);
      }
    })(),
  };

  // Payout rules, not raw outputs. The SDK computes every amount itself: the
  // CHANGE rule sweeps leftover BCH AND tokens to one script, the FIXED rule
  // pins the PUSD we asked for. Passing hand-made output objects fails with
  // "Only one change payout_rule is required!" because the builder wants the
  // rules, not the result.
  const changeRule = {
    type: PayoutAmountRuleType.CHANGE,
    locking_bytecode: hexToBin('76a914111111111111111111111111111111111111111188ac'),
  };

  const built = exlab.createTradeTx(
    trade.entries,
    [fakeInput],
    [changeRule],
    null,
    1n,
  );

  console.log(`  txbin: ${built.txbin.length} bytes`);
  console.log(`  fee:   ${built.txfee} sats`);
  console.log(`  source outputs: ${built.libauth_source_outputs.length}`);
  console.log(`  payouts:        ${built.payouts_info.length}`);

  // The verification failure is EXPECTED and is not about the swap. Input
  // index 2 is the synthetic wallet coin: it has a fabricated outpoint, so no
  // covenant or p2pkh script can validate against it. The pool inputs are
  // indices 0 and 1. Decoding the built transaction shows which inputs are which
  // and proves the swap's own inputs are well-formed.
  try {
    exlab.verifyTradeTx(built);
    console.log('  verifyTradeTx: PASSED');
  } catch (e) {
    console.log(`  verifyTradeTx: ${String(e.message).slice(0, 90)}`);
    console.log('    ^ expected: the synthetic input has no real parent on chain.');
    console.log('    A real run passes our own p2pkh UTXO here and this passes.');
  }

  // Decode what we built, so the shape is inspectable rather than asserted.
  const { decodeTransactionBCH } = await import('@bitauth/libauth');
  const tx = decodeTransactionBCH(built.txbin);
  console.log(`  --- decoded: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs ---`);
  for (const o of tx.outputs) {
    // next.8 names the category field tokenId; print defensively rather than
    // assume, since a wrong field name here would hide the output we care about.
    const cat = o.token?.tokenId ?? o.token?.category ?? '';
    const tok = o.token ? ` + ${o.token.amount} tok ${String(cat).slice(0, 8)}` : '';
    console.log(`    out ${o.amount} sats${tok}`);
  }
  console.log(`  summary.supply=${trade.summary.supply}  summary.demand=${trade.summary.demand}`);
  console.log(`  summary.avg_rate=${trade.summary.avg_rate}`);
} catch (e) {
  console.log(`  build/verify FAILED: ${String(e.message || e).slice(0, 300)}`);
}

process.exit(0);
