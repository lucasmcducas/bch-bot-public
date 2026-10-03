#!/usr/bin/env node
// scripts/send.mjs — build, sign, and broadcast a BCH transaction
//
// Usage: node scripts/send.mjs <recipient_address> <sats>
//        node scripts/send.mjs <recipient_address> <sats> --fee-rate 1.0
//
// SAFETY: broadcasts a real transaction on mainnet if wallet is mainnet.
//   Set BCH_CONFIRM=yes env var to actually broadcast (moth convention).

import { connect, scripthashForAddress, listUnspent, assertBroadcastAccepted,
} from '../lib/network.mjs';
import {
  loadWallet,
  loadHdNode,
  resolveAddressPath,
  newChangeAddress,
  commitChangeAddress,
  deriveReceivingAddresses,
  scanCount,
  deriveChangeAddresses,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import { bchToBaseUnits } from '../lib/router.mjs'

const FEE_RATE_SATS_PER_BYTE = 1.0; // conservative; mainnet often 1.0–2.0
const DUST_THRESHOLD = 546n;

async function findUtxosForAmount(client, wallet, hdNode, targetSats) {
  // Derive first 20 receiving addresses, collect UTXOs, sum, return best-fit subset
  // Scan BOTH chains. Change addresses hold real money -- this wallet's own
  // `send` writes change there -- so a receiving-only scan understates
  // spendable funds and can report "insufficient funds" with a large balance
  // sitting unused. Tag each entry with its chain so callers can still tell
  // them apart.
  const addrs = [
    ...deriveReceivingAddresses(scanCount('address_index')).map((a) => ({ ...a, chain: 'recv' })),
    ...deriveChangeAddresses(scanCount('change_index')).map((a) => ({ ...a, chain: 'change' })),
  ];
  const candidates = [];
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const utxos = await listUnspent(client, sh);
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
    console.log(`Usage: send.mjs <recipient_address> <amount>`);
    console.log(`  <amount> in BCH (e.g. 0.001), or in satoshis if it is a bare integer with no decimal point.`);
    console.log(`Set BCH_CONFIRM=yes to actually broadcast (dry-run otherwise).`);
    process.exit(args.length < 2 ? 1 : 0);
  }
  const [recipient, amountArg] = args;
  // The amount is a bare integer of satoshis, or a BCH amount with a decimal
  // point. Accepting both is deliberate: a bare integer is unambiguous (there
  // is no such thing as 0.5 sats), so existing callers keep working, and a
  // decimal point can only mean BCH. It is not possible to express a
  // sub-satoshi fraction of BCH, so there is no case where a decimal-point
  // amount is ambiguous in the other direction.
  let targetSats;
  try {
    // A bare integer means satoshis, and ONLY a bare integer. `BigInt` is far
    // too permissive for an amount: it accepts 0x10 as 16, 0b101 as 5 and 1e3
    // as 1000, so `0x10` would quietly send 16 sats to an amount nobody typed.
    // Match the shape explicitly before converting.
    if (/^\d+\.\d*$/.test(amountArg)) {
      targetSats = bchToBaseUnits(amountArg);
    } else if (/^\d+$/.test(amountArg)) {
      targetSats = BigInt(amountArg);
    } else {
      throw new Error('unrecognised amount form');
    }
  } catch {
    // Report every rejection the same way, and name the limit explicitly, so a
    // user who typed 9 decimal places learns the cause instead of seeing a
    // bare "Cannot convert to a BigInt".
    console.error(
      `invalid amount: ${amountArg} -- use BCH with at most 8 decimal places (e.g. 0.001), or an integer number of satoshis`
    );
    process.exit(1);
  }
  if (targetSats <= 0n) {
    console.error(`amount must be greater than zero`);
    process.exit(1);
  }

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
    const outputs = [{ address: recipient, valueSatoshis: targetSats }];

    // Estimate fee: per-byte * approximate tx size (P2PKH tx ~200 bytes per input + 34 per output + 10 overhead)
    const estSize = 10 + selected.length * 200 + outputs.length * 34 + 34; // +34 for change
    const estFee = BigInt(Math.ceil(estSize * FEE_RATE_SATS_PER_BYTE));
    const change = total - targetSats - estFee;

    if (change >= DUST_THRESHOLD) {
      // Use a fresh change address from m/44'/145'/0'/1/i (the change chain).
        // Derive without consuming: the increment is committed only after the
        // broadcast is accepted, so a rejected run does not burn an address.
        const changeReservation = newChangeAddress(false);
        const changeAddr = changeReservation.address;
        outputs.push({ address: changeAddr.address, valueSatoshis: change });
        console.error(`change: ${change} sats -> ${changeAddr.address} (change chain index ${changeAddr.index})`);
      } else {
        console.error(`change ${change} sats below dust; absorbed into fee`);
      }

    // 3. Map UTXOs to signing inputs (each needs hdNode + derivation path)
    // Resolve each input's BIP44 path by looking the address up, never by
    // defaulting to index 0. An address outside the gap-limit window used to
    // resolve to 0, which signs with the wrong key.
    const inputsForSigning = selected.map((u) => ({
      ...u,
      hdNode,
      account: w.account || 0,
      ...resolveAddressPath(u.address, { window: 20, label: 'input UTXO' }),
    }));

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
    const acceptedTxid = assertBroadcastAccepted(result, signed.tx_hash);
    // The node confirmed the txid, so the derived change address is now real.
    commitChangeAddress(changeReservation.index);
    console.log(JSON.stringify({ ...outJson, broadcast: true, txid: acceptedTxid, server_response: result }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
