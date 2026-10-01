#!/usr/bin/env node
// scripts/sweep.mjs — consolidate dust + small UTXOs into one to save on future fees
//
// Usage:
//   node scripts/sweep.mjs                       # dry-run: show what would be swept
//   BCH_CONFIRM=yes node scripts/sweep.mjs       # actually broadcast
//
// Strategy:
//   - Scan all wallet addresses (receiving + change chains)
//   - For each UTXO below SWEEP_THRESHOLD_SATS, mark as candidate
//   - Build a single tx that spends all candidates, pays 1 sat/byte, sends to a fresh change addr
//   - Skip dust that would cost more in fees than it saves (the "sweep threshold" floor)
//
// Safety:
//   - NEVER sweeps UTXOs that hold tokens: spending the UTXO consumes the token
//     with it. Skipped token UTXOs are reported, and need send-token instead.

import { connect, scripthashForAddress } from '../lib/network.mjs';
import {
  loadWallet,
  loadHdNode,
  deriveReceivingAddresses,
  deriveChangeAddresses,
  newChangeAddress,
  resolveAddressPath,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';

const SWEEP_THRESHOLD_SATS = 5000n;     // sweep any UTXO below this
const MIN_REMAINING_AFTER_FEE_SATS = 500n;  // refuse to sweep if it'd leave < 500 sats
const FEE_RATE_SATS_PER_BYTE = 1n;        // conservative; mainnet often 1-2 sats/byte

async function gatherAllUtxos(client) {
  const all = [];
  for (const a of deriveReceivingAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) all.push({ address: a.address, chain: 'recv', ...u });
    }
  }
  for (const a of deriveChangeAddresses(20)) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) all.push({ address: a.address, chain: 'change', ...u });
    }
  }
  return all;
}

function selectSweepCandidates(utxos) {
  // Sweep BCH-only UTXOs below threshold. NEVER sweep a token-bearing UTXO.
  //
  // This function used to include token UTXOs whose sat value was under 2000,
  // with a comment saying "Sweep if user opts in (always sweep for now)". That
  // discarded the token: spending the UTXO consumes the CashToken with it, and
  // there is no output that preserves it. It also contradicted this file's own
  // header, which promised "NEVER sweeps UTXOs that hold tokens whose value is
  // hard to assess", and contradicted the script's other comment describing the
  // threshold as roughly 5000 sats.
  //
  // A dust sweep is a fee optimisation. Destroying a token to save a few
  // hundred sats is not an optimisation, and it is not reversible, so token
  // UTXOs are excluded unconditionally. They need send-token's own flow.
  const candidates = [];
  const skippedTokens = [];
  for (const u of utxos) {
    const value = BigInt(u.value);
    if (value >= SWEEP_THRESHOLD_SATS) continue;
    if (u.token_data) { skippedTokens.push(u); continue; }
    candidates.push(u);
  }
  return { candidates, skippedTokens };
}

function deriveChangeIndex(addr, recvAddrs, changeAddrs) {
  // Look the address up; never default to index 0. Falling back there signs a
  // UTXO with the key for /0/0, which is a different key from the one the
  // address was derived from. An unresolvable address is an error.
  const recvIdx = recvAddrs.findIndex((a) => a.address === addr);
  if (recvIdx >= 0) return { account: 0, change: 0, index: recvIdx };
  const chgIdx = changeAddrs.findIndex((a) => a.address === addr);
  if (chgIdx >= 0) return { account: 0, change: 1, index: chgIdx };
  throw new Error(
    `cannot resolve the key for sweep input ${addr}: it is outside the ${recvAddrs.length}-address ` +
    `gap limit this sweep scans. Widen the scan rather than guessing an index, because a ` +
    `wrong index signs with the wrong key.`
  );
}

async function main() {
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  if (w.network !== 'mainnet' && process.env.BCH_WALLET_DIR === undefined) {
    console.error(`wallet is ${w.network}; sweep is mainnet-only by default`);
    process.exit(1);
  }
  console.error(`network: ${w.network}, sweep threshold: ${SWEEP_THRESHOLD_SATS} sat`);

  const { hdNode } = loadHdNode();
  const client = await connect(w.network);

  try {
    console.error('[1/4] scanning wallet UTXOs...');
    const allUtxos = await gatherAllUtxos(client);
    console.error(`   ${allUtxos.length} UTXO(s) total`);

    console.error('[2/4] selecting sweep candidates...');
    const { candidates, skippedTokens } = selectSweepCandidates(allUtxos);
    // Say so explicitly. A silently skipped token looks identical to a wallet
    // that has none, which is the same under-reporting failure the /7/ chain
    // has. If tokens are being skipped, the user should be told.
    if (skippedTokens.length > 0) {
      const totalTokenValue = skippedTokens.reduce((acc, u) => acc + BigInt(u.value), 0n);
      console.error(
        `   skipping ${skippedTokens.length} token-bearing UTXO(s) (${totalTokenValue} sat) -- ` +
        'sweeping them would destroy the token. use send-token to consolidate those.'
      );
    }
    if (candidates.length === 0) {
      console.error('   no candidates below threshold. nothing to sweep.');
      return;
    }
    const totalIn = candidates.reduce((acc, u) => acc + BigInt(u.value), 0n);
    console.error(`   ${candidates.length} candidate(s), total ${totalIn} sat`);

    // Estimate fee (worst case: 10 + N*200 + 1*34 bytes for 1 output)
    const estSize = 10n + BigInt(candidates.length) * 200n + 34n;
    const estFee = estSize * FEE_RATE_SATS_PER_BYTE;
    console.error(`   estimated fee: ${estFee} sat (${estSize} bytes)`);

    if (totalIn < estFee + MIN_REMAINING_AFTER_FEE_SATS) {
      console.error(`   ✗ total in (${totalIn}) < fee (${estFee}) + min-remaining (${MIN_REMAINING_AFTER_FEE_SATS})`);
      console.error('   sweeping would create or worsen a dust problem. abort.');
      process.exit(1);
    }
    const expectedChange = totalIn - estFee;
    console.error(`   expected change output: ${expectedChange} sat`);

    // Build the change address (fresh)
    const changeAddr = newChangeAddress();
    console.error('[3/4] building + signing sweep tx...');

    // Map candidates to signing inputs (need hdNode + derivation path)
    const recvAddrs = deriveReceivingAddresses(20);
    const changeAddrs = deriveChangeAddresses(20);
    const inputs = candidates.map((u) => {
      const path = deriveChangeIndex(u.address, recvAddrs, changeAddrs);
      return {
        ...u,
        hdNode,
        account: path.account,
        change: path.change,
        index: path.index,
      };
    });

    const outputs = [{ address: changeAddr.address, valueSatoshis: expectedChange }];

    const signed = await signP2pkhTransaction({ inputs, outputs });
    console.error(`   txid=${signed.tx_hash}`);
    console.error(`   fee=${signed.fee} sat (actual)`);
    console.error(`   change: ${expectedChange} sat -> ${changeAddr.address}`);

    if (process.env.BCH_CONFIRM !== 'yes') {
      console.error('[4/4] DRY RUN. set BCH_CONFIRM=yes to broadcast.');
      console.error(`   https://bchexplorer.cash/tx/${signed.tx_hash}`);
      console.log(JSON.stringify({
        tx_hash: signed.tx_hash,
        tx_hex: signed.tx_hex,
        fee: signed.fee.toString(),
        swept_utxos: candidates.length,
        swept_total: totalIn.toString(),
        change: expectedChange.toString(),
        dry_run: true,
      }, null, 2));
      return;
    }

    console.error('[4/4] BCH_CONFIRM=yes — broadcasting...');
    const result = await client.request('blockchain.transaction.broadcast', signed.tx_hex);
    if (typeof result === 'string' && result.startsWith('Error')) {
      throw new Error(`broadcast rejected: ${result}`);
    }
    console.error(`   broadcast response: ${result || '(empty — tx accepted)'}`);
    console.log(JSON.stringify({
      tx_hash: signed.tx_hash,
      broadcast: true,
      server_response: result,
      swept_utxos: candidates.length,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });