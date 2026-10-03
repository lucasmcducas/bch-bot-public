# WizardConnect: how our wallet can sign inside the app

Luke: "you cant connect a wallet? the whole point is for our omarchy wallet to do
it." Correct, and I had drifted into proposing the browser sign instead — which
abandons the point of the product. The browser should be a UI, not the signer.

## It already exists

`https://app.cauldron.quest` ships **wizardconnect**, a bridge built for exactly
this shape: a Node wallet holding a key on one machine, a dapp in a browser on
another. From the app bundle:

    PU = `https://signer.riften.net`
    Gv = `cauldron`, Kv = `walletconnect`, qv = `wizard`
    Ez = `wizardconnect-session`
    class ... { sendSignRequest(e) { ... this.conn.relay(e) ... } }

and a full dapp-side client: `isWalletDiscovered()`, `nextSequence()`,
`sendSignRequest()`, `pushDappReady()`, `pendingSignatureRequests`, key exchange
with a 30s timeout. This is not a hack or an extension shim; it is a documented
protocol the app ships in its own bundle.

Spec and reference implementation: `github.com/mainnet-pat/wc2-bch-bcr`
(README + `examples/react/ConnectorContext.tsx`). Tapswap and Cashonize already
work through it.

## The interface our wallet implements

```ts
export interface IConnector {
  address(): Promise<string | undefined>;
  signTransaction(options: WcSignTransactionRequest): Promise<WcSignTransactionResponse | undefined>;
  signMessage(options: WcSignMessageRequest): Promise<WcSignMessageResponse | undefined>;
  connect(): Promise<void>;
  connected(): Promise<boolean>;
  disconnect(): Promise<void>;
  on(event: "addressChanged", cb: Function): void;
  on(event: "disconnect", cb: Function): void;
}
```

Three methods matter, and **we already have all three**:

| Method | What it needs | Do we have it |
|---|---|---|
| `address()` | one cashaddress from our HD chain | yes — `deriveReceivingAddresses` |
| `signTransaction()` | sign specific inputs of a dapp-built tx | yes — `signExternalTransaction`, already used for the CLI swap, and the exact-outpoint gate is right there |
| `signMessage()` | sign arbitrary bytes | yes — P2PKH signing |

## The two details that make it work

**The app marks which inputs we sign by setting `unlockingBytecode` to an empty
`Uint8Array`.** That is the same convention our own swap path already speaks: the
router tells us `inputsToSign`, we sign those and nothing else. Cauldron's 13
covenant inputs arrive signature-free by design, and ours arrive empty. The
wallet may also detect that a UTXO is its own and sign it without being asked.

**Pubkey and signature placeholders.** CashScript contracts take a pubkey and a
signature as constructor/function arguments, and dapps work with cashaddresses,
which encode pubkey *hashes*. So the dapp cannot know either value. It signals
them with fixed-size zero arrays:

> We signal the use of pubkeys by using a 33-byte long zero-filled arrays and
> schnorr (the currently supported type) signatures by using a 65-byte long
> zero-filled arrays. Wallet detects these patterns and replaces them
> accordingly.

A 33-byte zero array anywhere in the transaction means "put the wallet's pubkey
here". A 65-byte zero array means "put a Schnorr signature here". The wallet
substitutes both. Our existing `buildStakeTransaction` and covenant signing code
already does pubkey substitution, so this is a pattern match, not new machinery.

`options.sourceOutputs` is transmitted with libauth's `stringify` and must be
parsed with the `parseExtendedJson` shown in the README — it round-trips
`Uint8Array` and `BigInt` as `<Uint8Array: 0x…>` and `<bigint: …n>`.

## What this means for the swap

The whole `swap-open` handoff is superseded by the right architecture:

```
app.cauldron.quest  ──wizardconnect──>  our wallet
   builds the tx from the WORKING router        signs with our key
   (live pools, correct route)                  runs our verification gates
```

The browser is a UI. **Our wallet is the signer.** No extension, no
WalletConnect QR, no handing the key to a page.

This also sidesteps the drained-parent problem honestly: the app's router is the
one with live positions — its own TVL panel showed $245,633 and two trades six
seconds apart while our builder was naming a parent whose 56 outputs were all
spent. Let the working router build it, sign it with our key.

## Status

Nothing implemented. This is the design, read out of the app's own bundle and
the reference spec, and it is small: a relay client, three methods, two
placeholder patterns, and reuse of signing code that already exists and already
passes its gates.

The one thing left to pin down before writing it is the relay's transport and
the exact `WcSignTransactionRequest` field names — those are in the bundle and
in the spec, not yet read in full.
