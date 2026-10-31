// Audio: mixing voice + music with ducking and fades, and a free procedural music generator.

export type Interval = [number, number];
export type Breakpoint = { t: number; gain: number };

export type EnvelopeOptions = {
  base: number;
  duck: number;
  attack?: number;
  release?: number;
  fadeIn?: number;
  fadeOut?: number;
};

/** Merges intervals that overlap or are closer than `gap` seconds. */
export function mergeIntervals(intervals: Interval[], gap = 0): Interval[] {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as Interval)
    .sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

/** Gain breakpoints for a music bed that dips under speech and fades in/out. Pure, so it is testable. */
export function duckingEnvelope(
  voice: Interval[],
  duration: number,
  o: EnvelopeOptions,
): Breakpoint[] {
  const attack = o.attack ?? 0.25;
  const release = o.release ?? 0.6;
  const fadeIn = o.fadeIn ?? 1;
  const fadeOut = o.fadeOut ?? 1.5;
  const pts: Breakpoint[] = [
    { t: 0, gain: 0 },
    { t: Math.min(fadeIn, duration), gain: o.base },
  ];
  for (const [s, e] of mergeIntervals(voice, attack + release)) {
    pts.push(
      { t: s - attack, gain: o.base },
      { t: s, gain: o.duck },
      { t: e, gain: o.duck },
      { t: e + release, gain: o.base },
    );
  }
  pts.push({ t: Math.max(0, duration - fadeOut), gain: o.base }, { t: duration, gain: 0 });
  // Keep times inside [0, duration] and non-decreasing.
  let prev = 0;
  return pts.map((p) => {
    const t = Math.min(duration, Math.max(prev, p.t));
    prev = t;
    return { t, gain: p.gain };
  });
}

/** Linear interpolation of an envelope (matches what the Web Audio ramps produce). */
export function gainAt(env: Breakpoint[], t: number): number {
  if (env.length === 0) return 0;
  if (t <= env[0]!.t) return env[0]!.gain;
  for (let i = 1; i < env.length; i++) {
    const a = env[i - 1]!;
    const b = env[i]!;
    if (t <= b.t)
      return b.t === a.t ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
  }
  return env[env.length - 1]!.gain;
}

export type MixInput = {
  duration: number;
  sampleRate?: number;
  voice: { buffer: AudioBuffer; start: number }[];
  music?: { buffer: AudioBuffer; volume: number; duck: boolean } | undefined;
};

/** Renders voice + music to one stereo AudioBuffer of exactly `duration` seconds. */
export async function mixAudio(inp: MixInput): Promise<AudioBuffer> {
  const sr = inp.sampleRate ?? 48000;
  const length = Math.max(1, Math.ceil(inp.duration * sr));
  const ctx = new OfflineAudioContext(2, length, sr);

  // A gentle limiter on the master so the sum of voice and music never clips.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  const master = ctx.createGain();
  master.gain.setValueAtTime(1, 0);
  master.gain.setValueAtTime(1, Math.max(0, inp.duration - 0.6));
  master.gain.linearRampToValueAtTime(0, inp.duration);
  master.connect(limiter).connect(ctx.destination);

  const voiceIntervals: Interval[] = [];
  for (const v of inp.voice) {
    const src = ctx.createBufferSource();
    src.buffer = v.buffer;
    src.connect(master);
    src.start(Math.max(0, v.start));
    voiceIntervals.push([v.start, v.start + v.buffer.duration]);
  }

  if (inp.music) {
    const src = ctx.createBufferSource();
    src.buffer = inp.music.buffer;
    src.loop = true;
    const g = ctx.createGain();
    const env = duckingEnvelope(inp.music.duck ? voiceIntervals : [], inp.duration, {
      base: inp.music.volume,
      duck: inp.music.volume * 0.3,
    });
    g.gain.setValueAtTime(env[0]!.gain, env[0]!.t);
    for (const p of env.slice(1)) g.gain.linearRampToValueAtTime(p.gain, p.t);
    src.connect(g).connect(master);
    src.start(0);
  }
  return ctx.startRendering();
}

const NOTE_SETS = [
  [110.0, 164.81, 220.0, 261.63, 329.63], // Am
  [87.31, 130.81, 174.61, 220.0, 261.63], // F
  [65.41, 130.81, 164.81, 196.0, 261.63], // C
  [98.0, 146.83, 196.0, 246.94, 293.66], // G
];

/**
 * A free, royalty-free ambient pad generated from code: four slowly evolving chords, 32 seconds,
 * designed to loop. Not a "composition by AI" — a simple procedural bed for under narration.
 */
export async function generateAmbientLoop(sampleRate = 48000, chordSec = 8): Promise<AudioBuffer> {
  const total = chordSec * NOTE_SETS.length;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1400;
  lp.Q.value = 0.6;
  lp.connect(ctx.destination);
  NOTE_SETS.forEach((notes, ci) => {
    const t0 = ci * chordSec;
    notes.forEach((f, ni) => {
      for (const [type, cents] of [
        ["sine", -5],
        ["triangle", 6],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = f;
        osc.detune.value = cents;
        const g = ctx.createGain();
        const peak = 0.05 / (1 + ni * 0.15);
        const attack = 2.2;
        const release = 2.6;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + attack);
        g.gain.setValueAtTime(peak, t0 + chordSec - release * 0.4);
        g.gain.linearRampToValueAtTime(0, Math.min(total, t0 + chordSec + release * 0.4));
        const pan = ctx.createStereoPanner();
        pan.pan.value = ((ni % 5) - 2) * 0.18;
        osc.connect(g).connect(pan).connect(lp);
        osc.start(t0);
        osc.stop(Math.min(total, t0 + chordSec + release));
      }
    });
  });
  const buf = await ctx.startRendering();
  // Normalise the peak so the bed has a predictable level.
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++)
    for (const s of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) {
    const k = 0.7 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i]! *= k;
    }
  }
  return buf;
}
