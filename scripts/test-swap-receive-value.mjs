// scripts/test-swap-receive-value.mjs — proves the gate catches a short payment.
//
// THE BUG (2026-10-02, real, fixed by the security audit): verifyTransactionOutputs
// byte-compares every output against our addresses, which correctly catches
// REDIRECTION, but never compared the VALUE of an output already proven ours. A
// router that quoted 36,141 and built an output paying our own address 1 base
// unit passed every gate: the destination is genuinely ours, the pool count
// matches, no token category is wrong. The user signs it and receives nothing.
//
// Ownership answers "is this my money going somewhere I did not agree to?"
// It cannot answer "is my money arriving short?" Those are different questions
// and only the second one needs the amount.
//
// Run: node scripts/test-swap-receive-value.mjs

import { verifyTransactionOutputs } from '../lib/router.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import { loadHdNode } from '../lib/wallet.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const MINE = 'bitcoincash:qpjfw956u6rc88n8ul4xxyu9fu2v94s2eylh9vtzhv';
const POOL = 'bitcoincash:qrjcuk2c749w6ezgpdk685e6yx35a9l29qqmn98jmw';
const CHANGE = 'bitcoincash:qzvs5u0rjcd70kttcqd9vnjyudhqh2pqf5zrgumffh';
const QUOTED = 36141n;   // what the router promised
const PAID = 1n;         // what a hostile router actually builds

const { hdNode } = loadHdNode();

/** Build a real, signed 1-in/2-out transaction with an arbitrary receive value. */
async function buildTx(receiveValue) {
  const input = {
    tx_hash: 'ab90acba4e383b3cc4ba1d0d934568d04ce397610ebd0744dc7638e431733ce6',
    tx_pos: 0,
    valueSatoshis: 1_000_000n,
    address: MINE,
    hdNode,
    account: 0,
    change: 0,
    index: 0,
  };
  const change = 1_000_000n - receiveValue - 500n;
  // The second output is OUR change, declared as such -- exactly how swap.mjs
  // passes changeAddresses. Putting a large value in an undeclared address
  // would (correctly) trip the fee ceiling and test nothing about amounts.
  const { tx_hex } = await signP2pkhTransaction({
    inputs: [input],
    outputs: [
      { address: MINE, valueSatoshis: receiveValue },
      { address: CHANGE, valueSatoshis: change },
    ],
  });
  return tx_hex;
}

console.log('the gate must reject a correct address paying the wrong amount\n');

const honestTx = await buildTx(QUOTED);
const shortTx = await buildTx(PAID);

await test('an honest build at the quoted amount passes', async () => {
  const r = await verifyTransactionOutputs(honestTx, {
    expectedReceiveAddresses: [MINE],
    changeAddresses: [CHANGE],
    maxFeeSats: 2000n,
    expectedReceiveAmount: QUOTED.toString(),
    minReceiveAmount: QUOTED.toString(),
  });
  assert(r.ok, `honest build rejected: ${JSON.stringify(r.problems)}`);
});

await test('paying the RIGHT address the WRONG amount is refused', async () => {
  const r = await verifyTransactionOutputs(shortTx, {
    expectedReceiveAddresses: [MINE],
    changeAddresses: [CHANGE],
    maxFeeSats: 2000n,
    expectedReceiveAmount: QUOTED.toString(),
    minReceiveAmount: QUOTED.toString(),
  });
  assert(!r.ok, 'a short payment to our own address was accepted -- the bug is back');
  const text = JSON.stringify(r.problems);
  assert(/36141/.test(text) || /below/.test(text) || /amount/i.test(text),
    `refusal must name the amounts, got: ${text}`);
});

await test('a payment below the user floor is refused even if it matches a quote', async () => {
  // The user set --min-output 10000. The router quoted and built 5000, which is
  // internally consistent but below what the user agreed to accept.
  const tx = await buildTx(5000n);
  const r = await verifyTransactionOutputs(tx, {
    expectedReceiveAddresses: [MINE],
    changeAddresses: [CHANGE],
    maxFeeSats: 2000n,
    expectedReceiveAmount: 5000n.toString(),
    minReceiveAmount: 10000n.toString(),
  });
  assert(!r.ok, 'a payment under the user floor was accepted');
  assert(JSON.stringify(r.problems).includes('10000'),
    'the refusal must name the required floor');
});

await test('a build with NO output to the receive address is refused', async () => {
  // Everything goes to the pool; nothing to us. Ownership checks pass (no
  // foreign output), so only the receive check can catch this.
  const input = {
    tx_hash: 'ab90acba4e383b3cc4ba1d0d934568d04ce397610ebd0744dc7638e431733ce6',
    tx_pos: 0,
    valueSatoshis: 1_000_000n,
    address: MINE,
    hdNode,
    account: 0,
    change: 0,
    index: 0,
  };
  const { tx_hex } = await signP2pkhTransaction({
    inputs: [input],
    outputs: [{ address: CHANGE, valueSatoshis: 999_500n }],
  });
  const r = await verifyTransactionOutputs(tx_hex, {
    expectedReceiveAddresses: [MINE],
    changeAddresses: [CHANGE],
    maxFeeSats: 2000n,
    expectedReceiveAmount: QUOTED.toString(),
    minReceiveAmount: QUOTED.toString(),
  });
  assert(!r.ok, 'a build delivering nothing to the receive address was accepted');
});

await test('omitting the amount opts out, so existing callers are unaffected', async () => {
  // The check must be additive: a caller that does not pass an amount gets the
  // old behaviour rather than a spurious failure.
  const r = await verifyTransactionOutputs(shortTx, {
    expectedReceiveAddresses: [MINE],
    changeAddresses: [CHANGE],
    maxFeeSats: 2000n,
  });
  assert(r.ok, `opting out should pass as before: ${JSON.stringify(r.problems)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
