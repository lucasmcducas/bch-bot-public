Add a prevout-liveness test, and record why the swap is actually rejected

Read the raw JSON-RPC frame instead of trusting the client library, and the
node's real verdict finally appears:

    broadcast <our tx>  ERROR code=-32000
      "RPC error (-32602 InvalidParams): rejected by network; RPC error
       (-32000 Other): Call 'sendrawtransaction' to full node failed: Missing inputs"

    broadcast "00"      ERROR -32603 "failed to parse tx"

Two different failures, so my earlier "the node returns {} for valid and invalid
alike, therefore it is not evaluating anything" was wrong. The client library
collapses the JSON-RPC error object into an empty object, which is why
blockchain.transaction.broadcast looks like a silent {} no matter what. The node
was answering all along.

"Missing inputs" means the outpoint is absent from the UTXO set. It is not a
covenant-evaluation error and not a parse error: the node parsed the transaction
and passed it to the full node, which could not find the coins.

The parents all exist, so the transactions are not unknown. Their outputs are
spent. Verified against the repo's own known-good listUnspent():

    in[ 0] v 4   spent / absent
    ...
    in[12] v 0   spent / absent
    in[13] v 0   UNSPENT (1000 sats, h968967)     <- ours
    in[14] v 0   UNSPENT (800000 sats, h971038)  <- ours

h968967 matches what scripts/utxos.mjs reports, which is the control that makes
this reading trustworthy.

scripts/test-swap-prevout-liveness.mjs pins the distinction, 4/4.

The expensive bug along the way, worth remembering: a listunspent entry carries
BOTH outpoint_hash and tx_hash and they are not equal -- outpoint_hash is the
byte-reversed form. Matching on the wrong one reports every coin as spent. I hit
that and briefly believed the wallet's own inputs were gone.

Not a stale quote, either. A route built seconds later (0.002 BCH, 12 pools,
txid afbac2dd) spends the same dead parent 381179a5..02fd, so the router is
routing through pools whose outputs are already consumed. lib/router.mjs has no
pool-selection parameter -- route.quote takes only sell/buy/amount/side -- so
there is no way to steer around it from our side.

No funds moved: 0.01659311 BCH, 6 UTXOs, 2 ROACH, change_index 39.
