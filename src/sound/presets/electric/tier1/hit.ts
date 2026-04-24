/**
 * Electric tier-1 (Chain Lightning) — locked-in HIT sound: Death Strike.
 * CC0 sample from OpenGameArt.
 */
import { playSample } from '../../../samplePlayer';
import type { SoundVariant } from '../../../types';

export const electricTier1HitDeath: SoundVariant = {
  id: 'electric-t1-hit-06',
  label: '강타',
  description: '크게 터지는 결정타',
  play() {
    return playSample(
      'elec-hit-death',
      '/sounds/electric/tier1/hits/death.wav',
      { volume: 0.8 },
    );
  },
};
