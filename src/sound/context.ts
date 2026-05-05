import { getSavedVolume, saveVolume } from '../storage';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const liveNodes = new Set<AudioScheduledSourceNode>();

// Burst voice budget — drops new short hit sounds when too many are stacking.
// Loops (sustained skill drones) are tracked separately and never dropped.
// 48 = ~6 simultaneous heavy combo bursts (each ~7-8 nodes). Tuned empirically.
const BURST_VOICE_BUDGET = 48;
let burstVoiceCount = 0;

export function canAllocateBurst(): boolean {
  return burstVoiceCount < BURST_VOICE_BUDGET;
}

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = getSavedVolume();

    // Limiter — prevents clipping when many heavy sounds stack (chain hits, ult).
    // Threshold/ratio tuned to be transparent for single hits, catch only stacked peaks.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 10;
    limiter.ratio.value = 10;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.18;

    master.connect(limiter);
    limiter.connect(ctx.destination);
  }
  return ctx;
}

export function getMaster(): GainNode {
  getAudioContext();
  return master!;
}

export function unlockAudio(): Promise<void> {
  const c = getAudioContext();
  if (c.state === 'suspended') return c.resume();
  return Promise.resolve();
}

export function trackNode(node: AudioScheduledSourceNode, opts?: { loop?: boolean }): void {
  liveNodes.add(node);
  const isLoop = opts?.loop ?? false;
  if (!isLoop) burstVoiceCount++;
  node.addEventListener('ended', () => {
    liveNodes.delete(node);
    if (!isLoop) burstVoiceCount = Math.max(0, burstVoiceCount - 1);
  });
}

export function stopAll(): void {
  for (const n of liveNodes) {
    try { n.stop(); } catch { /* already stopped */ }
  }
  liveNodes.clear();
  burstVoiceCount = 0;
}

export function setMasterVolume(v: number): void {
  const m = getMaster();
  m.gain.setTargetAtTime(v, getAudioContext().currentTime, 0.01);
  saveVolume(v);
}
