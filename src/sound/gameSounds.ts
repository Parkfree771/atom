/**
 * Game SFX API.
 *
 * Per-element hit functions:
 *   - playFieldDrop → 물방울 blup (water / earth / dark / 물+전기 — 장판형 펄스 stagger)
 *   - playHitBeam   → isotope-warp (light — single beam shot)
 *   - playHitChain  → isotope-warp staggered (electric — chain hits, 불+전기/빛+전기 c2)
 *   - playImpact    → core-collapse (묵직한 폭발 임팩트 — 물+불/빛+암흑/불+암흑 c2 단발 폭발)
 *   - playMeteorImpact → 짧은 운석 착탄 (~250ms — 유성우 콤보 4종 + 흙/불 ult, 100ms 간격 안전)
 *   - playGravitonThud → graviton-thud (마그마 균열 흙+불 3링 순차 폭발, 링당 1회)
 *   - playAtomicDecay → atomic-decay (빛 기반 c2 빔 발사 — 물+빛/불+빛/흙+빛, 발사당 1회)
 *   - playIsotopeWarp → isotope-warp 1회 (지속 발사 c3 hit — 사구아로/무지개 장마, 80ms throttle)
 *   - playDeepBoom    → deepBoom (큰 c3 폭발 burst — 개기일식/빅뱅/천지섬광, sub 75→22Hz)
 *   - playRollingBoom → rollingBoom (deepBoom과 layer — 천지섬광 FLASH 천둥 trail)
 *   - playDynamoClap  → 산업용 금속 박수 (자철 다이나모 RECONNECT, 250Hz 사각 + 80Hz sub)
 *   - playRiftBurst   → 균열 갈라짐 (심연균열 BURST, sub 70→25Hz + 1.5kHz crack + brown lp 500Hz)
 *
 * Continuous loops (sustain while skill active):
 *   - startFireRoar / stopFireRoar — 화염방사 whoosh, brown lp 900Hz
 *     (불은 roar loop만, 별도 hit tick 없음 — 6Hz 펄스 × 적 밀도 = 깨짐)
 *   - setDeepHumActive(bool) — 어두운 sub 럼블 (50+65Hz + 갈색 lp 120Hz)
 *     적용: c2 지속형 4종 (메일스트롬/퀵샌드/자기장폭풍/테슬라늪)
 *           + c3 사이클 gathering 4종 (개기일식 CONVERGE, 빅뱅 CONVERGE, 증기폭뢰 PRESSURE, 천지섬광 CONVERGE)
 *     중앙 토글 — 다중 active OK, 모두 꺼지면 stop
 *   - setAbyssShimmerActive(bool) — 종말의 먹구름 sustained (55+58Hz beat + 갈색 lp 220Hz)
 *     박동(throb) detuned sine beating, 사슬 사운드는 별도 없음
 *   - setTornadoHowlActive(bool) — 흑뢰 토네이도 sustained (50Hz sub + 갈색 lp 350Hz)
 *     휘몰아치는 어두운 바람, 체인 번개는 별도 없음
 *   - setGravityWellActive(bool) — 은하 소용돌이 sustained (45Hz sub + 60Hz octave + 갈색 lp 180Hz)
 *     가장 어둡고 무거운 중력 우물, 흡수 이벤트는 별도 없음
 *   - setMireSwampActive(bool) — 감전 퀵샌드 sustained base (50Hz sub + 갈색 lp 220Hz)
 *   - playMireZap() — 24f DoT 펄스 zap (사각 180Hz lp 600Hz, 1회)
 *
 * playHit is a generic fallback (used by combo effects without explicit mapping).
 */
import { unlockAudio, canAllocateBurst } from './context';
import type { VoiceHandle } from './primitives';
import { playNoise, playOsc, group } from './primitives';
import { isotopeWarp, coreCollapse, gravitonThud, atomicDecay, deepBoom, rollingBoom } from './atomVariants';

const HIT_THROTTLE_MS = 25;

let lastHit = 0;

// Per-function entry throttle. Prevents the same sound from firing twice within
// `ms` — protects against multi-combo overlap where 3+ effects trigger the same
// SFX in the same frame. Single-combo behavior unchanged.
const lastFiredAt = new Map<string, number>();
function shouldFire(key: string, ms: number): boolean {
  if (!canAllocateBurst()) return false;
  const now = performance.now();
  const last = lastFiredAt.get(key) ?? 0;
  if (now - last < ms) return false;
  lastFiredAt.set(key, now);
  return true;
}

// Cap per-call to prevent runaway audio density. Visuals + limiter cover the rest.
const MAX_BEAM_SOUNDS = 6;
const MAX_FIELD_SOUNDS = 5;
const MAX_CHAIN_SOUNDS = 10;

// ── Tier-1 skill hits ──
// Each takes a count = number of enemies hit this pulse/shot. Sounds are
// staggered with gap > 50ms — below that sits in the 20-40Hz "roughness"
// perception band and stacks into a buzzing/grinding sound.

// 물방울 blup — 사인 480→160Hz 급강하 + 짧은 핑크 잔향. freq 지터로 stacking 안전.
function wetBlupSound(): void {
  const startF = 480 * (0.88 + Math.random() * 0.24);
  const endF = 160 * (0.92 + Math.random() * 0.16);
  playOsc({
    type: 'sine', freq: startF, freqEnd: endF,
    env: { attack: 0.002, decay: 0.018, sustain: 0.4, release: 0.07, peak: 0.42 },
  });
  playNoise({
    type: 'pink', duration: 0.04,
    env: { attack: 0.003, decay: 0.01, sustain: 0.15, release: 0.025, peak: 0.18 },
    filter: { type: 'lowpass', freq: 800, q: 0.8 },
  });
}

export function playFieldDrop(count = 1, gapMs = 70): void {
  if (count <= 0) return;
  if (!shouldFire('fieldDrop', 20)) return;
  void unlockAudio();
  const n = Math.min(count, MAX_FIELD_SOUNDS);
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => { if (canAllocateBurst()) wetBlupSound(); }, i * gapMs);
  }
}

export function playHitBeam(count = 1, gapMs = 60): void {
  if (count <= 0) return;
  if (!shouldFire('hitBeam', 20)) return;
  void unlockAudio();
  const n = Math.min(count, MAX_BEAM_SOUNDS);
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => { if (canAllocateBurst()) isotopeWarp.play(); }, i * gapMs);
  }
}

// 묵직한 폭발/임팩트 — c2 폭발형 콤보용 (물+불, 빛+암흑, 빛+암흑 등 단발 큰 폭발).
// coreCollapse 자체에 ±8% freq 지터 내장돼 있어 2~3개 stacking 안전.
export function playImpact(): void {
  if (!shouldFire('impact', 30)) return;
  void unlockAudio();
  coreCollapse.play();
}

// 유성우 임팩트 — 묵직한 "쿠웅" 운석 착탄음 (~400~550ms total).
// 메커니즘 핵심: 시각 임팩트 프레임에 즉시 발화. setTimeout 사용 금지(비결정적 지연이
// 다중 콤보 동시 활성 시 사운드를 무작위로 어긋나게 만들어 "다다다다" 됨).
// 변동 폭은 freq/peak/release 자체에서만 — 타이밍은 절대 흔들지 않음.
export function playMeteorImpact(): void {
  if (!canAllocateBurst()) return;
  void unlockAudio();
  // Sub thump — 깊고 길게 (운석 무게감의 핵심).
  const subFreq = 48 + Math.random() * 28;        // 48~76Hz
  const subEnd = 16 + Math.random() * 14;         // 16~30Hz
  const subPeak = 0.65 + Math.random() * 0.2;     // 0.65~0.85
  const subRelease = 0.25 + Math.random() * 0.2;  // 0.25~0.45
  playOsc({
    type: 'sine', freq: subFreq, freqEnd: subEnd,
    env: { attack: 0.002, decay: 0.05, sustain: 0.4, release: subRelease, peak: subPeak },
  });
  // Mid body — 운석 본체 충돌 텍스처
  const bodyFreq = 110 + Math.random() * 80;      // 110~190Hz
  const bodyPeak = 0.28 + Math.random() * 0.12;   // 0.28~0.4
  playOsc({
    type: 'triangle', freq: bodyFreq, freqEnd: bodyFreq * 0.5,
    env: { attack: 0.003, decay: 0.05, sustain: 0.25, release: 0.15 + Math.random() * 0.1, peak: bodyPeak },
  });
  // Crack — 약하게 (지배적이면 "다다다" 됨). 클릭 흔적만 남김.
  const crackFreq = 1200 + Math.random() * 1000;  // 1200~2200Hz
  const crackPeak = 0.10 + Math.random() * 0.08;  // 0.10~0.18
  playNoise({
    type: 'white', duration: 0.03,
    env: { attack: 0.001, decay: 0.006, sustain: 0, release: 0.022, peak: crackPeak },
    filter: { type: 'bandpass', freq: crackFreq, q: 1.5 + Math.random() * 0.8 },
  });
  // 흙 scatter — 흙 부서지는 텍스처
  const scatterPeak = 0.28 + Math.random() * 0.18; // 0.28~0.46
  const scatterRel = 0.18 + Math.random() * 0.15;  // 0.18~0.33
  playNoise({
    type: 'brown', duration: 0.3,
    env: { attack: 0.004, decay: 0.05, sustain: 0.32, release: scatterRel, peak: scatterPeak },
    filter: { type: 'lowpass', freq: 450 + Math.random() * 400, q: 0.8 },
  });
}

// 중력자 타격 — 마그마 균열(흙+불) 3링 순차 폭발용. 링당 1회 호출.
// gravitonThud 자체에 freq 지터 내장 — 같은 프레임에 2~3링 동시 polish 안전.
export function playGravitonThud(): void {
  if (!shouldFire('gravitonThud', 30)) return;
  void unlockAudio();
  gravitonThud.play();
}

// 원자 붕괴 — 빛 기반 c2 빔 콤보(물+빛/불+빛/흙+빛) 발사 시. 빔 1발마다 1회 (7발 동시도 1회).
// 차분한 하강 사인 + 핑크 잔향 — 빔 임팩트 마무리감.
export function playAtomicDecay(): void {
  if (!shouldFire('atomicDecay', 30)) return;
  void unlockAudio();
  atomicDecay.play();
}

// 깊은 폭발 — c3 사이클형 burst용 (개기일식 CORONA_BURST, 빅뱅 EXPLODE, 천지섬광 FLASH).
// deepBoom variant: sub 75→22Hz longer + 갈색 lp 400Hz, 클릭 없음, 큰 폭발 묵직함.
export function playDeepBoom(): void {
  if (!shouldFire('deepBoom', 50)) return;
  void unlockAudio();
  deepBoom.play();
}

// 천둥 롤 — 천지섬광 FLASH에 deepBoom과 layer로 함께 재생.
// rollingBoom: sub 60→25Hz + 노이즈 필터 sweep 200→500Hz, 천둥 굴러가는 듯한 trail.
export function playRollingBoom(): void {
  if (!shouldFire('rollingBoom', 50)) return;
  void unlockAudio();
  rollingBoom.play();
}

// 심연균열 BURST — sub 70→25Hz + 1.5kHz 화이트 crack + 갈색 lp 500Hz, 콰앙 + 쩍 균열.
// 주기적(~2.17초)으로 발동, freq 지터로 stacking 안전.
export function playRiftBurst(): void {
  if (!shouldFire('riftBurst', 30)) return;
  void unlockAudio();
  playOsc({
    type: 'sine', freq: 70 * (0.92 + Math.random() * 0.16), freqEnd: 25,
    env: { attack: 0.003, decay: 0.05, sustain: 0.5, hold: 0.1, release: 0.45, peak: 0.8 },
  });
  playNoise({
    type: 'white', duration: 0.05,
    env: { attack: 0.001, decay: 0.012, sustain: 0, release: 0.04, peak: 0.4 },
    filter: { type: 'bandpass', freq: 1500 * (0.85 + Math.random() * 0.3), q: 2 },
  });
  playNoise({
    type: 'brown', duration: 0.45,
    env: { attack: 0.005, decay: 0.06, sustain: 0.32, release: 0.35, peak: 0.4 },
    filter: { type: 'lowpass', freq: 500, q: 0.7 },
  });
}

// 자철 다이나모 RECONNECT — 250Hz 사각 + 80Hz sub + 갈색 lp 350Hz, 펀치한 산업용 금속 박수.
export function playDynamoClap(): void {
  if (!shouldFire('dynamoClap', 30)) return;
  void unlockAudio();
  playOsc({
    type: 'square', freq: 250 * (0.95 + Math.random() * 0.1),
    env: { attack: 0.001, decay: 0.025, sustain: 0.2, release: 0.1, peak: 0.35 },
    filter: { type: 'lowpass', freq: 700, q: 1 },
  });
  playOsc({
    type: 'sine', freq: 80 * (0.92 + Math.random() * 0.16),
    env: { attack: 0.003, decay: 0.05, sustain: 0.45, hold: 0.05, release: 0.3, peak: 0.75 },
  });
  playNoise({
    type: 'brown', duration: 0.35,
    env: { attack: 0.005, decay: 0.05, sustain: 0.3, release: 0.28, peak: 0.4 },
    filter: { type: 'lowpass', freq: 350, q: 0.7 },
  });
}

// 동위원소 왜곡 1회 — 지속 발사 c3 hit feedback (6 콤보 공유: 심연진동/프리즘캐스케이드/솔라폭주/장마/사구아로/크리스탈뇌격).
// 50ms throttle = 20Hz max. 사구아로 13발/초 거의 모두 통과 + 다중 콤보 동시 활성 시 서로 안 막음.
const ISOTOPE_HIT_THROTTLE_MS = 50;
let lastIsotopeHit = 0;
export function playIsotopeWarp(): void {
  if (!canAllocateBurst()) return;
  const now = performance.now();
  if (now - lastIsotopeHit < ISOTOPE_HIT_THROTTLE_MS) return;
  lastIsotopeHit = now;
  void unlockAudio();
  isotopeWarp.play();
}

// Electric chain — 80ms gap (isotope-warp instances breathe within 2s cooldown).
// Cap=10 = tier-1 max chain (covers c2 multi-chain combos that can produce 20+ hits).
export function playHitChain(count: number, gapMs = 80): void {
  if (count <= 0) return;
  if (!shouldFire('hitChain', 20)) return;
  void unlockAudio();
  const n = Math.min(count, MAX_CHAIN_SOUNDS);
  for (let i = 0; i < n; i++) {
    window.setTimeout(() => { if (canAllocateBurst()) isotopeWarp.play(); }, i * gapMs);
  }
}

// ── Continuous loops ──
// 지속형 스킬용 — 스킬 활성 동안 sustained하게 재생, 비활성 시 fade-out.
// 매 프레임 startX() 호출돼도 idempotent (이미 실행 중이면 no-op).

let fireRoarHandle: VoiceHandle | null = null;

export function startFireRoar(): void {
  if (fireRoarHandle) return;
  void unlockAudio();
  // 1.5s brown noise 버퍼 loop. hold=9999로 영구 sustain, stop()이 fade-out 처리.
  fireRoarHandle = playNoise({
    type: 'brown',
    duration: 1.5,
    loop: true,
    env: {
      attack: 0.08,    // 부드러운 fade-in
      decay: 0.05,
      sustain: 0.42,
      hold: 9999,      // 사실상 무한 — stop()이 cancel
      release: 0.12,
      peak: 0.5,
    },
    filter: { type: 'lowpass', freq: 900, q: 1.2 },
  });
}

export function stopFireRoar(): void {
  if (!fireRoarHandle) return;
  fireRoarHandle.stop();
  fireRoarHandle = null;
}

let mireSwampHandles: VoiceHandle[] | null = null;

// 감전 퀵샌드 sustained — 50Hz sub + 갈색 lp 220Hz, 어두운 늪 base loop.
export function setMireSwampActive(active: boolean): void {
  if (active && !mireSwampHandles) {
    void unlockAudio();
    const sub = playOsc({
      type: 'sine', freq: 50 * (0.95 + Math.random() * 0.1),
      env: { attack: 0.22, decay: 0.05, sustain: 0.55, hold: 9999, release: 0.35, peak: 0.5 },
      loop: true,
    });
    const body = playNoise({
      type: 'brown', duration: 3.0, loop: true,
      env: { attack: 0.25, decay: 0.05, sustain: 0.4, hold: 9999, release: 0.35, peak: 0.4 },
      filter: { type: 'lowpass', freq: 220, q: 1 },
    });
    mireSwampHandles = [sub, body];
  } else if (!active && mireSwampHandles) {
    for (const h of mireSwampHandles) h.stop();
    mireSwampHandles = null;
  }
}

// 감전 퀵샌드 DoT 펄스 zap — 톱니 180Hz 짧은 전기 zap (24f 주기로 호출).
export function playMireZap(): void {
  if (!shouldFire('mireZap', 30)) return;
  void unlockAudio();
  playOsc({
    type: 'sawtooth', freq: 180,
    env: { attack: 0.001, decay: 0.015, sustain: 0.18, release: 0.06, peak: 0.22 },
    filter: { type: 'lowpass', freq: 600, q: 1.2 },
  });
}

let gravityWellHandles: VoiceHandle[] | null = null;

// 은하 소용돌이 sustained — 45Hz sub + 60Hz octave + 갈색 lp 180Hz. 가장 어둡고 무거운 중력 우물.
export function setGravityWellActive(active: boolean): void {
  if (active && !gravityWellHandles) {
    void unlockAudio();
    const sub = playOsc({
      type: 'sine', freq: 45 * (0.95 + Math.random() * 0.1),
      env: { attack: 0.22, decay: 0.05, sustain: 0.6, hold: 9999, release: 0.35, peak: 0.55 },
      loop: true,
    });
    const oct = playOsc({
      type: 'sine', freq: 60,
      env: { attack: 0.22, decay: 0.05, sustain: 0.4, hold: 9999, release: 0.35, peak: 0.3 },
      loop: true,
    });
    const body = playNoise({
      type: 'brown', duration: 3.0, loop: true,
      env: { attack: 0.25, decay: 0.05, sustain: 0.35, hold: 9999, release: 0.35, peak: 0.32 },
      filter: { type: 'lowpass', freq: 180, q: 1 },
    });
    gravityWellHandles = [sub, oct, body];
  } else if (!active && gravityWellHandles) {
    for (const h of gravityWellHandles) h.stop();
    gravityWellHandles = null;
  }
}

let tornadoHowlHandles: VoiceHandle[] | null = null;

// 흑뢰 토네이도 sustained — 갈색 노이즈 lp 350Hz + 50Hz sub. 휘몰아치는 어두운 바람.
// 원본 lab variant는 200→450Hz sweep 있었지만 loop에선 sweep 효과 사라지므로 mid value 350Hz 정적.
export function setTornadoHowlActive(active: boolean): void {
  if (active && !tornadoHowlHandles) {
    void unlockAudio();
    const sub = playOsc({
      type: 'sine', freq: 50 * (0.95 + Math.random() * 0.1),
      env: { attack: 0.22, decay: 0.05, sustain: 0.5, hold: 9999, release: 0.35, peak: 0.45 },
      loop: true,
    });
    const wind = playNoise({
      type: 'brown', duration: 3.0, loop: true,
      env: { attack: 0.22, decay: 0.05, sustain: 0.45, hold: 9999, release: 0.35, peak: 0.5 },
      filter: { type: 'lowpass', freq: 350, q: 0.8 },
    });
    tornadoHowlHandles = [sub, wind];
  } else if (!active && tornadoHowlHandles) {
    for (const h of tornadoHowlHandles) h.stop();
    tornadoHowlHandles = null;
  }
}

let abyssShimmerHandles: VoiceHandle[] | null = null;

// 종말의 먹구름 sustained — 55+58Hz 사인 (3Hz subtle beat) + 갈색 lp 220Hz.
// 박동(throb)은 detuned sine beating으로 구현. 마이크로 tick은 loop엔 빠짐.
export function setAbyssShimmerActive(active: boolean): void {
  if (active && !abyssShimmerHandles) {
    void unlockAudio();
    const a = playOsc({
      type: 'sine', freq: 55,
      env: { attack: 0.22, decay: 0.05, sustain: 0.55, hold: 9999, release: 0.35, peak: 0.48 },
      loop: true,
    });
    const b = playOsc({
      type: 'sine', freq: 58,
      env: { attack: 0.22, decay: 0.05, sustain: 0.45, hold: 9999, release: 0.35, peak: 0.36 },
      loop: true,
    });
    const body = playNoise({
      type: 'brown', duration: 3.0, loop: true,
      env: { attack: 0.25, decay: 0.05, sustain: 0.32, hold: 9999, release: 0.35, peak: 0.3 },
      filter: { type: 'lowpass', freq: 220, q: 1 },
    });
    abyssShimmerHandles = [a, b, body];
  } else if (!active && abyssShimmerHandles) {
    for (const h of abyssShimmerHandles) h.stop();
    abyssShimmerHandles = null;
  }
}

let deepHumHandles: VoiceHandle[] | null = null;

// 지속형 c2 어두운 sub 럼블 — 메일스트롬(물+암흑) / 퀵샌드(물+흙) 통일.
// 50Hz sub + 65Hz fundamental + 갈색 lp 120Hz (lab의 deepHum 변종 동일 톤, loop용 envelope).
export function setDeepHumActive(active: boolean): void {
  if (active && !deepHumHandles) {
    void unlockAudio();
    const sub = playOsc({
      type: 'sine', freq: 50,
      env: { attack: 0.22, decay: 0.05, sustain: 0.5, hold: 9999, release: 0.35, peak: 0.42 },
      loop: true,
    });
    const fund = playOsc({
      type: 'sine', freq: 65,
      env: { attack: 0.22, decay: 0.05, sustain: 0.55, hold: 9999, release: 0.35, peak: 0.5 },
      loop: true,
    });
    const body = playNoise({
      type: 'brown', duration: 3.0, loop: true,
      env: { attack: 0.25, decay: 0.05, sustain: 0.32, hold: 9999, release: 0.35, peak: 0.3 },
      filter: { type: 'lowpass', freq: 120, q: 1 },
    });
    deepHumHandles = [sub, fund, body];
  } else if (!active && deepHumHandles) {
    for (const h of deepHumHandles) h.stop();
    deepHumHandles = null;
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
  if (!canAllocateBurst()) return;
  const now = performance.now();
  if (now - lastHit < HIT_THROTTLE_MS) return;
  lastHit = now;
  void unlockAudio();
  impact(0.85 + Math.random() * 0.3);
}

// ── Kill ──
// 처치 사운드 비활성화 (사용자 요청). API는 유지 — 호출자는 그대로, 소리만 안 남.
// 복원하려면 함수 본문에 이전 합성(triangle 220→70 + pink bp 1500Hz, boss=sine 110→32 + brown lp 600 + white bp 1800) 다시 채우면 됨.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function playKill(_opts: { boss?: boolean } = {}): void {
  // no-op
}
