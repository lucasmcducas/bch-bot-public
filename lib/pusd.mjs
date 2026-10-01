// lib/pusd.mjs — ParyonUSD Stability Pool stake tx builder
//
// Implements the addToPool() shape from contracts/stabilitypool/poolContractFunctions/AddLiquidity.cash
// (verified via @paryonusd/contracts v1.0.0, fingerprint f46099a7... on mainnet-v1).
//
// AddLiquidity.cash requires this exact 5-or-6 output shape:
//   output[0]: StabilityPool P2SH (mutable NFT, value = input[0].value, NFT commitment unchanged)
//   output[1]: StabilityPoolSidecar P2SH (PUSD amount = input[1].amount + addedTokenAmount)
//   output[2]: AddLiquidity function contract (P2SH, value = 1000 sats, NFT state 0x01)
//   output[3]: user's staking receipt NFT (value = 1000 sats, commitment = nextEpoch + addedTokenAmount)
//   output[4]: PUSD change OR no-token output (optional)
//   output[5]: BCH change (optional, no tokens)
//
// 5 inputs (per the contract comment):
//   input[0]: StabilityPool UTXO (carries minting NFT, category = poolTokenId + 0x02)
//   input[1]: StabilityPoolSidecar UTXO (PUSD-bearing)
//   input[2]: AddLiquidity function contract UTXO (the active input)
//   input[3]: user's PUSD UTXO (≥ 100.00 PUSD = 10000 base units)
//   input[4]: user's BCH UTXO (for fees + AddLiquidity's 1000-sat value)
//
// Sighash: input 0/1/3/4 use 0x41 P2PKH (compiler path); input 2 uses 0x61 covenant manual path.
//
// Until we have funded covenant UTXOs to test with, this module builds the tx shape but
// cannot broadcast. Used by scripts/stake.mjs and as a reference for the bot's Phase 3 work.

import { hexToBin } from './hex.mjs'

// Deployed contract addresses (from ParyonUSD/verify_contract_deployment/config.ts mainnet-v1)
// categoryId for the PUSD FT (token prefix when constructing source outputs)
export const PUSD_CATEGORY_ID = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
// categoryId for the Stability Pool mutable NFT (input[0])
export const POOL_CATEGORY_ID = '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81';
// Minimum stake: 100.00 PUSD = 10000 base units (PUSD has 2 decimals)
export const MIN_STAKE_BASE_UNITS = 10000n;

// Contract artifacts (from @paryonusd/contracts v1.0.0 on npm).
//
// These were previously five truncations and one fabricated string. Four were
// "4bb467b6..."-style placeholders that matched nothing, and StabilityPool held
// 'e2136acf6f1cbb1a0fce6b1bece6b1bece6b1bece' -- a made-up tail that looked
// like a real hash, which is the most dangerous shape a constant like this can
// take: a fingerprint check that always passes, or always fails depending on
// how it is compared. All six below were read out of the published package's
// artifacts, not recalled.
export const ARTIFACT_FINGERPRINTS = {
  AddLiquidity: 'f46099a7e734f5f0ec466ae997296e8ade8be45426394adda6bf61977fe478fa',
  StabilityPool: 'e2136acf16013e341012ea1fb48cbb59972c2d0f8db6d9bf3c15f079be2607f3',
  StabilityPoolSidecar: '4bb467b6b82a9fb063eaa951abff7e03075c5ad3cb0f47fa83b5848a4ac6c1fd',
  WithdrawFromPool: 'dfecf8b4e84a528682aee6d600101ac47d15b169d4e7d7ced51eab724cbeda4a',
  Payout: '26e6cf01b4ca42263b287a42d776e1bd458400b89b95abfd61514a38d1ca38bb',
  NewPeriodPool: '2b7045d451c246f5e256f5acf1cbe234cab447deb2c37874666fb68f4e19ded0',
};

/** True when `candidate` is one of the known contract fingerprints. */
export function isKnownArtifactFingerprint(candidate) {
  if (typeof candidate !== 'string') return false;
  return Object.values(ARTIFACT_FINGERPRINTS).includes(candidate.toLowerCase());
}

/**
 * Assert a contract fingerprint is one we recognise.
 *
 * Fails closed on an unknown value. A fingerprint is a contract-identity check,
 * so "we have never heard of this contract" must not be treated as "fine" --
 * that is precisely the case where a substituted contract would slip through.
 */
export function assertKnownArtifactFingerprint(candidate, label = 'contract') {
  if (!isKnownArtifactFingerprint(candidate)) {
    throw new Error(
      `unrecognised ${label} fingerprint ${String(candidate)}; refusing to proceed against a ` +
      `contract we cannot identify. Known: ${Object.entries(ARTIFACT_FINGERPRINTS).map(([k, v]) => `${k}=${v}`).join(', ')}`
    );
  }
  return true;
}

// Per AddLiquidity.cash: minimumToStake = 100_00 (= 10000 base units = 100.00 PUSD)
export function validateStakeAmount(amountBaseUnits) {
  if (amountBaseUnits < MIN_STAKE_BASE_UNITS) {
    throw new Error(`stake amount ${amountBaseUnits} below minimum ${MIN_STAKE_BASE_UNITS} (100.00 PUSD)`);
  }
}

/**
 * Parse the current epoch from the StabilityPool NFT commitment.
 *
 * Per AddLiquidity.cash:
 *   bytes4 periodPoolBytes = tx.inputs[0].nftCommitment.split(4)[0];
 *   int currentEpoch = int(periodPoolBytes) / 10;
 *   int nextEpoch = currentEpoch + 1;
 *
 * The commitment's first 4 bytes = current period (0-indexed). Each epoch = 10 periods.
 * @param {string} commitmentHex - hex string of the NFT commitment
 * @returns {bigint} next epoch (current + 1)
 */
export function parseNextEpoch(commitmentHex) {
  if (!commitmentHex || commitmentHex.length < 8) {
    throw new Error(`commitment too short: ${commitmentHex}`);
  }
  const first4 = commitmentHex.slice(0, 8);
  const period = parseInt(first4, 16);
  // BigInt division for safety (periods can be > 2^31 if the chain is long-lived)
  const currentEpoch = BigInt(period) / 10n;
  return currentEpoch + 1n;
}

/**
 * Build the receipt NFT commitment for output[3].
 * Per AddLiquidity.cash:
 *   bytes newReceipt = toPaddedBytes(nextEpoch, 4) + bytes(addedTokenAmount);
 *
 * @param {bigint} nextEpoch
 * @param {bigint} addedTokenAmount
 * @returns {string} hex string of the commitment
 */
export function buildReceiptCommitment(nextEpoch, addedTokenAmount) {
  // toPaddedBytes(value, 4) = 4 bytes BE (big-endian, padded to 4 bytes)
  // Per CashScript: bytes(int) for int values is minimal BE (NOT LE, NOT 4-byte padded)
  //   so bytes(10000) = 0x2710 (2 bytes, minimal BE)
  const epoch4BE = nextEpoch.toString(16).padStart(8, '0'); // 4 bytes BE
  const amountBE = addedTokenAmount.toString(16);           // minimal BE
  // Remove leading zeros from amount that fit in epoch4BE byte positions
  return epoch4BE + amountBE;
}

/**
 * Build the PUSD stake transaction structure (inputs + outputs + signing plan).
 * Returns an object the caller can use to assemble and sign the tx.
 *
 * @param {object} args
 * @param {object} args.stabilityPoolInput - {tx_hash, tx_pos, value, nft_commitment}
 * @param {object} args.sidecarInput - {tx_hash, tx_pos, value, token_amount}
 * @param {object} args.addLiquidityInput - {tx_hash, tx_pos, value, nft_commitment}
 * @param {object} args.userPusdInput - {tx_hash, tx_pos, value, token_amount}
 * @param {object} args.userBchInput - {tx_hash, tx_pos, value}
 * @param {bigint} args.stakeAmount - amount of PUSD to stake (in base units, e.g. 10000n for 100.00 PUSD)
 * @param {object} args.poolContract - { address, bytecode } — StabilityPool P2SH
 * @param {object} args.sidecarContract - { address, bytecode } — StabilityPoolSidecar P2SH
 * @param {object} args.addLiquidityContract - { address, bytecode } — AddLiquidity function contract
 * @param {object} args.userAddress - { address } — recipient of the receipt NFT + change
 * @returns {object} tx-structure
 */
export function buildStakeTransaction({
  stabilityPoolInput,
  sidecarInput,
  addLiquidityInput,
  userPusdInput,
  userBchInput,
  stakeAmount,
  poolContract,
  sidecarContract,
  addLiquidityContract,
  userAddress,
}) {
  validateStakeAmount(stakeAmount);

  // Parse current epoch from pool's NFT commitment
  const nextEpoch = parseNextEpoch(stabilityPoolInput.nft_commitment);

  // Compute added amount (what we're depositing vs what's already in sidecar)
  const sidecarBefore = BigInt(sidecarInput.token_amount);
  const sidecarAfter = sidecarBefore + stakeAmount;

  // Build outputs
  const outputs = [
    // 0: StabilityPool recreated
    {
      lockingBytecode: poolContract.bytecode,
      valueSatoshis: BigInt(stabilityPoolInput.value),
      token: { category: hexToBin(POOL_CATEGORY_ID), amount: 0n, nft: { capability: 'minting', commitment: hexToBin(stabilityPoolInput.nft_commitment) } },
    },
    // 1: StabilityPoolSidecar with added amount
    {
      lockingBytecode: sidecarContract.bytecode,
      valueSatoshis: BigInt(sidecarInput.value),  // usually 0
      token: { category: hexToBin(PUSD_CATEGORY_ID), amount: sidecarAfter },
    },
    // 2: AddLiquidity function contract recreated (value 1000, NFT commitment unchanged)
    {
      lockingBytecode: addLiquidityContract.bytecode,
      valueSatoshis: 1000n,
      token: { category: hexToBin(POOL_CATEGORY_ID), amount: 0n, nft: { capability: 'none', commitment: hexToBin(addLiquidityInput.nft_commitment) } },
    },
    // 3: user's receipt NFT
    {
      lockingBytecode: undefined,  // set by signer from userAddress
      address: userAddress.address,
      valueSatoshis: 1000n,
      token: {
        category: hexToBin(POOL_CATEGORY_ID),
        amount: 0n,
        nft: { capability: 'minting', commitment: hexToBin(buildReceiptCommitment(nextEpoch, stakeAmount)) },
      },
    },
  ];

  return {
    description: 'PUSD Stability Pool stake',
    nextEpoch,
    receiptCommitment: buildReceiptCommitment(nextEpoch, stakeAmount),
    inputs: [
      { ...stabilityPoolInput, role: 'pool',     sighashType: 0x41, derivationHint: 'pool' },
      { ...sidecarInput,        role: 'sidecar', sighashType: 0x41, derivationHint: 'sidecar' },
      { ...addLiquidityInput,   role: 'fn-contract', sighashType: 0x61, derivationHint: 'add-liquidity' },  // covenant
      { ...userPusdInput,       role: 'user-pusd',  sighashType: 0x41, derivationHint: 'user' },
      { ...userBchInput,        role: 'user-bch',   sighashType: 0x41, derivationHint: 'user' },
    ],
    outputs,
  };
}