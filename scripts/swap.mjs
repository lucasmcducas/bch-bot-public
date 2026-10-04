#!/usr/bin/env node
// scripts/swap.mjs — swap BCH or a CashToken on Cauldron, in-wallet.
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
// units, because the protocol is integer base units throughout.
//
// WHAT CHANGED, AND WHY
//
// This used to hand the transaction to router.riften.net, which assembled it
// server-side and named the pool inputs. It named parent fd02de7d..1138, whose
// 56 outputs are all spent, and it named the same one on every quote -- so the
// network rejected every swap with "Missing inputs", an error that reads like a
// malformed transaction and is not one. The liquidity was real; only the
// position had moved. Re-pointing the router's inputs would have meant
// reimplementing the constant-product math, which is a rewrite rather than a
// fix.
//
// It is now assembled locally with @cashlab/cauldron (ExchangeLab) from pool
// state read off the public indexer. That is how Paytaca, the reference wallet
// for this protocol, does its own swaps. See lib/exlab-swap.mjs.
//
// BECAUSE THE BUILD IS LOCAL, three chunks of the old file are gone rather than
// moved, and it is worth being explicit about why each is not simply missing:
//
//   * the router's inputsToSign indirection. It named which of ITS inputs were
//     ours, by index into a transaction mixing our inputs with 27 pool inputs. A
//     live dry-run returned [12, 13] against 2 funding UTXOs, and the lookup in
//     `funding` produced "no funding UTXO supplied for input 12" -- an error
//     naming an input that cannot exist, which is the tell that two index spaces
//     were being conflated. Locally we pass our own coins and the SDK places
//     them, so the two index spaces never meet.
//   * the stale-pool pre-check across two nodes. It existed to catch pool
//     inputs the router had already lost before we signed. We build from the
//     indexer's live list seconds earlier, and a competing swap now costs a
//     retry rather than a signature and a fee. That check was also, notably, the
//     only place the codebase handled "a node cannot read p2sh32 covenants",
//     and it handled it by refusing to conclude -- which is still right, and now
//     lives in lib/network.mjs outpointIsUnspent.
//   * verifyTransactionOutputs and routerFeeCeiling. Both asked whether a
//     SERVER-ASSEMBLED transaction paid us correctly. See lib/exlab-swap.mjs for
//     why that is not a safety net worth keeping, and for what replaced the part
//     of it that was genuinely valuable.
//
// WHAT IS KEPT, AND IS STILL LOAD-BEARING
//
//   * the funding filter. Plain BCH is always offered as coin, and token UTXOs
//     only when they match the sell side. Conflating those makes a token swap
//     unfundable: a token UTXO carries dust-level sats, nowhere near the miner
//     fee, so the router rejected the set with "insufficient_funds: inputs 14188
//     sats cannot cover outputs 13184 + miner fee 1173" while 801,000 sats of
//     plain BCH the wallet actually held were never offered.
//   * scanning change addresses, and deriving the window from the wallet's own
//     counters. A fixed limit of 20 made the coin at change index 38 invisible,
//     and it fails SILENTLY, because a scan that finds little reports "not enough
//     funds" rather than "looked in the wrong place". On this wallet 856,855 of
//     1,657,855 sat sat on a change address.
//   * the FULL derivation path when spending. Passing change=0 unconditionally
//     signed a change-chain UTXO with the receiving-chain key for the same
//     index -- /0/19 instead of /1/19 -- and the failure surfaces as a
//     "Missing inputs"-style rejection that reads like a malformed transaction.
//     It stayed hidden because the scan only reached change index 19 while
//     change_index was 40, so every change UTXO the swap could see happened to
//     be on the receiving chain. That is a coincidence of current state, not a
//     property of the code, and it breaks the first time a swap is funded from
//     a change address. Here the chain travels with the UTXO from the scan.
//   * the change address is DERIVED, never reserved. newChangeAddress()
//     increments on call, so committing early burned an address on every run
//     that reached signing -- including runs the network then rejected. One
//     "Missing inputs" run advanced change_index by 5, and five pushed it 40->45.
//   * the retry, and its bound. Cauldron pools are shared state; a competing
//     swap can consume the exact inputs we picked mid-flight. Measured 2026-10-02
//     on a swap that passed every local gate.
//
// THE SIGNING MODEL IS DIFFERENT, AND IT IS WHY THIS FILE IS SHORT
//
// The SDK takes our p2pkh input as a SpendableCoin carrying coin.key -- a
// PRIVATE key -- under a compiler entry named user_key. It unlocks the pool
// covenants itself and signs our input with the key we hand it. createTradeTx
// returns a COMPLETE, SIGNED transaction: no signTransaction, no finalize step,
// no signExternalTransaction call anywhere in this path.
//
// Verified rather than inferred, by building with a throwaway key and reading the
// unlocking bytecode: 69-byte covenant unlocks on the pool inputs, a 65-byte DER
// signature push on ours.
//
// So private keys are handed to a third-party library. Three things bound that,
// and all three are load-bearing:
//   1. the key passed is the CHILD key for the one address holding that UTXO, so
//      a mishandled key leaks one input, never the seed;
//   2. no key is loaded until --quote-only has already returned, so the quote
//      path touches no key material at all;
//   3. nothing moves without BCH_CONFIRM=yes, so even a hostile library cannot
//      broadcast without a human setting an environment variable.
// Read lib/exlab-swap.mjs before changing any of those.

import { connect, scripthashForAddress, listUnspent, broadcastViaElectrum } from '../lib/network.mjs';
import { loadWallet, loadHdNode, loadState, deriveReceivingAddresses,
  scanCount, deriveChangeAddresses, newChangeAddress, commitChangeAddress,
  deriveChildPrivKey } from '../lib/wallet.mjs';
import { bchToBaseUnits, toBaseUnits, resolveToken } from '../lib/router.mjs';
import {
  fetchPools, quoteSwap, buildSwap, verifyAgainstQuote, SpendableCoinType,
} from '../lib/exlab-swap.mjs';
import { addressToLockingBytecode } from '../lib/sign.mjs';

// The largest "output to an address we do not control" we will accept.
//
// A locally built swap has no router fee to reason about: receive and change are
// both ours, so a well-formed swap has NO foreign output at all. The ceiling is
// therefore zero -- and it is never null. The router version returned null when a
// build reported no usable fee, which made the check skip the ceiling entirely
// and accept an unexplained output unexamined, failing open on exactly the case
// it exists for.
const FOREIGN_OUTPUT_CEILING = 0n;

// Cauldron pool UTXOs are shared state. A competing swap can consume the exact
// inputs we selected while we are still building, and the node then rejects our
// perfectly valid signed transaction with "Missing inputs" -- measured
// 2026-10-02 on a swap that passed every local gate.
//
// Retrying the same bytes is guaranteed to fail; they name inputs that are gone.
// So a retry re-runs the WHOLE attempt against fresh pool state. Bounded, because
// each attempt costs a quote and can move the price against the user: three is
// enough to ride out a contended block, and past that the pool is not for us
// right now.
const MAX_ATTEMPTS = Number(process.env.BCH_SWAP_ATTEMPTS || 3);

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
  // minIdx + 1 is 0 when the flag is absent, which would silently drop the first
  // positional argument -- so the skip set is only built when the flag is there.
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

// One full attempt: quote, fund, build, verify, broadcast. Everything in here can
// be invalidated by another trader between any two steps, so a retry must re-run
// ALL of it -- never resume partway.
async function runAttempt(attempt = 1) {
  const { sell: sellArg, buy: buyArg, amount: amountArg, quoteOnly, minOutput } = parseArgs();

  const [sellTok, buyTok] = await Promise.all([resolveToken(sellArg), resolveToken(buyArg)]);
  if (sellTok.categoryId === buyTok.categoryId) {
    console.error('sell and buy must be different assets');
    process.exit(1);
  }

  // The protocol is integer base units throughout, so a user-facing amount has to
  // be scaled by the asset's decimals. BCH is always 8; a token amount is scaled
  // by whatever the indexer reports, and an unknown decimal count means we
  // cannot safely guess a scale.
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
  const outDecimals = buyTok.categoryId === 'bch' ? 8 : buyTok.decimals;
  console.error(`swap: ${displayAmount(amountBase, sellTok.decimals)} ${sellTok.symbol} -> ${buyTok.symbol}`);

  // ---- quote: no wallet, no keys --------------------------------------------
  // Pools are keyed by the TOKEN side. A BCH->PUSD swap routes through PUSD
  // pools, and so does PUSD->BCH; asking for BCH pools finds none.
  const poolTokenId = buyTok.categoryId === 'bch' ? sellTok.categoryId : buyTok.categoryId;
  const pools = await fetchPools(poolTokenId);
  const trade = quoteSwap({
    sell: sellTok.categoryId,
    buy: buyTok.categoryId,
    amountBaseUnits: amountBase,
    pools,
    // Already resolved to a symbol by the caller; only used to make a refusal
    // legible ("no direct market for PUSD -> ROACH") instead of two hex strings.
    sellSymbol: sellTok.symbol,
    buySymbol: buyTok.symbol,
  });

  console.error(`[1/4] quote: ${displayAmount(trade.summary.demand, outDecimals)} ${buyTok.symbol} across ${trade.entries.length} pool(s)`);
  for (const [n, e] of trade.entries.entries()) {
    console.error(`      pool ${n + 1}: +${e.supply} in -> ${e.demand} out`);
  }

  if (quoteOnly) {
    console.log(JSON.stringify({
      sell: sellTok.symbol, buy: buyTok.symbol,
      amount_in: amountBase.toString(),
      expected_output: trade.summary.demand.toString(),
      pools: trade.entries.length,
      engine: 'exlab',
    }, null, 2));
    return;
  }

  // Past this line we load key material. Nothing above touches a key.
  const w = loadWallet();
  if (!w) { console.error('no wallet; run create-wallet.mjs first'); process.exit(1); }
  const account = w.account || 0;
  const { hdNode } = loadHdNode();
  console.error(`network: ${w.network}`);

  // ---- funding UTXOs --------------------------------------------------------
  // Scan change addresses too, not just receiving ones. Change is money this
  // wallet sent itself and got back; leaving it out under-reports the spendable
  // balance. On this wallet 856,855 of 1,657,855 sat sat on a change address, so
  // a receiving-only scan could only ever offer 801,000 sat. balance.mjs and
  // sweep.mjs already scan both; this keeps the three consistent.
  // Derive the scan window from the wallet's own counters, not a fixed 20: the
  // hardcoded limit made the coin at change index 38 invisible, and the failure
  // is silent, because a scan that finds little reports "not enough funds"
  // rather than "looked in the wrong place".
  const st = loadState();
  const recvCount = scanCount('address_index', st);
  const chgCount = scanCount('change_index', st);
  console.error(
    `      scanning ${recvCount} receiving + ${chgCount} change addresses ` +
    `(state: addr ${st.address_index}, change ${st.change_index})...`
  );
  const addrs = [
    ...deriveReceivingAddresses(recvCount).map((a) => ({ ...a, chain: 0 })),
    ...deriveChangeAddresses(chgCount).map((a) => ({ ...a, chain: 1 })),
  ];

  console.error('[2/4] collecting funding UTXOs...');
  const client = await connect(w.network);
  const funding = [];
  try {
    for (const a of addrs) {
      const sh = scripthashForAddress(a.address);
      const utxos = await listUnspent(client, sh);
      if (!Array.isArray(utxos)) continue;
      for (const u of utxos) {
        // Two different jobs, and conflating them makes a token swap impossible
        // to fund:
        //
        //   1. the SELL ASSET, which must match the trade's sell side
        //   2. the COIN, which pays the miner fee and is needed even when the
        //      sell asset is a token
        //
        // This filter used to require a UTXO to match the sell side, which
        // dropped every plain BCH UTXO on a token sell. A token UTXO carries
        // only its own dust-level sats (1000 here), nowhere near the ~13,000
        // sats a swap's outputs plus miner fee need, so the router rejected the
        // set with "insufficient_funds: inputs 14188 sats cannot cover outputs
        // 13184 + miner fee 1173" -- 14,188 being the router's own total for the
        // two token UTXOs we sent it. The 801,000 sats of plain BCH the wallet
        // actually held were never offered.
        //
        // So: always include plain BCH as coin, and include token UTXOs only
        // when they match the sell asset. Sending a DIFFERENT token as funding
        // would hand the builder an input it cannot use, so those stay out.
        const isToken = !!u.token_data;
        if (isToken && u.token_data?.category !== sellTok.categoryId) continue;
        funding.push({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: String(u.value),
          lockingBytecode: addressToLockingBytecode(a.address),
          token: isToken ? { token_id: sellTok.categoryId, amount: String(u.token_data.amount) } : null,
          address: a.address,
          index: a.index,
          chain: a.chain,
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
  // For a BCH sell the coin UTXOs ARE the sell asset -- they are one set, not
  // two. Treating them as disjoint categories made sellSats 0 and reported
  // "insufficient BCH: need 100000 sats, have 0" against a wallet holding
  // 1,656,311 sats. The token-sell case is the one with two genuinely distinct
  // sets, because the sell asset is a token and the coin is BCH.
  const isBchSell = sellTok.categoryId === 'bch';
  const sellAssets = funding.filter((f) => f.token && f.token.token_id === sellTok.categoryId);
  const coins = funding.filter((f) => !f.token);
  const sellSats = sellAssets.reduce((acc, f) => acc + BigInt(f.value), 0n);
  const coinSats = coins.reduce((acc, f) => acc + BigInt(f.value), 0n);
  const sellTokens = sellAssets.reduce((acc, f) => acc + BigInt(f.token.amount), 0n);
  console.error(
    `      ${funding.length} UTXO(s) available: ${coins.length} coin (${coinSats} sat)` +
    (isBchSell ? '' : `, ${sellAssets.length} sell-asset (${sellTokens} ${sellTok.symbol})`)
  );

  const sellAssetsUsable = isBchSell ? coins : sellAssets;
  const sellSatsUsable = isBchSell ? coinSats : sellSats;
  if (isBchSell && sellSatsUsable < amountBase) {
    throw new Error(`insufficient ${sellTok.symbol}: need ${amountBase} sats, have ${sellSatsUsable}`);
  }
  if (!isBchSell && sellTokens < amountBase) {
    throw new Error(`insufficient ${sellTok.symbol}: need ${amountBase}, have ${sellTokens}`);
  }
  // A token sell still pays its miner fee in BCH.
  if (!isBchSell && coinSats < 2000n) {
    throw new Error(`insufficient BCH for the miner fee: have ${coinSats} sats`);
  }

  // A BCH sell spends the coin UTXOs. A TOKEN sell must supply BOTH: the token
  // UTXOs are the sell asset, and coin UTXOs pay the miner fee and fund the
  // FIXED receive output. Offering only the token UTXO fails with "Not enough
  // change remained to pay the transaction fee" -- the token UTXO carries 651
  // sats of its own dust and the trade needs a few hundred more.
  //
  // This is the same lesson as the sell-asset/coin split above, one level down:
  // the two sets are not alternatives, they are both inputs.
  const spendSet = isBchSell ? coins : [...sellAssetsUsable, ...coins];
  const chosen = [];
  let total = 0n;
  let tokenTotal = 0n;
  for (const f of [...spendSet].sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? -1 : 1))) {
    chosen.push(f);
    if (f.token) { tokenTotal += BigInt(f.token.amount); continue; }
    total += BigInt(f.value);
    // Enough coin to cover the fee plus the dust a token receive output needs.
    if (tokenTotal >= amountBase && total >= 20000n) break;
  }
  if (isBchSell && total < amountBase) {
    throw new Error(`cannot cover ${amountBase} from ${total} sats of ${sellTok.symbol}`);
  }
  if (!isBchSell && tokenTotal < amountBase) {
    throw new Error(`cannot cover ${amountBase} from ${tokenTotal} ${sellTok.symbol}`);
  }

  // DERIVE the change address, never reserve it. newChangeAddress() persists the
  // increment on call, so calling it with the default burned an address on every
  // run that reached signing -- including runs the network then rejected.
  // Observed: a swap rejected with "Missing inputs" advanced change_index by 5,
  // and five such runs pushed it 40 -> 45. The counter moves only after a
  // broadcast is confirmed accepted.
  const changeReservation = newChangeAddress(false);
  const changeLocking = addressToLockingBytecode(changeReservation.address);
  // The RECEIVE output is a separate, FIXED payout so the SDK has an explicit
  // instruction to pay the quoted amount. Without it the demand is folded into
  // change, which is invisible for a token buy and catastrophic for a
  // buy-for-BCH where the demand and our coin are the same asset. See
  // lib/exlab-swap.mjs buildSwap.
  const receiveLocking = addressToLockingBytecode(addrs[0].address);

  // ---- build ----------------------------------------------------------------
  // coin.key is the CHILD PRIVATE KEY for the address holding that UTXO. Not the
  // seed, not the HD root: a library that mishandles a key then leaks one
  // input's key rather than the whole wallet. f.chain is the derivation chain
  // from the scan, which is what keeps /0/19 and /1/19 distinct.
  const inputCoins = chosen.map((f) => ({
    outpoint: { index: f.vout, txhash: wireTxid(f.txid) },
    output: {
      locking_bytecode: f.lockingBytecode,
      amount: BigInt(f.value),
      token: f.token ? { amount: BigInt(f.token.amount), token_id: f.token.token_id } : undefined,
    },
    type: SpendableCoinType.P2PKH,
    key: deriveChildPrivKey(hdNode, account, f.chain, f.index),
  }));

  console.error('[3/4] building the swap...');
  const built = buildSwap({
    trade, inputCoins,
    changeLockingBytecode: changeLocking,
    receiveLockingBytecode: receiveLocking,
  });
  console.error(
    `      built ${built.unsignedTxHex.length / 2} bytes, ` +
    `${built.payoutsInfo.length} payout(s), fee ${built.feeSats} sats (already signed)`
  );

  // ---- verify: the last gate before anything moves --------------------------
  // The short-payment guard. Ownership checks cannot catch "right address, wrong
  // amount", so the BUILT payout is compared against the quote the user is about
  // to approve, and a shortfall refuses rather than warns.
  const v = verifyAgainstQuote({ trade, built, minOutputBaseUnits: minOutput ? BigInt(minOutput) : null });
  if (!v.ok) {
    console.error('REFUSING TO SIGN -- the built transaction does not match the quote:');
    for (const p of v.problems) console.error(`  - ${p}`);
    process.exit(3);
  }
  console.error(
    `      verified: pays ${displayAmount(v.paidOut, outDecimals)} ${buyTok.symbol} ` +
    `against a quote of ${displayAmount(v.quoteDemand, outDecimals)}`
  );

  // Every payout must be OURS. payoutsInfo holds two kinds: the FIXED receive
  // and the CHANGE -- and now BOTH of them legitimately pay a different address
  // than the change we derived, because the receive goes to the wallet's first
  // receiving address. Checking only against the change bytecode flagged our own
  // receive output as "foreign, 97984 sats" and refused a correct trade.
  //
  // The two addresses are compared as a SET, not as one value. Pool covenant
  // outputs are not in payoutsInfo at all -- they are the pool's own locked
  // positions, not something we receive.
  const ours = new Set([
    Buffer.from(changeLocking).toString('hex'),
    Buffer.from(receiveLocking).toString('hex'),
  ]);
  const foreign = (built.payoutsInfo ?? []).filter((p) => {
    const bc = p.output?.locking_bytecode;
    if (!bc) return false;
    return !ours.has(Buffer.from(bc).toString('hex'));
  });
  const foreignSats = foreign.reduce((a, p) => a + BigInt(p.output?.amount ?? 0n), 0n);
  if (foreignSats > FOREIGN_OUTPUT_CEILING) {
    console.error(`REFUSING TO SIGN -- ${foreign.length} payout(s) we do not control, ${foreignSats} sats`);
    process.exit(3);
  }

  const out = {
    engine: 'exlab',
    sell: sellTok.symbol, buy: buyTok.symbol,
    amount_in: amountBase.toString(),
    amount_out: v.paidOut.toString(),
    amount_out_display: displayAmount(v.paidOut, outDecimals),
    inputs: chosen.length,
    fee_sats: built.feeSats.toString(),
    tx_hex: built.unsignedTxHex,   // the SDK returns it already signed
  };

  if (process.env.BCH_CONFIRM !== 'yes') {
    console.error('DRY RUN -- set BCH_CONFIRM=yes to broadcast');
    console.log(JSON.stringify({ ...out, dry_run: true }, null, 2));
    return;
  }

  // ---- broadcast ------------------------------------------------------------
  // Electrum only. The Cauldron HTTP endpoint presents no TLS certificate at
  // all -- "no peer certificate available", verified from two hosts -- so it is
  // not a fallback that works, and offering it as one would only produce a
  // confusing second failure after a first.
  console.error('[4/4] broadcasting...');
  const bc = await connect(w.network);
  let txid;
  try {
    const r = await broadcastViaElectrum(bc, built.unsignedTxHex);
    txid = r.txid;
    console.error(`      broadcast via Electrum (${w.network}), txid ${txid}`);
  } catch (e) {
    // A failure to broadcast is NOT a failure to sign: the hex is already valid
    // and can be broadcast by hand, so it travels with the error.
    //
    // "Missing inputs" is the pools going stale under us. Those bytes are
    // permanently dead, so the only fix is a rebuild against fresh pool state. A
    // transport error leaves the transaction valid, so it is NOT retryable --
    // rebuilding on a network blip would move the price against the user for
    // nothing.
    e.retryable = /missing inputs|bad-txns-inputs|txn-mempool-conflict|conflict/i.test(e.message);
    e.signedHex = built.unsignedTxHex;
    throw e;
  } finally {
    try { bc.disconnect(); } catch { /* already closed */ }
  }

  // Only now, with the node having confirmed the txid, is it safe to consume the
  // change address. Deriving it is free; reserving it is the part that costs.
  const newIndex = commitChangeAddress(changeReservation.index);
  console.error(`      change address ${changeReservation.index} committed (change_index=${newIndex})`);

  console.log(JSON.stringify({ ...out, dry_run: false, broadcast: true, txid }, null, 2));
}

/**
 * Outpoint transaction hash, byte for byte, with NO reversal.
 *
 * This function used to reverse. It was wrong, and the reversal cost us a real
 * broadcast: "Missing inputs", three times, on a route whose pool inputs were
 * verifiably unspent.
 *
 * The chain settles it, and I should have asked the chain first. Of the wallet's
 * six unspent UTXOs, every one resolves on the network AS GIVEN and none
 * resolves reversed:
 *
 *   fc87d83c84c0c3ceed4b7dde1d63949b6045bdc21d820e5c9f7a87dbb4838dfb
 *     as-is: YES   reversed: no
 *
 * The reasoning that produced the reversal was: "Electrum reports display
 * order, libauth wants wire order, therefore reverse." Both halves are true
 * about ELECTRUM's own API, and neither applies to an outpoint on the wire --
 * an outpoint stores the hash in the same order the network indexes it. So the
 * reversal produced a hash that names a transaction which does not exist, and
 * the network's answer, "Missing inputs", is indistinguishable from a spent
 * input. That is the whole reason it was hard to find.
 *
 * Note the shape of the bug: it was applied to BOTH the pool inputs (from the
 * indexer) and our own input (from Electrum). The pool inputs looked fine only
 * because the indexer happens to report the same order Electrum does, so
 * reversing both cancelled out for them and left exactly one input wrong.
 */
function wireTxid(txid) {
  return Uint8Array.from(Buffer.from(String(txid), 'hex'));
}

async function main() {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runAttempt(attempt);
    } catch (e) {
      lastErr = e;
      const canRetry = e.retryable && attempt < MAX_ATTEMPTS;
      if (!canRetry) {
        if (e.retryable) {
          console.error(
            `\n[retry] still "Missing inputs" after ${attempt} attempt(s) -- the pools are\n` +
            '        being contested. Nothing was spent; your funds are unchanged.'
          );
        }
        throw e;
      }
      // The signed hex from the failed attempt is reported so a human can
      // inspect it, but it is never re-broadcast: it is dead by construction.
      console.error(
        `\n[retry] ${attempt}/${MAX_ATTEMPTS} rejected: ` +
        `${String(e.message).split('\n')[0].trim()}`
      );
      console.error(
        '        the pool inputs we selected were consumed by another swap between our\n' +
        '        build and our broadcast. Re-quoting and rebuilding against fresh state.'
      );
      // Back off a little so we are not the same contention we just lost to.
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

main().catch((e) => {
  console.error('error:', e.message);
  if (e.signedHex) {
    console.error(
      '\nThe transaction IS signed and valid. Its hex is in the JSON above and can\n' +
      'be broadcast by hand, or the swap retried once the pools are free.'
    );
  }
  process.exit(1);
});
