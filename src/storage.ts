// Lightweight localStorage wrapper. All access wrapped in try/catch — Safari private mode
// and some embedded browsers throw on localStorage access. Falls back gracefully to no-op.

const HIGH_SCORE_KEY = 'atom.highScore';
const VOLUME_KEY = 'atom.volume';

function safeGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function getHighScore(): number {
  const raw = safeGet(HIGH_SCORE_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Save score if it beats the current high. Returns the (possibly updated) best. */
export function saveHighScoreIfBetter(score: number): { best: number; isNew: boolean } {
  const prev = getHighScore();
  if (score > prev) {
    safeSet(HIGH_SCORE_KEY, String(score));
    return { best: score, isNew: true };
  }
  return { best: prev, isNew: false };
}

const DEFAULT_VOLUME = 0.23;

export function getSavedVolume(): number {
  const raw = safeGet(VOLUME_KEY);
  if (!raw) return DEFAULT_VOLUME;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_VOLUME;
}

export function saveVolume(v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) return;
  safeSet(VOLUME_KEY, String(v));
}
