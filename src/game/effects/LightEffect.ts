import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 빛 속성 1단계 — 레이저 빔
 *
 * 차징 → 발사 사이클.
 * 차징: 광점이 사방에서 중심으로 모임, 코어 밝아짐
 * 발사: 일직선 빔. 셀이 직선 위에 밀집해서 빔 형태.
 *       가늘고 밝은 코어 + 주변 빛 셀 글로우.
 *       발사 순간 플래시, 이후 페이드.
 *
 * 컨테이너 회전 안 함 — 차징은 전방향, 빔은 각도로 직접 그림
 */

// ── 차징 광점 ──
interface ChargeParticle {
  x: number;
  y: number;
  speed: number;
  size: number;
}

const enum LightPhase {
  CHARGING = 0,
  FIRING = 1,
}

export class LightEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private beamGfx: PIXI.Graphics;

  active = false;
  private beamRange = 2000;
  private time = 0;
  private currentAngle = 0;

  // 페이즈
  private phase: LightPhase = LightPhase.CHARGING;
  private phaseTimer = 0;
  private readonly CHARGE_DURATION = 90;  // 1.5초
  private readonly FIRE_DURATION = 50;    // ~0.8초

  // 엔진이 읽는 공개 상태
  beamFiredThisFrame = false;
  chargeStartedThisFrame = false;
  beamDirection = 0;

  // 차징 광점
  private chargeParticles: ChargeParticle[] = [];


  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.beamGfx = new PIXI.Graphics();
    this.container.addChild(this.beamGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.phase = LightPhase.CHARGING;
    this.phaseTimer = 0;
    this.chargeParticles = [];
    this.beamFiredThisFrame = false;
    this.chargeStartedThisFrame = true;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  setDirection(angle: number) {
    let diff = angle - this.currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.currentAngle += diff * 0.08;
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.beamFiredThisFrame = false;
    this.chargeStartedThisFrame = false;
    this.phaseTimer += dt;

    if (this.phase === LightPhase.CHARGING) {
      this.updateCharging(dt);
      if (this.phaseTimer >= this.CHARGE_DURATION) {
        this.phase = LightPhase.FIRING;
        this.phaseTimer = 0;
        this.beamFiredThisFrame = true;
        this.beamDirection = this.currentAngle;
        this.chargeParticles = [];
      }
    } else {
      if (this.phaseTimer >= this.FIRE_DURATION) {
        this.phase = LightPhase.CHARGING;
        this.phaseTimer = 0;
        this.chargeStartedThisFrame = true;
      }
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  차징
  // ═══════════════════════════════════════════════════════════

  private updateCharging(dt: number) {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    // 광점 생성 (진행될수록 빈번)
    const spawnRate = 2 + progress * 4;
    if (Math.floor(this.time) % Math.max(1, Math.floor(4 - spawnRate)) === 0
        && this.chargeParticles.length < 35) {
      const count = 1 + Math.floor(progress * 2);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 50 + Math.random() * 70;
        this.chargeParticles.push({
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          speed: 0.8 + Math.random() * 0.5 + progress * 1.8,
          size: 0.8 + Math.random() * 1.2,
        });
      }
    }

    // 광점 이동 (중심으로 가속)
    for (let i = this.chargeParticles.length - 1; i >= 0; i--) {
      const p = this.chargeParticles[i];
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d < 3) {
        swapPop(this.chargeParticles, i);
        continue;
      }
      const nx = -p.x / d;
      const ny = -p.y / d;
      p.x += nx * p.speed * dt;
      p.y += ny * p.speed * dt;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.beamGfx.clear();

    if (this.phase === LightPhase.CHARGING) {
      this.drawCharging();
    } else {
      this.drawBeam();
    }
  }

  private drawCharging() {
    const progress = this.phaseTimer / this.CHARGE_DURATION;
    this.glowGfx.lineStyle(0);

    // 광점들
    for (const p of this.chargeParticles) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      const alpha = Math.min(1, d / 25) * 0.7;

      // 꼬리 (먼 쪽이 연함)
      this.glowGfx.beginFill(0xfef08a, alpha * 0.25);
      this.glowGfx.drawCircle(p.x, p.y, p.size * 2.5);
      this.glowGfx.endFill();

      // 코어
      this.glowGfx.beginFill(0xfef08a, alpha);
      this.glowGfx.drawCircle(p.x, p.y, p.size);
      this.glowGfx.endFill();
    }

    // 중심 코어 (차징에 따라 밝아짐)
    if (progress > 0.1) {
      const intensity = (progress - 0.1) / 0.9;
      this.glowGfx.beginFill(0xfef08a, 0.12 * intensity);
      this.glowGfx.drawCircle(0, 0, 18 * intensity);
      this.glowGfx.endFill();

      this.glowGfx.beginFill(0xffffff, 0.08 * intensity * intensity);
      this.glowGfx.drawCircle(0, 0, 7 * intensity);
      this.glowGfx.endFill();
    }
  }

  private drawBeam() {
    const fadeProg = this.phaseTimer / this.FIRE_DURATION;
    const alpha = 1 - fadeProg * 0.85;
    const fade = 1 - fadeProg * 0.4;
    const angle = this.beamDirection;
    const R = this.beamRange;

    // 발사 직후 두께 팽창 → 수축 (처음 5프레임 120% → 정상)
    const impactBulge = this.phaseTimer < 5
      ? 1 + (1 - this.phaseTimer / 5) * 0.3
      : 1;

    const endX = Math.cos(angle) * R;
    const endY = Math.sin(angle) * R;
    const bulge = fade * impactBulge;

    // ── 빔 5겹 ──

    // 1) 최외곽 — 넓고 연한 금
    this.beamGfx.lineStyle(60 * bulge, 0xfef08a, alpha * 0.12);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 2) 외곽 — 진한 금
    this.beamGfx.lineStyle(38 * bulge, 0xfef08a, alpha * 0.28);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 3) 중간 코어 — 밝은 크림
    this.beamGfx.lineStyle(20 * bulge, 0xfef9c3, alpha * 0.55);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 4) 내부 코어 — 거의 백색
    this.beamGfx.lineStyle(10 * bulge, 0xfffef5, alpha * 0.75);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 5) 심선 — 순백
    this.beamGfx.lineStyle(4 * bulge, 0xffffff, alpha * 0.9);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);
    this.beamGfx.lineStyle(0);

    // ── 발사 임팩트 플래시 ──
    if (fadeProg < 0.25) {
      const flashAlpha = (0.25 - fadeProg) / 0.25;
      this.glowGfx.lineStyle(0);
      // 강렬한 백색 코어
      this.glowGfx.beginFill(0xffffff, 0.6 * flashAlpha);
      this.glowGfx.drawCircle(0, 0, 22);
      this.glowGfx.endFill();
      // 금색 충격파 링
      this.glowGfx.lineStyle(3 * flashAlpha, 0xfef08a, 0.5 * flashAlpha);
      this.glowGfx.drawCircle(0, 0, 35 + (1 - flashAlpha) * 25);
      this.glowGfx.lineStyle(0);
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.chargeParticles = [];
    this.glowGfx.clear();
    this.beamGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
