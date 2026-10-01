#!/usr/bin/env node
// scripts/encrypt-wallet.mjs — upgrade a plaintext (v1) wallet to encrypted (v2)
//
// Usage:
//   node scripts/encrypt-wallet.mjs            # interactive (prompts for passphrase)
//   BCH_WALLET_PASSPHRASE=... node scripts/encrypt-wallet.mjs
//
// Prompts for the new encryption passphrase (NOT the BIP-39 passphrase —
// that's separate). Verifies the wallet can be re-decrypted with the new
// passphrase before overwriting the file.
//
// SAFETY: this rewrites wallet.json. Back up first if you care.

import { loadWallet } from '../lib/wallet.mjs';
import {
  encryptPlaintextWallet,
  decryptEncryptedWallet,
  isEncrypted,
  isPlaintext,
} from '../lib/wallet-encryption.mjs';
import { resolveWalletPaths } from '../lib/wallet.mjs';
import { readFileSync, writeFileSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

// Resolved by the wallet module, not recomputed here. This file used to derive
// the same path independently from lib/wallet.mjs. If the two ever disagreed,
// this script would have encrypted a different file than the CLI reads, and the
// wallet would look like it had lost its funds.
const { wallet: WALLET_FILE } = resolveWalletPaths();

async function promptHidden(question) {
  // Minimal hidden-prompt for Unix terminals. We disable echo by putting the
  // terminal in raw mode. Falls back to a plain prompt if that fails.
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let input = '';
    if (!stdin.isTTY) {
      // Non-TTY: just read a line
      const rl = createInterface({ input: stdin, output: stdout, terminal: false });
      rl.on('line', (line) => { rl.close(); resolve(line); });
      rl.on('close', () => resolve(input));
      return;
    }
    // TTY: raw-mode hide
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x03) { // Ctrl+C
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        reject(new Error('interrupted'));
      } else if (code === 0x0d || code === 0x0a) { // Enter
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(input);
      } else if (code === 0x7f || code === 0x08) { // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else if (code >= 0x20) { // printable
        input += ch;
        process.stderr.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bch-bot encrypt-wallet');
    console.log();
    console.log('Upgrades a plaintext (v1) wallet.json to an encrypted (v2) wallet.');
    console.log('You will be prompted for the new encryption passphrase.');
    console.log();
    console.log('Environment:');
    console.log('  BCH_WALLET_PASSPHRASE   provide passphrase non-interactively');
    console.log('  BCH_WALLET_DIR          wallet directory (default ~/.bch-wallet)');
    process.exit(0);
  }

  if (!existsSync(WALLET_FILE)) {
    console.error(`no wallet found at ${WALLET_FILE}`);
    console.error('run "bch-bot create-wallet" first');
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));

  if (isEncrypted(raw)) {
    console.log('wallet is already encrypted (v2). Nothing to do.');
    process.exit(0);
  }

  if (!isPlaintext(raw)) {
    console.error('wallet.json has unknown format; refusing to encrypt.');
    process.exit(1);
  }

  // Get the new encryption passphrase
  let pass1, pass2;
  if (process.env.BCH_WALLET_PASSPHRASE) {
    pass1 = process.env.BCH_WALLET_PASSPHRASE;
    pass2 = pass1;
  } else {
    pass1 = await promptHidden('Enter new wallet-encryption passphrase: ');
    pass2 = await promptHidden('Confirm passphrase: ');
  }

  if (pass1 !== pass2) {
    console.error('passphrases do not match; aborting');
    process.exit(1);
  }
  if (!pass1 || pass1.length < 8) {
    console.error('passphrase too short (min 8 chars); aborting');
    process.exit(1);
  }

  // Encrypt
  console.log('encrypting...');
  const encrypted = encryptPlaintextWallet(raw, pass1);

  // Verify: round-trip decrypt to make sure the passphrase works
  const decrypted = decryptEncryptedWallet(encrypted, pass1);
  if (decrypted.mnemonic !== raw.mnemonic) {
    console.error('round-trip verification failed; aborting');
    process.exit(1);
  }
  console.log('round-trip verification passed');

  // Back up the plaintext wallet to wallet.json.v1.bak (just once)
  const backupPath = WALLET_FILE + '.v1.bak';
  if (!existsSync(backupPath)) {
    copyFileSync(WALLET_FILE, backupPath);
    chmodSync(backupPath, 0o600);
    console.log(`backed up plaintext wallet to ${backupPath}`);
  } else {
    console.log(`backup already exists at ${backupPath} (skipping)`);
  }

  // Write the encrypted wallet
  writeFileSync(WALLET_FILE, JSON.stringify(encrypted, null, 2));
  chmodSync(WALLET_FILE, 0o600);
  console.log(`encrypted wallet written to ${WALLET_FILE}`);
  console.log();
  console.log('NEXT STEPS:');
  console.log('  - Set BCH_WALLET_PASSPHRASE=... in your shell before running');
  console.log('    bch-bot commands, OR pass it inline.');
  console.log('  - Keep the plaintext backup safe (e.g., encrypted USB) in case');
  console.log('    you ever forget the passphrase.');
  console.log('  - NEVER store the passphrase in the same place as wallet.json.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
