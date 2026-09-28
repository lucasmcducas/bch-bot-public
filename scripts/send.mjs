#!/usr/bin/env node
// scripts/send.mjs — build, sign, and broadcast a BCH transaction
//
// Usage: node scripts/send.mjs <recipient_address> <sats>
//        node scripts/send.mjs <recipient_address> <sats> --fee-rate 1.0
//
// SAFETY: broadcasts a real transaction on mainnet if wallet is mainnet.
//   Set BCH_CONFIRM=yes env var to actually broadcast (moth convention).

import { connect, scripthashForAddress } from '../lib/network.mjs';
import { loadWallet, loadHdNode, deriveReceivingAddresses, newChangeAddress, deriveChangeAddresses } from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import { binToHex } from '../lib/hex.mjs';
import { computeTreasuryFee, withTreasuryFee, formatFeeLine } from '../lib/fee.mjs';

const FEE_RATE_SATS_PER_BYTE = 1.0; // conservative; mainnet often 1.0–2.0
const DUST_THRESHOLD = 546n;

async function findUtxosForAmount(client, wallet, hdNode, targetSats) {
  // Derive first 20 receiving addresses, collect UTXOs, sum, return best-fit subset
  const addrs = deriveReceivingAddresses(20);
  const candidates = [];
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) {
        candidates.push({
          address: a.address,
          tx_hash: u.tx_hash,
          tx_pos: u.tx_pos,
          valueSatoshis: u.value,
          // Phase 1: BCH-only inputs (filter out token-bearing UTXOs)
          has_token: !!u.token_data,
        });
      }
    }
  }
  // Largest-first selection
  const bchOnly = candidates.filter((c) => !c.has_token).sort((a, b) => Number(b.valueSatoshis - a.valueSatoshis));
  const selected = [];
  let total = 0n;
  for (const u of bchOnly) {
    selected.push(u);
    total += BigInt(u.valueSatoshis);
    if (total >= BigInt(targetSats) + 10000n) break; // buffer for fee
  }
  if (total < BigInt(targetSats) + 1000n) {
    throw new Error(`insufficient funds: have ${total} sats, need ${targetSats} + fee`);
  }
  return { selected, total };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: send.mjs <recipient_address> <sats>`);
    console.log(`Set BCH_CONFIRM=yes to actually broadcast (dry-run otherwise).`);
    console.log();
    console.log(`Treasury fee: 0.5% of transfer amount (set BCH_TREASURY_BPS=0 to disable)`);
    process.exit(args.length < 2 ? 1 : 0);
  }
  const [recipient, satsArg] = args;
  const targetSats = BigInt(satsArg);

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const { hdNode } = loadHdNode();
  console.error(`network: ${w.network}`);

  const client = await connect(w.network);
  try {
    // 1. Find UTXOs
    const { selected, total } = await findUtxosForAmount(client, w, hdNode, targetSats);
    console.error(`selected ${selected.length} UTXO(s), total ${total} sats`);

    // 2. Build outputs (recipient + change)
    // Compute treasury fee FIRST so we can size the tx and change correctly.
    const treasuryFee = computeTreasuryFee(targetSats);
    console.error(formatFeeLine(treasuryFee));

    const outputs = [{ address: recipient, valueSatoshis: targetSats }];
    if (treasuryFee && !treasuryFee.skipped) {
      outputs.push({ address: treasuryFee.address, valueSatoshis: treasuryFee.valueSatoshis });
    }

    // Estimate fee: per-byte * approximate tx size (P2PKH tx ~200 bytes per input + 34 per output + 10 overhead)
    const estSize = 10 + selected.length * 200 + outputs.length * 34 + 34; // +34 for change
    const estFee = BigInt(Math.ceil(estSize * FEE_RATE_SATS_PER_BYTE));
    const change = total - targetSats - (treasuryFee && !treasuryFee.skipped ? treasuryFee.valueSatoshis : 0n) - estFee;

    if (change >= DUST_THRESHOLD) {
      // Use a fresh change address from m/44'/145'/0'/1/i (the change chain).
        const changeAddr = newChangeAddress();
        outputs.push({ address: changeAddr.address, valueSatoshis: change });
        console.error(`change: ${change} sats -> ${changeAddr.address} (change chain index ${changeAddr.index})`);
      } else {
        console.error(`change ${change} sats below dust; absorbed into fee`);
      }

    // 3. Map UTXOs to signing inputs (each needs hdNode + derivation path)
    // For Phase 1 simplicity, derive all inputs from the same change=0 chain
    const inputsForSigning = selected.map((u) => {
      // Find the index by searching the derived addresses
      const addrs = deriveReceivingAddresses(20);
      const idx = addrs.findIndex((a) => a.address === u.address);
      return {
        ...u,
        hdNode,
        account: w.account || 0,
        change: 0,
        index: idx >= 0 ? idx : 0,
      };
    });

    // 4. Sign
    const { tx_hex, tx_hash, fee } = await signP2pkhTransaction({
      inputs: inputsForSigning,
      outputs,
    });
    console.error(`signed tx ${tx_hash} (fee ${fee} sats)`);

    // 5. Broadcast (gated by BCH_CONFIRM)
    const willBroadcast = process.env.BCH_CONFIRM === 'yes';
    const outJson = {
      tx_hash,
      tx_hex,
      fee: fee.toString(),
      dry_run: !willBroadcast,
      treasury_fee: treasuryFee && !treasuryFee.skipped
        ? { address: treasuryFee.address, valueSatoshis: treasuryFee.valueSatoshis.toString(), bps: treasuryFee.bps }
        : null,
    };
    if (!willBroadcast) {
      console.error('DRY RUN — set BCH_CONFIRM=yes to broadcast');
      console.log(JSON.stringify(outJson, null, 2));
      return;
    }

    const result = await client.request('blockchain.transaction.broadcast', tx_hex);
    if (typeof result === 'string' && result.startsWith('Error')) {
      throw new Error(`broadcast failed: ${result}`);
    }
    console.log(JSON.stringify({ ...outJson, broadcast: true, server_response: result }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });