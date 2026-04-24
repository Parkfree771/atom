/**
 * Fire tier-1 (Flamethrower) — locked-in HIT sound: Dry Crackle.
 * Original 6-candidate set was pruned after user selection.
 */
import { playNoise, group } from '../../../primitives';
import type { SoundVariant } from '../../../types';

export const fireTier1HitDryCrackle: SoundVariant = {
  id: 'fire-t1-hit-02',
  label: '바삭 크래클',
  description: '종이/낙엽 타는 바삭한 소리',
  play() {
    const voices: ReturnType<typeof playNoise>[] = [];
    for (let i = 0; i < 4; i++) {
      voices.push(playNoise({
        type: 'white',
        duration: 0.15,
        env: {
          attack: 0.001, decay: 0.02, sustain: 0,
          release: 0.06 + Math.random() * 0.04,
          peak: 0.35 + Math.random() * 0.25,
        },
        filter: { type: 'bandpass', freq: 2200 + Math.random() * 3500, q: 3.5 + Math.random() * 2 },
      }));
    }
    const bed = playNoise({
      type: 'pink',
      duration: 0.25,
      env: { attack: 0.005, decay: 0.04, sustain: 0.2, hold: 0.06, release: 0.14, peak: 0.3 },
      filter: { type: 'highpass', freq: 1500, q: 0.8 },
    });
    return group([...voices, bed]);
  },
};
