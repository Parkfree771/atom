import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+전기 2단계 — 감전 파도 (Electrified Wave)
 *
 * 물 1단계 파동(확대) + 파동 링 자체가 전기를 품고 지직거린다.
 * 파봉(crest)에서 전기 스파크가 더 강하게 튀고,
 * 링이 적에게 닿으면 넉백 + 감전.
 *
 * 컨테이너는 플레이어 위치에 세팅 (물 1단계와 동일 패턴).
 */

// ── 파동 링 ──
interface WaveRing {
  progress: number;
  seed: number;
}

// ── 물보라 파티클 ──
interface Splash {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  isElectric: boolean; // 전기 스파크인지 물보라인지
}

export class WaterElectricEffect {
  private container: PIXI.Container;
  private ringGfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private splashGfx: PIXI.Graphics;
  private sparkGfx: PIXI.Graphics; // 전기 노이즈 전용

  active = false;
  radius = 0;
  private time = 0;

  // 파동 링
  private rings: WaveRing[] = [];
  private ringSpawnTimer = 0;
  private readonly RING_SPAWN_INTERVAL = 45; // 물 1단계(28)보다 느리게 — 느리지만 강력한 파도

  // 파티클 (물보라 + 전기 스파크 혼합)
  private splashes: Splash[] = [];

  // ── 색상: 물 ──
  private readonly COL_WAVE_CREST  = 0x2563eb;
  private readonly COL_WAVE_TROUGH = 0x1d4ed8;
  private readonly COL_WAVE_PEAK   = 0x3b82f6;
  private readonly COL_SPLASH_GLOW = 0x1e40af;
  private readonly COL_SPLASH_CORE = 0x2563eb;

  // ── 색상: 전기 (노란/금빛 — 파란 물과 대비) ──
  private readonly COL_SPARK_OUTER = 0xeab308; // 진한 금
  private readonly COL_SPARK_MID   = 0xfde047; // 선명한 노랑
  private readonly COL_SPARK_CORE  = 0xfef9c3; // 밝은 크림
  private readonly COL_SPARK_WHITE = 0xfefce8; // 거의 백(따뜻)

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.ringGfx = new PIXI.Graphics();
    this.container.addChild(this.ringGfx);

    this.sparkGfx = new PIXI.Graphics();
    this.sparkGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.sparkGfx);

    this.splashGfx = new PIXI.Graphics();
    this.splashGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.splashGfx);
  }

  start(x: number, y: number, radius: number) {
    this.active = true;
    this.radius = radius;
    this.time = 0;
    this.rings = [];
    this.splashes = [];
    this.ringSpawnTimer = 0;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // ── 파동 링 생성 ──
    this.ringSpawnTimer += dt;
    if (this.ringSpawnTimer >= this.RING_SPAWN_INTERVAL) {
      this.ringSpawnTimer = 0;
      this.rings.push({ progress: 0, seed: Math.random() * 1000 });
    }

    // ── 파동 링 진행 ──
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].progress += 0.009 * dt; // 물 1단계(0.012)보다 느린 팽창
      if (this.rings[i].progress > 1.0) swapPop(this.rings, i);
    }

    // ── 파티클 생성 ──
    if (Math.floor(this.time) % 3 === 0 && this.rings.length > 0) {
      this.spawnSplashes();
    }
    // 전기 스파크도 추가 생성
    if (Math.floor(this.time) % 4 === 0 && this.rings.length > 0) {
      this.spawnElectricSparks();
    }

    // ── 파티클 업데이트 ──
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.x += s.vx; s.y += s.vy;
      if (s.isElectric) {
        s.vx *= 0.9;  // 전기 스파크는 빠르게 감속
        s.vy *= 0.9;
      } else {
        s.vy += 0.04;
        s.vx *= 0.98;
      }
      s.life -= dt;
      if (s.life <= 0) swapPop(this.splashes, i);
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.ringGfx.clear();
    this.glowGfx.clear();
    this.sparkGfx.clear();
    this.splashGfx.clear();

    this.drawWaveRings();
    this.drawSplashes();
  }

  private drawWaveRings() {
    const R = this.radius;

    for (const ring of this.rings) {
      const p = ring.progress;
      const currentR = R * p;
      if (currentR < 3) continue;

      const fadeIn = Math.min(1, p / 0.12);
      const fadeOut = p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1;
      const lifeAlpha = fadeIn * fadeOut;
      if (lifeAlpha < 0.01) continue;

      const waveFreq1 = 5, waveFreq2 = 8, waveFreq3 = 13;
      const waveAmp1 = currentR * 0.08;
      const waveAmp2 = currentR * 0.035;
      const waveAmp3 = currentR * 0.015;
      const timePhase = this.time * 0.06;
      const seed = ring.seed;
      const baseThickness = 3.0 + currentR * 0.025; // 물 1단계보다 두꺼운 파도
      const segments = 80;
      const step = (Math.PI * 2) / segments;

      for (let j = 0; j < segments; j++) {
        const angle1 = j * step;
        const angle2 = (j + 1) * step;

        const und1 =
          Math.sin(angle1 * waveFreq1 + timePhase + seed) * waveAmp1 +
          Math.sin(angle1 * waveFreq2 - timePhase * 1.3 + seed * 0.7) * waveAmp2 +
          Math.sin(angle1 * waveFreq3 + timePhase * 0.7 + seed * 1.3) * waveAmp3;
        const und2 =
          Math.sin(angle2 * waveFreq1 + timePhase + seed) * waveAmp1 +
          Math.sin(angle2 * waveFreq2 - timePhase * 1.3 + seed * 0.7) * waveAmp2 +
          Math.sin(angle2 * waveFreq3 + timePhase * 0.7 + seed * 1.3) * waveAmp3;

        const r1 = currentR + und1;
        const r2 = currentR + und2;
        const x1 = Math.cos(angle1) * r1;
        const y1 = Math.sin(angle1) * r1;
        const x2 = Math.cos(angle2) * r2;
        const y2 = Math.sin(angle2) * r2;

        const crestFactor = (und1 / waveAmp1 + 1) * 0.5;
        const thickness = baseThickness * (0.6 + crestFactor * 0.8);
        const brightness = 0.4 + crestFactor * 0.4;
        const color = crestFactor > 0.6 ? this.COL_WAVE_CREST : this.COL_WAVE_TROUGH;

        // ── 메인 파동 링 ──
        this.ringGfx.lineStyle(thickness, color, lifeAlpha * brightness);
        this.ringGfx.moveTo(x1, y1);
        this.ringGfx.lineTo(x2, y2);

        // (전기 노이즈는 링 단위로 아래에서 일괄 렌더링)
      }

      // ── 파봉 꼭대기 강조 (물+전기 하이브리드) ──
      for (let peak = 0; peak < waveFreq1; peak++) {
        const peakAngle = (peak / waveFreq1) * Math.PI * 2 + timePhase / waveFreq1 + seed;
        const peakUnd = Math.sin(peakAngle * waveFreq1 + timePhase + seed) * waveAmp1;

        if (peakUnd > waveAmp1 * 0.5) {
          const peakR = currentR + peakUnd;
          const pkx = Math.cos(peakAngle) * peakR;
          const pky = Math.sin(peakAngle) * peakR;

          // 물 파봉 점
          this.ringGfx.lineStyle(0);
          this.ringGfx.beginFill(this.COL_WAVE_PEAK, lifeAlpha * 0.6);
          this.ringGfx.drawCircle(pkx, pky, baseThickness * 0.6);
          this.ringGfx.endFill();

          // (파봉 글로우 — 지그재그에 통합)
        }
      }
    }

    // ══════════════════════════════════════════
    // 링 전체를 따라 달리는 지그재그 전기
    // ══════════════════════════════════════════
    for (const ring of this.rings) {
      const p = ring.progress;
      const currentR = R * p;
      if (currentR < 8) continue;

      const fadeIn = Math.min(1, p / 0.12);
      const fadeOut = p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1;
      const lifeAlpha = fadeIn * fadeOut;
      if (lifeAlpha < 0.02) continue;

      const waveAmp1 = currentR * 0.08;
      const timePhase = this.time * 0.06;
      const seed = ring.seed;

      // 지그재그 포인트 생성 — 링을 따라가면서 안/밖으로 지터
      const zigSegments = 60;
      const zigStep = (Math.PI * 2) / zigSegments;
      const jitterAmt = 4 + currentR * 0.04; // 반경 클수록 지터 큼

      // 2줄의 지그재그 (겹치면 더 자연스러움)
      for (let line = 0; line < 2; line++) {
        const lineFlicker = 0.6 + Math.random() * 0.4;
        const lineAlpha = lifeAlpha * lineFlicker;
        const lineSeed = seed + line * 500;

        // 글로우 패스
        this.sparkGfx.lineStyle(5, this.COL_SPARK_OUTER, lineAlpha * 0.2);
        for (let z = 0; z <= zigSegments; z++) {
          const angle = z * zigStep;
          const und =
            Math.sin(angle * 5 + timePhase + seed) * waveAmp1 +
            Math.sin(angle * 8 - timePhase * 1.3 + seed * 0.7) * waveAmp1 * 0.4;
          const baseR = currentR + und;
          // 매 세그먼트마다 랜덤 지터 (매 프레임 새로 → 지직거림)
          const jitter = (Math.random() - 0.5) * jitterAmt * 2;
          const r = baseR + jitter;
          const x = Math.cos(angle) * r;
          const y = Math.sin(angle) * r;
          if (z === 0) this.sparkGfx.moveTo(x, y);
          else this.sparkGfx.lineTo(x, y);
        }

        // 코어 패스 (더 밝고 가는 선)
        this.sparkGfx.lineStyle(1.8, this.COL_SPARK_MID, lineAlpha * 0.55);
        for (let z = 0; z <= zigSegments; z++) {
          const angle = z * zigStep;
          const und =
            Math.sin(angle * 5 + timePhase + seed) * waveAmp1 +
            Math.sin(angle * 8 - timePhase * 1.3 + seed * 0.7) * waveAmp1 * 0.4;
          const baseR = currentR + und;
          const jitter = (Math.random() - 0.5) * jitterAmt * 2;
          const r = baseR + jitter;
          const x = Math.cos(angle) * r;
          const y = Math.sin(angle) * r;
          if (z === 0) this.sparkGfx.moveTo(x, y);
          else this.sparkGfx.lineTo(x, y);
        }

        // 심선 패스 (제일 밝고 가느다란)
        this.sparkGfx.lineStyle(0.8, this.COL_SPARK_CORE, lineAlpha * 0.4);
        for (let z = 0; z <= zigSegments; z++) {
          const angle = z * zigStep;
          const und =
            Math.sin(angle * 5 + timePhase + seed) * waveAmp1 +
            Math.sin(angle * 8 - timePhase * 1.3 + seed * 0.7) * waveAmp1 * 0.4;
          const baseR = currentR + und;
          const jitter = (Math.random() - 0.5) * jitterAmt * 2;
          const r = baseR + jitter;
          const x = Math.cos(angle) * r;
          const y = Math.sin(angle) * r;
          if (z === 0) this.sparkGfx.moveTo(x, y);
          else this.sparkGfx.lineTo(x, y);
        }
      }
    }

    this.sparkGfx.lineStyle(0);
  }

  private drawSplashes() {
    this.splashGfx.lineStyle(0);
    for (const s of this.splashes) {
      const lt = s.life / s.maxLife;
      const alpha = lt < 0.3 ? lt / 0.3 : lt > 0.7 ? (1 - lt) / 0.3 : 1;
      const sz = s.size * (0.3 + lt * 0.7);

      if (s.isElectric) {
        // 전기 스파크
        this.splashGfx.beginFill(this.COL_SPARK_OUTER, alpha * 0.2);
        this.splashGfx.drawCircle(s.x, s.y, sz * 2.5);
        this.splashGfx.endFill();
        this.splashGfx.beginFill(this.COL_SPARK_WHITE, alpha * 0.7);
        this.splashGfx.drawCircle(s.x, s.y, sz * 0.7);
        this.splashGfx.endFill();
      } else {
        // 물보라
        this.splashGfx.beginFill(this.COL_SPLASH_GLOW, alpha * 0.15);
        this.splashGfx.drawCircle(s.x, s.y, sz * 3);
        this.splashGfx.endFill();
        this.splashGfx.beginFill(this.COL_SPLASH_CORE, alpha * 0.7);
        this.splashGfx.drawCircle(s.x, s.y, sz);
        this.splashGfx.endFill();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  파티클 생성
  // ═══════════════════════════════════════════════════════════

  /** 물 1단계와 동일한 물보라 */
  private spawnSplashes() {
    const outerRing = this.rings.reduce<WaveRing | null>((best, r) =>
      !best || r.progress > best.progress ? r : best, null);
    if (!outerRing || outerRing.progress < 0.15 || outerRing.progress > 0.85) return;

    const currentR = this.radius * outerRing.progress;
    for (let i = 0; i < 2; i++) {
      const angle = Math.random() * Math.PI * 2;
      const undulation = Math.sin(angle * 5 + this.time * 0.06 + outerRing.seed) * currentR * 0.08;
      const r = currentR + undulation;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      const speed = 0.6 + Math.random() * 1.2;
      const maxLife = 12 + Math.random() * 10;
      this.splashes.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.3,
        life: maxLife, maxLife,
        size: 1.2 + Math.random() * 1.5,
        isElectric: false,
      });
    }
  }

  /** 파동 링 위에서 전기 스파크 분출 */
  private spawnElectricSparks() {
    // 활성 링에서 파봉 위치 근처에서 스파크 생성
    for (const ring of this.rings) {
      if (ring.progress < 0.1 || ring.progress > 0.9) continue;
      if (Math.random() > 0.5) continue; // 50% 확률로 스킵

      const currentR = this.radius * ring.progress;
      const angle = Math.random() * Math.PI * 2;
      const und = Math.sin(angle * 5 + this.time * 0.06 + ring.seed) * currentR * 0.08;

      // 파봉일 때만 스파크
      if (und < currentR * 0.03) continue;

      const r = currentR + und;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

      // 바깥 방향 + 약간 랜덤으로 튀어나감
      const sparkSpeed = 1.0 + Math.random() * 1.5;
      const sparkAngle = angle + (Math.random() - 0.5) * 0.8;
      const maxLife = 6 + Math.random() * 8;

      this.splashes.push({
        x, y,
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        life: maxLife, maxLife,
        size: 0.8 + Math.random() * 1.0,
        isElectric: true,
      });
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.rings = [];
    this.splashes = [];
    this.ringGfx.clear();
    this.glowGfx.clear();
    this.sparkGfx.clear();
    this.splashGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
