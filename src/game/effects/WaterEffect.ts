import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물 속성 1단계 — 파동 장판
 *
 * 캐릭터 중심에서 동심원 물결이 퍼져나간다.
 * 링이 단순한 원이 아니라 사인파로 일렁거린다.
 * 파봉(crest)은 두껍고 밝고, 파곡(trough)은 얇고 어둡다.
 *
 * 구현: PIXI.Graphics (일렁이는 링) + PIXI.Graphics (물보라 파티클)
 */

// ── 파동 링 하나의 상태 ──
interface WaveRing {
  /** 0→1 진행도 (0=중심, 1=최대 반경 도달) */
  progress: number;
  /** 고유 시드 (일렁임 패턴 분산용) */
  seed: number;
}

// ── 물보라 파티클 ──
interface Splash {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
}

export class WaterEffect {
  private container: PIXI.Container;
  private ringGfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private splashGfx: PIXI.Graphics;

  active = false;
  private radius = 0;
  private time = 0;

  // 파동 링 풀 (3~4개가 동시에 존재)
  private rings: WaveRing[] = [];
  private ringSpawnTimer = 0;
  private readonly RING_SPAWN_INTERVAL = 28; // 프레임 간격

  // 물보라 파티클
  private splashes: Splash[] = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 레이어 (아래)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 링 레이어 (중간)
    this.ringGfx = new PIXI.Graphics();
    this.container.addChild(this.ringGfx);

    // 물보라 레이어 (위)
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

    // ── 새 파동 링 생성 ──
    this.ringSpawnTimer += dt;
    if (this.ringSpawnTimer >= this.RING_SPAWN_INTERVAL) {
      this.ringSpawnTimer = 0;
      this.rings.push({
        progress: 0,
        seed: Math.random() * 1000,
      });
    }

    // ── 파동 링 진행 + 소멸 ──
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].progress += 0.012 * dt;
      if (this.rings[i].progress > 1.0) {
        swapPop(this.rings, i);
      }
    }

    // ── 물보라 파티클 생성 (파봉 위치에서) ──
    if (Math.floor(this.time) % 3 === 0 && this.rings.length > 0) {
      this.spawnSplashes();
    }

    // ── 물보라 파티클 업데이트 ──
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.04; // 중력
      s.vx *= 0.98; // 감속
      s.life -= dt;
      if (s.life <= 0) {
        swapPop(this.splashes, i);
      }
    }

    // ── 렌더링 ──
    this.draw();
  }

  private draw() {
    this.ringGfx.clear();
    this.glowGfx.clear();
    this.splashGfx.clear();

    const R = this.radius;

    for (const ring of this.rings) {
      const p = ring.progress;

      // 현재 반경
      const currentR = R * p;
      if (currentR < 3) continue;

      // 라이프사이클 알파: 생성 시 페이드인, 가장자리에서 페이드아웃
      const fadeIn = Math.min(1, p / 0.12);
      const fadeOut = p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1;
      const lifeAlpha = fadeIn * fadeOut;
      if (lifeAlpha < 0.01) continue;

      // ── 일렁이는 링 그리기 ──
      // 사인파 여러 겹을 겹쳐서 자연스러운 물결 형태
      const waveFreq1 = 5;   // 기본 물결 주파수 (5봉우리)
      const waveFreq2 = 8;   // 미세 물결
      const waveFreq3 = 13;  // 초미세 물결
      const waveAmp1 = currentR * 0.08;  // 기본 진폭 (반경의 8%)
      const waveAmp2 = currentR * 0.035;
      const waveAmp3 = currentR * 0.015;
      const timePhase = this.time * 0.06;
      const seed = ring.seed;

      // 파봉/파곡에 따른 두께 변화
      const baseThickness = 2.0 + currentR * 0.02;

      const segments = 80; // 링 세분화
      const step = (Math.PI * 2) / segments;

      // ── 메인 링 (구간별로 두께/밝기 변화) ──
      // 파봉에서는 두껍고 밝게, 파곡에서는 얇고 어둡게
      for (let j = 0; j < segments; j++) {
        const angle1 = j * step;
        const angle2 = (j + 1) * step;

        // 두 끝점의 undulation 계산
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

        // 파봉(undulation > 0)일수록 두껍고 밝음
        const crestFactor = (und1 / waveAmp1 + 1) * 0.5; // 0~1
        const thickness = baseThickness * (0.6 + crestFactor * 0.8);
        const brightness = 0.4 + crestFactor * 0.4;

        // 색상: 파곡은 깊은 남색, 파봉은 진한 파랑
        const color = crestFactor > 0.6 ? 0x2563eb : 0x1d4ed8;

        this.ringGfx.lineStyle(thickness, color, lifeAlpha * brightness);
        this.ringGfx.moveTo(x1, y1);
        this.ringGfx.lineTo(x2, y2);
      }

      // ── 파봉 꼭대기 강조 (진한 파랑 점) ──
      for (let peak = 0; peak < waveFreq1; peak++) {
        const peakAngle = (peak / waveFreq1) * Math.PI * 2 + timePhase / waveFreq1 + seed;
        const peakUnd =
          Math.sin(peakAngle * waveFreq1 + timePhase + seed) * waveAmp1;

        if (peakUnd > waveAmp1 * 0.5) {
          const peakR = currentR + peakUnd;
          const px = Math.cos(peakAngle) * peakR;
          const py = Math.sin(peakAngle) * peakR;

          this.ringGfx.lineStyle(0);
          this.ringGfx.beginFill(0x3b82f6, lifeAlpha * 0.6);
          this.ringGfx.drawCircle(px, py, baseThickness * 0.6);
          this.ringGfx.endFill();
        }
      }
    }

    // ── 물보라 파티클 렌더링 ──
    this.splashGfx.lineStyle(0);
    for (const s of this.splashes) {
      const lt = s.life / s.maxLife;
      const alpha = lt < 0.3 ? lt / 0.3 : lt > 0.7 ? (1 - lt) / 0.3 : 1;
      const sz = s.size * (0.3 + lt * 0.7);

      // 글로우
      this.splashGfx.beginFill(0x1e40af, alpha * 0.15);
      this.splashGfx.drawCircle(s.x, s.y, sz * 3);
      this.splashGfx.endFill();

      // 코어
      this.splashGfx.beginFill(0x2563eb, alpha * 0.7);
      this.splashGfx.drawCircle(s.x, s.y, sz);
      this.splashGfx.endFill();
    }
  }

  /** 파봉 위치에서 물보라 파티클 분출 */
  private spawnSplashes() {
    // 가장 바깥쪽 링에서 생성
    const outerRing = this.rings.reduce<WaveRing | null>((best, r) =>
      !best || r.progress > best.progress ? r : best, null);
    if (!outerRing || outerRing.progress < 0.15 || outerRing.progress > 0.85) return;

    const currentR = this.radius * outerRing.progress;
    const count = 2;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      // 파봉 위치 근처에서 스폰
      const undulation = Math.sin(angle * 5 + this.time * 0.06 + outerRing.seed)
                        * currentR * 0.08;
      const r = currentR + undulation;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

      // 바깥 방향으로 튀어나감
      const speed = 0.6 + Math.random() * 1.2;
      const maxLife = 12 + Math.random() * 10;

      this.splashes.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.3,
        life: maxLife,
        maxLife,
        size: 1.2 + Math.random() * 1.5,
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
    this.splashGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
