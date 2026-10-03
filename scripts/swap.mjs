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

import { connect, scripthashForAddress, listUnspent, scriptHasUnspent,
  outpointIsUnspent, connectToken,
 } from '../lib/network.mjs';
import { loadWallet, loadHdNode, loadState, deriveReceivingAddresses,
  scanCount, deriveChangeAddresses, newChangeAddress, commitChangeAddress, deriveChildPrivKey } from '../lib/wallet.mjs';
import { addressToLockingBytecode, signExternalTransaction } from '../lib/sign.mjs';
import { binToHex } from '../lib/hex.mjs';
import { quote, buildSwap, verifyBuildAgainstQuote, verifyTransactionOutputs, broadcastViaElectrum, broadcastSwap, resolveToken, bchToBaseUnits, toBaseUnits } from '../lib/router.mjs';

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

// One full attempt: quote, fund, build, verify, sign, broadcast. Everything in
// here can be invalidated by another trader between any two steps, so a retry
// must re-run ALL of it -- never resume partway.
async function runAttempt(attempt = 1) {
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
  // Scan change addresses too, not just receiving ones. Change is money this
  // wallet sent itself and got back; leaving it out under-reports the spendable
  // balance. On this wallet 856,855 of 1,657,855 sat sat on a change address,
  // so a receiving-only scan could only ever offer 801,000 sat. balance.mjs and
  // sweep.mjs already scan both; this keeps the three consistent.
  // Derive the scan window from the wallet's own counters, not a fixed 20. The
  // hardcoded limit meant this wallet's coin at change index 38 was invisible
  // here, exactly as it was to balance.mjs -- and the failure is silent, because
  // a scan that finds little reports "not enough funds" rather than "looked in
  // the wrong place".
  const st = loadState();
  const recvCount = scanCount('address_index', st);
  const chgCount = scanCount('change_index', st);
  console.error(
    `      scanning ${recvCount} receiving + ${chgCount} change addresses ` +
    `(state: addr ${st.address_index}, change ${st.change_index})...`
  );
  const addrs = [
    ...deriveReceivingAddresses(recvCount).map((a) => ({ ...a, chain: 'recv' })),
    ...deriveChangeAddresses(chgCount).map((a) => ({ ...a, chain: 'change' })),
  ];
  const byAddress = new Map(addrs.map((a) => [a.address, a]));
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
        // 13184 + miner fee 1173" -- 14,188 being the router's own total for
        // the two token UTXOs we sent it. The 801,000 sats of plain BCH the
        // wallet actually held were never offered.
        //
        // So: always include plain BCH as coin, and include token UTXOs only
        // when they match the sell asset. Sending a DIFFERENT token as funding
        // would hand the router an input it cannot use, so those stay out.
        const isToken = !!u.token_data;
        if (isToken && u.token_data?.category !== sellTok.categoryId) continue;
        funding.push({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: String(u.value),
          scriptHex: binToHex(addressToLockingBytecode(a.address)),
          token: isToken ? { category: sellTok.categoryId, amount: String(u.token_data.amount) } : null,
          role: isToken ? 'sell-asset' : 'coin',
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
  const sellAssets = funding.filter((f) => f.role === 'sell-asset');
  const coins = funding.filter((f) => f.role === 'coin');
  const sellSats = sellAssets.reduce((a, f) => a + BigInt(f.value), 0n);
  const coinSats = coins.reduce((a, f) => a + BigInt(f.value), 0n);
  console.error(
    `      ${funding.length} UTXO(s) available: ${sellAssets.length} sell-asset (${sellSats} sat), ${coins.length} coin (${coinSats} sat)`,
  );

  const receiveAddr = addrs[0].address;
  // Derive the change address WITHOUT consuming it. newChangeAddress() persists
  // the increment on call, so calling it here burned addresses on every run that
  // reached signing -- including runs the network then rejected. Observed: a
  // swap rejected with "Missing inputs" advanced change_index by 5, and five
  // such runs pushed it 40 -> 45.
  //
  // The address is derived, not reserved; the counter moves only after a
  // broadcast is confirmed to have been accepted.
  const changeReservation = newChangeAddress(false);
  const changeAddr = changeReservation.address;

  console.error('[3/4] building the unsigned swap...');
  const build = await buildSwap({
    sell: sellTok.categoryId, buy: buyTok.categoryId, amount: amountBase, side: 'sell',
    funding: funding.map(({ txid, vout, value, scriptHex, token }) =>
      token ? { txid, vout, value, scriptHex, token } : { txid, vout, value, scriptHex }),
    // role is local bookkeeping only and is deliberately not sent.
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
    // The amount the quote promised, and the floor the user set. Without
    // these the gate proves the money is going to our address but never that
    // the right AMOUNT arrives, which is the one thing a hostile router can
    // change while keeping every ownership check happy.
    expectedReceiveAmount: q.outputAmount,
    minReceiveAmount: minOutput || q.outputAmount,
    changeAddresses: [changeAddr],
    maxFeeSats: routerFeeCeiling(build),
    // A BCH -> PUSD swap has no token outputs (it sells plain BCH). A
    // PUSD -> BCH swap has many, all paying pool covenants, and every one must
    // be PUSD -- the asset actually being sold.
    expectedSellTokenCategory: sellTok.categoryId === 'bch' ? null : sellTok.categoryId,
    // The route the user agreed to: how many pools the quote said, and how much
    // BCH the inputs carry. Together these make the built transaction checkable
    // rather than merely self-consistent.
    maxSellValueSats: sellTok.categoryId === 'bch' ? amountBase : null,
    expectedPoolCount: q.poolCount,
    maxInputValueSats: funding.reduce((acc, u) => acc + BigInt(u.value), 0n),
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

  // The router names which inputs are OURS as indices into the transaction it
  // built, which mixes our inputs with the pools' 27. It is NOT an index into
  // `funding`.
  //
  // A live mainnet dry-run proved this: with 2 funding UTXOs the router
  // returned inputsToSign [12, 13], and the old code looked those up in
  // `funding` -- where index 12 does not exist, producing "no funding UTXO
  // supplied for input 12". The error names an input that cannot exist, which
  // is the tell that the two index spaces were being conflated.
  //
  // So map the router's index to a funding UTXO by outpoint: read the input's
  // outpoint out of the built transaction and find the funding entry that
  // spends the same txid:vout. The router is only permitted to name inputs we
  // actually offered, so a name we cannot match is a refusal, not a guess.
  const { decodeTransactionBCH } = await import('@bitauth/libauth');
  const { hexToBin } = await import('../lib/hex.mjs');
  const builtInputs = decodeTransactionBCH(hexToBin(build.unsignedTxHex)).inputs;

  const byOutpoint = new Map(funding.map((u) => [`${u.txid}:${u.vout}`, u]));
  const fundingForInput = new Map();   // router input index -> funding entry
  for (const index of build.inputsToSign) {
    const input = builtInputs[index];
    if (!input) {
      console.error(`REFUSING TO SIGN -- the router named input ${index}, but the built transaction has only ${builtInputs.length} inputs.`);
      process.exit(3);
    }
    // Electrum and the transaction serialisation disagree on byte order, so
    // match on both. Getting this backwards would look like "unknown UTXO".
    const txid = Buffer.from(input.outpointTransactionHash).toString('hex');
    const reversed = Buffer.from(input.outpointTransactionHash).reverse().toString('hex');
    const vout = Number(input.outpointIndex);
    const match = byOutpoint.get(`${txid}:${vout}`) || byOutpoint.get(`${reversed}:${vout}`);
    if (!match) {
      console.error(
        `REFUSING TO SIGN -- the router wants us to sign input ${index}, which spends ` +
        `${reversed}:${vout}, and that is not one of the UTXOs we offered.`
      );
      process.exit(3);
    }
    fundingForInput.set(index, match);
  }

  // The pool covenant inputs are the router's, not ours, and they are the ones
  // that go stale: a competing swap spends the same pool outputs, and ABC then
  // rejects the whole transaction with "Missing inputs" -- an error that reads
  // like a malformed transaction rather than a spent input. ABC raises that
  // only from HaveCoin/HaveInputs, so an unspent-output check is exactly the
  // right test. Check before signing: after signing we have spent a signature
  // and a fee to learn the route was stale.
  {
    // Token-aware node, NOT connect(w.network). The pool parents are Cauldron
    // covenant transactions: a plain Fulcrum node does not index p2sh32 and
    // answers every blockchain.transaction.get for them with a null, so every
    // pool input read as "parent unknown" and the stale-pool gate silently
    // degraded to "could not read anything" on every run.
    const checkClient = await connectToken();
    const stale = [];
    let unreadable = 0;
    try {
      for (let i = 0; i < builtInputs.length; i++) {
        if (fundingForInput.has(i)) continue;          // ours; already verified above
        // libauth's outpointTransactionHash is stored LITTLE-ENDIAN (wire
        // order), so the raw bytes ARE the on-chain order. Electrum's
        // tx_hash is the big-endian display form -- the reverse. The router
        // names the parent in wire order, so send the bytes as they are and
        // only fall back to the reversed form. Doing it the other way round
        // looks up a txid that does not exist and reports a healthy route as
        // "parent unknown".
        const wireOrder = Buffer.from(builtInputs[i].outpointTransactionHash).toString('hex');
        const displayOrder = Buffer.from(builtInputs[i].outpointTransactionHash).reverse().toString('hex');
        const vout = Number(builtInputs[i].outpointIndex);
        let parent = null;
        let raw = null;
        for (const candidate of [wireOrder, displayOrder]) {
          // `request` is VARIADIC, not array-taking: passing [candidate, false]
          // puts [[candidate, false]] on the wire and the node answers {},
          // which is indistinguishable from 'no such transaction'. That made
          // every one of the 15 pool inputs read as 'parent unknown' and
          // disabled the stale-pool safety check, on a pool transaction that
          // demonstrably exists (verified by both byte orders on two nodes).
          parent = await checkClient.request('blockchain.transaction.get', candidate, false)
            .catch(() => null);
          if (typeof parent === 'string') { raw = candidate; break; }
        }
          stale.push({ i, raw, vout, why: 'outpoint not in the unspent set' });
        // Decode the parent with libauth instead of walking it by hand.
        //
        // The pool parent is 10,851 bytes with 57 inputs and 56 outputs, and the
        // hand-rolled walk drifted: it returned the SAME wrong locking script
        // for vout 4, 5 and 32, because the byte cursor slipped inside a
        // CashToken prefix (0xef = PREFIX_TOKEN) rather than landing on an
        // output boundary. Identical wrong bytes for different indices is the
        // signature of a misaligned parse.
        //
        // It failed SILENTLY, which is what made it expensive. The wrong lock
        // still hashes to a perfectly valid scripthash, and querying a valid
        // scripthash for a script the node does not index legitimately returns
        // an empty UTXO set -- so all 13 live pools came back "already spent".
        //
        // decodeTransactionBCH is already imported above for the unsigned tx,
        // so this is strictly less code and one decoder instead of two.
        let parentTx;
        try {
          parentTx = decodeTransactionBCH(hexToBin(parent));
        } catch {
          // Undecodable parent is a transport problem, not proof the pool is
          // spent. Count it as unreadable so the caller reports it honestly
          // instead of refusing or silently proceeding.
          unreadable += 1;
          continue;
        }
        const parentOutput = parentTx.outputs[vout];
        if (!parentOutput) { unreadable += 1; continue; }
        const lock = parentOutput.lockingBytecode;
        // Ask with cross-node confirmation. A single node answering
        // listunspent with an empty array does NOT mean the output is spent:
        // Fulcrum does not index p2sh32 covenant scripts and reports 0 unspent
        // and 0 confirmed for every live Cauldron pool. Measured on all 13 pool
        // covenants of a real quote: Rostrum saw 1..60 unspent each, Fulcrum saw
        // none, and 13 of 13 disagreed. Reading the empty answer as
        // 'already spent' would refuse a perfectly good swap.
        // The EXACT outpoint, not merely this covenant has some live coin.
        // A competing swap re-creates the covenant at a new position, so the
        // lock keeps live outputs while our chosen outpoint is already consumed
        // -- the weaker check passed 12/12 on a parent whose 56 outputs were all
        // spent, and every broadcast was rejected.  is the display-order
        // txid of the parent as the router named it.
        const verdict = await outpointIsUnspent(Buffer.from(lock).toString('hex'), vout, raw, {
          network: w.network,
        });
        if (verdict === 'spent') {
          stale.push({ i, raw, vout, why: 'outpoint not in the unspent set' });
        } else if (verdict === 'inconclusive') {
          unreadable += 1;
        }
      }
    } finally {
      await checkClient.disconnect();
    }
    const poolInputCount = builtInputs.length - fundingForInput.size;
    if (unreadable) {
      console.error(`      note: ${unreadable} of ${poolInputCount} pool input(s) unreadable from any node;`);
      console.error('            treating as unproven rather than spent.');
    }
    if (stale.length === 0 && unreadable < poolInputCount) {
      console.error(`      pool inputs verified unspent (${poolInputCount - unreadable}/${poolInputCount})`);
    } else if (stale.length === poolInputCount) {
      // EVERY pool input is confirmed spent. This is the exact case the gate
      // exists to catch, and it used to be exempted here as a "transport
      // problem", which is why three consecutive attempts signed and broadcast
      // a transaction built entirely from drained positions. Refuse.
      //
      // A genuine transport failure lands in `unreadable`, not `stale`: a node
      // that cannot read a parent increments unreadable, and a node that cannot
      // see p2sh32 covenants never returns a verdict at all.
      console.error(`REFUSING TO SIGN -- all ${poolInputCount} pool input(s) are already spent.`);
      for (const x of stale.slice(0, 5)) {
        console.error(`      input ${x.i}: ${x.raw?.slice(0, 16)}.. v${x.vout}  ${x.why}`);
      }
      throw new Error('router returned a route whose pool inputs are all spent');
    } else if (unreadable === poolInputCount) {
      // Every pool input could not be read. That IS a transport problem (this
      // node answered null to every blockchain.transaction.get during the check),
      // not evidence that the pools are spent. Say so, and let the caller proceed
      // to a broadcast, which is the authority.
      console.error('      note: could not read the router\'s pool inputs from this node;');
      console.error('            continuing so the broadcast can confirm or refute them.');
    } else if (stale.length) {
      console.error(`REFUSING TO SIGN -- ${stale.length} of the router's pool inputs are no longer spendable:`);
      for (const x of stale.slice(0, 5)) {
        console.error(`  - input ${x.i} spends ${x.raw.slice(0, 16)}...:${x.vout} (${x.why})`);
      }
      if (stale.length > 5) console.error(`  ... and ${stale.length - 5} more`);
      console.error('');
      console.error('The router served pool state that a competing swap has already');
      console.error('consumed. This is the normal condition on a busy pool, not a');
      console.error('malformed transaction: retry to be quoted against fresh pools.');
      process.exit(4);
    }
  }

  // The router names which inputs are ours; each must be one we funded. Keyed by
  // the router's input index, not by position in `funding`.
  const signed = await signExternalTransaction({
    unsignedTxHex: build.unsignedTxHex,
    inputsToSign: build.inputsToSign,
    sourceOutputs: build.sourceOutputs,
    // Bind the router's choice of inputs to the funding set we actually chose.
    // The router says which inputs are ours; we say which UTXOs we meant to
    // spend. If those disagree, refuse rather than sign the router's choice.
    expectedInput: (index) => {
      const utxo = fundingForInput.get(index);
      return utxo ? { txid: utxo.txid, vout: Number(utxo.vout) } : null;
    },
    inputMaterial: (index) => {
      const utxo = fundingForInput.get(index);
      if (!utxo) throw new Error(`no funding UTXO supplied for input ${index}`);
      // Resolve the FULL derivation path, not just the index. This used to pass
      // change=0 unconditionally, so a change-chain UTXO was signed with the
      // receiving-chain key for the same index: `/0/19` instead of `/1/19`. The
      // signature then fails to validate against the script, and the failure
      // surfaces as a "Missing inputs"-style rejection that reads like a
      // malformed transaction rather than a wrong key.
      //
      // It stayed hidden because the funding scan only reaches change index 19
      // while change_index is 40, so every change UTXO the swap could see
      // happened to be on the receiving chain. That is a coincidence of current
      // state, not a property of the code, and it breaks the first time a swap
      // is funded from a change address. `derived.chain` is already carried from
      // the scan, and resolveAddressPath throws rather than guessing when an
      // address is in neither chain.
      const derived = byAddress.get(utxo.address);
      if (!derived) throw new Error(`no key derivable for input ${index}`);
      const change = derived.chain === 'change' ? 1 : 0;
      return {
        privateKey: deriveChildPrivKey(hdNode, 0, change, derived.index),
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
  // Broadcast over Electrum first, using a fresh connection. The HTTP endpoint
  // is a fallback, not the primary: it is a third-party service that was
  // serving zero bytes over TLS, and a swap never needed it -- Electrum's
  // `blockchain.transaction.broadcast` is how every other command in this repo
  // already broadcasts, and the mainnet servers accept token outputs.
  const txid = await broadcastSwapWithFallback(w.network, signed.txHex);
  // Only now, with the node having confirmed the txid, is it safe to consume the
  // change address. Deriving it is free; reserving it is the part that costs.
  const newIndex = commitChangeAddress(changeReservation.index);
  console.error(`   change address ${changeReservation.index} committed (change_index=${newIndex})`);

  console.log(JSON.stringify({ ...out, dry_run: false, broadcast: true, txid }, null, 2));
}

// Broadcast, preferring Electrum and falling back to the router's HTTP endpoint.
//
// Both paths are reported in the error if both fail, because "the swap failed"
// and "the broadcast failed" are different problems and the user needs to know
// which. A failure to broadcast is NOT a failure to sign: the signed hex is
// already valid and can be broadcast by hand, so that is included in the error.
async function broadcastSwapWithFallback(network, signedTxHex) {
  const attempts = [];

  let client = null;
  try {
    client = await connect(network);
    const r = await broadcastViaElectrum(client, signedTxHex);
    console.error(`      broadcast via Electrum (${network}), txid ${r.txid}`);
    return r.txid;
  } catch (e) {
    attempts.push(`electrum(${network}): ${e.message}`);
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }

  try {
    const r = await broadcastSwap(signedTxHex);
    console.error(`      broadcast via the Cauldron HTTP endpoint, txid ${r.txid}`);
    return r.txid;
  } catch (e) {
    attempts.push(`cauldron http: ${e.message}`);
  }

  const err = new Error(
    `could not broadcast the signed transaction by either path:\n` +
    attempts.map((a) => `  - ${a}`).join('\n') +
    `\n\nThe transaction IS signed and valid. Its hex is above; it can be broadcast\n` +
    `by hand, or the swap can be retried once a path is reachable.`
  );

  // "Missing inputs" is the pools going stale under us: a competing swap consumed
  // them between our build and our broadcast. The bytes are permanently dead, so
  // the only fix is a rebuild against a fresh quote. A transport error (node
  // down, TLS failing) leaves the transaction perfectly valid, so retrying the
  // same hex would work -- but that is handled by broadcastSwapWithFallback
  // already trying both paths, and rebuilding on a network blip would move the
  // price against the user for nothing.
  err.retryable = attempts.some((a) => /missing inputs|bad-txns-inputs|txn-mempool-conflict|conflict/i.test(a));
  err.signedHex = signedTxHex;
  throw err;
}

// Retry wrapper.
//
// Cauldron pool UTXOs are shared state. A competing swap can consume the exact
// inputs we selected while we are still building, and the node then rejects our
// perfectly-valid signed transaction with "Missing inputs". Measured 2026-10-02:
// a swap that passed every local gate (quote matched build, 2/15 outputs ours,
// 13/13 pool inputs verified unspent across two nodes) was still rejected at
// broadcast for exactly this reason.
//
// Retrying the same bytes is guaranteed to fail -- they name inputs that are
// gone. So a retry re-runs the entire attempt against fresh pool state. Bounded
// because each attempt costs a quote and can move the price against the user;
// three is enough to ride out a contended block, and past that the pool is not
// for us right now.
const MAX_ATTEMPTS = Number(process.env.BCH_SWAP_ATTEMPTS || 3);

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
            `        being contested. Nothing was spent; your funds are unchanged.`
          );
        }
        throw e;
      }
      // The signed hex from the failed attempt is printed so a human can inspect
      // it, but it is never re-broadcast: it is dead by construction.
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

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
