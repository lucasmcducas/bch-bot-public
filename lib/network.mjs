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
  electrum: '1.5',
  rostrum: '1.5', // Electrum protocol version we negotiate; rostrum servers reply "1.5"
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
  const lockResult = cashAddressToLockingBytecode(address);
  if (typeof lockResult === 'string') throw new Error(`address decode failed: ${lockResult}`);
  // Electrum scripthash = sha256(lockingBytecode), reversed (little-endian display)
  const hash = sha256.hash(lockResult.bytecode);
  // Reverse for little-endian display
  return Buffer.from(hash).reverse().toString('hex');
}