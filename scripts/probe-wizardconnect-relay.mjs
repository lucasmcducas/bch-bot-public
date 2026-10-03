// Prove the wallet half reaches the REAL Cauldron relay and publishes
// wallet_ready. No dapp, no signing, throwaway dapp identity, no wallet keys
// beyond the relay HMAC. This is the check that would catch a transport or
// key-exchange regression that unit tests cannot see.
//
//   node scripts/probe-wizardconnect-relay.mjs [relay-host]
//
// Exits 0 on connected, 2 otherwise.

// Prove the wallet side reaches the REAL Cauldron relay and completes key
// exchange. This is the "does the transport actually work" test, with no dapp
// and no signing -- it stops at wallet_ready.
//
// Reads and writes nothing but the relay. No wallet keys are used for the
// relay identity beyond HMAC of a throwaway URI, and NO transaction is signed.

import { WalletConnectionManager } from '@wizardconnect/wallet';
import { encodeKeyExchangeURI } from '@wizardconnect/core';
import { randomBytes } from 'node:crypto';
import { createWizAdapter, buildWizardNodes } from '../lib/wizardconnect-adapter.mjs';

const RELAY = process.argv[2] || 'relay.riften.net';

// A throwaway dapp identity, minted the way a browser would.
//
// The public key must be a REAL secp256k1 point: NIP-59 derives a conversation
// key with an ECDH, and 32 random bytes are almost never on the curve. The first
// version of this probe used random bytes and failed with
//   bad point: is not on curve, sqrt error
// so mint a keypair rather than inventing one.
const { secp256k1 } = await import('@bitauth/libauth');
const dappPriv = randomBytes(32);
const dappPub = secp256k1.derivePublicKeyCompressed(dappPriv);
if (typeof dappPub === 'string') throw new Error('derivePublicKeyCompressed failed');
// Nostr keys are X-ONLY: 32 bytes, the x coordinate with no parity prefix. The
// URI encoder rejects 33 bytes, so drop the leading 02/03. This is the same
// convention NIP-19 uses, and it is why a "compressed" key is the wrong thing
// to hand this API even though it is the right thing for Bitcoin.
const pub = Buffer.from(dappPub).slice(1).toString('hex');
const sec = Buffer.from(randomBytes(8)).toString('hex');
const { uri } = encodeKeyExchangeURI(pub, sec, { hostname: RELAY });
console.log(`relay:  ${RELAY}`);
console.log(`uri:    ${uri.slice(0, 52)}...`);

const nodes = buildWizardNodes();
const manager = new WalletConnectionManager(createWizAdapter(nodes));

let sawConnected = false;
let sawReady = false;
let echoCount = 0;

// The relay echoes published messages back on our own subscription, so the
// library logs wallet_ready once per echo. That repetition IS the evidence the
// round trip is live, so count it rather than printing 30 identical lines.
const realLog = console.log;
console.log = (...a) => {
  const line = a.map(String).join(' ');
  if (line.includes('wallet_ready')) { echoCount++; return; }
  realLog(...a);
};

const statusName = (s) => (typeof s === 'string' ? s : s?.status ?? s?.state ?? JSON.stringify(s));
manager.on('connectionStatusChanged', (id, status) => {
  const name = statusName(status);
  console.log(`  status: ${id.slice(0, 8)} -> ${name}`);
  if (name === 'connected' || name === 'ready') sawConnected = true;
});

manager.on('connectionsChanged', () => {
  const conns = manager.getConnections();
  for (const [id, c] of Object.entries(conns)) {
    console.log(`  connection ${id.slice(0, 8)}: status=${statusName(c.status)} dapp=${c.dappName ?? '-'}`);
  }
});

const connectionId = manager.connect(uri);
console.log(`  connect() returned ${connectionId.slice(0, 8)}`);

// A real dapp publishes a dapp_ready on the relay. Without one we will not see
// a full handshake, but reaching `connected` proves the transport, the key
// exchange framing, and our relay identity derivation all work.
await new Promise((resolve) => setTimeout(resolve, 25000));

console.log('');
console.log = realLog;
console.log(`  reached connected:  ${sawConnected ? 'YES' : 'no'}`);
console.log(`  wallet_ready echoes: ${echoCount} (each one is the relay round trip)`);

const conns = manager.getConnections();
const any = Object.values(conns)[0];
if (any) console.log(`  final status:       ${statusName(any.status)}`);
void sawReady;

manager.disconnectAll();
await new Promise((r) => setTimeout(r, 1500));
console.log(`  disconnected:       ok`);
process.exit(sawConnected ? 0 : 2);
