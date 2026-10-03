Check the exact outpoint, not just whether the covenant has any live coin

swap.mjs's pre-signing gate asks scriptHasUnspent(lockingScript), which answers
"does this covenant have ANY unspent output anywhere". That is not the question
that matters. A competing swap re-creates the covenant at a new position, so the
lock keeps live coins while the specific outpoint the router selected is already
consumed. The gate then says "unspent" and we sign a transaction that cannot
possibly be accepted.

Measured on parent fd02de7d..1138, 56 outputs, all 56 spent:

  v 0  gate says unspent   exact outpoint: SPENT
  v 1  gate says unspent   exact outpoint: SPENT
  v 2  gate says unspent   exact outpoint: SPENT
  v 3  gate says unspent   exact outpoint: SPENT
  v 4  gate says unspent   exact outpoint: SPENT
  v 5  gate says unspent   exact outpoint: SPENT
  v 6  gate says unspent   exact outpoint: SPENT

Meanwhile the same covenant locks report live coins from other transactions:

  h971235 v0   0f5e93ac...   1717810 sats
  h971235 v13  0f5e93ac...   2736037 sats
  h971247 v43  ebcf3aee...  11324336 sats
  h971247 v44  ebcf3aee...  11355884 sats
  h971262 v2   6038da57...   5672160 sats

The pool is alive and trading. Our position in it is not. The gate cannot tell
those apart, so it passed 12/12 and the node rejected all three retries with
"Missing inputs".

Also note the byte-order trap this exposed: libauth's
outpointTransactionHash is ALREADY the Electrum display order. Reversing it
produces a txid that decodes to ASCII hex text, which is not a transaction. The
repo's code builds the parent fetch by trying wire order first and falling back
to reversed, and the reversed candidate is the garbage one.

