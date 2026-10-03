// Mint a throwaway dapp identity and print a real pairing URI for the live
// Cauldron relay. Same key shape a browser would use: a real secp256k1 point,
// x-only, because Nostr keys are x-only and the URI encoder rejects 33 bytes.
import { encodeKeyExchangeURI } from '@wizardconnect/core';
import { secp256k1 } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';

const priv = randomBytes(32);
const compressed = secp256k1.derivePublicKeyCompressed(priv);
if (typeof compressed === 'string') throw new Error('derive failed');
const pub = Buffer.from(compressed).slice(1).toString('hex');   // x-only, 32 bytes
const sec = Buffer.from(randomBytes(8)).toString('hex');

const host = process.argv[2] || 'relay.riften.net';
const { uri } = encodeKeyExchangeURI(pub, sec, { hostname: host });
console.log(uri);
