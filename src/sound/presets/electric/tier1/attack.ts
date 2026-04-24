/**
 * Electric tier-1 (Chain Lightning) — locked-in ATTACK sound: Continuous Spark.
 * CC0 sample from OpenGameArt.
 */
import { playSample } from '../../../samplePlayer';
import type { SoundVariant } from '../../../types';

export const electricTier1AttackContinuousSpark: SoundVariant = {
  id: 'electric-t1-atk-05',
  label: '연속 스파크',
  description: '끊기지 않고 이어지는 전기 스파크',
  play() {
    return playSample(
      'elec-atk-continuous',
      '/sounds/electric/tier1/attacks/continuousspark.wav',
      { volume: 0.9 },
    );
  },
};
