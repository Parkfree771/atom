/**
 * File-based sample playback using @pixi/sound. Used where procedural synthesis
 * cannot reach the desired realism (e.g. arcing electricity, recorded impacts).
 *
 * Samples live under /public/sounds/<element>/<tier>/... and are referenced by
 * public URL path (e.g. '/sounds/electric/tier1/attacks/spark.wav').
 */
import { sound } from '@pixi/sound';

const addedAliases = new Set<string>();

function ensureLoaded(alias: string, url: string): void {
  if (addedAliases.has(alias)) return;
  sound.add(alias, url);
  addedAliases.add(alias);
}

export interface SamplePlayOpts {
  volume?: number;
  /** playback rate (1 = normal, 2 = double-speed up an octave). */
  speed?: number;
  /** seconds offset into the file to begin playback (trims leading silence). */
  start?: number;
  /** seconds offset into the file to end playback (trims tail). */
  end?: number;
  loop?: boolean;
}

export function playSample(
  alias: string,
  url: string,
  opts: SamplePlayOpts = {},
): { stop: (at?: number) => void } {
  ensureLoaded(alias, url);
  const instance = sound.play(alias, {
    volume: opts.volume ?? 0.7,
    speed: opts.speed ?? 1,
    start: opts.start,
    end: opts.end,
    loop: opts.loop ?? false,
  });

  return {
    stop() {
      if (instance instanceof Promise) {
        instance.then((i) => i.stop()).catch(() => undefined);
      } else if (instance) {
        instance.stop();
      }
    },
  };
}
