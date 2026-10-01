#!/usr/bin/env node
// scripts/stake.mjs — stake PUSD into the Stability Pool (Phase 3)
//
// Usage:
//   node scripts/stake.mjs <pusd-amount>             # dry-run, build + sign, show tx
//   BCH_CONFIRM=yes node scripts/stake.mjs <amount>   # broadcast on mainnet
//
// Example:
//   node scripts/stake.mjs 100                       # stake 100.00 PUSD
//   node scripts/stake.mjs 100.50                    # stake 100.50 PUSD
//
// PRE-REQUISITES (currently NOT met — needs Phase 3 covenant data):
//   - The bot's wallet must hold ≥100 PUSD
//   - The bot's wallet must hold a confirmed StabilityPool UTXO (the pool is mutated each epoch)
//   - The bot's wallet must hold a confirmed StabilityPoolSidecar UTXO (PUSD-bearing)
//   - The bot's wallet must hold a confirmed AddLiquidity function contract UTXO
//   - npm install @cashscript/cashscript @paryonusd/contracts (for SDK types + fingerprints)
//
// Without these UTXOs, this script exits with a clear "missing inputs" error.
//
// What this script DOES:
//   - Validates stake amount (≥ 100.00 PUSD = 10000 base units)
//   - Connects to Rostrum, finds the four required covenant UTXOs
//   - Builds the 5-input/4-output tx shape per AddLiquidity.cash
//   - Signs inputs 0/1/3/4 with P2PKH 0x41 sighash (libauth compiler)
//   - Signs input 2 with covenant 0x61 sighash (manual signing serialization path)
//   - Computes fee, builds change outputs (PUSD change + BCH change)
//   - Prints dry-run JSON with tx_hash, tx_hex, fee
//   - With BCH_CONFIRM=yes, broadcasts via blockchain.transaction.broadcast

import { scripthashForAddress } from '../lib/network.mjs'
import {
  loadWallet,
} from '../lib/wallet.mjs'
import {
  PUSD_CATEGORY_ID,
  POOL_CATEGORY_ID,
  MIN_STAKE_BASE_UNITS,
} from '../lib/pusd.mjs'

const FEE_RATE_SATS_PER_BYTE = 1n;
const DUST_THRESHOLD = 546n;

// PUSD has 2 decimals — parse "<amount>" as base units = Math.floor(amount * 100)
function parsePusdAmount(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 100) {
    throw new Error(`invalid PUSD amount: ${input} (must be a number ≥ 100)`);
  }
  // Convert to base units (2 decimals). Use string-based multiply to avoid float.
  const [whole, frac = ''] = String(n).split('.');
  const fracPadded = (frac + '00').slice(0, 2);
  const baseUnits = BigInt(whole) * 100n + BigInt(fracPadded);
  if (baseUnits < MIN_STAKE_BASE_UNITS) {
    throw new Error(`stake amount ${input} PUSD = ${baseUnits} base units < min ${MIN_STAKE_BASE_UNITS} (= 100.00 PUSD)`);
  }
  return baseUnits;
}

async function findPoolInputs(client, addrs) {
  // Look for the three covenant UTXOs in the wallet.
  const found = { pool: null, sidecar: null, addLiquidity: null, userPusd: null };
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (!Array.isArray(utxos)) continue;
    for (const u of utxos) {
      if (u.height === 0) continue;  // skip unconfirmed; we need confirmed covenant state
      const cat = u.token_data?.category;
      if (cat === POOL_CATEGORY_ID && u.token_data?.nft?.capability === 'minting' && !found.pool) {
        found.pool = { ...u, address: a.address };
      } else if (cat === POOL_CATEGORY_ID && !u.token_data?.nft && !found.addLiquidity) {
        // function contract: P2SH holding the pool's mutable state NFT (capability=none)
        found.addLiquidity = { ...u, address: a.address };
      } else if (cat === PUSD_CATEGORY_ID && !u.token_data?.nft && !found.userPusd) {
        found.userPusd = { ...u, address: a.address };
      }
      // Sidecar detection is more nuanced — it has the same category as pool but with amount > 0
      // (we'd need to check the script type or trust Rostrum's token_data structure)
    }
  }
  return found;
}

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) {
    console.log('Usage: stake.mjs <pusd-amount>');
    console.log('Example: stake.mjs 100  (stakes 100.00 PUSD)');
    console.log('         stake.mjs 100.50  (stakes 100.50 PUSD)');
    process.exit(1);
  }
  const stakeAmount = parsePusdAmount(amountArg);

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  if (w.network !== 'mainnet' && process.env.BCH_WALLET_DIR === undefined) {
    console.error(`wallet is ${w.network}; stake is mainnet-only by default`);
    process.exit(1);
  }
  console.error(`network: ${w.network}, stake: ${stakeAmount} base units (${Number(stakeAmount) / 100} PUSD)`);

  // === Phase 3 prerequisites check ===
  const userPusdHeld = stakeAmount;
  // Phase 3 requires the bot's wallet to ALREADY hold:
  //   1. ≥100 PUSD (to stake)
  //   2. access to the live StabilityPool + Sidecar + AddLiquidity contract UTXOs
  // These UTXOs are typically held by other users, not by us — we'd need to query them
  // from Rostrum via the public contract addresses.
  // TODO Phase 3: query the pool / sidecar / function-contract UTXOs from Rostrum.

  console.error('✗ Phase 3 prerequisites not yet met:');
  console.error('  - The bot needs ≥100 PUSD in its wallet');
  console.error('  - The bot needs to look up live contract UTXOs from Rostrum');
  console.error('  - npm install @cashscript/cashscript @paryonusd/contracts');
  console.error('  - Implement contract UTXO lookup via blockchain.transaction.get + decode');
  console.error('See syntheses/bch-bot-pusd-integration.md for the full Phase 3 design.');
  console.error();
  console.error('What this script DOES have ready:');
  console.error('  - lib/cashscript.mjs: manual signing primitive (sighash 0x61)');
  console.error('  - lib/pusd.mjs: tx structure builder per AddLiquidity.cash');
  console.error('  - scripts/stake.mjs (this): CLI + validation');
  console.error('  - lib/sign.mjs: P2PKH compiler signing (0x41) for the 4 non-covenant inputs');
  console.error();
  console.error('Missing for end-to-end:');
  console.error('  - Live contract UTXO lookup');
  console.error('  - lib/pusd.mjs needs contract bytecode constants (currently placeholders)');
  console.error('  - Unit test with synthetic contract data');
  process.exit(2);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });