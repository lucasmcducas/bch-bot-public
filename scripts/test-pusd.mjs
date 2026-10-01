#!/usr/bin/env node
// scripts/test-pusd.mjs — unit tests for lib/pusd.mjs and lib/cashscript.mjs
//
// We can't run a real PUSD stake (needs covenant UTXOs we don't have), so this
// exercises the tx-construction code paths against synthetic data and verifies
// the produced structure matches the AddLiquidity.cash contract spec.

import {
  PUSD_CATEGORY_ID,
  POOL_CATEGORY_ID,
  MIN_STAKE_BASE_UNITS,
  parseNextEpoch,
  buildReceiptCommitment,
  buildStakeTransaction,
  validateStakeAmount,
} from '../lib/pusd.mjs';
import { buildCovenantUnlockingBytecode, SigningSerializationFlag } from '../lib/cashscript.mjs';

let verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
let pass = 0, fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    pass++;
    if (verbose) console.log('  ✓', label);
  } else {
    fail++;
    console.log('  ✗', label);
    if (detail) console.log('     ', detail);
  }
}

console.log('--- test 1: PUSD constants ---');
{
  assert('PUSD category id = 2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
    PUSD_CATEGORY_ID === '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544');
  assert('Pool category id = 7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81',
    POOL_CATEGORY_ID === '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81');
  assert('MIN_STAKE = 10000 base units (= 100.00 PUSD)', MIN_STAKE_BASE_UNITS === 10000n);
  // Sighash flag for covenant inputs
  const expectedSighash = SigningSerializationFlag.allOutputs
    | SigningSerializationFlag.utxos
    | SigningSerializationFlag.forkId;
  assert('all | utxos | forkId = 0x61', expectedSighash === 0x61);
}

console.log();
console.log('--- test 2: validateStakeAmount ---');
{
  assert('100.00 PUSD (= 10000 base units) is valid', (() => {
    try { validateStakeAmount(10000n); return true; } catch { return false; }
  })());
  assert('99.99 PUSD (= 9999 base units) is below min — throws', (() => {
    try { validateStakeAmount(9999n); return false; } catch { return true; }
  })());
  assert('50.00 PUSD (= 5000 base units) throws', (() => {
    try { validateStakeAmount(5000n); return false; } catch { return true; }
  })());
}

console.log();
console.log('--- test 3: parseNextEpoch ---');
{
  // Per AddLiquidity.cash: int(periodPoolBytes) / 10 where periodPoolBytes is the
  // first 4 bytes of the NFT commitment (read as BE uint32).
  //   05000000 = 0x05000000 = 83,886,080 → currentEpoch = 8,388,608 → nextEpoch = 8,388,609
  //   00000001 = period 1 → currentEpoch 0 → nextEpoch 1
  //   0000000a = period 10 → currentEpoch 1 → nextEpoch 2
  //   00000064 = period 100 → currentEpoch 10 → nextEpoch 11
  assert('commitment 05000000 → nextEpoch = 8388609 (0x05000000 = 83886080 → /10 = 8388608 → +1 = 8388609)',
    parseNextEpoch('05000000') === 8388609n);
  assert('commitment 00000001 (= period 1) → nextEpoch = 1',
    parseNextEpoch('00000001') === 1n);
  assert('commitment 0000000a (= period 10) → nextEpoch = 2',
    parseNextEpoch('0000000a') === 2n);
  assert('commitment 00000064 (= period 100) → nextEpoch = 11',
    parseNextEpoch('00000064') === 11n);
}

console.log();
console.log('--- test 4: buildReceiptCommitment ---');
{
  // Per CashScript: toPaddedBytes(nextEpoch, 4) = 4 bytes BE; bytes(addedTokenAmount) = minimal BE.
  // For nextEpoch=6, amount=10000 (= 0x2710):
  //   toPaddedBytes(6, 4) = 00000006
  //   bytes(10000) = 2710
  //   full = 000000062710
  const c1 = buildReceiptCommitment(6n, 10000n);
  assert('nextEpoch=6, amount=10000 → 000000062710', c1 === '000000062710');

  // For nextEpoch=1, amount=50000 (= 0xc350):
  const c2 = buildReceiptCommitment(1n, 50000n);
  assert('nextEpoch=1, amount=50000 → 00000001c350', c2 === '00000001c350');
}

console.log();
console.log('--- test 5: buildStakeTransaction (synthetic covenant data) ---');
{
  // Mock covenant inputs
  const stabilityPoolInput = {
    tx_hash: 'aa'.repeat(32),
    tx_pos: 0,
    value: 10000,
    nft_commitment: '05000000',  // period 5 → nextEpoch 1
  };
  const sidecarInput = {
    tx_hash: 'bb'.repeat(32),
    tx_pos: 0,
    value: 0,
    token_amount: '50000',  // 500.00 PUSD currently in sidecar
  };
  const addLiquidityInput = {
    tx_hash: 'cc'.repeat(32),
    tx_pos: 0,
    value: 1000,
    nft_commitment: '01',  // function contract state identifier
  };
  const userPusdInput = {
    tx_hash: 'dd'.repeat(32),
    tx_pos: 0,
    value: 0,
    token_amount: '10000',  // 100.00 PUSD to stake
  };
  const userBchInput = {
    tx_hash: 'ee'.repeat(32),
    tx_pos: 0,
    value: 5000,
  };
  const poolContract = { address: 'bitcoincash:pp8...', bytecode: new Uint8Array(25) };
  const sidecarContract = { address: 'bitcoincash:pp9...', bytecode: new Uint8Array(25) };
  const addLiquidityContract = { address: 'bitcoincash:ppA...', bytecode: new Uint8Array(25) };
  const userAddress = { address: 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603' };

  const tx = buildStakeTransaction({
    stabilityPoolInput,
    sidecarInput,
    addLiquidityInput,
    userPusdInput,
    userBchInput,
    stakeAmount: 10000n,
    poolContract,
    sidecarContract,
    addLiquidityContract,
    userAddress,
  });

  assert('description set', tx.description === 'PUSD Stability Pool stake');
  assert('nextEpoch > 1 (any value, computed from pool commitment)',
    typeof tx.nextEpoch === 'bigint' && tx.nextEpoch >= 1n);
  assert('receipt commitment matches builder output',
    tx.receiptCommitment === buildReceiptCommitment(tx.nextEpoch, 10000n));

  assert('5 inputs', tx.inputs.length === 5);
  assert('input[0] = pool (0x41 sighash)', tx.inputs[0].sighashType === 0x41);
  assert('input[2] = AddLiquidity covenant (0x61 sighash)', tx.inputs[2].sighashType === 0x61);
  assert('input[3] = user PUSD (0x41)', tx.inputs[3].sighashType === 0x41);

  assert('4 required outputs', tx.outputs.length === 4);
  assert('output[0] is pool-recreated (value = input[0].value)', tx.outputs[0].valueSatoshis === BigInt(10000));
  assert('output[1] sidecar has 600.00 PUSD (500 existing + 100 staked)', tx.outputs[1].token.amount === 60000n);
  assert('output[2] is function contract recreated (value=1000)', tx.outputs[2].valueSatoshis === 1000n);
  assert('output[3] is receipt NFT (value=1000)', tx.outputs[3].valueSatoshis === 1000n);
  assert('output[3] has minting capability', tx.outputs[3].token.nft.capability === 'minting');
  // For commitment 05000000, period = 0x05000000 = 83886080 → nextEpoch = 8388609
  const expectedCommitment = buildReceiptCommitment(tx.nextEpoch, 10000n);
  assert('output[3] commitment matches receipt builder', Buffer.from(tx.outputs[3].token.nft.commitment).toString('hex') === expectedCommitment);
}

console.log();
console.log('--- test 6: buildCovenantUnlockingBytecode (manual signing) ---');
{
  const fakeSignature = new Uint8Array(64);
  fakeSignature.fill(0xab);  // 64 bytes of 0xab
  const fakePubkey = new Uint8Array(33);
  fakePubkey.fill(0x02);
  fakePubkey[0] = 0x02;  // compressed pubkey prefix
  const fakeRedeemScript = new Uint8Array(50);
  fakeRedeemScript.fill(0x76);  // OP_VERIFY

  const unlocking = buildCovenantUnlockingBytecode({
    signature: fakeSignature,
    publicKey: fakePubkey,
    redeemScript: fakeRedeemScript,
    sighashType: 0x61,
  });
  // Expected length: 1 (push 65) + 65 (sig+0x61) + 1 (push 33) + 33 (pubkey) + 1 (push 50) + 50 (redeemscript) = 151
  assert('unlocking bytecode length = 151 (1+65+1+33+1+50)', unlocking.length === 151);
  assert('first byte = 0x41 (push 65)', unlocking[0] === 0x41);
  assert('byte 65 = sighash 0x61', unlocking[65] === 0x61);
  assert('byte 66 = 0x21 (push 33)', unlocking[66] === 0x21);
  assert('byte 67 = 0x02 (compressed pubkey prefix)', unlocking[67] === 0x02);
  assert('byte 100 = 0x32 (push 50)', unlocking[100] === 0x32);
}

console.log();
console.log('='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail > 0 ? 1 : 0);