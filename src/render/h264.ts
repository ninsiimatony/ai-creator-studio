// Minimal H.264 SPS parsing, only far enough to read the VUI colour fields.
//
// Why: the encoder decides the colour range/matrix it writes into the H.264 stream (Chrome writes full-range
// flags). The MP4 container carries its own colour tag, and players can disagree about which one wins, so the
// container must be tagged to match what the bitstream actually declares. We read it here and never alter the stream.

export type VuiColor = { fullRange: boolean; primaries: number; transfer: number; matrix: number };
export type VuiPositions = {
  fullRange: number;
  primaries: number;
  transfer: number;
  matrix: number;
};

/** Removes emulation-prevention bytes (00 00 03 -> 00 00). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** Inserts emulation-prevention bytes where a 00 00 0x (x <= 3) pattern would appear. */
export function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

class Bits {
  pos = 0;
  constructor(private d: Uint8Array) {}
  bit(): number {
    const byte = this.d[this.pos >> 3];
    if (byte === undefined) throw new Error("SPS ended early");
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 32) throw new Error("bad exp-golomb");
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: Bits, size: number) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Finds the VUI colour fields in an unescaped SPS NAL (starting with the NAL header byte). Returns null if absent. */
export function findVuiColor(rbsp: Uint8Array): { value: VuiColor; at: VuiPositions } | null {
  const r = new Bits(rbsp);
  r.bits(8); // NAL header
  const profile = r.bits(8);
  r.bits(8); // constraint flags
  r.bits(8); // level
  r.ue(); // sps id
  if (HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++)
        if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  r.ue();
  r.ue();
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference_flag
  if (r.bit()) {
    r.ue();
    r.ue();
    r.ue();
    r.ue();
  }
  if (!r.bit()) return null; // no VUI
  if (r.bit()) {
    if (r.bits(8) === 255) r.bits(32); // extended SAR
  }
  if (r.bit()) r.bit(); // overscan
  if (!r.bit()) return null; // no video_signal_type
  r.bits(3); // video_format
  const fullRangePos = r.pos;
  const fullRange = r.bit();
  if (!r.bit()) return null; // no colour description
  const primariesPos = r.pos;
  const primaries = r.bits(8);
  const transferPos = r.pos;
  const transfer = r.bits(8);
  const matrixPos = r.pos;
  const matrix = r.bits(8);
  return {
    value: { fullRange: fullRange === 1, primaries, transfer, matrix },
    at: {
      fullRange: fullRangePos,
      primaries: primariesPos,
      transfer: transferPos,
      matrix: matrixPos,
    },
  };
}

const PRIMARIES: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020" };
const TRANSFER: Record<number, string> = {
  1: "bt709",
  6: "smpte170m",
  13: "iec61966-2-1",
  16: "pq",
  18: "hlg",
};
const MATRIX: Record<number, string> = {
  0: "rgb",
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020-ncl",
};

export type ContainerColor = {
  primaries: string;
  transfer: string;
  matrix: string;
  fullRange: boolean;
};

/**
 * The colour space an H.264 stream declares in its SPS, expressed in WebCodecs names so the MP4 container can
 * be tagged to agree with it. Returns null when the stream declares nothing (decoders then assume BT.709 limited).
 */
export function colorFromAvcC(avcC: Uint8Array): ContainerColor | null {
  try {
    if (avcC[0] !== 1 || ((avcC[5] ?? 0) & 0x1f) < 1) return null;
    const len = ((avcC[6] ?? 0) << 8) | (avcC[7] ?? 0);
    const sps = avcC.subarray(8, 8 + len);
    const v = findVuiColor(unescapeRbsp(sps))?.value;
    if (!v) return null;
    const primaries = PRIMARIES[v.primaries];
    const transfer = TRANSFER[v.transfer];
    const matrix = MATRIX[v.matrix];
    if (!primaries || !transfer || !matrix) return null;
    return { primaries, transfer, matrix, fullRange: v.fullRange };
  } catch {
    return null;
  }
}
