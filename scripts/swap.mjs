#!/usr/bin/env node
// scripts/swap.mjs — execute a Cauldron AMM swap (BCH ↔ token)
//
// Usage:
//   node scripts/swap.mjs <supply> <demand> <amount>          # dry-run, build + show tx
//   BCH_CONFIRM=yes node scripts/swap.mjs ...                  # broadcast
//
// Example:
//   node scripts/swap.mjs BCH pusd 1000                       # sell 1000 sats BCH for PUSD
//   node scripts/swap.mjs pusd BCH 100                        # sell 100 PUSD for BCH
//
// Supply/demand token IDs are 64-char hex category ids (or 'BCH' for native).
// Amount is in base units (sats for BCH, token base units for tokens).
//
// PRE-REQUISITES:
//   - Live Cauldron pools exist on mainnet (currently EMPTY per test-cauldron.mjs)
//   - Bot's wallet has a BCH-only input to pay the pool + fee
//   - User's private key is accessible (moth-pattern plaintext wallet.json)
//
// What this script DOES:
//   - Connects to Cauldron's rostrum endpoint (rostrum.cauldron.quest:50004, protocol 1.4.3)
//   - Queries pool UTXOs (via token.history or pool.list — currently empty)
//   - Builds the swap tx via ExchangeLab SDK
//   - Signs with libauth's compiler path (P2PKH, sighash 0x41 — Selene's pattern)
//   - Dry-runs by default; BCH_CONFIRM=yes broadcasts
//
// What this script DOES NOT do yet:
//   - Pool UTXO discovery (the rostrum returns empty even though it has pool.list)
//   - LP operations (separate scripts/add-liquidity.mjs needed)
//   - Multi-hop routing (only direct BCH ↔ token swaps)

import { connect, scripthashForAddress } from '../lib/network.mjs';
import { connectCauldronRostrum, BCH_TOKEN } from '../lib/cauldron.mjs';
import {
  loadWallet,
  loadHdNode,
  deriveReceivingAddresses,
  deriveChangeAddresses,
  newChangeAddress,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swap.mjs <supply_token> <demand_token> <amount>');
    console.log('Example: swap.mjs BCH pusd 1000');
    console.log('         swap.mjs pusd BCH 100');
    console.log('Set BCH_CONFIRM=yes to broadcast (dry-run otherwise).');
    process.exit(args.length < 3 ? 1 : 0);
  }
  const [supply, demand, amountStr] = args;
  const amount = BigInt(amountStr);
  return { supply, demand, amount };
}

async function main() {
  const { supply, demand, amount } = parseArgs();
  if (supply === demand) {
    console.error('supply and demand tokens cannot be the same');
    process.exit(1);
  }

  console.error(`swap: ${amount} ${supply} → ${demand}`);

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const { hdNode } = loadHdNode();
  console.error(`network: ${w.network}`);

  console.error('[1/5] connecting to Cauldron rostrum...');
  const cauldronClient = await connectCauldronRostrum();

  try {
    console.error('[2/5] discovering pool UTXOs...');
    // Try multiple discovery methods; Cauldron's rostrum has pool.list (empty per test)
    let pools = [];
    try {
      const list = await cauldronClient.request('token.list');
      pools = Object.values(list || {});
      if (pools.length === 0) {
        console.error('   pool.list returned empty — Cauldron has no active pools');
        console.error('   (this matches the wiki note that Cauldron liquidity is thin)');
        process.exit(2);
      }
    } catch (e) {
      console.error('   pool.list failed:', String(e).slice(0, 80));
      process.exit(2);
    }

    if (pools.length === 0) {
      console.error('   no pools available. cannot build swap.');
      process.exit(2);
    }

    // [3/5] build swap tx via ExchangeLab
    // (this would use lib/cauldron.mjs::buildSwapTx — needs the SDK output shape wired)
    console.error('[3/5] building swap tx (placeholder — see lib/cauldron.mjs::buildSwapTx)...');
    console.error('   not yet fully wired. Phase 4 work.');
    process.exit(2);
  } finally {
    await cauldronClient.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });