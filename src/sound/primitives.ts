import { getAudioContext, getMaster, trackNode } from './context';

export type NoiseType = 'white' | 'pink' | 'brown';

const bufferCache = new Map<string, AudioBuffer>();

export function makeNoiseBuffer(type: NoiseType, duration: number): AudioBuffer {
  const ctx = getAudioContext();
  const key = `${type}:${duration}:${ctx.sampleRate}`;
  const cached = bufferCache.get(key);
  if (cached) return cached;

  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);

  if (type === 'white') {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    // Paul Kellet's pink noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // brown / red noise — integrated white
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + w * 0.02);
      if (last > 1) last = 1; else if (last < -1) last = -1;
      data[i] = last * 3.5;
    }
  }

  bufferCache.set(key, buf);
  return buf;
}

export interface EnvelopeOpts {
  attack: number;
  decay?: number;
  sustain?: number;
  release: number;
  peak?: number;
  hold?: number; // time at sustain before release
}

/** Apply ADSR to a gain node starting at t0. Returns the scheduled end time. */
export function applyEnvelope(gain: GainNode, t0: number, env: EnvelopeOpts): number {
  const peak = env.peak ?? 1;
  const sustain = env.sustain ?? peak * 0.7;
  const decay = env.decay ?? 0.02;
  const hold = env.hold ?? 0;

  const g = gain.gain;
  g.cancelScheduledValues(t0);
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(peak, t0 + env.attack);
  g.linearRampToValueAtTime(sustain, t0 + env.attack + decay);
  if (hold > 0) g.setValueAtTime(sustain, t0 + env.attack + decay + hold);
  const endTime = t0 + env.attack + decay + hold + env.release;
  g.linearRampToValueAtTime(0, endTime);
  return endTime;
}

export interface NoiseVoiceOpts {
  type?: NoiseType;
  duration: number; // source buffer duration
  env: EnvelopeOpts;
  filter?: { type: BiquadFilterType; freq: number; q?: number; freqEnd?: number };
  lowShelfBoost?: number;
  loop?: boolean;
  output?: AudioNode;
  detune?: number; // playbackRate multiplier (1 = normal)
}

export interface VoiceHandle {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  stop(at?: number): void;
}

/** One-shot filtered noise burst. Auto-stops at envelope end. */
export function playNoise(opts: NoiseVoiceOpts): VoiceHandle {
  const ctx = getAudioContext();
  const t0 = ctx.currentTime;
  const buf = makeNoiseBuffer(opts.type ?? 'white', opts.duration);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = opts.loop ?? false;
  if (opts.detune) src.playbackRate.value = opts.detune;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  let node: AudioNode = src;
  if (opts.filter) {
    const f = ctx.createBiquadFilter();
    f.type = opts.filter.type;
    f.frequency.value = opts.filter.freq;
    if (opts.filter.q != null) f.Q.value = opts.filter.q;
    if (opts.filter.freqEnd != null) {
      f.frequency.setValueAtTime(opts.filter.freq, t0);
      f.frequency.exponentialRampToValueAtTime(
        Math.max(20, opts.filter.freqEnd),
        t0 + opts.env.attack + (opts.env.decay ?? 0) + (opts.env.hold ?? 0) + opts.env.release,
      );
    }
    node.connect(f);
    node = f;
  }
  node.connect(gain);
  gain.connect(opts.output ?? getMaster());

  const end = applyEnvelope(gain, t0, opts.env);
  src.start(t0);
  src.stop(end + 0.05);
  trackNode(src);

  return {
    source: src,
    gain,
    stop(at?: number) {
      const when = at ?? ctx.currentTime;
      gain.gain.cancelScheduledValues(when);
      gain.gain.setTargetAtTime(0, when, 0.03);
      try { src.stop(when + 0.15); } catch { /* already stopped */ }
    },
  };
}

export interface OscVoiceOpts {
  type: OscillatorType;
  freq: number;
  freqEnd?: number; // exponential sweep
  env: EnvelopeOpts;
  filter?: { type: BiquadFilterType; freq: number; q?: number };
  output?: AudioNode;
}

export function playOsc(opts: OscVoiceOpts): VoiceHandle {
  const ctx = getAudioContext();
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  osc.frequency.setValueAtTime(opts.freq, t0);
  const totalLen = opts.env.attack + (opts.env.decay ?? 0) + (opts.env.hold ?? 0) + opts.env.release;
  if (opts.freqEnd != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + totalLen);
  }

  const gain = ctx.createGain();
  gain.gain.value = 0;

  let node: AudioNode = osc;
  if (opts.filter) {
    const f = ctx.createBiquadFilter();
    f.type = opts.filter.type;
    f.frequency.value = opts.filter.freq;
    if (opts.filter.q != null) f.Q.value = opts.filter.q;
    node.connect(f);
    node = f;
  }
  node.connect(gain);
  gain.connect(opts.output ?? getMaster());

  const end = applyEnvelope(gain, t0, opts.env);
  osc.start(t0);
  osc.stop(end + 0.05);
  trackNode(osc);

  return {
    source: osc,
    gain,
    stop(at?: number) {
      const when = at ?? ctx.currentTime;
      gain.gain.cancelScheduledValues(when);
      gain.gain.setTargetAtTime(0, when, 0.02);
      try { osc.stop(when + 0.1); } catch { /* already stopped */ }
    },
  };
}

/** Combine multiple voices into a single controllable handle. */
export function group(voices: VoiceHandle[]): { stop: (at?: number) => void } {
  return {
    stop(at?: number) {
      for (const v of voices) v.stop(at);
    },
  };
}

/**
 * Spawn N short noise clicks scattered over `duration` seconds — the signature
 * of arc/crackle/spark sounds. Each click is bandpass-filtered at a random freq.
 */
export interface CrackleBurstOpts {
  duration: number;
  count: number;
  clickLen?: number;
  freqMin?: number;
  freqMax?: number;
  qMin?: number;
  qMax?: number;
  peak?: number;
  noiseType?: NoiseType;
  output?: AudioNode;
}

export function playCrackleBurst(opts: CrackleBurstOpts): { stop: (at?: number) => void } {
  const count = Math.max(1, Math.floor(opts.count));
  const handles: VoiceHandle[] = [];
  for (let i = 0; i < count; i++) {
    const delay = Math.random() * opts.duration;
    const freq = (opts.freqMin ?? 1500) + Math.random() * ((opts.freqMax ?? 5000) - (opts.freqMin ?? 1500));
    const q = (opts.qMin ?? 2) + Math.random() * ((opts.qMax ?? 6) - (opts.qMin ?? 2));
    const peak = (opts.peak ?? 0.45) * (0.6 + Math.random() * 0.4);
    const clickLen = opts.clickLen ?? 0.04;
    const timeoutId = window.setTimeout(() => {
      const h = playNoise({
        type: opts.noiseType ?? 'white',
        duration: clickLen,
        env: { attack: 0.001, decay: 0.008, sustain: 0, release: clickLen * 0.6, peak },
        filter: { type: 'bandpass', freq, q },
        output: opts.output,
      });
      handles.push(h);
    }, delay * 1000);
    // wrap to cancel the setTimeout if stopped early
    handles.push({
      source: undefined as unknown as AudioScheduledSourceNode,
      gain: undefined as unknown as GainNode,
      stop() { window.clearTimeout(timeoutId); },
    } as VoiceHandle);
  }
  return {
    stop(at?: number) {
      for (const h of handles) h.stop(at);
    },
  };
}
