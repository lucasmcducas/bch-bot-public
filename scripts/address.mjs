#!/usr/bin/env node
// scripts/address.mjs — derive a new receiving address from the loaded wallet
//
// Usage: node scripts/address.mjs
//        node scripts/address.mjs --count N  (derive N without state change, for gap scan)

import { newReceivingAddress, deriveReceivingAddresses, loadWallet } from '../lib/wallet.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { count: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count') out.count = parseInt(args[++i], 10);
  }
  return out;
}

const opts = parseArgs();
const w = loadWallet();
if (!w) {
  console.error('no wallet; run create-wallet.mjs first');
  process.exit(1);
}
console.error(`network: ${w.network}`);

if (opts.count > 1) {
  const addrs = deriveReceivingAddresses(opts.count);
  addrs.forEach((a) => console.log(`${a.index}\t${a.address}`));
} else {
  const { address, index } = newReceivingAddress();
  console.log(address);
  console.error(`(index ${index})`);
}