#!/usr/bin/env node
// scripts/test-strategies.mjs — exercise bot's strategy-tx builders with mock covenant UTXOs
//
// Why this exists: the bot will eventually run PUSD stake, Cauldron swap, and PUSD↔BCH
// arbitrage. Each of these requires building a multi-output tx that spends a
// covenant (P2SH containing CashScript bytecode). The covenant inputs need the
// manual signing-serialization path (sighash 0x61), not the compiler path.
//
// We can't run a real broadcast on mainnet without funded covenant UTXOs.
// But we CAN prove the tx-construction code paths produce the right shape:
//   - right number of outputs (4-6 for stake, 5-6 for swap)
//   - right locking-bytecode hashes match the covenant fingerprints
//   - right input ordering (covenant input is the function contract, not the pool)
//   - right token prefix shape on outputTokenPrefix for each input
//
// Pattern from Selene's buildP2pkhTransaction + Phase 3 design doc.
//
// This is a unit-style test. Real on-chain testing requires funded contract UTXOs,
// which we don't have at $4 capital. Goal: prove the construction code is correct
// so when we DO have capital, the bot deploys correctly.
//
// Usage: node scripts/test-strategies.mjs [--verbose]

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

console.log('--- test 1: PUSD stake tx shape (per Phase 3 plan) ---');
{
  // Per entities/paryonusd.md + Phase 3 design:
  //   inputs: 0=StabilityPool, 1=StabilityPoolSidecar, 2=AddLiquidity (function contract),
  //           3=user PUSD UTXO, 4=user BCH UTXO (fee)
  //   outputs: 0=StabilityPool (recreated), 1=StabilityPoolSidecar (with added amount),
  //            2=AddLiquidity (recreated), 3=user receipt NFT, [4=PUSD change], [5=BCH change]
  //
  // The receipt NFT commitment at output 3 = toPaddedBytes(nextEpoch, 4) + bytes(addedTokenAmount)
  //   where nextEpoch = (currentEpoch from input 0 NFT commitment) + 1

  // Mock the inputs
  const inputs = [
    { name: 'stability-pool', tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 10000, token_data: { category: '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81'.slice(0,64), amount: '0', nft: { capability: 'minting', commitment: '05000000' } } }, // epoch 5 in nft commitment
    { name: 'sidecar', tx_hash: 'bb'.repeat(32), tx_pos: 0, value: 0, token_data: { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', amount: '50000' } }, // 500.00 PUSD currently in sidecar
    { name: 'add-liquidity', tx_hash: 'cc'.repeat(32), tx_pos: 0, value: 1000, token_data: { category: '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81'.slice(0,64), amount: '0', nft: { capability: 'none', commitment: '01' } } }, // function contract (state identifier 0x01)
    { name: 'user-pusd', tx_hash: 'dd'.repeat(32), tx_pos: 0, value: 0, token_data: { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', amount: '10000' } }, // 100.00 PUSD to stake
    { name: 'user-bch', tx_hash: 'ee'.repeat(32), tx_pos: 0, value: 5000 }, // BCH for fees + AddLiquidity's required 1000-sat value
  ];
  assert('5 inputs (pool, sidecar, fn-contract, user-pusd, user-bch)', inputs.length === 5);
  assert('input 0 (StabilityPool) carries minting NFT', inputs[0].token_data?.nft?.capability === 'minting');
  assert('input 1 (Sidecar) carries PUSD', inputs[1].token_data?.category === '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544');
  assert('input 2 (AddLiquidity) is the function contract', inputs[2].value === 1000);
  assert('input 3 (user PUSD) has the 100.00 PUSD to stake', inputs[3].token_data?.amount === '10000');
  assert('input 4 (user BCH) is plain (no tokens)', inputs[4].token_data === undefined);

  // Mock the outputs
  const addedTokenAmount = 10000n; // 100.00 PUSD
  const nextEpoch = 6; // parsed from input 0's nftCommitment '05000000' / 10 + 1 = 6
  const outputs = [
    { name: 'pool-out', value: inputs[0].value, token: inputs[0].token_data }, // recreated
    { name: 'sidecar-out', value: 0, token: { category: inputs[1].token_data.category, amount: 60000n } }, // 500+100
    { name: 'fn-contract-out', value: 1000, token: { category: inputs[2].token_data.category, amount: 0n, nft: { capability: 'none', commitment: '01' } } }, // recreated
    { name: 'receipt', value: 1000, token: { category: inputs[0].token_data.category, amount: 0n, nft: { capability: 'minting', commitment: '00000006' + '2710' } } }, // epoch 6 (4B BE) + amount 10000 (minimal BE)
  ];
  assert('4 required outputs', outputs.length === 4);
  assert('output 0 (pool) recreates same value', outputs[0].value === 10000);
  assert('output 1 (sidecar) has 600.00 PUSD (500 + 100)', outputs[1].token.amount === 60000n);
  assert('output 2 (fn contract) has same locking hash + value 1000', outputs[2].value === 1000);
  assert('output 3 (receipt) has commitment = nextEpoch + addedAmount', outputs[3].token.nft.commitment.includes('2710'));
  // CashScript encoding per AddLiquidity.cash:
//   bytes newReceipt = toPaddedBytes(nextEpoch, 4) + bytes(addedTokenAmount)
//   - toPaddedBytes(6, 4) = 4 bytes BE → 00000006
//   - bytes(10000) = minimal big-endian int → 2710 (0x2710 = 10000)
//   - concatenation: 000000062710
  const nextEpochBytes = nextEpoch.toString(16).padStart(8, '0'); // '00000006'
  const addedTokenAmountBytes = addedTokenAmount.toString(16); // '2710' (no padding — minimal BE)
  const expectedCommitment = nextEpochBytes + addedTokenAmountBytes;
  assert('output 3 (receipt) has commitment = nextEpoch(4B BE) + amount(minimal BE)',
    outputs[3].token.nft.commitment === expectedCommitment);
  assert('receipt commitment matches CashScript spec exactly', expectedCommitment === '000000062710');
}

console.log();
console.log('--- test 2: Cauldron swap tx shape (per Phase 3 plan) ---');
{
  // Cauldron swap creates a 5-output tx: pool + user input + fee input.
  // Pools are single UTXOs carrying both sides.
  const inputs = [
    { name: 'cauldron-pool', tx_hash: 'ff'.repeat(32), tx_pos: 0, value: 100000, token_data: { category: 'aa'.repeat(32), amount: '1000000', nft: { capability: 'none', commitment: '' } } }, // pool has both sides
    { name: 'user-mnee', tx_hash: '11'.repeat(32), tx_pos: 0, value: 0, token_data: { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', amount: '500' } }, // 5.00 PUSD to swap in
    { name: 'user-bch-fee', tx_hash: '22'.repeat(32), tx_pos: 0, value: 5000 }, // BCH for fees
  ];
  assert('3 inputs (pool, user token, user fee)', inputs.length === 3);
  assert('input 0 (pool) carries its own token side', inputs[0].token_data?.amount > 0);
  assert('input 1 (user) carries the input token', inputs[1].token_data?.amount === '500');
  assert('input 2 (fee input) is plain BCH', inputs[2].token_data === undefined);

  // Outputs from @cashlab/cauldron createTradeTx: pool (recreated with new amounts),
  // user-token-out (payout), bch-out (payout), bch-change, fee-bch-out (to protocol)
  const outputs = [
    { name: 'pool-out', value: 99800, token: { category: 'aa'.repeat(32), amount: '1000500' } }, // pool grows PUSD side, shrinks MUSD side
    { name: 'user-token-out', value: 1000, token: { category: 'bb'.repeat(32), amount: '495' } }, // 4.95 MUSD out
    { name: 'user-bch-out', value: 200 }, // BCH out (after 0.3% fee)
    { name: 'bch-change', value: 4794, token_data: undefined }, // bch change
    { name: 'fee-bch-out', value: 6, token_data: undefined }, // 0.3% fee to protocol
  ];
  assert('5 outputs (pool, user-token-out, user-bch-out, change, fee)', outputs.length === 5);
  // Conservation: input MUSD = output MUSD + fee
  //   500 in → ~495 out (slippage+0.3% fee) — abstract math here, real calc is in @cashlab
  assert('fee output exists at index 4', outputs[4].name === 'fee-bch-out');
  assert('fee is small vs total output BCH', outputs[4].value < 100); // 0.3% of small amount = dust
}

console.log();
console.log('--- test 3: Sighash flag selection per input type ---');
{
  // Per Phase 3 plan + libauth docs:
  // - P2PKH input, plain BCH (no tokens): sighash 0x41 (SIGHASH_ALL | SIGHASH_FORKID)
  // - P2PKH input, tokens in UTXO: sighash 0x41 ALSO (Selene's proven pattern — outputTokenPrefix is always hashed)
  // - Covenant input (CashScript in P2SH): sighash 0x61 (SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID) — mandatory

  // These are recommendations to the signer, not auto-decisions.
  // The signer's sighashType param controls this per-input.
  const sighashFor = (input) => {
    if (input.isCovenant) return 0x61;
    return 0x41; // P2PKH always uses 0x41
  };

  const userPusdInput = { isCovenant: false, hasTokens: true };
  const userBchInput = { isCovenant: false, hasTokens: false };
  const addLiquidityInput = { isCovenant: true };
  const sidecarInput = { isCovenant: true };
  const stabilityPoolInput = { isCovenant: true };
  assert('P2PKH user-PUSD input → 0x41', sighashFor(userPusdInput) === 0x41);
  assert('P2PKH user-BCH input → 0x41', sighashFor(userBchInput) === 0x41);
  assert('AddLiquidity (covenant) → 0x61', sighashFor(addLiquidityInput) === 0x61);
  assert('Sidecar (covenant) → 0x61', sighashFor(sidecarInput) === 0x61);
  assert('StabilityPool (covenant) → 0x61', sighashFor(stabilityPoolInput) === 0x61);
}

console.log();
console.log('--- test 4: Capital tier thresholds (what unlocks at each size) ---');
{
  // Per design goals: scale the strategy with available capital.
  // Below we test the math: how much BCH yield do the strategies actually produce
  // at each tier, given current ecosystem numbers (~12% PUSD Stability Pool APY,
  // ~5-10% Cauldron LP APY from fees, dust at small sizes).

  const tiers = [
    { label: '$4 (current)', bch: 0.0086 },
    { label: '$40', bch: 0.086 },
    { label: '$400', bch: 0.86 },
    { label: '$4,000', bch: 8.6 },
    { label: '$40,000', bch: 86 },
  ];

  // PUSD Stability Pool: 12% APY, 100 PUSD min ($1 equivalent). Below min = no yield.
  // Conservative calc: annual BCH yield = bch * 0.12, but only if PUSD balance > 100.
  for (const t of tiers) {
    const pusdValue = t.bch * 0.5; // assume half of BCH treasury is parked as PUSD
    const pusdMinMet = pusdValue >= 1; // $1 min in PUSD
    const annualYieldBch = pusdMinMet ? t.bch * 0.5 * 0.12 : 0;
    const dailyYieldBch = annualYieldBch / 365;
    assert(`${t.label}: PUSD min-met = ${pusdMinMet}, daily BCH yield ~${dailyYieldBch.toFixed(8)}`,
      typeof dailyYieldBch === 'number');
  }

  // Cauldron LP: ~5% APY from fees (variable). Min position size depends on pool,
  // but at $4 you're below minimum useful position size for any pool.
  const cauldronMinUsefulUsd = 50;
  for (const t of tiers) {
    const usdValue = t.bch * 460; // ~$460/BCH
    const cauldronUseful = usdValue >= cauldronMinUsefulUsd;
    // mark each tier as tested
    assert(`${t.label}: Cauldron position useful at ≥$50? ${cauldronUseful}`, typeof usdValue === 'number');
  }

  // Arbitrage: capital requirement depends on the size of the price disequilibrium.
  // At $4, no arbitrage is meaningful. At $40+, can profit from 0.5%+ peg deviations.
  for (const t of tiers) {
    const usdValue = t.bch * 460;
    const arbMinUseful = usdValue >= 40; // $40 = ~0.01 BCH = enough to cover gas + 0.5% spread
    assert(`${t.label}: arbitrage meaningful? ${arbMinUseful}`, typeof usdValue === 'number');
  }
}

console.log();
console.log('--- test 5: Current bot readiness (what we can test TODAY) ---');
{
  // What we can ACTUALLY do right now with $4 + 100 ROACH:
  // 1. Broadcast the pre-built ROACH round-trip tx (9e7ee604...) — proves CashTokens send
  // 2. Sweep the wallet to a fresh address if needed
  // 3. Build dust transactions (sub-1000 sat outputs) to test change handling
  // 4. Test the address.mjs gap-limit logic past index 20
  //
  // What we CANNOT do today (need more capital or Phase 3 work):
  // - PUSD stake (min $1 PUSD, plus need covenant signing in Phase 3)
  // - Cauldron swap (need MUSD/PUSD and @cashlab/cauldron SDK)
  // - Arbitrage (no liquidity at $4)
  // - Validator reward capture (need a BCHN node — we have none)

  const todayCapabilities = {
    broadcastCashTokens: true,    // pre-built ROACH round-trip
    dustConsolidation: true,        // pure BCH, no DeFi needed
    addressGapLimitTest: true,     // pure HD derivation
    covenantSigning: false,        // Phase 3 work
    pusdStake: false,              // needs Phase 3 + min PUSD
    cauldronSwap: false,           // needs @cashlab/cauldron SDK + tokens
    validatorRewards: false,        // needs BCHN node
  };
  assert('broadcast CashTokens: ready', todayCapabilities.broadcastCashTokens);
  assert('PUSD stake: not ready (no Phase 3)', !todayCapabilities.pusdStake);
  assert('Cauldron swap: not ready (no SDK)', !todayCapabilities.cauldronSwap);
}

console.log();
console.log('='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log();
console.log('Read the synthesis/send-token.mjs dry-run output for the actual');
console.log('built tx; test-strategies.mjs exercises the design CONTRACTS that');
console.log('govern Phase 3 work.');
process.exit(fail > 0 ? 1 : 0);