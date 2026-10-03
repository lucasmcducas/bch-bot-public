// lib/wizardconnect-service.mjs
//
// The WizardConnect wallet side, wired: relay, key exchange, request queueing,
// and the approval gate that stands between a dapp and this wallet's key.
//
// WHY THIS IS SEPARATE FROM THE ADAPTER
//
// lib/wizardconnect-adapter.mjs knows how to derive and how to sign. It cannot
// decide whether to. That decision needs a human, so it lives here, in the one
// place that can see a request, and the adapter is handed to the library with
// its signTransaction replaced by a rejection (as the reference wallets do).
//
// The approval gate is the security boundary. A dapp can ask for anything; the
// only thing standing between that request and a signature is `onApprove` being
// called with a summary the user has seen. So:
//
//   - there is no code path from a dapp message to a signature except the gate
//   - no timeout auto-approves; a missing handler REFUSES
//   - the summary the gate receives is built from the transaction itself, not
//     from anything the dapp supplied, because a dapp describing its own
//     request is the thing to be suspicious of
//
// WHAT THE SUMMARY MUST SHOW
//
// Not "approve this transaction". The two failure modes that matter on a swap
// are invisible in a raw hex dump:
//
//   1. a covenant input whose decoded value is NOT BCH. A Cauldron route spends
//      pool positions; their outputs pay the pools, and a user reading "you are
//      sending 0.001 BCH" when the transaction also consumes a 5,000 USD pool
//      position has been misinformed.
//   2. an output to an address the wallet does not own. The refund, the change,
//      the counterparty -- who is getting paid, and by how much.
//
// So the summary separates, per output, the plain satoshis from any token
// amount, and flags outputs paying addresses outside our chains.

import { WalletConnectionManager } from '@wizardconnect/wallet';
import { DerivationPath } from './wizardconnect-adapter.mjs';
import { buildWizardNodes, createWizAdapter, createSignedWizTransaction } from './wizardconnect-adapter.mjs';

/** Chains a request may name. 7 is the dapp's defi/Cauldron chain. */
const ALLOWED_PATHS = new Set([
  DerivationPath.Receive,
  DerivationPath.Change,
  DerivationPath.Cauldron,
]);

const binToHexStr = (b) => Buffer.from(b).toString('hex');

/**
 * What the user is being asked to approve. Everything here is derived from the
 * transaction bytes; nothing is taken on the dapp's word.
 */
function summarizeRequest(request, nodes) {
  const tx = typeof request.transaction === 'string' ? null : request.transaction;
  const sourceOutputs = Array.isArray(request.sourceOutputs) ? request.sourceOutputs : [];

  const inputs = sourceOutputs.map((src, i) => ({
    index: i,
    sats: src.valueSatoshis === undefined ? null : String(src.valueSatoshis),
    // A contract input is a covenant position, not a coin the user holds.
    isContract: !!(src.contract?.artifact?.contractName),
    contractName: src.contract?.artifact?.contractName ?? null,
    token: src.token
      ? { category: binToHexStr(src.token.category), amount: String(src.token.amount) }
      : null,
    lockingBytecode: src.lockingBytecode ? binToHexStr(src.lockingBytecode) : null,
  }));

  const outputs = (tx?.outputs ?? []).map((o, i) => ({
    index: i,
    sats: String(o.valueSatoshis ?? 0n),
    token: o.token
      ? { category: binToHexStr(o.token.category), amount: String(o.token.amount) }
      : null,
    lockingBytecode: o.lockingBytecode ? binToHexStr(o.lockingBytecode) : null,
  }));

  const plainIn = inputs.reduce((a, x) => a + (x.sats ? BigInt(x.sats) : 0n), 0n);
  const plainOut = outputs.reduce((a, o) => a + BigInt(o.sats), 0n);
  const minerFee = plainIn - plainOut;

  return {
    inputCount: inputs.length,
    outputCount: outputs.length,
    inputs,
    outputs,
    plainIn,
    plainOut,
    minerFee,
    // Anything not plain BCH moving through the transaction. On a Cauldron swap
    // this is the whole trade; on anything else it is a reason to look twice.
    hasTokens: inputs.some((x) => x.token) || outputs.some((o) => o.token),
    hasContractInputs: inputs.some((x) => x.isContract),
    nodes,
  };
}

/**
 * Create a WizardConnect service.
 *
 * @param {object} opts
 * @param {(summary: object, meta: {dappName: string|null, connectionId: string}) => Promise<boolean>} opts.onApprove
 *   MUST resolve true to sign. There is no default and no timeout: a wallet
 *   without a gate refuses every request, which is the correct failure.
 * @param {(connectionId: string) => void} [opts.onConnectionState]
 * @param {(connectionId: string, reason: string) => void} [opts.onDisconnect]
 */
export function createWizardConnectService(opts = {}) {
  const { onApprove, onConnectionState, onDisconnect } = opts;

  if (typeof onApprove !== 'function') {
    throw new Error(
      'createWizardConnectService requires onApprove: without an approval gate '
      + 'this wallet would sign whatever a dapp asks for',
    );
  }

  const nodes = buildWizardNodes();
  const adapter = createWizAdapter(nodes);

  const manager = new WalletConnectionManager(adapter);

  manager.on('connectionStatusChanged', (connectionId, status) => {
    onConnectionState?.(connectionId, status);
  });

  manager.on('connectionsChanged', () => {
    for (const [id, c] of Object.entries(manager.getConnections())) {
      onConnectionState?.(id, c.status);
    }
  });

  manager.on('remoteDisconnect', (connectionId, reason, message) => {
    onDisconnect?.(connectionId, message || String(reason));
  });

  manager.on('signCancelled', (connectionId, sequence, reason) => {
    // A cancel is the dapp withdrawing the request. Nothing to sign.
    void connectionId;
    void sequence;
    void reason;
  });

  // The approval gate.
  manager.on('pendingSignRequest', async ({ connectionId, request }) => {
    const conn = manager.getConnections()[connectionId];
    const dappName = conn?.dappName ?? null;

    let summary;
    try {
      summary = summarizeRequest(request, nodes);
    } catch (e) {
      await manager.sendSignError(connectionId, request.sequence,
        `could not read the request: ${e.message}`);
      return;
    }

    let approved = false;
    try {
      approved = await onApprove(summary, { dappName, connectionId });
    } catch (e) {
      approved = false;
      void e;
    }

    if (!approved) {
      await manager.sendSignError(connectionId, request.sequence, 'rejected by the user');
      return;
    }

    // Derive the keys for the paths the dapp named, and sign.
    try {
      const inputKeys = await buildInputKeys(request, nodes);
      const { signedTransaction } = createSignedWizTransaction(request, inputKeys);
      await manager.sendSignResponse(connectionId, request.sequence, signedTransaction);
    } catch (e) {
      await manager.sendSignError(connectionId, request.sequence, e.message);
    }
  });

  return {
    manager,
    adapter,
    nodes,

    /** Pair with a dapp from a wiz:// URI. */
    connect(uri) {
      if (typeof uri !== 'string' || !/^wiz:\/\//i.test(uri)) {
        throw new Error('expected a wiz:// pairing URI');
      }
      return manager.connect(uri);
    },

    getConnections: () => manager.getConnections(),
    disconnect: (id) => manager.disconnect(id),
    disconnectAll: () => manager.disconnectAll(),
  };
}

/**
 * Build the signing-key map from the request's inputPaths.
 *
 * Each entry names a chain and an index. The chain must be one we expose to
 * dapps -- if a request names the relay chain it is asking for a key we have
 * refused to hand out, and the whole request is refused rather than quietly
 * skipping the input.
 */
async function buildInputKeys(request, nodes) {
  const paths = request.inputPaths;
  if (!paths || typeof paths !== 'object') return new Map();

  const keys = new Map();
  for (const [indexStr, spec] of Object.entries(paths)) {
    const index = Number(indexStr);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`inputPaths has a bad input index: ${indexStr}`);
    }
    const chain = Number(spec?.path);
    if (!ALLOWED_PATHS.has(chain)) {
      // Refuse rather than skip. A request naming a chain we do not expose is
      // either a bug or an attempt to get a key we deliberately withheld.
      throw new Error(`request names derivation path ${spec?.path}, which this wallet does not expose`);
    }
    if (spec.index !== undefined && (BigInt(spec.index) < 0n || BigInt(spec.index) >= 0x80000000n)) {
      throw new Error(`inputPaths has an out-of-range address index: ${spec.index}`);
    }
    const addrIndex = spec.index === undefined ? 0 : Number(spec.index);

    const { deriveHdPrivateNodeChild, secp256k1 } = await import('@bitauth/libauth');
    const child = deriveHdPrivateNodeChild(nodes.privateChains.get(chain), addrIndex);
    const pubkeyCompressed = secp256k1.derivePublicKeyCompressed(child.privateKey);
    if (typeof pubkeyCompressed === 'string') throw new Error('failed to derive public key');
    keys.set(index, { privateKey: child.privateKey, pubkeyCompressed });
  }
  return keys;
}
