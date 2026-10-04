#!/usr/bin/env node
// scripts/send-token.mjs — send a CashToken FT or NFT from the wallet
//
// Usage:
//   node scripts/send-token.mjs <recipient> <category_hex> <amount>          # FT
//   node scripts/send-token.mjs --nft <recipient> <category_hex> <commitment_hex>  # NFT
//   BCH_CONFIRM=yes node scripts/send-token.mjs ...                          # actually broadcast
//
// Phase 2 CashTokens wiring on top of Phase 1's libauth compiler + Rostrum.

  // ONE window, used for the scan AND for key resolution. These were two
  // different numbers for years, and the disagreement made a token the wallet
  // demonstrably holds unsignable.
  const st = loadState();
  const tokenScanWindow = Math.max(scanCount('address_index'), scanCount('change_index'));

//
// Pattern from Selene Wallet TransactionBuilderService.buildP2pkhTransaction
// (gitlab.com/selene.cash/selene-wallet) + Moth's CLI script shape.

import { connect, scripthashForAddress, listUnspent, assertBroadcastAccepted,
} from '../lib/network.mjs';
import {
  loadWallet,
  loadHdNode,
  deriveReceivingAddresses,
  scanCount,
  loadState,
  deriveChangeAddresses,
  newChangeAddress,
  commitChangeAddress,
  resolveAddressPath,
} from '../lib/wallet.mjs';
import { signP2pkhTransaction } from '../lib/sign.mjs';
import {
  createTokenOutput,
  createNftOutput,
  sumFtBalances,
  selectInputsForTokenSend,
} from '../lib/tokens.mjs'
import { toBaseUnits } from '../lib/router.mjs';
import { tokenMeta, DEFAULT_DECIMALS } from '../lib/token-registry.mjs';

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
  const addrs = deriveReceivingAddresses(scanCount('address_index'));
  const all = [];
  for (const a of addrs) {
    const sh = scripthashForAddress(a.address);
    const utxos = await listUnspent(client, sh);
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
    for (const a of deriveChangeAddresses(scanCount('change_index'))) {
      const sh = scripthashForAddress(a.address);
      const utxos = await listUnspent(client, sh);
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
    // Parse the amount ONCE, in base units, and reuse it. Three separate sites
    // used to call BigInt(opts.amount) on the raw string, so a display amount like
    // "0.10" threw at whichever site ran first -- and the other two would have
    // thrown the same way even after the first was fixed. One parse, one
    // variable, so the three cannot disagree.
    const requestedAmount = (() => {
      if (opts.isNft) return 1n;
      const decimals = tokenMeta(opts.category?.toLowerCase())?.decimals ?? DEFAULT_DECIMALS;
      try {
        const v = /^\d+$/.test(opts.amount)
          ? BigInt(opts.amount)
          : toBaseUnits(opts.amount, decimals);
        if (v <= 0n) throw new Error('not positive');
        return v;
      } catch {
        console.error(
          `invalid amount: ${opts.amount} -- use a display amount with at most ${decimals} decimal places (e.g. 0.1), or a whole number of base units`
        );
        process.exit(1);
      }
    })();
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
      const amtBig = requestedAmount;
      const decimals = tokenMeta(targetCat)?.decimals ?? DEFAULT_DECIMALS;
      if (amtBig > haveTarget) {
        console.error(
          `insufficient ${targetCat.slice(0, 8)}...: have ${haveTarget} base units, need ${amtBig}`
        );
        process.exit(1);
      }
      console.error(`[3/7] building FT output (category ${targetCat.slice(0, 16)}..., amount ${amtBig} base units = ${opts.amount} at ${decimals} decimals)`);
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
      tokenAmount: requestedAmount,
      bchRequired: bchForFee,
    });
    // The sat value carried by the FT inputs. selectInputsForTokenSend returns
    // the token totals but not the sat totals, and those sats have to leave the
    // output set via the token outputs -- otherwise the change calculation
    // overpays by exactly the sat value of the FT inputs.
    const ftSatsIn = rawInputs
      .filter((u) => u.token_data)
      .reduce((acc, u) => acc + BigInt(u.value ?? 0), 0n);
    console.error(`   ${rawInputs.length} input(s): FT sum=${ftTotal} (${ftSatsIn} sats), BCH sum=${bchTotal}`);

    // Build all outputs: [recipient FT/NFT, change-FT (if any excess), BCH change]
    // Change addresses are DERIVED here but only reserved (committed) once the
    // node confirms the broadcast, so a rejected run does not burn indices.
    let ftChangeAddr = null;
    let bchChangeAddr = null;
    const outputs = [recipientTokenOutput];

    // FT change: if we over-selected FT inputs, send excess back to a change address
    const excessFt = ftTotal - requestedAmount;
    if (excessFt > 0n) {
      ftChangeAddr = newChangeAddress(false);
      const ftChange = createTokenOutput({
        address: ftChangeAddr.address,
        category: targetCat,
        amount: excessFt,
      });
      // outputToLibauth looks for .address; copy it on. (lockBytecode + valueSatoshis + token already set)
      outputs.push({ ...ftChange, address: ftChangeAddr.address });
      console.error(`   FT change: ${excessFt} -> ${ftChangeAddr.address}`);
    }

    // BCH change: everything not claimed by an output, minus the fee.
    //
    // The FT inputs carry sats as well as tokens, and BOTH token outputs claim
    // sats: the recipient FT output and the FT change output, each raised to the
    // dust floor by createTokenOutput. Subtracting only the fee made the outputs
    // exceed the inputs -- a NEGATIVE fee of -456 sat -- and the node rejects
    // that. So subtract the real sat value of every output built so far, not a
    // fee estimate alone.
    const tokenOutputSats = outputs.reduce(
      (acc, o) => acc + BigInt(o.valueSatoshis ?? 0),
      0n,
    );
    const estSize = 10 + rawInputs.length * 200 + outputs.length * 50 + 34; // token outputs are larger
    const estFee = BigInt(Math.ceil(estSize * FEE_RATE_SATS_PER_BYTE));
    const bchChange = bchTotal + ftSatsIn - tokenOutputSats - estFee;
    // The fee is implicit (signP2pkhTransaction computes it as inputs - outputs),
    // so a wrong change amount does not fail loudly -- it produces a fee of
    // zero, a negative fee, or a fee under the node's minimum, and the node
    // rejects it with no useful context. Refuse to sign instead.
    if (bchChange < 0n) {
      console.error(
        `ABORT: outputs exceed available sats by ${-bchChange} sat ` +
        `(BCH in ${bchTotal}, FT in ${ftSatsIn}, token outputs ${tokenOutputSats}, fee ${estFee})`,
      );
      process.exit(1);
    }
    if (bchChange >= DUST_THRESHOLD) {
      bchChangeAddr = newChangeAddress(false);
      outputs.push({
        lockingBytecode: undefined, // set by signP2pkhTransaction via outputToLibauth
        address: bchChangeAddr.address,
        valueSatoshis: bchChange,
      });
      console.error(`   BCH change: ${bchChange} sats -> ${bchChangeAddr.address}`);
    } else {
      console.error(`   BCH change ${bchChange} sats below dust; absorbed into fee`);
    }

    // Map inputs to signing shape (needs hdNode + derivation path per input).
    // The previous version assumed "not a receive address" implies "a change
    // address", so an address in neither list produced change: 1 with index -1
    // -- a receiving-chain UTXO signed with a change-chain key. Resolve against
    // both chains and fail if the address is in neither.
    const inputs = rawInputs.map((u) => ({
      ...u,
      hdNode,
      account: 0,
      // The window MUST be the same size as the scan above, or a token that
      // this command already FOUND cannot be signed.
      //
      // It found 2.00 ROACH at change index 40 and then refused to sign it,
      // because the scan used scanCount() -- the wallet's own counters, 45
      // addresses -- while the resolver was hardcoded to 20. Every other
      // signer in this repo derives both from the same place; this one did not,
      // and the symptom is a command that says it cannot find money it is
      // holding.
      //
      // A wrong window is worse than a small one: the point of resolving a key
      // rather than guessing an index is that a wrong index signs with the
      // wrong key, so the two numbers must come from one source.
      ...resolveAddressPath(u.address, { window: tokenScanWindow, label: 'token input UTXO' }),
    }));

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
    // A node that rejects can answer `{}` rather than an error, and the old
    // message here printed that as '(empty -- tx accepted)'. Require the txid.
    const acceptedTxid = assertBroadcastAccepted(result, signed.tx_hash);
    // Confirmed by the node. Commit whichever change addresses were used; the
    // call is idempotent and takes the highest index, so passing both is safe.
    for (const a of [ftChangeReservation, bchChangeReservation]) {
      if (a) commitChangeAddress(a.index);
    }
    console.error(`   broadcast response: ${acceptedTxid}`);
    console.error('[7/7] broadcast complete. check the explorer for confirmation:');
    console.error(`   https://bchexplorer.cash/tx/${signed.tx_hash}`);
    console.log(JSON.stringify({
      tx_hash: signed.tx_hash,
      broadcast: true,
      txid: acceptedTxid,
      server_response: result,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => { console.error('error:', e.message); console.error(e.stack); process.exit(1); });