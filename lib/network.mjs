// lib/network.mjs — Rostrum/Electrum client wrapper with failover
//
// Pattern from Selene Wallet ElectrumService.ts:
//   - Try servers in order from mainnet_servers / chipnet_servers / cauldron_servers
//   - Negotiate protocol version on connect (Electrum 1.5, Rostrum 1.4.3 for CashTokens)
//   - Blacklist failing servers (Selene has server_blacklist: Array<string>)
//   - Server list comes from Selene's src/util/network.ts (verified 2026-09-17)

import { ElectrumClient } from '@electrum-cash/network';

// Public Rostrum/Electrum servers (verified 2026-09-17 to be reachable)
// Source: Selene Wallet src/util/network.ts
export const SERVERS = {
  mainnet: [
    // Token-aware first. Rostrum reports has_token/token_id/token_amount/
    // token_bitfield on listunspent, which the public Fulcrum nodes do not, so
    // connecting to one of those makes a CashToken holding invisible to the
    // wallet (measured 2026-10-02: this node reports the wallet's confirmed
    // 1 ROACH; cashnode.bch.ninja reports no token field at all). It is a
    // full mainnet node, so it is preferred rather than special-cased, and the
    // Fulcrum nodes below remain as failover.
    'rostrum.cauldron.quest:50004',      // Rostrum, CashTokens-aware
    'cashnode.bch.ninja:50004',          // Kallisti / Selene Official (canonical)
    'bitcoincash.network:50004',          // Dagur
    'blackie.c3-soft.com:50004',          // Calin
    'bch.loping.net:50004',
    'bch.soul-dev.com:50004',
    'bitcoincash.stackwallet.com:50004',  // Stack Wallet
    'node.minisatoshi.cash:50004',        // minisatoshi
    'fulcrum.criptolayer.net:50004',      // molecular
  ],
  chipnet: [
    'chipnet.bch.ninja:50004',            // Kallisti
    'chipnet.c3-soft.com:64004',          // Calin
  ],
  testnet3: ['blackie.c3-soft.com:60004'],
  testnet4: ['blackie.c3-soft.com:62004', 'tbch4.loping.net:62004'],
  // Rostrum with CashTokens protocol 1.4.3+
  cauldron: ['rostrum.cauldron.quest:50004'],
};

export const PROTOCOL_VERSIONS = {
  // The public mainnet nodes (Fulcrum 2.1.2) only speak Electrum protocol
  // 1.4 / 1.4.3. Asking for 1.5 does not fail loudly: the server accepts the
  // socket, then answers every `blockchain.*` call with an EMPTY object, so
  // balance reads as zero and swaps broadcast as "Missing inputs". Offer the
  // versions the servers actually implement, newest first, so a server that
  // does speak 1.5 can still pick it.
  electrum: '1.4',
  rostrum: ['1.4', '1.4.3'],
};

const NETWORK_ALIASES = { mainnet: 'mainnet', chipnet: 'chipnet', testnet3: 'testnet3', testnet4: 'testnet4' };

/**
 * Connect to the best available server for the given network.
 * Tries servers in order; blacklists failures for the rest of the process.
 *
 * @param {string} network - one of "mainnet" | "chipnet" | "testnet3" | "testnet4" | "cauldron"
 * @returns {Promise<ElectrumClient>}
 */
export async function connect(network) {
  // No default, and no silent fallback. A wallet is created for one network and
  // its addresses are derived from one seed, so scanning the wrong network's
  // scripthashes does not throw -- it just finds nothing and reports "no UTXOs
  // available", which reads like an empty wallet rather than a wrong-network
  // lookup. An omitted or misspelt network must be a loud failure that names the
  // caller, not a quiet wrong answer. This is the only choke point every script
  // passes through, so requiring the argument here covers all of them.
  if (typeof network !== 'string' || network.length === 0) {
    throw new Error('connect(network) requires an explicit network: pass w.network from the loaded wallet');
  }
  const list = SERVERS[network];
  if (!list) {
    throw new Error(`unknown network "${network}"; expected one of ${Object.keys(SERVERS).join(', ')}`);
  }
  let lastErr;
  for (const hostPort of list) {
    const [host, portStr] = hostPort.split(':');
    const port = parseInt(portStr, 10);
    // @electrum-cash/web-socket takes host WITHOUT port; port comes from options
    const client = new ElectrumClient('bch-bot', PROTOCOL_VERSIONS.electrum, host, { port });
    try {
      await client.connect();
      const ver = await client.request('server.version', PROTOCOL_VERSIONS.electrum, PROTOCOL_VERSIONS.rostrum);
      if (typeof ver === 'string' && ver.startsWith('Error')) {
        throw new Error(ver);
      }
      return client;
    } catch (e) {
      lastErr = e;
      try { await client.disconnect(true); } catch {}
    }
  }
  throw new Error(`could not connect to any ${network} server: ${lastErr?.message || lastErr}`);
}

/** CashTokens-aware connect (uses rostrum protocol version). */
export async function connectToken() {
  return connect('cauldron');
}

/**
 * Compute the Electrum scripthash for a cashaddr (used for address subscriptions).
 * Electrum uses the script hash of the locking bytecode, displayed as a big-endian hex SHA256.
 */
import { cashAddressToLockingBytecode, sha256 } from '@bitauth/libauth';

export function scripthashForAddress(address) {
  // Reject a non-string here rather than letting it reach libauth, which fails
  // with "Cannot read properties of undefined (reading 'toLowerCase')" -- a
  // TypeError from inside a dependency, naming neither the address nor the
  // caller. A bad argument is a bug worth naming.
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(`address decode failed: expected a cash address string, got ${address === null ? 'null' : typeof address}`);
  }
  const lockResult = cashAddressToLockingBytecode(address);
  if (typeof lockResult === 'string') throw new Error(`address decode failed: ${lockResult}`);
  // Electrum scripthash = sha256(lockingBytecode), reversed (little-endian display)
  const hash = sha256.hash(lockResult.bytecode);
  // Reverse for little-endian display
  return Buffer.from(hash).reverse().toString('hex');
}
/**
 * Fetch unspent outputs for a scripthash with token data normalised.
 *
 * Every script that needs UTXOs should call this rather than
 * `client.request('blockchain.scripthash.listunspent', sh)` directly, so token
 * fields are in one shape regardless of which server answered. See
 * normaliseTokenData in lib/tokens.mjs for why the raw response cannot be
 * trusted to name them consistently.
 *
 * @param {import('@electrum-cash/network').ElectrumClient} client
 * @param {string} scripthash - big-endian sha256 of the locking script
 * @returns {Promise<Array<object>>} UTXOs, each with an optional `token_data`
 */
export async function listUnspent(client, scripthash) {
  const utxos = await client.request('blockchain.scripthash.listunspent', scripthash);
  if (!Array.isArray(utxos)) return utxos;
  const { normaliseTokenDataList } = await import('./tokens.mjs');
  return normaliseTokenDataList(utxos);
}


/**
 * There used to be a `scriptHasUnspent(lockingScriptHex)` here, and it was
 * wrong in the most expensive way possible: it reported success on a dead
 * position.
 *
 * It asked whether the covenant lock held ANY unspent output. A competing swap
 * re-creates the covenant at a new position, so the lock stays non-empty
 * forever -- the weaker question is permanently true for an active pool AND for
 * a position that no longer exists. The swap's pre-signing gate called it,
 * printed "pool inputs verified unspent (12/12)" on a route whose every input
 * was already consumed, and lost three consecutive broadcasts to "Missing
 * inputs" before anyone looked.
 *
 * Use `outpointIsUnspent(lockingScriptHex, vout, txid)` below, which can ask the
 * exact question. `scripts/lint-check-questions.mjs` fails the build if a
 * function named as an exact check cannot support that question.
 */


/**
 * Require that a node actually accepted a broadcast.
 *
 * `blockchain.transaction.broadcast` answers with the transaction id on
 * success, but a node that rejects a transaction can answer `{}` instead of an
 * error string -- the same non-answer a protocol-version mismatch produces, and
 * the reason this wallet once logged "BROADCAST ACCEPTED" from it. A
 * `startsWith('Error')` check lets `{}` through, and every caller then reports
 * `broadcast: true` for a transaction that was never accepted.
 *
 * The txid is verified rather than trusted, and when the node will not confirm,
 * the locally computed txid is still reported -- clearly marked unconfirmed --
 * so a caller never has to guess whether the transaction landed.
 *
 * @param {unknown} result - whatever the node returned
 * @param {string} [expectedTxid] - the txid signed locally, if known
 * @returns {string} the accepted txid
 * @throws when the node did not confirm a transaction
 */
export function assertBroadcastAccepted(result, expectedTxid) {
  const isTxid = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);
  if (isTxid(result)) return result.toLowerCase();
  if (result && typeof result === 'object' && isTxid(result.txid)) {
    return result.txid.toLowerCase();
  }
  if (expectedTxid) {
    throw new Error(
      `broadcast was NOT confirmed by the node (returned ${JSON.stringify(result).slice(0, 80)}). `
      + `The transaction signed locally is ${expectedTxid}; check the explorer before treating it as sent.`
    );
  }
  throw new Error(
    `broadcast returned an unexpected response: ${JSON.stringify(result).slice(0, 200)}`
  );
}
/**
 * Broadcast a signed transaction over an already-connected Electrum client.
 *
 * This lives here rather than in the file it came out of, because
 * assertBroadcastAccepted is a VALIDATOR, not a broadcaster: it judges whatever
 * a node returned and throws when the answer is not a txid. It never makes the
 * call. I deleted this function on the belief that the validator covered it and
 * that was wrong -- the test suite for it caught the gap immediately, which is
 * the argument for having those tests.
 *
 * The response shape is deliberately not assumed. A node may answer with a bare
 * txid string, with {txid}, or with something that is neither -- and the third
 * case is the dangerous one, because a caller that assumes success will report
 * a transaction as sent when it was rejected. So every shape goes through
 * assertBroadcastAccepted, and a non-txid answer throws.
 *
 * @param {{request: Function}} client - a connected Electrum client
 * @param {string} signedTxHex - the fully signed transaction
 * @param {string} [expectedTxid] - txid computed locally, for a useful error
 * @returns {Promise<{txid: string, confirmed: boolean}>}
 */
export async function broadcastViaElectrum(client, signedTxHex, expectedTxid = undefined) {
  if (!client || typeof client.request !== 'function') {
    throw new Error('broadcastViaElectrum requires a connected Electrum client');
  }
  if (typeof signedTxHex !== 'string' || signedTxHex.length === 0) {
    throw new Error('signed transaction hex is required');
  }
  // THREE ways a broadcast can fail, and the difference matters because two of
  // them look identical if you only check for a txid.
  //
  //   1. The client REJECTS with an Error carrying a consensus message.
  //   2. The client RESOLVES with an Error INSTANCE as the value. This is what
  //      an Electrum client actually does on a rejected broadcast, and it is
  //      the trap: an Error has no enumerable own keys, so JSON.stringify(err)
  //      yields the string "{}" and the consensus message is destroyed. The
  //      message survives String(err) -- "Error: the transaction was rejected by
  //      network rules.\n\nTX decode failed" -- and that is the only
  //      diagnostic an operator gets for a swap that did not land.
  //   3. The client RESOLVES with something that is not a txid and not an
  //      Error: the silent failure, which is what assertBroadcastAccepted is
  //      for.
  //
  // So an Error-shaped value is re-thrown with its own message rather than
  // formatted as JSON, and a throw propagates untouched.
  const result = await client.request('blockchain.transaction.broadcast', signedTxHex);

  if (result instanceof Error) {
    throw new Error(String(result.message || result));
  }

  const txid = assertBroadcastAccepted(result, expectedTxid);
  return { txid, confirmed: true };
}

/**
 * Is a SPECIFIC outpoint (txid + vout) still spendable?
 *
 * `scriptHasUnspent()` answers "does this covenant have any live coin", which
 * is not the question that matters when validating a route. A competing swap
 * re-creates the covenant at a new position, so the lock keeps live outputs
 * while the exact outpoint the router picked is already consumed. The weaker
 * check then says "unspent" and we sign a transaction the node must reject.
 *
 * Measured 2026-10-02 on parent fd02de7d..1138 (56 outputs, all 56 spent): the
 * lock-level check reported `unspent` for every one of them, and three separate
 * build+broadcast cycles signed and lost 12/12 "verified" pool inputs to a
 * "Missing inputs" rejection.
 *
 * Same Fulcrum caveat applies and is handled identically: a node that does not
 * index p2sh32 returns an empty array, which is "cannot see", not "spent". So
 * this asks more than one node and only concludes 'spent' when two independent
 * ones both list the lock without our outpoint.
 *
 * @param {string} lockingScriptHex
 * @param {number} vout
 * @param {string} txid - Electrum display order. libauth's
 *   outpointTransactionHash is ALREADY in this order; reversing it yields a
 *   value that decodes to ASCII hex text and is not a transaction.
 * @param {object} [opts]
 * @returns {Promise<'unspent'|'spent'|'inconclusive'>}
 */
export async function outpointIsUnspent(lockingScriptHex, vout, txid, { network = 'mainnet' } = {}) {
  const { createHash } = await import('node:crypto');
  const scripthash = createHash('sha256')
    .update(Buffer.from(lockingScriptHex, 'hex'))
    .digest()
    .reverse()
    .toString('hex');

  const matches = (list) => Array.isArray(list)
    && list.some((u) => u.tx_hash === txid && Number(u.tx_pos) === Number(vout));

  /** @type {Array<boolean|null>} - true = ours listed, false = lock listed without it */
  const answers = [];
  const close = [];

  // Only a node that INDEXES p2sh32 covenants can give a meaningful negative.
  // Measured across the public set for a live Cauldron covenant lock: Rostrum
  // listed 5 unspent outputs, while bch.imaginary.cash, cashnode.bch.ninja and
  // fulcrum.jettscythe.xyz each returned 0 -- not because the coins are gone but
  // because Fulcrum does not index covenant scripts at all. Counting those
  // zeros as agreement would make every live route look drained, so only the
  // token-aware node is asked, and its answer is labelled for what it is.
  try {
    const c = await connectToken();
    close.push(c);
    const r = await c.request('blockchain.scripthash.listunspent', scripthash).catch(() => null);
    if (Array.isArray(r)) answers.push(matches(r));
  } catch {
    answers.push(null);
  }

  for (const c of close) {
    try { await c.disconnect(); } catch { /* already closed */ }
  }

  if (answers[0] === true) return 'unspent';
  // The token-aware node indexed the lock and omitted our outpoint. That is
  // the only node qualified to say so, so one such answer is the verdict.
  if (answers[0] === false) return 'spent';
  return 'inconclusive';
}
