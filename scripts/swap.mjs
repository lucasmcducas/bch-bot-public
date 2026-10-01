#!/usr/bin/env node
// scripts/swap.mjs — swap BCH or a CashToken on Cauldron, via the Riften Router.
//
// Usage:
//   node scripts/swap.mjs <sell> <buy> <amount>                    # dry-run
//   BCH_CONFIRM=yes node scripts/swap.mjs <sell> <buy> <amount>    # broadcast
//
// Examples:
//   node scripts/swap.mjs BCH pusd 0.01        # sell 0.01 BCH, receive PUSD
//   node scripts/swap.mjs pusd BCH 1.50        # sell 1.50 PUSD, receive BCH
//   node scripts/swap.mjs BCH pusd 0.01 --quote-only
//
// <sell>/<buy> accept a symbol (pusd, roach) or a 64-char category hex; 'bch'
// is native. A BCH amount is in display units (8 dp); a token amount is in base
// units, because the router's protocol is integer base units throughout.
//
// A Cauldron pool input must be signed by the pool operator, so this wallet
// cannot assemble a swap alone. The Router (Riften Labs, the DEX operator)
// builds the unsigned transaction and names the inputs we own; we sign only
// those and broadcast. See lib/router.mjs.

import { connect, scripthashForAddress } from '../lib/network.mjs';
import { loadWallet, loadHdNode, deriveReceivingAddresses, newChangeAddress, deriveChildPrivKey } from '../lib/wallet.mjs';
import { addressToLockingBytecode, signExternalTransaction } from '../lib/sign.mjs';
import { binToHex } from '../lib/hex.mjs';
import { quote, buildSwap, verifyBuildAgainstQuote, verifyTransactionOutputs, broadcastSwap, resolveToken, bchToBaseUnits, toBaseUnits } from '../lib/router.mjs';

// The largest "output to an address we do not control" we are willing to accept.
//
// The router charges its fee on the build, and reports it as build.feeSats, so
// the ceiling is derived from what the build actually said rather than from a
// hardcoded bps rate that could drift from the router. The ceiling is the
// reported fee with generous headroom for the miner fee, doubled to allow for
// a multi-output trade.
//
// This NEVER returns null. An earlier version returned null when the build
// reported no usable fee, which made verifyTransactionOutputs skip the ceiling
// check entirely and accept an unexplained output unexamined -- failing open on
// exactly the case the check exists for. If the build gives us no fee to work
// from, the honest response is a ceiling of zero: no unexplained output is
// acceptable, and the caller's own build must then have no foreign outputs.
//
// A ceiling of zero is not merely safe, it is correct here: the receive and
// change outputs are both ours, so a well-formed swap has no foreign output at
// all. The headroom below only matters if the router ever starts paying itself
// out of band.
function routerFeeCeiling(build) {
  const reported = build && build.feeSats !== undefined && build.feeSats !== null
    ? BigInt(build.feeSats)
    : null;
  if (reported === null || reported <= 0n) return 0n;
  // A floor of 1000 sats covers the miner fee on a typical trade; the reported
  // router fee is added on top, then doubled. Erring high is safe because a
  // redirected output carries the whole traded amount, not a fee-sized sum, and
  // is caught at every trade size.
  const minerAllowance = 1000n;
  return (reported + minerAllowance) * 2n;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: swap.mjs <sell> <buy> <amount> [--quote-only] [--min-output N]');
    console.log('Example: swap.mjs BCH pusd 0.01');
    console.log('         swap.mjs pusd BCH 1.5');
    console.log('Set BCH_CONFIRM=yes to broadcast (dry-run otherwise).');
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const quoteOnly = argv.includes('--quote-only');
  const minIdx = argv.indexOf('--min-output');
  const minOutput = minIdx !== -1 ? argv[minIdx + 1] : null;
  // minIdx + 1 is 0 when the flag is absent, which would silently drop the
  // first positional argument -- so the skip set is only built when the flag
  // is actually present.
  const skip = new Set(minIdx === -1 ? [] : [minIdx, minIdx + 1]);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));
  if (positional.length < 3) {
    console.error('need <sell> <buy> <amount>');
    process.exit(1);
  }
  return { sell: positional[0], buy: positional[1], amount: positional[2], quoteOnly, minOutput };
}

function displayAmount(baseUnits, decimals) {
  if (decimals === null || decimals === undefined) return String(baseUnits);
  const d = Number(decimals);
  if (!Number.isFinite(d) || d === 0) return String(baseUnits);
  const v = BigInt(baseUnits);
  const div = 10n ** BigInt(d);
  return `${v / div}.${(v % div).toString().padStart(d, '0')}`;
}

async function main() {
  const { sell: sellArg, buy: buyArg, amount: amountArg, quoteOnly, minOutput } = parseArgs();

  const [sellTok, buyTok] = await Promise.all([resolveToken(sellArg), resolveToken(buyArg)]);
  if (sellTok.categoryId === buyTok.categoryId) {
    console.error('sell and buy must be different assets');
    process.exit(1);
  }

  // The router's protocol is integer base units throughout, so a user-facing
  // amount has to be scaled by the asset's decimals. BCH is always 8; a token
  // amount is scaled by whatever the indexer reports, and an unknown decimal
  // count means we cannot safely guess a scale.
  let amountBase;
  if (sellTok.categoryId === 'bch') {
    amountBase = bchToBaseUnits(amountArg);
  } else if (sellTok.decimals === null || sellTok.decimals === undefined) {
    throw new Error(
      `decimals unknown for ${sellTok.symbol} -- pass the amount in base units with its category id`
    );
  } else {
    amountBase = toBaseUnits(amountArg, Number(sellTok.decimals));
  }
  console.error(`swap: ${displayAmount(amountBase, sellTok.decimals)} ${sellTok.symbol} -> ${buyTok.symbol}`);

  const q = await quote({
    sell: sellTok.categoryId, buy: buyTok.categoryId, amount: amountBase, side: 'sell',
  });
  console.error(`[1/4] quote: ${displayAmount(q.outputAmount, buyTok.decimals)} ${buyTok.symbol} across ${q.poolCount} pool(s)`);
  console.error(`      price ${q.priceBefore} -> ${q.priceAfter} after your trade`);

  if (quoteOnly) {
    console.log(JSON.stringify({
      sell: sellTok.symbol, buy: buyTok.symbol,
      amount_in: amountBase.toString(), expected_output: q.outputAmount,
      pools: q.poolCount, price_before: q.priceBefore, price_after: q.priceAfter,
      dry_run: true,
    }, null, 2));
    return;
  }

  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const { hdNode } = loadHdNode();
  console.error(`network: ${w.network}`);

  // The router needs our own spendable UTXOs to fund the trade, and the input
  // asset must match the sell side: sending the wrong asset into a swap would
  // hand the router a funding set it cannot use.
  console.error('[2/4] collecting funding UTXOs...');
  const addrs = deriveReceivingAddresses(20);
  const byAddress = new Map(addrs.map((a) => [a.address, a]));
  const client = await connect(w.network);
  const funding = [];
  try {
    for (const a of addrs) {
      const sh = scripthashForAddress(a.address);
      const utxos = await client.request('blockchain.scripthash.listunspent', sh);
      if (!Array.isArray(utxos)) continue;
      for (const u of utxos) {
        const isToken = !!u.token_data;
        if (isToken) {
          if (u.token_data?.category !== sellTok.categoryId) continue;
        } else if (sellTok.categoryId !== 'bch') {
          continue;
        }
        funding.push({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: String(u.value),
          scriptHex: binToHex(addressToLockingBytecode(a.address)),
          token: isToken ? { category: sellTok.categoryId, amount: String(u.token_data.amount) } : null,
          address: a.address,
          index: a.index,
        });
      }
    }
  } finally {
    await client.disconnect();
  }

  if (funding.length === 0) {
    console.error(`no ${sellTok.symbol} UTXOs available to fund the swap`);
    process.exit(2);
  }
  console.error(`      ${funding.length} UTXO(s) available`);

  const receiveAddr = addrs[0].address;
  const changeAddr = newChangeAddress().address;

  console.error('[3/4] building the unsigned swap...');
  const build = await buildSwap({
    sell: sellTok.categoryId, buy: buyTok.categoryId, amount: amountBase, side: 'sell',
    funding: funding.map(({ txid, vout, value, scriptHex, token }) =>
      token ? { txid, vout, value, scriptHex, token } : { txid, vout, value, scriptHex }),
    receiveAddr, changeAddr,
    minOutput: minOutput || undefined,
  });

  // The router is documented as beta and says a quote must be checked against
  // the built transaction. This is that check, and the last gate before a
  // signature exists.
  const gate = verifyBuildAgainstQuote(q, build, { minOutput: minOutput || undefined });
  if (!gate.ok) {
    console.error('REFUSING TO SIGN -- the built transaction does not match the quote:');
    for (const p of gate.problems) console.error(`  - ${p}`);
    process.exit(3);
  }
  console.error(`      verify: build matches quote (output ${build.expectedOutput})`);

  // The comparison above checks two numbers the ROUTER supplied, so a
  // compromised router could satisfy it while redirecting the output. Read the
  // transaction bytes that would actually be signed and confirm every output
  // goes to an address we control, or is a small plain output we account for as
  // fee. A token-aware output is never accepted as a fee: that is an asset
  // leaving the wallet, not satoshis.
  const outputCheck = await verifyTransactionOutputs(build.unsignedTxHex, {
    expectedReceiveAddresses: [receiveAddr],
    changeAddresses: [changeAddr],
    maxFeeSats: routerFeeCeiling(build),
  });
  if (!outputCheck.ok) {
    console.error('REFUSING TO SIGN -- the built transaction pays an address we do not control:');
    for (const p of outputCheck.problems) console.error(`  - ${p}`);
    process.exit(3);
  }
  console.error(
    `      verify: ${outputCheck.outputs.filter((o) => o.isOurs).length}/${outputCheck.outputs.length} outputs are ours` +
    ` (amount ${build.expectedOutput})`
  );

  console.error(`      router fee ${build.feeSats} sats, miner fee ${build.minerFeeSats} sats`);
  console.error(`      we sign input(s) ${JSON.stringify(build.inputsToSign)}`);

  // The router names which inputs are ours; the funding list is in the same
  // order it was sent, so index into it rather than guessing from a txid.
  const signed = await signExternalTransaction({
    unsignedTxHex: build.unsignedTxHex,
    inputsToSign: build.inputsToSign,
    sourceOutputs: build.sourceOutputs,
    // Bind the router's choice of inputs to the funding set we actually chose.
    // The router says which inputs are ours; we say which UTXOs we meant to
    // spend. If those disagree, refuse rather than sign the router's choice.
    expectedInput: (index) => {
      const utxo = funding[index];
      return utxo ? { txid: utxo.txid, vout: Number(utxo.vout) } : null;
    },
    inputMaterial: (index) => {
      const utxo = funding[index];
      if (!utxo) throw new Error(`no funding UTXO supplied for input ${index}`);
      const derived = byAddress.get(utxo.address);
      if (!derived) throw new Error(`no key derivable for input ${index}`);
      return {
        privateKey: deriveChildPrivKey(hdNode, 0, 0, derived.index),
        valueSatoshis: BigInt(utxo.value),
      };
    },
  });

  const out = {
    txid: signed.txid,
    tx_hex: signed.txHex,
    sell: sellTok.symbol,
    buy: buyTok.symbol,
    amount_in: amountBase.toString(),
    amount_out: build.expectedOutput,
    amount_out_display: displayAmount(build.expectedOutput, buyTok.decimals),
    router_fee_sats: build.feeSats,
    miner_fee_sats: build.minerFeeSats,
    dry_run: true,
  };

  if (process.env.BCH_CONFIRM !== 'yes') {
    console.error('DRY RUN -- set BCH_CONFIRM=yes to broadcast');
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error('[4/4] broadcasting...');
  const { txid } = await broadcastSwap(signed.txHex);
  console.log(JSON.stringify({ ...out, dry_run: false, broadcast: true, txid }, null, 2));
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
