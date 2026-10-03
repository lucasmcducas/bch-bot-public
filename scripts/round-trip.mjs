#!/usr/bin/env node
// scripts/round-trip.mjs — dedicated 1000-sat mainnet smoke test
//
// One-shot script that exercises the entire bot pipeline:
//   1. Verify the wallet has a confirmed UTXO large enough to cover 1000 + fee + dust
//   2. Pick the largest confirmed UTXO as the sole input
//   3. Build outputs: [recipient(1000), change(remainder - fee)]
//   4. Sign with libauth's compiler (Schnorr P2PKH)
//   5. Show the dry-run JSON for review
//   6. With BCH_CONFIRM=yes, broadcast via blockchain.transaction.broadcast
//   7. Verify the tx appears at cashnode.bch.ninja
//
// Difference from send.mjs:
//   - Hardcodes the 1000-sat round-trip amount (no arg parsing)
//   - Logs every step explicitly (good for first-time debugging)
//   - Waits for confirmation before returning (so we know it actually mined)
//
// Run: BCH_CONFIRM=yes node scripts/round-trip.mjs

import { connect, scripthashForAddress, listUnspent,
} from '../lib/network.mjs';
import {
  loadWallet,
  loadHdNode,
  resolveAddressPath,
  newChangeAddress,
  commitChangeAddress,
  deriveReceivingAddresses,
  deriveChangeAddresses,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';

const ROUND_TRIP_AMOUNT_SATS = 1000n;
const FEE_RATE_SATS_PER_BYTE = 1.0;
const DUST_THRESHOLD = 546n;

async function main() {
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  if (w.network !== 'mainnet' && process.env.BCH_WALLET_DIR === undefined) {
    // Safety: refuse to round-trip unless explicitly pointed at a non-default wallet dir.
    // Override via BCH_WALLET_DIR to run against chipnet/testnet/dev wallets.
    console.error(`wallet is ${w.network}, expected mainnet`);
    console.error(`(override BCH_WALLET_DIR to run against a ${w.network} wallet)`);
    process.exit(1);
  }
  if (w.network !== 'mainnet') {
    console.warn(`!! running round-trip against ${w.network} (override via BCH_WALLET_DIR=${process.env.BCH_WALLET_DIR})`);
  }
  const { hdNode } = loadHdNode();

  console.log(`[1/6] connecting to ${w.network} Rostrum...`);
  const client = await connect(w.network);

  try {
    // Step 1: gather confirmed UTXOs from receiving chain
    console.log(`[2/6] scanning first 20 receiving addresses for UTXOs...`);
    // Scan BOTH chains. Change addresses hold real money -- this wallet's own
  // `send` writes change there -- so a receiving-only scan understates
  // spendable funds and can report "insufficient funds" with a large balance
  // sitting unused. Tag each entry with its chain so callers can still tell
  // them apart.
  const addrs = [
    ...deriveReceivingAddresses(20).map((a) => ({ ...a, chain: 'recv' })),
    ...deriveChangeAddresses(20).map((a) => ({ ...a, chain: 'change' })),
  ];
    const allUtxos = [];
    for (const a of addrs) {
      const sh = scripthashForAddress(a.address);
      const utxos = await listUnspent(client, sh);
      if (Array.isArray(utxos)) {
        for (const u of utxos) allUtxos.push({ address: a.address, ...u });
      }
    }
    console.log(`   found ${allUtxos.length} UTXO(s)`);
    if (allUtxos.length === 0) {
      console.error('   ✗ no UTXOs. fund the wallet first.');
      process.exit(1);
    }

    // Step 2: pick the largest confirmed UTXO. Skip unconfirmed for safety on mainnet.
    const confirmed = allUtxos.filter((u) => u.height > 0);
    console.log(`   ${confirmed.length} confirmed, ${allUtxos.length - confirmed.length} unconfirmed`);
    if (confirmed.length === 0) {
      const allow0conf = process.env.BCH_ALLOW_UNCONFIRMED === 'yes';
      if (!allow0conf) {
        console.error('   ✗ no confirmed UTXOs. wait for one block confirmation (~10 min) before round-tripping.');
        console.error('   to override (BCH Avalanche pre-consensus usually makes 0-conf safe for small amounts):');
        console.error('     BCH_ALLOW_UNCONFIRMED=yes BCH_CONFIRM=yes node scripts/round-trip.mjs');
        process.exit(1);
      }
      console.warn(`   ⚠ no confirmed UTXOs; BCH_ALLOW_UNCONFIRMED=yes is set. spending the unconfirmed UTXO (0-conf risk).`);
      // Fall through and use the unconfirmed UTXOs below.
      allUtxos.sort((a, b) => b.value - a.value);
      const fallback = allUtxos[0];
      confirmed.push(fallback);
    }
    confirmed.sort((a, b) => b.value - a.value);
    const input = confirmed[0];
    console.log(`   using UTXO: ${input.tx_hash}:${input.tx_pos} (${input.value} sats, block ${input.height})`);

    // Step 3: build outputs
    const estSize = 10 + 1 * 200 + 2 * 34; // 1 input, 2 outputs (recipient + change)
    const estFee = BigInt(Math.ceil(estSize * FEE_RATE_SATS_PER_BYTE));
    const totalIn = BigInt(input.value);
    const change = totalIn - ROUND_TRIP_AMOUNT_SATS - estFee;

    const recipientAddr = deriveReceivingAddresses(1)[0].address; // re-use index 0 just for show
    const outputs = [{ address: recipientAddr, valueSatoshis: ROUND_TRIP_AMOUNT_SATS }];

    if (change >= DUST_THRESHOLD) {
      const changeReservation = newChangeAddress(false);
      const changeAddr = changeReservation.address;
      outputs.push({ address: changeAddr.address, valueSatoshis: change });
      console.log(`[3/6] recipient=${recipientAddr} (1000 sats)`);
      console.log(`       change  =${changeAddr.address} (${change} sats, change chain idx ${changeAddr.index})`);
    } else {
      console.log(`[3/6] recipient=${recipientAddr} (1000 sats), change absorbed into fee`);
    }
    console.log(`       fee     =~${estFee} sats (${estSize} bytes * ${FEE_RATE_SATS_PER_BYTE} sat/byte)`);

    // Step 4: sign. findIndex would return -1 for an address outside the scan
    // window, and a -1 index is a silently wrong derivation path, so resolve the
    // address against both chains and fail if it is not ours.
    const inputForSigning = {
      ...input,
      hdNode,
      account: 0,
      ...resolveAddressPath(input.address, { window: 20, label: 'round-trip input' }),
    };
    console.log(`[4/6] signing with libauth compiler (Schnorr P2PKH)...`);
    const signed = await signP2pkhTransaction({ inputs: [inputForSigning], outputs });
    console.log(`       txid=${signed.tx_hash}`);
    console.log(`       fee =${signed.fee} sats (actual)`);
    console.log(`       tx (${signed.tx_hex.length / 2} bytes hex):`);
    console.log(`         ${signed.tx_hex.slice(0, 80)}...`);

    // Step 5: dry-run gate
    if (process.env.BCH_CONFIRM !== 'yes') {
      console.log();
      console.log(`[5/6] DRY RUN. set BCH_CONFIRM=yes to broadcast.`);
      console.log(`[6/6] skipped (dry run)`);
      console.log();
      console.log('full dry-run JSON:');
      console.log(JSON.stringify({ tx_hash: signed.tx_hash, tx_hex: signed.tx_hex, fee: signed.fee.toString() }, null, 2));
      return;
    }

    // Step 5b: broadcast
    console.log(`[5/6] BCH_CONFIRM=yes — broadcasting...`);
    const result = await client.request('blockchain.transaction.broadcast', signed.tx_hex);
    if (typeof result === 'string' && result.startsWith('Error')) {
      throw new Error(`broadcast rejected: ${result}`);
    }
    // `{}` is a node's non-answer, not a success -- the same shape a
    // protocol-version mismatch produces. Requiring the txid is what stops a
    // rejected broadcast from being printed as "(empty -- tx accepted)".
    const acceptedTxid = assertBroadcastAccepted(result, signed.tx_hash);
    console.log(`       broadcast response: ${acceptedTxid}`);

    // Confirmed by the node, so the change address is committed. Before this the
    // increment happened at derivation, so a rejected round-trip still burned
    // the address.
    commitChangeAddress(changeReservation.index);

    // Step 6: poll for first confirmation
    console.log(`[6/6] waiting for first confirmation (target ~10 min)...`);
    const txid = signed.tx_hash;
    let conf = 0;
    let elapsed = 0;
    const pollStart = Date.now();
    while (conf === 0) {
      elapsed = Math.floor((Date.now() - pollStart) / 1000);
      const tx = await client.request('blockchain.transaction.get', txid);
      if (tx && typeof tx === 'string') {
        // We can also check the recipient scripthash history to confirm it saw the tx
        const sh = scripthashForAddress(recipientAddr);
        const hist = await client.request('blockchain.scripthash.get_history', sh);
        const found = hist.find((h) => h.tx_hash === txid);
        if (found && found.height > 0) {
          conf = 1;
          console.log(`       ✓ confirmed at block ${found.height} after ${elapsed}s`);
          break;
        }
      }
      if (elapsed > 1800) {
        console.error(`       ⚠ not confirmed after 30 min. txid=${txid}`);
        console.error('       check https://bchexplorer.cash/tx/' + txid);
        process.exit(2);
      }
      if (elapsed % 60 < 5) {
        console.log(`       ...polling (${elapsed}s elapsed)`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    console.log();
    console.log('=== ROUND-TRIP COMPLETE ===');
    console.log(JSON.stringify({
      txid: signed.tx_hash,
      from: input.address,
      to: recipientAddr,
      amount_sats: ROUND_TRIP_AMOUNT_SATS.toString(),
      fee_sats: signed.fee.toString(),
      confirmations: conf,
      elapsed_seconds: elapsed,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); console.error(e.stack); process.exit(1); });