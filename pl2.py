p='scripts/test-swap-prevout-liveness.mjs'
s=open(p).read()
old = "import { connect, listUnspent } from '../lib/network.mjs';"
new = "import { connectToken, listUnspent } from '../lib/network.mjs';"
assert old in s, 'import not found'
s = s.replace(old, new, 1)
# Every read goes through connect(); only connectToken indexes p2sh32.
s = s.replace('const c = await connect(', 'const c = await connectToken(', 1)
s = s.replace("await c.request('blockchain.transaction.get'", "await c.request('blockchain.transaction.get'", 1)
open(p,'w').write(s)
print('liveness test now uses the token-aware node')
