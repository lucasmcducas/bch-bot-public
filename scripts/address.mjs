#!/usr/bin/env node
// scripts/address.mjs — derive a receiving address from the loaded wallet
//
// Usage: node scripts/address.mjs
//        node scripts/address.mjs --count N     (derive N, no state change — gap scan)
//        node scripts/address.mjs --json        (machine-readable, for the plugin)
//
// --json prints a single object on stdout with diagnostics on stderr, matching
// balance.mjs. The plugin parses stdout, so a text-mode table would have to be
// scraped and would break on the first address that looks like a tab.

import { newReceivingAddress, deriveReceivingAddresses, loadWallet } from '../lib/wallet.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { count: 1, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count') out.count = parseInt(args[++i], 10);
    if (args[i] === '--json') out.json = true;
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
  if (opts.json) {
    console.log(JSON.stringify({
      network: w.network,
      addresses: addrs.map((a) => ({ index: a.index, address: a.address })),
    }, null, 2));
  } else {
    addrs.forEach((a) => console.log(`${a.index}\t${a.address}`));
  }
} else {
  const { address, index } = newReceivingAddress();
  if (opts.json) {
    console.log(JSON.stringify({ network: w.network, index, address }, null, 2));
  } else {
    console.log(address);
    console.error(`(index ${index})`);
  }
}
