// lib/hex.mjs — tiny hex helper (avoid pulling another dep)
export function binToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBin(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error(`bad hex: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}