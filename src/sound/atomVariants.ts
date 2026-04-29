/**
 * ATOM-themed hit/kill sound candidates.
 *
 * All procedural — synthesized via primitives. Designed in two families:
 *  - HIT: tonal + sweep, layered, chain-friendly
 *  - KILL: descending tone with tail, longer presence
 *
 * Heavy sub-bass variants (core-collapse, graviton-thud) are kept lighter
 * than full kill weight so chain hits don't clip on ×10 stacking.
 */
import { playNoise, playOsc, group } from './primitives';

export type AtomVariantKind = 'hit' | 'kill';

export interface AtomVariant {
  id: string;
  label: string;
  description: string;
  kind: AtomVariantKind;
  play(): { stop: (at?: number) => void };
}

// ── HIT family ──

export const plasmaZap: AtomVariant = {
  id: 'plasma-zap',
  label: '플라즈마 자프',
  description: '톤 스윕 — 1.8kHz→380Hz 떨어지는 전기 버스트',
  kind: 'hit',
  play() {
    const zap = playOsc({
      type: 'sawtooth', freq: 1800, freqEnd: 380,
      env: { attack: 0.001, decay: 0.015, sustain: 0.2, release: 0.06, peak: 0.32 },
      filter: { type: 'bandpass', freq: 1600, q: 3 },
    });
    const fizz = playNoise({
      type: 'white', duration: 0.07,
      env: { attack: 0.001, decay: 0.015, sustain: 0, release: 0.05, peak: 0.25 },
      filter: { type: 'highpass', freq: 2000, q: 0.7 },
    });
    return group([zap, fizz]);
  },
};

export const fusionPop: AtomVariant = {
  id: 'fusion-pop',
  label: '핵융합 팝',
  description: '두 사인이 살짝 디튠된 융합 — 부드러운 팝',
  kind: 'hit',
  play() {
    const a = playOsc({
      type: 'sine', freq: 520,
      env: { attack: 0.002, decay: 0.02, sustain: 0.2, release: 0.07, peak: 0.4 },
    });
    const b = playOsc({
      type: 'sine', freq: 545,
      env: { attack: 0.002, decay: 0.02, sustain: 0.2, release: 0.07, peak: 0.4 },
    });
    return group([a, b]);
  },
};

export const coreCollapse: AtomVariant = {
  id: 'core-collapse',
  label: '핵심 붕괴',
  description: '서브 베이스 + 붕괴 럼블 — 묵직한 임팩트 (freq 지터로 체인 공명 회피)',
  kind: 'hit',
  play() {
    // Per-instance freq jitter (±8%) breaks phase coherence when stacked.
    // Without this, ~30Hz sub waves at 30ms gap align constructively → clipping.
    const subStart = 95 * (0.92 + Math.random() * 0.16);
    const subEnd = 30 * (0.92 + Math.random() * 0.16);
    const clickFreq = 1900 * (0.9 + Math.random() * 0.2);
    const sub = playOsc({
      type: 'sine', freq: subStart, freqEnd: subEnd,
      env: { attack: 0.003, decay: 0.06, sustain: 0.45, hold: 0.12, release: 0.45, peak: 0.85 },
    });
    const rumble = playNoise({
      type: 'brown', duration: 0.7,
      env: { attack: 0.003, decay: 0.08, sustain: 0.35, hold: 0.1, release: 0.5, peak: 0.55 },
      filter: { type: 'lowpass', freq: 600, q: 0.7 },
    });
    const click = playNoise({
      type: 'white', duration: 0.16,
      env: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.12, peak: 0.4 },
      filter: { type: 'bandpass', freq: clickFreq, q: 2 },
    });
    return group([sub, rumble, click]);
  },
};

export const orbitalResonance: AtomVariant = {
  id: 'orbital-resonance',
  label: '궤도 공명',
  description: '3개 사인 하모닉(440·660·880Hz, 5도+옥타브) — 종소리 같은 임팩트',
  kind: 'hit',
  play() {
    const fundamental = playOsc({
      type: 'sine', freq: 442,
      env: { attack: 0.001, decay: 0.025, sustain: 0.25, release: 0.12, peak: 0.4 },
    });
    const fifth = playOsc({
      type: 'sine', freq: 663,
      env: { attack: 0.001, decay: 0.025, sustain: 0.2, release: 0.1, peak: 0.3 },
    });
    const octave = playOsc({
      type: 'sine', freq: 884,
      env: { attack: 0.001, decay: 0.02, sustain: 0.15, release: 0.08, peak: 0.22 },
    });
    return group([fundamental, fifth, octave]);
  },
};

export const gravitonThud: AtomVariant = {
  id: 'graviton-thud',
  label: '중력자 타격',
  description: '서브 스윕 75→25Hz + 짧은 클릭 — freq 지터로 장판 펄스 누적 시 크래클 방지',
  kind: 'hit',
  play() {
    // freq 지터 ±10% — 장판형 스킬이 펄스마다 최대 8개를 30ms 간격으로 발사할 때
    // 동일 sub freq가 위상 코히어런스로 누적되어 "깨지는 소리"가 나는 현상 방지.
    // attack을 2ms→5ms로 늘려 onset transient도 부드럽게.
    const subStart = 75 * (0.9 + Math.random() * 0.2);
    const subEnd = 25 * (0.9 + Math.random() * 0.2);
    const clickFreq = 2200 * (0.85 + Math.random() * 0.3);
    const sub = playOsc({
      type: 'sine', freq: subStart, freqEnd: subEnd,
      env: { attack: 0.005, decay: 0.04, sustain: 0.3, release: 0.12, peak: 0.5 },
    });
    // 클릭 q 2.5→1.2: bandpass resonance가 stacked transient에서 "드득드득" 만드는 주범.
    // 낮춘 q는 더 wide/smooth한 고주파 짧은 퍼프로 들림.
    const click = playNoise({
      type: 'white', duration: 0.05,
      env: { attack: 0.003, decay: 0.012, sustain: 0, release: 0.035, peak: 0.3 },
      filter: { type: 'bandpass', freq: clickFreq, q: 1.2 },
    });
    return group([sub, click]);
  },
};

export const gammaPulse: AtomVariant = {
  id: 'gamma-pulse',
  label: '감마 펄스',
  description: '스퀘어 스윕 1400→320Hz + 좁은 밴드패스 — plasma-zap 정제판',
  kind: 'hit',
  play() {
    const sweep = playOsc({
      type: 'square', freq: 1400, freqEnd: 320,
      env: { attack: 0.001, decay: 0.012, sustain: 0.18, release: 0.05, peak: 0.28 },
      filter: { type: 'bandpass', freq: 1100, q: 4 },
    });
    const air = playNoise({
      type: 'white', duration: 0.04,
      env: { attack: 0.001, decay: 0.008, sustain: 0, release: 0.03, peak: 0.18 },
      filter: { type: 'highpass', freq: 3000, q: 0.7 },
    });
    return group([sweep, air]);
  },
};

export const chainReaction: AtomVariant = {
  id: 'chain-reaction',
  label: '연쇄 반응',
  description: '두 클릭 → 톤 페이드인 — 점화 + 반응 패턴 (체인용 설계)',
  kind: 'hit',
  play() {
    const click1 = playNoise({
      type: 'white', duration: 0.02,
      env: { attack: 0.0005, decay: 0.005, sustain: 0, release: 0.012, peak: 0.42 },
      filter: { type: 'bandpass', freq: 2400, q: 3.5 },
    });
    const click2 = playNoise({
      type: 'white', duration: 0.02,
      env: { attack: 0.018, decay: 0.005, sustain: 0, release: 0.012, peak: 0.38 },
      filter: { type: 'bandpass', freq: 2900, q: 3.5 },
    });
    const tone = playOsc({
      type: 'sine', freq: 480, freqEnd: 280,
      env: { attack: 0.012, decay: 0.025, sustain: 0.22, release: 0.07, peak: 0.32 },
    });
    return group([click1, click2, tone]);
  },
};

// ── KILL family ──

export const atomicDecay: AtomVariant = {
  id: 'atomic-decay',
  label: '원자 붕괴',
  description: '하강 사인(440→55Hz) + 핑크 잔향 — 차분한 처치',
  kind: 'kill',
  play() {
    const tone = playOsc({
      type: 'sine', freq: 440, freqEnd: 55,
      env: { attack: 0.002, decay: 0.05, sustain: 0.3, hold: 0.04, release: 0.32, peak: 0.55 },
    });
    const tail = playNoise({
      type: 'pink', duration: 0.4,
      env: { attack: 0.005, decay: 0.05, sustain: 0.25, release: 0.32, peak: 0.3 },
      filter: { type: 'lowpass', freq: 1200, q: 0.8 },
    });
    return group([tone, tail]);
  },
};

export const isotopeWarp: AtomVariant = {
  id: 'isotope-warp',
  label: '동위원소 왜곡',
  description: '디튠된 두 사인 320→60Hz 평행 하강 — 부드러운 4Hz 비팅 + freq 지터(체인 안전)',
  kind: 'kill',
  play() {
    // freq 지터 ±5% — 전기 체인에서 다중 인스턴스 위상 코히어런스 방지.
    // 디튠 4Hz로 축소 (이전 8Hz는 버즈가 강했음). 시작 freq를 320Hz로 낮춰 귀 피로 감소.
    const startA = 320 * (0.95 + Math.random() * 0.1);
    const endA = 60 * (0.95 + Math.random() * 0.1);
    const startB = startA * 1.012; // ~4Hz beat at 320Hz
    const endB = endA * 1.013;
    const a = playOsc({
      type: 'sine', freq: startA, freqEnd: endA,
      env: { attack: 0.003, decay: 0.05, sustain: 0.32, hold: 0.02, release: 0.22, peak: 0.42 },
    });
    const b = playOsc({
      type: 'sine', freq: startB, freqEnd: endB,
      env: { attack: 0.003, decay: 0.05, sustain: 0.3, hold: 0.02, release: 0.22, peak: 0.38 },
    });
    const tail = playNoise({
      type: 'pink', duration: 0.28,
      env: { attack: 0.008, decay: 0.04, sustain: 0.18, release: 0.2, peak: 0.2 },
      filter: { type: 'lowpass', freq: 700, q: 0.8 },
    });
    return group([a, b, tail]);
  },
};

export const neutrinoShimmer: AtomVariant = {
  id: 'neutrino-shimmer',
  label: '중성미자 시머',
  description: '하모닉 3중 평행 하강(1100·1650·2200→) + 핑크 잔향 — 영묘한 처치',
  kind: 'kill',
  play() {
    const h1 = playOsc({
      type: 'sine', freq: 1100, freqEnd: 300,
      env: { attack: 0.004, decay: 0.05, sustain: 0.28, release: 0.26, peak: 0.32 },
    });
    const h2 = playOsc({
      type: 'sine', freq: 1650, freqEnd: 450,
      env: { attack: 0.004, decay: 0.05, sustain: 0.24, release: 0.24, peak: 0.26 },
    });
    const h3 = playOsc({
      type: 'sine', freq: 2200, freqEnd: 600,
      env: { attack: 0.004, decay: 0.05, sustain: 0.2, release: 0.22, peak: 0.2 },
    });
    const tail = playNoise({
      type: 'pink', duration: 0.3,
      env: { attack: 0.008, decay: 0.04, sustain: 0.18, release: 0.22, peak: 0.22 },
      filter: { type: 'highpass', freq: 1200, q: 0.7 },
    });
    return group([h1, h2, h3, tail]);
  },
};

export const ATOM_VARIANTS: AtomVariant[] = [
  // hit family
  plasmaZap, fusionPop, coreCollapse,
  orbitalResonance, gravitonThud, gammaPulse, chainReaction,
  // kill family
  atomicDecay, isotopeWarp, neutrinoShimmer,
];
