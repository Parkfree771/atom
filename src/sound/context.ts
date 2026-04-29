let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const liveNodes = new Set<AudioScheduledSourceNode>();

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.23;

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

export function trackNode(node: AudioScheduledSourceNode): void {
  liveNodes.add(node);
  node.addEventListener('ended', () => liveNodes.delete(node));
}

export function stopAll(): void {
  for (const n of liveNodes) {
    try { n.stop(); } catch { /* already stopped */ }
  }
  liveNodes.clear();
}

export function setMasterVolume(v: number): void {
  const m = getMaster();
  m.gain.setTargetAtTime(v, getAudioContext().currentTime, 0.01);
}
