#!/usr/bin/env node
// scripts/create-wallet.mjs — generate a new BIP39 wallet, save to ~/.bch-wallet/wallet.json
//
// Usage: node scripts/create-wallet.mjs [--network chipnet|mainnet|testnet3|testnet4]
//
// SAFETY: writes to ~/.bch-wallet/wallet.json with mode 0600. Will not overwrite
// an existing wallet unless --force is passed.

import { createWallet, walletPaths } from '../lib/wallet.mjs';
import { existsSync } from 'node:fs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { network: 'chipnet', force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network') out.network = args[++i];
    else if (args[i] === '--force') out.force = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: create-wallet.mjs [--network chipnet|mainnet|testnet3|testnet4] [--force]');
      process.exit(0);
    }
  }
  return out;
}

const opts = parseArgs();
const paths = walletPaths();

if (existsSync(paths.wallet) && !opts.force) {
  console.error(`wallet already exists at ${paths.wallet}`);
  console.error('pass --force to overwrite (this DESTROYS the existing seed)');
  process.exit(1);
}

const { mnemonic, network } = createWallet({ network: opts.network });

console.log(`✓ Created new BCH wallet (network=${network})`);
console.log(`  Path: ${paths.wallet} (mode 0600)`);
console.log(`  Backup these 24 words OFF this machine:`);
console.log();
console.log(`    ${mnemonic}`);
console.log();
console.log('⚠  Anyone with these 24 words has full control of the wallet.');
console.log('⚠  Write them down on paper. Do not paste them anywhere digital.');