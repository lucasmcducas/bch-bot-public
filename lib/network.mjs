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
 * Ask whether a locking script has any unspent output, treating "this node
 * cannot see that script" as INCONCLUSIVE rather than "it is spent".
 *
 * Why this exists: Fulcrum does not index p2sh32 covenant scripts, so
 * `scripthash.listunspent` returns an empty array for a Cauldron pool output
 * that is very much alive. Measured 2026-10-02 across all 13 pool covenants a
 * real BCH->PUSD quote used:
 *
 *   rostrum.cauldron.quest : 1..60 unspent per lock, 9M..420M sat confirmed
 *   cashnode.bch.ninja     : 0 unspent, 0 confirmed, for every single one
 *
 * Treating the empty answer as proof of spend would refuse valid swaps, which
 * is the exact failure the caller is trying to avoid. So: an empty result from
 * one node is not a verdict. Confirm with a second node before concluding the
 * output is gone.
 *
 * Three outcomes, deliberately distinguished:
 *   'unspent'    - some node listed an unspent output for this script
 *   'spent'      - two independent nodes both report nothing unspent
 *   'inconclusive' - the nodes disagree, or only one could be asked
 *
 * @param {string} lockingScriptHex
 * @param {object} opts
 * @param {string} [opts.network] - network for the primary client
 * @param {import('@electrum-cash/network').ElectrumClient} [opts.client] - reuse an open client
 * @returns {Promise<'unspent'|'spent'|'inconclusive'>}
 */
export async function scriptHasUnspent(lockingScriptHex, { network = 'mainnet', client } = {}) {
  const { createHash } = await import('node:crypto');
  const scripthash = createHash('sha256')
    .update(Buffer.from(lockingScriptHex, 'hex'))
    .digest()
    .reverse()
    .toString('hex');

  /** @type {Array<boolean|null>} - true = saw unspent, false = empty, null = error */
  const answers = [];
  const close = [];

  if (client) {
    const r = await client
      .request('blockchain.scripthash.listunspent', scripthash)
      .catch(() => null);
    answers.push(Array.isArray(r) ? r.length > 0 : null);
  } else {
    // connect() rejects on a socket failure. Without this catch the rejection
    // escapes the caller and kills the process -- observed as a
    // SocketConnectionError out of a read-only balance probe.
    try {
      const c = await connect(network);
      close.push(c);
      const r = await c.request('blockchain.scripthash.listunspent', scripthash).catch(() => null);
      answers.push(Array.isArray(r) ? r.length > 0 : null);
    } catch {
      answers.push(null);
    }
  }

  if (answers[0] === true) return 'unspent';

  // First node says nothing unspent. A single node cannot distinguish "spent"
  // from "this node does not index this script", so ask a different one.
  try {
    const alt = await connect('cauldron');
    close.push(alt);
    const r = await alt.request('blockchain.scripthash.listunspent', scripthash).catch(() => null);
    answers.push(Array.isArray(r) ? r.length > 0 : null);
  } catch {
    answers.push(null);
  }

  for (const c of close) {
    try { await c.disconnect(); } catch { /* already closed */ }
  }

  if (answers.some((a) => a === true)) return 'unspent';
  if (answers.filter((a) => a === false).length >= 2) return 'spent';
  return 'inconclusive';
}
