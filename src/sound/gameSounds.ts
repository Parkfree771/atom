/**
 * Game SFX API.
 *
 * Per-element hit functions map tier-1 skills to ATOM variants:
 *   - playHitField  → graviton-thud (water / earth / dark / fire — field-style DOT)
 *   - playHitBeam   → isotope-warp  (light — single beam shot)
 *   - playHitChain  → isotope-warp staggered (electric — chain hits)
 *
 * playHit is a generic fallback (used by combo effects without explicit mapping).
 */
import { unlockAudio } from './context';
import { playNoise, playOsc, group } from './primitives';
import { gravitonThud, isotopeWarp } from './atomVariants';

const HIT_THROTTLE_MS = 25;
const KILL_THROTTLE_MS = 35;

let lastHit = 0;
let lastKill = 0;

// Cap per-call to prevent runaway audio density. Visuals + limiter cover the rest.
const MAX_FIELD_SOUNDS = 5;
const MAX_BEAM_SOUNDS = 6;

// ── Tier-1 skill hits ──
// Each takes a count = number of enemies hit this pulse/shot. Sounds are
// staggered with gap > 50ms — below that sits in the 20-40Hz "roughness"
// perception band and stacks into a buzzing/grinding sound.

export function playHitField(count = 1, gapMs = 70): void {
  if (count <= 0) return;
  void unlockAudio();
  const n = Math.min(count, MAX_FIELD_SOUNDS);
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => gravitonThud.play(), i * gapMs);
  }
}

export function playHitBeam(count = 1, gapMs = 60): void {
  if (count <= 0) return;
  void unlockAudio();
  const n = Math.min(count, MAX_BEAM_SOUNDS);
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => isotopeWarp.play(), i * gapMs);
  }
}

// Electric chain — 80ms gap (isotope-warp instances breathe within 2s cooldown).
export function playHitChain(count: number, gapMs = 80): void {
  if (count <= 0) return;
  void unlockAudio();
  for (let i = 0; i < count; i++) {
    window.setTimeout(() => isotopeWarp.play(), i * gapMs);
  }
}

// ── Generic (fallback for combos / unmapped uses) ──

function impact(pitch: number): { stop: (at?: number) => void } {
  const click = playNoise({
    type: 'white',
    duration: 0.06,
    env: { attack: 0.001, decay: 0.012, sustain: 0, release: 0.04, peak: 0.5 },
    filter: { type: 'bandpass', freq: 2400 * pitch, q: 2.5 },
  });
  const body = playNoise({
    type: 'pink',
    duration: 0.1,
    env: { attack: 0.002, decay: 0.03, sustain: 0, release: 0.07, peak: 0.35 },
    filter: { type: 'lowpass', freq: 900 * pitch, q: 1 },
  });
  return group([click, body]);
}

export function playHit(): void {
  const now = performance.now();
  if (now - lastHit < HIT_THROTTLE_MS) return;
  lastHit = now;
  void unlockAudio();
  impact(0.85 + Math.random() * 0.3);
}

// ── Kill ──

export function playKill(opts: { boss?: boolean } = {}): void {
  const now = performance.now();
  if (now - lastKill < KILL_THROTTLE_MS) return;
  lastKill = now;
  void unlockAudio();

  if (opts.boss) {
    playOsc({
      type: 'sine',
      freq: 110, freqEnd: 32,
      env: { attack: 0.002, decay: 0.05, sustain: 0.4, hold: 0.08, release: 0.45, peak: 0.85 },
    });
    playNoise({
      type: 'brown',
      duration: 0.6,
      env: { attack: 0.002, decay: 0.08, sustain: 0.3, hold: 0.1, release: 0.45, peak: 0.55 },
      filter: { type: 'lowpass', freq: 600, q: 0.7 },
    });
    playNoise({
      type: 'white',
      duration: 0.18,
      env: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.12, peak: 0.4 },
      filter: { type: 'bandpass', freq: 1800, q: 2 },
    });
    return;
  }

  const pitch = 0.9 + Math.random() * 0.2;
  playOsc({
    type: 'triangle',
    freq: 220 * pitch, freqEnd: 70 * pitch,
    env: { attack: 0.001, decay: 0.04, sustain: 0.2, release: 0.18, peak: 0.55 },
  });
  playNoise({
    type: 'pink',
    duration: 0.18,
    env: { attack: 0.002, decay: 0.04, sustain: 0, release: 0.13, peak: 0.4 },
    filter: { type: 'bandpass', freq: 1500 * pitch, q: 2 },
  });
}
