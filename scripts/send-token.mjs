#!/usr/bin/env node
// scripts/send-token.mjs — send a CashToken FT or NFT from the wallet
//
// Usage:
//   node scripts/send-token.mjs <recipient> <category_hex> <amount>          # FT
//   node scripts/send-token.mjs --nft <recipient> <category_hex> <commitment_hex>  # NFT
//   BCH_CONFIRM=yes node scripts/send-token.mjs ...                          # actually broadcast
//
// Phase 2 CashTokens wiring on top of Phase 1's libauth compiler + Rostrum.
//
// Pattern from Selene Wallet TransactionBuilderService.buildP2pkhTransaction
// (gitlab.com/selene.cash/selene-wallet) + Moth's CLI script shape.

import { connect, scripthashForAddress } from '../lib/network.mjs';
import {
  loadWallet,
  loadHdNode,
  deriveReceivingAddresses,
  deriveChangeAddresses,
  newChangeAddress,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import {
  utxoToTokenPrefix,
  createTokenOutput,
  createNftOutput,
  sumFtBalances,
  selectInputsForTokenSend,
} from '../lib/tokens.mjs';
import { binToHex } from '../lib/hex.mjs';

const FEE_RATE_SATS_PER_BYTE = 1.0;
const DUST_THRESHOLD = 546n;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { isNft: false };
  if (args.includes('--nft')) {
    out.isNft = true;
    const filtered = args.filter((a) => a !== '--nft');
    [out.recipient, out.category, out.commitment] = filtered;
  } else {
    [out.recipient, out.category, out.amount] = args;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  FT:  send-token.mjs <recipient> <category_hex> <amount>');
    console.log('  NFT: send-token.mjs --nft <recipient> <category_hex> <commitment_hex>');
    console.log('Set BCH_CONFIRM=yes to actually broadcast (dry-run otherwise).');
    process.exit(0);
  }
  return out;
}

async function gatherAllUtxos(client, wallet) {
  const addrs = deriveReceivingAddresses(20);
  const all = [];
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const utxos = await client.request('blockchain.scripthash.listunspent', sh);
    if (Array.isArray(utxos)) {
      for (const u of utxos) all.push({ address: a.address, ...u });
    }
  }
  return all;
}

async function main() {
  const opts = parseArgs();
  if (!opts.recipient || !opts.category) {
    console.error('Usage: send-token.mjs <recipient> <category_hex> <amount|nft>');
    process.exit(1);
  }
  if (!opts.isNft && !opts.amount) {
    console.error('FT send requires <amount>. Use --nft for NFTs.');
    process.exit(1);
  }
  if (opts.isNft && !opts.commitment) {
    console.error('NFT send requires <commitment_hex>.');
    process.exit(1);
  }

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const { hdNode } = loadHdNode();
  console.error(`network: ${w.network}`);

  console.error(`[1/7] connecting to ${w.network} Rostrum...`);
  const client = await connect(w.network);

  try {
    console.error('[2/7] scanning wallet UTXOs (receiving + change chains)...');
    const recvUtxos = await gatherAllUtxos(client, w);
    const changeUtxos = [];
    for (const a of deriveChangeAddresses(20)) {
      const sh = scripthashForAddress(a.address);
      const utxos = await client.request('blockchain.scripthash.listunspent', sh);
      if (Array.isArray(utxos)) {
        for (const u of utxos) changeUtxos.push({ address: a.address, ...u });
      }
    }
    const allUtxos = [...recvUtxos, ...changeUtxos];
    console.error(`   found ${allUtxos.length} UTXO(s) total (${recvUtxos.length} receiving, ${changeUtxos.length} change)`);

    const tokenSums = sumFtBalances(allUtxos, { ftOnly: false });
    console.error(`   token categories present: ${tokenSums.size}`);
    for (const [cat, amt] of tokenSums.entries()) {
      const kind = cat === opts.category.toLowerCase() ? ' <-- spend target' : '';
      console.error(`     ${cat.slice(0, 16)}...  amount=${amt.toString()}${kind}`);
    }
    const targetCat = opts.category.toLowerCase();
    const haveTarget = tokenSums.get(targetCat) ?? 0n;
    if (haveTarget === 0n) {
      console.error(`   ✗ no UTXO holds category ${targetCat.slice(0, 16)}...`);
      process.exit(1);
    }

    // Build the recipient output
    let recipientTokenOutput;
    if (opts.isNft) {
      console.error(`[3/7] building NFT output (category ${targetCat.slice(0, 16)}..., commitment ${opts.commitment.slice(0, 16)}...)`);
      recipientTokenOutput = createNftOutput({
        address: opts.recipient,
        category: targetCat,
        capability: 'none', // for transfer (NFT becomes non-mutable when sent)
        commitment: opts.commitment,
      });
    } else {
      const amtBig = BigInt(opts.amount);
      console.error(`[3/7] building FT output (category ${targetCat.slice(0, 16)}..., amount ${amtBig.toString()})`);
      recipientTokenOutput = createTokenOutput({
        address: opts.recipient,
        category: targetCat,
        amount: amtBig,
      });
    }
    // outputToLibauth reads .address; copy it on so the signer doesn't crash on undefined.
    recipientTokenOutput = { ...recipientTokenOutput, address: opts.recipient };

    // Select inputs (FT to cover the amount, BCH-only for fees)
    const bchForFee = 1000n; // generous budget; signP2pkhTransaction reports actual
    console.error('[4/7] selecting inputs (FT + BCH-only)...');
    const { inputs: rawInputs, ftTotal, bchTotal } = selectInputsForTokenSend({
      allUtxos,
      category: targetCat,
      tokenAmount: opts.isNft ? 1n : BigInt(opts.amount),
      bchRequired: bchForFee,
    });
    console.error(`   ${rawInputs.length} input(s): FT sum=${ftTotal}, BCH sum=${bchTotal}`);

    // Build all outputs: [recipient FT/NFT, change-FT (if any excess), BCH change]
    const outputs = [recipientTokenOutput];

    // FT change: if we over-selected FT inputs, send excess back to a change address
    const excessFt = ftTotal - (opts.isNft ? 1n : BigInt(opts.amount));
    if (excessFt > 0n) {
      const ftChangeAddr = newChangeAddress();
      const ftChange = createTokenOutput({
        address: ftChangeAddr.address,
        category: targetCat,
        amount: excessFt,
      });
      // outputToLibauth looks for .address; copy it on. (lockBytecode + valueSatoshis + token already set)
      outputs.push({ ...ftChange, address: ftChangeAddr.address });
      console.error(`   FT change: ${excessFt} -> ${ftChangeAddr.address}`);
    }

    // BCH change estimate (libauth will compute actual via fee in signP2pkhTransaction)
    const estSize = 10 + rawInputs.length * 200 + outputs.length * 50 + 34; // token outputs are larger
    const estFee = BigInt(Math.ceil(estSize * FEE_RATE_SATS_PER_BYTE));
    const bchChange = bchTotal - estFee;
    if (bchChange >= DUST_THRESHOLD) {
      const bchChangeAddr = newChangeAddress();
      outputs.push({
        lockingBytecode: undefined, // set by signP2pkhTransaction via outputToLibauth
        address: bchChangeAddr.address,
        valueSatoshis: bchChange,
      });
      console.error(`   BCH change: ${bchChange} sats -> ${bchChangeAddr.address}`);
    } else {
      console.error(`   BCH change ${bchChange} sats below dust; absorbed into fee`);
    }

    // Map inputs to signing shape (needs hdNode + derivation path per input)
    const inputs = rawInputs.map((u) => {
      const recvIdx = deriveReceivingAddresses(20).findIndex((a) => a.address === u.address);
      const chgIdx = deriveChangeAddresses(20).findIndex((a) => a.address === u.address);
      return {
        ...u,
        hdNode,
        account: 0,
        change: recvIdx >= 0 ? 0 : 1,
        index: recvIdx >= 0 ? recvIdx : chgIdx,
      };
    });

    // Map token outputs to libauth's output shape (signP2pkhTransaction expects
    // {address, valueSatoshis, token?} for each output). Token outputs already
    // have token: {...} from createTokenOutput; we just need to expose address.
    const signingOutputs = outputs.map((o) => {
      if (o.address) return o; // already in the right shape
      return o;
    });

    console.error(`[5/7] signing with libauth compiler (Schnorr P2PKH, ${inputs.length} inputs, ${outputs.length} outputs)...`);
    const signed = await signP2pkhTransaction({ inputs, outputs: signingOutputs });
    console.error(`   txid=${signed.tx_hash}`);
    console.error(`   fee=${signed.fee} sats (actual)`);

    // Broadcast gate
    if (process.env.BCH_CONFIRM !== 'yes') {
      console.error('[6/7] DRY RUN. set BCH_CONFIRM=yes to broadcast.');
      console.error('[7/7] skipped (dry run)');
      console.log(JSON.stringify({
        tx_hash: signed.tx_hash,
        tx_hex: signed.tx_hex,
        fee: signed.fee.toString(),
        ft_total_in: ftTotal.toString(),
        bch_total_in: bchTotal.toString(),
        outputs: outputs.length,
        dry_run: true,
      }, null, 2));
      return;
    }

    console.error('[6/7] BCH_CONFIRM=yes — broadcasting...');
    const result = await client.request('blockchain.transaction.broadcast', signed.tx_hex);
    if (typeof result === 'string' && result.startsWith('Error')) {
      throw new Error(`broadcast rejected: ${result}`);
    }
    console.error(`   broadcast response: ${result || '(empty — tx accepted)'}`);
    console.error('[7/7] broadcast complete. check the explorer for confirmation:');
    console.error(`   https://bchexplorer.cash/tx/${signed.tx_hash}`);
    console.log(JSON.stringify({
      tx_hash: signed.tx_hash,
      broadcast: true,
      server_response: result,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); console.error(e.stack); process.exit(1); });