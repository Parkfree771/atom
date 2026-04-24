/**
 * Locked-in game SFX. User-picked variants go here. Called from game engine.
 *
 * Keep this file thin: only wiring. Sound implementations live under `presets/`.
 */
import { unlockAudio } from './context';
import { fireTier1AttackGasTorch } from './presets/fire/tier1/attack';
import { fireTier1HitDryCrackle } from './presets/fire/tier1/hit';
import { earthTier1AttackQuake } from './presets/earth/tier1/attack';
import { earthTier1HitThud } from './presets/earth/tier1/hit';
import { electricTier1AttackContinuousSpark } from './presets/electric/tier1/attack';
import { electricTier1HitDeath } from './presets/electric/tier1/hit';
import { lightTier1AttackCharge } from './presets/light/tier1/attack';
import { lightTier1HitShimmer } from './presets/light/tier1/hit';
import { darkTier1AttackVoidGrowl } from './presets/dark/tier1/attack';
import { darkTier1HitSwallowed } from './presets/dark/tier1/hit';
import { waterTier1AttackWaveUndulation } from './presets/water/tier1/attack';
import { waterTier1HitDroplet } from './presets/water/tier1/hit';

type Handle = { stop: (at?: number) => void };

// Long enough to cover any realistic continuous burst; stop() fades out early.
const ATTACK_LOOP_DURATION = 3600;

function makeContinuousSound(
  variant: { play(duration?: number): Handle },
  minHitIntervalMs = 70,
) {
  let attackHandle: Handle | null = null;
  let lastHitTime = 0;
  return {
    startAttack(): void {
      if (attackHandle) return;
      void unlockAudio();
      attackHandle = variant.play(ATTACK_LOOP_DURATION);
    },
    stopAttack(): void {
      if (!attackHandle) return;
      attackHandle.stop();
      attackHandle = null;
    },
    playHit(hitVariant: { play(): Handle }): void {
      const now = performance.now();
      if (now - lastHitTime < minHitIntervalMs) return;
      lastHitTime = now;
      void unlockAudio();
      hitVariant.play();
    },
  };
}

const fireSound = makeContinuousSound(fireTier1AttackGasTorch, 70);
export const fireTier1Sound = {
  startAttack: () => fireSound.startAttack(),
  stopAttack: () => fireSound.stopAttack(),
  playHit: () => fireSound.playHit(fireTier1HitDryCrackle),
};

const earthSound = makeContinuousSound(earthTier1AttackQuake, 120);
export const earthTier1Sound = {
  startAttack: () => earthSound.startAttack(),
  stopAttack: () => earthSound.stopAttack(),
  playHit: () => earthSound.playHit(earthTier1HitThud),
};

// Electric is a one-shot burst — no continuous loop. Attack fires on chain-start,
// hits fire per-enemy as each bolt lands (up to 10 per chain, ~5 frames apart).
let lastElectricHit = 0;
const ELEC_HIT_MIN_MS = 30;
export const electricTier1Sound = {
  fireAttack(): void {
    void unlockAudio();
    electricTier1AttackContinuousSpark.play();
  },
  playHit(): void {
    const now = performance.now();
    if (now - lastElectricHit < ELEC_HIT_MIN_MS) return;
    lastElectricHit = now;
    void unlockAudio();
    electricTier1HitDeath.play();
  },
};

// Light cycle: 1.5s charge → 0.83s fire. Sample is 8s — restart each cycle to
// keep it synced, stop old instance so they don't pile up.
let lightChargeHandle: Handle | null = null;
export const lightTier1Sound = {
  fireChargeSample(): void {
    if (lightChargeHandle) lightChargeHandle.stop();
    void unlockAudio();
    lightChargeHandle = lightTier1AttackCharge.play();
  },
  stopAll(): void {
    if (lightChargeHandle) {
      lightChargeHandle.stop();
      lightChargeHandle = null;
    }
  },
  playHit(): void {
    void unlockAudio();
    lightTier1HitShimmer.play();
  },
};

const darkSound = makeContinuousSound(darkTier1AttackVoidGrowl, 250);
export const darkTier1Sound = {
  startAttack: () => darkSound.startAttack(),
  stopAttack: () => darkSound.stopAttack(),
  playHit: () => darkSound.playHit(darkTier1HitSwallowed),
};

const waterSound = makeContinuousSound(waterTier1AttackWaveUndulation, 100);
export const waterTier1Sound = {
  startAttack: () => waterSound.startAttack(),
  stopAttack: () => waterSound.stopAttack(),
  playHit: () => waterSound.playHit(waterTier1HitDroplet),
};
