// IEEE 754 binary16 conversion, for the packed `velocity` and `remainder` fields: WGSL's `pack2x16float` and
// `unpack2x16float` on the GPU, these two on the CPU (scenes and tests). `Float16Array` is not in Chrome 113.
const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

/** The binary16 bits nearest to `value` (ties to even); out-of-range values become infinity. */
export function toHalf(value: number): number {
  scratch[0] = value;
  const bits = scratchBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp32 = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exp32 === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);

  const exp = exp32 - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;

  let half: number;
  let dropped: number;
  let halfway: number;
  if (exp <= 0) {
    // Subnormal result (or zero): the implicit leading bit becomes explicit and the mantissa shifts right.
    if (exp < -10) return sign;
    const shift = 14 - exp;
    const full = mantissa | 0x800000;
    half = full >>> shift;
    dropped = full & ((1 << shift) - 1);
    halfway = 1 << (shift - 1);
  } else {
    half = (exp << 10) | (mantissa >>> 13);
    dropped = mantissa & 0x1fff;
    halfway = 0x1000;
  }
  // A carry out of the mantissa rolls into the exponent, which is the correct rounding up.
  if (dropped > halfway || (dropped === halfway && (half & 1) === 1)) half++;
  return sign | half;
}

/** The value of the binary16 bits `half`. */
export function fromHalf(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exp === 0) return sign * mantissa * 2 ** -24;
  if (exp === 31) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
}

/** Two values as one `u32`, `x` in the low 16 bits: what `pack2x16float(vec2f(x, y))` returns. */
export function packHalf2(x: number, y: number): number {
  return (toHalf(x) | (toHalf(y) << 16)) >>> 0;
}

/** The two values of a `u32` packed by `packHalf2`. */
export function unpackHalf2(word: number): [number, number] {
  return [fromHalf(word & 0xffff), fromHalf(word >>> 16)];
}
