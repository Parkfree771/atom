import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불 속성 1단계 — 화염방사기
 *
 * 폴리곤 콘 없음. 화염 셀만으로 부채꼴을 채운다.
 * 뿌리: 작고 밝고 빽빽 → 백열
 * 끝단: 크고 어둡고 성김 → 화염 가장자리
 * 셀 분포가 곧 부채꼴 형태.
 *
 * 컨테이너 rotation으로 방향 처리 (+X = 화염 진행 방향)
 */

interface FlameCell {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  growRate: number;
  life: number;
  maxLife: number;
  wobblePhase: number;
  wobbleSpeed: number;
  brightness: number;
}

export class FireEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private flameGfx: PIXI.Graphics;

  active = false;
  private range = 0;
  private currentAngle = 0;

  private readonly CONE_HALF_ANGLE = Math.PI / 16; // 좌우 ~11도 = 총 ~22도
  private readonly MAX_CELLS = 160;

  private cells: FlameCell[] = [];

  // ── 색상 그라데이션 스톱 (거리 → RGB) ──
  private readonly COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
    { t: 0.00, r: 255, g: 251, b: 235 }, // 백열 코어
    { t: 0.03, r: 255, g: 230, b: 140 }, // 밝은 노랑
    { t: 0.06, r: 251, g: 191, b:  36 }, // 금색
    { t: 0.12, r: 253, g: 150, b:  20 }, // 진한 금색→오렌지
    { t: 0.22, r: 249, g: 115, b:  22 }, // 오렌지
    { t: 0.35, r: 245, g:  80, b:  30 }, // 짙은 오렌지
    { t: 0.48, r: 239, g:  68, b:  68 }, // 주홍
    { t: 0.62, r: 210, g:  40, b:  40 }, // 진한 적색
    { t: 0.76, r: 185, g:  28, b:  28 }, // 어두운 적색
    { t: 0.88, r: 160, g:  25, b:  25 }, // 진한 빨강
    { t: 1.00, r: 130, g:  18, b:  18 }, // 깊은 빨강
  ];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.flameGfx = new PIXI.Graphics();
    this.container.addChild(this.flameGfx);
  }

  start(x: number, y: number, range: number, direction: number) {
    this.active = true;
    this.range = range;
    this.currentAngle = direction;
    this.cells = [];
    this.container.position.set(x, y);
    this.container.rotation = direction;
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  setDirection(targetAngle: number) {
    let diff = targetAngle - this.currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.currentAngle += diff * 0.12;
    this.container.rotation = this.currentAngle;
  }

  update(dt: number) {
    if (!this.active) return;

    // ── 분출 ──
    this.spawnCells();

    // ── 업데이트 ──
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.wobblePhase += c.wobbleSpeed * dt;
      c.y += Math.sin(c.wobblePhase) * 0.4 * dt;
      c.size += c.growRate * dt;
      c.life -= dt;
      if (c.life <= 0 || c.x > this.range * 1.15) {
        swapPop(this.cells, i);
      }
    }
    while (this.cells.length > this.MAX_CELLS) this.cells.shift();

    this.draw();
  }

  private spawnCells() {
    const halfA = this.CONE_HALF_ANGLE;
    const count = 8;
    for (let i = 0; i < count; i++) {
      // 삼각분포 — 중심에 밀집
      const angle = (Math.random() + Math.random() - 1) * halfA;
      const speed = 5.0 + Math.random() * 4.0;
      const ml = 45 + Math.random() * 50;
      this.cells.push({
        x: 1 + Math.random() * 3,
        y: (Math.random() - 0.5) * 1.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 0.8 + Math.random() * 1.0,
        growRate: 0.18 + Math.random() * 0.14,
        life: ml, maxLife: ml,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.10 + Math.random() * 0.10,
        brightness: 0.75 + Math.random() * 0.25,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.flameGfx.clear();

    this.drawFlameCells();
  }

  private drawFlameCells() {
    const R = this.range;
    this.flameGfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    for (const c of this.cells) {
      const distFrac = Math.min(c.x / R, 1);
      const lifeFrac = c.life / c.maxLife;

      // ── 색상: 11스톱 연속 보간 ──
      const color = this.lerpFlameColor(distFrac);

      // ── 알파: 뿌리는 연하게(캐릭 보이게), 중간이 가장 진하게, 끝 페이드 ──
      const distAlpha = distFrac < 0.15
        ? 0.4 + distFrac * 4     // 뿌리: 연하게 시작 → 빠르게 올라감
        : 1 - distFrac * 0.5;    // 중간~끝: 서서히 페이드
      const lifeAlpha = lifeFrac < 0.2 ? lifeFrac / 0.2 : 1;
      const alpha = distAlpha * lifeAlpha * c.brightness;

      // 메인 셀
      this.flameGfx.beginFill(color, alpha * 0.55);
      this.flameGfx.drawCircle(c.x, c.y, c.size);
      this.flameGfx.endFill();

      // 뿌리 백열 코어
      if (distFrac < 0.05) {
        this.glowGfx.beginFill(0xfffbeb, alpha * 0.25);
        this.glowGfx.drawCircle(c.x, c.y, c.size * 0.5);
        this.glowGfx.endFill();
      }
    }
  }

  /** 거리(0~1)에 따른 연속 색상 보간 */
  private lerpFlameColor(t: number): number {
    const stops = this.COLOR_STOPS;
    const clamped = Math.max(0, Math.min(1, t));

    for (let i = 0; i < stops.length - 1; i++) {
      if (clamped <= stops[i + 1].t) {
        const f = (clamped - stops[i].t) / (stops[i + 1].t - stops[i].t);
        const r = Math.round(stops[i].r + (stops[i + 1].r - stops[i].r) * f);
        const g = Math.round(stops[i].g + (stops[i + 1].g - stops[i].g) * f);
        const b = Math.round(stops[i].b + (stops[i + 1].b - stops[i].b) * f);
        return (r << 16) | (g << 8) | b;
      }
    }
    const last = stops[stops.length - 1];
    return (last.r << 16) | (last.g << 8) | last.b;
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.cells = [];
    this.glowGfx.clear();
    this.flameGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
