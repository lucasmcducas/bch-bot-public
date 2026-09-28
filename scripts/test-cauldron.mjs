#!/usr/bin/env node
// scripts/test-cauldron.mjs — unit tests for lib/cauldron.mjs and live Cauldron integration
//
// Tests exercise:
//   1. SDK primitives (ExchangeLab construction, methods)
//   2. lib/cauldron.mjs exports and parsers
//   3. LIVE: parse real Cauldron pools from rostrum.cauldron.quest
//   4. LIVE: get token price for a real token (PUSD)
//   5. LIVE: quote a swap against real pools

import { ExchangeLab } from '@cashlab/cauldron';
import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common';

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

const PUSD_ID = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const ROACH_ID = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';

console.log('--- test 1: ExchangeLab construction + basic methods ---');
{
  const lab = new ExchangeLab();
  assert('ExchangeLab constructs', lab !== null && lab !== undefined);
  assert('rate denominator defaults to 10000000000000n',
    lab.getRateDenominator() === 10000000000000n);

  lab.setRateDenominator(1000000n);
  assert('rate denominator can be set',
    lab.getRateDenominator() === 1000000n);
  lab.setRateDenominator(10000000000000n);
}

console.log();
console.log('--- test 2: getOutputMinAmount ---');
{
  const lab = new ExchangeLab();
  const bchOnly = {
    locking_bytecode: new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac]),
    amount: 1000n,
  };
  assert('BCH-only P2PKH min = 546 sat (dust)', lab.getOutputMinAmount(bchOnly) === 546n);

  const withToken = {
    locking_bytecode: bchOnly.locking_bytecode,
    amount: 1000n,
    token: { amount: 100n, token_id: PUSD_ID },
  };
  assert('Token-bearing min > dust (FT adds bytes)', lab.getOutputMinAmount(withToken) > 546n);
}

console.log();
console.log('--- test 3: lib/cauldron.mjs exports ---');
{
  const c = await import('../lib/cauldron.mjs');
  assert('exports exlab (ExchangeLab)', typeof c.exlab?.constructTradeBestRateForTargetSupply === 'function');
  assert('exports connectCauldronRostrum', typeof c.connectCauldronRostrum === 'function');
  assert('exports fetchPools', typeof c.fetchPools === 'function');
  assert('exports parsePoolsFromRostrum', typeof c.parsePoolsFromRostrum === 'function');
  assert('exports getTokenPrice', typeof c.getTokenPrice === 'function');
  assert('exports quoteSwap', typeof c.quoteSwap === 'function');
  assert('exports quoteSwapForDemand', typeof c.quoteSwapForDemand === 'function');
  assert('exports CAULDRON_ROSTRUM', c.CAULDRON_ROSTRUM === 'rostrum.cauldron.quest:50004');
  assert('exports CAULDRON_PROTOCOL = 1.4.3', c.CAULDRON_PROTOCOL === '1.4.3');
  assert('exports BCH_TOKEN = "BCH"', c.BCH_TOKEN === 'BCH');
}

console.log();
console.log('--- test 4: LIVE Cauldron rostrum ---');
{
  const c = await import('../lib/cauldron.mjs');
  let client, error;
  try {
    client = await c.connectCauldronRostrum();
    const feat = await client.request('server.features');
    assert('Cauldron rostrum tokens=true', feat?.tokens === true);
    assert('server_version = Rostrum 15.0.0', feat?.server_version === 'Rostrum 15.0.0');
    assert('protocol_max = 1.4.3', feat?.protocol_max === '1.4.3');
    await client.disconnect();
  } catch (e) {
    error = e;
  }
  assert('Cauldron rostrum connects', !!client);
  if (error) console.log('   error:', String(error).slice(0, 80));
}

console.log();
console.log('--- test 5: LIVE PUSD pools ---');
{
  const c = await import('../lib/cauldron.mjs');
  const client = await c.connectCauldronRostrum();
  const pools = await c.fetchPools(client, PUSD_ID);
  assert('PUSD has > 10 live pools (micro-pool DEX reality)', pools.length > 10);
  assert('pool has PoolV0 shape', pools[0]?.version === '0');
  assert('pool has withdraw_pubkey_hash',
    pools[0]?.parameters?.withdraw_pubkey_hash instanceof Uint8Array);
  assert('pool has 32-byte txhash outpoint',
    pools[0]?.outpoint?.txhash instanceof Uint8Array && pools[0].outpoint.txhash.length === 32);
  assert('pool outpoint has numeric index',
    typeof pools[0]?.outpoint?.index === 'number');
  assert('pool output has token data',
    pools[0]?.output?.token?.token_id === PUSD_ID);
  assert('pool output amount > 0',
    pools[0]?.output?.amount > 0n);
  assert('pool lockingBytecode = cauldron pool V0 bytecode',
    pools[0]?.output?.lockingBytecode instanceof Uint8Array &&
    pools[0].output.lockingBytecode.length > 20);
  await client.disconnect();
  console.log('   (' + pools.length + ' live PUSD pools fetched)');
}

console.log();
console.log('--- test 6: LIVE token price calculation ---');
{
  const c = await import('../lib/cauldron.mjs');
  const client = await c.connectCauldronRostrum();
  const pools = await c.fetchPools(client, PUSD_ID);
  const price = c.getTokenPrice(pools, PUSD_ID);
  assert('price is a bigint', typeof price === 'bigint');
  assert('price > 0 (PUSD has nonzero liquidity)', price > 0n);
  console.log('   PUSD price:', price.toString(), 'sat per base unit');
  console.log('   (~' + (Number(price) / 100).toFixed(2) + ' sat per PUSD; ~$' + (Number(price) / 100 / 1e8 * 460).toFixed(4) + ' at $460/BCH)');
  await client.disconnect();
}

console.log();
console.log('--- test 7: LIVE swap quote ---');
{
  const c = await import('../lib/cauldron.mjs');
  const client = await c.connectCauldronRostrum();
  const pools = await c.fetchPools(client, PUSD_ID);

  // Sell 10000 sats BCH for PUSD
  const quote = c.quoteSwap({
    supply_token_id: 'BCH',
    demand_token_id: PUSD_ID,
    supply_amount: 10000n,
    pools,
  });
  assert('quote exists', quote !== null);
  assert('quote has summary with supply/demand/fee',
    quote?.summary?.supply !== undefined &&
    quote?.summary?.demand !== undefined &&
    quote?.summary?.trade_fee !== undefined);
  assert('quote uses at least one pool',
    quote?.entries?.length >= 1);
  // SDK semantics: summary.supply = input after fee deduction (what the pool receives),
  // summary.trade_fee = fee taken from the input. The total consumed ≈ supply + trade_fee.
  assert('supply (post-fee) is < supply_amount (pre-fee)',
    quote?.summary?.supply < 10000n);
  assert('demand is positive (we receive something)',
    quote?.summary?.demand > 0n);

  // Reverse quote: buy 100 PUSD with BCH
  const buyQuote = c.quoteSwapForDemand({
    supply_token_id: 'BCH',
    demand_token_id: PUSD_ID,
    demand_amount: 10000n, // 100.00 PUSD
    pools,
  });
  assert('buy quote exists', buyQuote !== null);
  assert('buy quote demand = 10000', buyQuote?.summary?.demand === 10000n);
  assert('buy quote supply > demand_amount (need more BCH than the demand token rate)',
    buyQuote?.summary?.supply > 10000n);

  await client.disconnect();
}

console.log();
console.log('--- test 8: LIVE ROACH pools ---');
{
  const c = await import('../lib/cauldron.mjs');
  const client = await c.connectCauldronRostrum();
  const pools = await c.fetchPools(client, ROACH_ID);
  assert('ROACH has at least 1 pool', pools.length >= 1);
  console.log('   (' + pools.length + ' ROACH pools)');
  await client.disconnect();
}

console.log();
console.log('='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail > 0 ? 1 : 0);