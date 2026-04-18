import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 빛+전기 2단계 — 프리즘 방전 (Prism Discharge)
 *
 * 차징: 광점이 모이면서 전기 아크가 광점 사이를 잇고, 프리즘 결정체가 형성
 * 발사: 차징 완료 시 금빛 체인 라이트닝 (전기 1단계 구조 + 금빛 강화)
 *       플레이어→적1→적2→...→적N 순차 전이, 더 두껍고 화려한 볼트
 */

// ── 차징 광점 ──
interface ChargeParticle {
  x: number;
  y: number;
  speed: number;
  size: number;
  id: number;
}

// ── 체인 볼트 ──
interface ChainBolt {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number;
  maxLife: number;
  delay: number;
  chainIndex: number;
  path: Array<{ x: number; y: number }>;
}

const enum PrismPhase {
  CHARGING = 0,
  FIRING = 1,
}

export class LightElectricEffect {
  private container: PIXI.Container;
  private glowGfx: PIXI.Graphics;
  private boltGfx: PIXI.Graphics;
  private arcGfx: PIXI.Graphics;

  active = false;
  private time = 0;
  private playerX = 0;
  private playerY = 0;

  // 페이즈
  private phase: PrismPhase = PrismPhase.CHARGING;
  private phaseTimer = 0;
  private readonly CHARGE_DURATION = 80;
  private readonly FIRE_DURATION = 50;

  // 엔진 통신: 차징 완료 시 true → 엔진이 체인 타겟 찾아서 fireChain() 호출
  chainFiredThisFrame = false;

  // 차징 광점
  private chargeParticles: ChargeParticle[] = [];
  private particleIdCounter = 0;

  // 프리즘 결정체
  private prismAngle = 0;
  private prismPulse = 0;

  // 전기 링
  private ringPhase = 0;

  // 체인 볼트
  private bolts: ChainBolt[] = [];

  // ── 색상 ──
  // 차징 (보라 포인트)
  private readonly COL_PURPLE    = 0xa78bfa;
  private readonly COL_DEEP_PURP = 0x8b5cf6;
  private readonly COL_LAVENDER  = 0xe0e7ff;
  // 공용
  private readonly COL_WHITE     = 0xffffff;
  // 볼트 (금빛)
  private readonly COL_BRIGHT_GOLD = 0xfde047;
  private readonly COL_GOLD        = 0xfef08a;
  private readonly COL_CREAM       = 0xfef9c3;
  private readonly COL_AMBER       = 0xf59e0b;
  private readonly COL_DEEP_GOLD   = 0xeab308;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.arcGfx = new PIXI.Graphics();
    this.arcGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.arcGfx);

    this.boltGfx = new PIXI.Graphics();
    this.container.addChild(this.boltGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.phase = PrismPhase.CHARGING;
    this.phaseTimer = 0;
    this.chargeParticles = [];
    this.bolts = [];
    this.chainFiredThisFrame = false;
    this.prismAngle = 0;
    this.playerX = x;
    this.playerY = y;
    // 컨테이너는 (0,0)에 고정 — 차징은 playerX/Y 기준, 볼트는 월드 좌표 직접
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.playerX = x;
    this.playerY = y;
  }

  /** 엔진이 체인 타겟 좌표를 월드 좌표로 전달. 순차 체인: points[0]=플레이어 → [1]=적1 → ... */
  fireChain(points: Array<{ x: number; y: number }>) {
    if (points.length < 2) return;

    const CHAIN_DELAY = 4; // 전기 1단계(5)보다 빠르게
    const chainCount = points.length - 1;
    for (let i = 0; i < chainCount; i++) {
      const life = Math.max(18, 40 - i * 2);
      this.bolts.push({
        fromX: points[i].x, fromY: points[i].y,
        toX: points[i + 1].x, toY: points[i + 1].y,
        life, maxLife: life,
        delay: i * CHAIN_DELAY,
        chainIndex: i,
        path: this.makePath(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y),
      });
    }
  }

  /** 매 프레임 볼트 좌표를 적 현재 위치로 갱신 + 경로 재생성 */
  updateChainPositions(positions: Array<{ x: number; y: number }>) {
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      const fromIdx = b.chainIndex;
      const toIdx = b.chainIndex + 1;
      if (fromIdx < positions.length) {
        b.fromX = positions[fromIdx].x;
        b.fromY = positions[fromIdx].y;
      }
      if (toIdx < positions.length) {
        b.toX = positions[toIdx].x;
        b.toY = positions[toIdx].y;
      }
      b.path = this.makePath(b.fromX, b.fromY, b.toX, b.toY);
    }
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.chainFiredThisFrame = false;
    this.phaseTimer += dt;

    if (this.phase === PrismPhase.CHARGING) {
      this.updateCharging(dt);
      if (this.phaseTimer >= this.CHARGE_DURATION) {
        this.phase = PrismPhase.FIRING;
        this.phaseTimer = 0;
        this.chainFiredThisFrame = true;
        this.chargeParticles = [];
      }
    } else {
      // 볼트 수명/딜레이
      for (let i = this.bolts.length - 1; i >= 0; i--) {
        const b = this.bolts[i];
        if (b.delay > 0) { b.delay -= dt; continue; }
        b.life -= dt;
        if (b.life <= 0) { swapPop(this.bolts, i); }
      }
      if (this.phaseTimer >= this.FIRE_DURATION) {
        this.phase = PrismPhase.CHARGING;
        this.phaseTimer = 0;
        this.bolts = [];
      }
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  차징
  // ═══════════════════════════════════════════════════════════

  private updateCharging(dt: number) {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    this.prismAngle += 0.03 * dt;
    this.prismPulse = Math.sin(this.time * 0.15) * 0.3 + 0.7;
    this.ringPhase += 0.08 * dt;

    // 광점 생성
    const spawnRate = 3 + progress * 5;
    if (Math.floor(this.time) % Math.max(1, Math.floor(3 - spawnRate)) === 0
        && this.chargeParticles.length < 45) {
      const count = 2 + Math.floor(progress * 3);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 55 + Math.random() * 75;
        this.chargeParticles.push({
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          speed: 1.0 + Math.random() * 0.6 + progress * 2.0,
          size: 0.8 + Math.random() * 1.4,
          id: this.particleIdCounter++,
        });
      }
    }

    // 광점 이동
    for (let i = this.chargeParticles.length - 1; i >= 0; i--) {
      const p = this.chargeParticles[i];
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d < 4) { swapPop(this.chargeParticles, i); continue; }
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
    this.arcGfx.clear();
    this.boltGfx.clear();

    if (this.phase === PrismPhase.CHARGING) {
      this.drawCharging();
    } else {
      this.drawBolts();
    }
  }

  private drawCharging() {
    const progress = this.phaseTimer / this.CHARGE_DURATION;
    const pts = this.chargeParticles;
    const cx = this.playerX;
    const cy = this.playerY;

    // ── 1. 광점들 ──
    this.glowGfx.lineStyle(0);
    for (const p of pts) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      const alpha = Math.min(1, d / 25) * 0.75;

      const isElectric = p.id % 4 === 0; // 1/4만 보라, 나머지 금빛
      const glowCol = isElectric ? this.COL_PURPLE : this.COL_AMBER;
      const coreCol = isElectric ? this.COL_LAVENDER : this.COL_BRIGHT_GOLD;

      this.glowGfx.beginFill(glowCol, alpha * 0.2);
      this.glowGfx.drawCircle(cx + p.x, cy + p.y, p.size * 3);
      this.glowGfx.endFill();

      this.glowGfx.beginFill(coreCol, alpha);
      this.glowGfx.drawCircle(cx + p.x, cy + p.y, p.size);
      this.glowGfx.endFill();
    }

    // ── 2. 광점 사이 전기 아크 ──
    if (pts.length >= 2 && progress > 0.15) {
      const arcAlpha = Math.min(1, (progress - 0.15) / 0.3) * 0.6;

      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j].x - pts[i].x;
          const dy = pts[j].y - pts[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 35 && dist > 3) {
            const arcIsGold = (i + j) % 2 === 0;
            const arcCol = arcIsGold ? this.COL_BRIGHT_GOLD : this.COL_PURPLE;
            const arcGlow = arcIsGold ? this.COL_AMBER : this.COL_DEEP_PURP;
            this.arcGfx.lineStyle(1.5, arcCol, arcAlpha * (0.5 + Math.random() * 0.5));
            this.arcGfx.moveTo(cx + pts[i].x, cy + pts[i].y);
            const mx = (pts[i].x + pts[j].x) / 2 + (Math.random() - 0.5) * dist * 0.4;
            const my = (pts[i].y + pts[j].y) / 2 + (Math.random() - 0.5) * dist * 0.4;
            this.arcGfx.lineTo(cx + mx, cy + my);
            this.arcGfx.lineTo(cx + pts[j].x, cy + pts[j].y);

            this.arcGfx.lineStyle(4, arcGlow, arcAlpha * 0.15);
            this.arcGfx.moveTo(cx + pts[i].x, cy + pts[i].y);
            this.arcGfx.lineTo(cx + mx, cy + my);
            this.arcGfx.lineTo(cx + pts[j].x, cy + pts[j].y);
          }
        }
      }
      this.arcGfx.lineStyle(0);
    }

    // ── 3. 프리즘 결정체 (30%부터) ──
    if (progress > 0.3) {
      const prismAlpha = Math.min(1, (progress - 0.3) / 0.3);
      const prismSize = 8 + progress * 10;
      const sides = 6;
      const pulse = this.prismPulse;

      this.glowGfx.lineStyle(3 * prismAlpha, this.COL_PURPLE, 0.3 * prismAlpha * pulse);
      this.drawPolygon(this.glowGfx, cx, cy, prismSize * 1.6, sides, this.prismAngle);

      this.glowGfx.lineStyle(2 * prismAlpha, this.COL_GOLD, 0.6 * prismAlpha);
      this.drawPolygon(this.glowGfx, cx, cy, prismSize, sides, this.prismAngle);

      this.glowGfx.lineStyle(1 * prismAlpha, this.COL_CREAM, 0.5 * prismAlpha * pulse);
      this.drawPolygon(this.glowGfx, cx, cy, prismSize * 0.6, sides, this.prismAngle + 0.5);

      this.glowGfx.lineStyle(0);
      this.glowGfx.beginFill(this.COL_BRIGHT_GOLD, 0.22 * prismAlpha * pulse);
      this.glowGfx.drawCircle(cx, cy, prismSize * 1.2);
      this.glowGfx.endFill();

      this.glowGfx.beginFill(this.COL_GOLD, 0.15 * prismAlpha * pulse);
      this.glowGfx.drawCircle(cx, cy, prismSize * 0.5);
      this.glowGfx.endFill();
    }

    // ── 4. 전기 링 (60%부터) ──
    if (progress > 0.6) {
      const ringAlpha = Math.min(1, (progress - 0.6) / 0.2) * 0.5;
      const ringR = 25 + Math.sin(this.ringPhase) * 8;
      const flicker = 0.6 + Math.random() * 0.4;

      this.arcGfx.lineStyle(2.5, this.COL_BRIGHT_GOLD, ringAlpha * flicker);
      this.arcGfx.drawCircle(cx, cy, ringR);
      this.arcGfx.lineStyle(5, this.COL_AMBER, ringAlpha * 0.2 * flicker);
      this.arcGfx.drawCircle(cx, cy, ringR);
      this.arcGfx.lineStyle(0);
    }
  }

  private drawBolts() {
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      this.drawSingleBolt(b);
    }
  }

  private drawSingleBolt(b: ChainBolt) {
    const lifeRatio = b.life / b.maxLife;
    const age = b.maxLife - b.life;

    // 등장 순간 과하게 밝게 (탁!)  — 전기 1단계보다 더 강렬
    const flash = age < 4 ? 1.8 - (age / 4) * 0.8 : 1;
    const flicker = 0.7 + Math.random() * 0.3;
    const a = lifeRatio * flicker * flash;

    const pts = b.path;

    // ── 5패스: 금빛 번개 (전기 1단계 4패스 → 5패스 + 더 두꺼움) ──

    // 1) 최외곽: 앰버 헤이즈 (전기에는 없는 후광)
    this.boltGfx.lineStyle(28 * flash, this.COL_AMBER, a * 0.12);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // 2) 외곽: 진한 금 (전기의 진보라 자리)
    this.boltGfx.lineStyle(18 * flash, this.COL_DEEP_GOLD, a * 0.3);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // 3) 중간: 선명한 금 (전기의 보라 자리)
    this.boltGfx.lineStyle(10 * flash, this.COL_BRIGHT_GOLD, a * 0.55);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // 4) 코어: 밝은 금/크림 (전기의 라벤더 자리)
    this.boltGfx.lineStyle(5 * flash, this.COL_CREAM, a * 0.8);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // 5) 심선: 순백
    this.boltGfx.lineStyle(2.5 * flash, this.COL_WHITE, a * 0.95);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // ── 분기 볼트 (30%) — 전기 1단계(25%)보다 빈번 ──
    const dx = b.toX - b.fromX;
    const dy = b.toY - b.fromY;
    for (let i = 1; i < pts.length - 1; i++) {
      if (Math.random() < 0.3) {
        const brLen = 12 + Math.random() * 25;
        const brAng = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2.2;
        const bx = pts[i].x + Math.cos(brAng) * brLen;
        const by = pts[i].y + Math.sin(brAng) * brLen;
        const mx = (pts[i].x + bx) / 2 + (Math.random() - 0.5) * 8;
        const my = (pts[i].y + by) / 2 + (Math.random() - 0.5) * 8;

        // 분기 외곽
        this.boltGfx.lineStyle(6 * flash, this.COL_DEEP_GOLD, a * 0.2);
        this.boltGfx.moveTo(pts[i].x, pts[i].y);
        this.boltGfx.lineTo(mx, my);
        this.boltGfx.lineTo(bx, by);

        // 분기 코어
        this.boltGfx.lineStyle(2, this.COL_BRIGHT_GOLD, a * 0.5);
        this.boltGfx.moveTo(pts[i].x, pts[i].y);
        this.boltGfx.lineTo(mx, my);
        this.boltGfx.lineTo(bx, by);
      }
    }
    this.boltGfx.lineStyle(0);

    // ── 적중점 스파크 (금빛 폭발) ──
    const endPt = pts[pts.length - 1];
    if (age < 8) {
      const sparkA = a * (1 - age / 8);
      this.glowGfx.lineStyle(0);
      this.glowGfx.beginFill(this.COL_WHITE, 0.6 * sparkA);
      this.glowGfx.drawCircle(endPt.x, endPt.y, 8);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(this.COL_BRIGHT_GOLD, 0.4 * sparkA);
      this.glowGfx.drawCircle(endPt.x, endPt.y, 16);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(this.COL_AMBER, 0.15 * sparkA);
      this.glowGfx.drawCircle(endPt.x, endPt.y, 24);
      this.glowGfx.endFill();
    }

    // ── 시작점(전이 원점) 글로우 ──
    const startPt = pts[0];
    if (age < 5) {
      const startA = a * (1 - age / 5) * 0.6;
      this.glowGfx.beginFill(this.COL_GOLD, startA * 0.3);
      this.glowGfx.drawCircle(startPt.x, startPt.y, 12);
      this.glowGfx.endFill();
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  유틸
  // ═══════════════════════════════════════════════════════════

  private drawPolygon(gfx: PIXI.Graphics, cx: number, cy: number, r: number, sides: number, rotation: number) {
    for (let i = 0; i <= sides; i++) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) gfx.moveTo(px, py);
      else gfx.lineTo(px, py);
    }
  }

  private makePath(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];

    const segs = Math.max(5, Math.floor(dist / 14)); // 전기(16)보다 촘촘
    const jitter = dist * 0.2;
    const perpX = -dy / dist;
    const perpY = dx / dist;

    const pts: Array<{ x: number; y: number }> = [{ x: x0, y: y0 }];
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const j = (Math.random() - 0.5) * jitter;
      pts.push({
        x: x0 + dx * t + perpX * j,
        y: y0 + dy * t + perpY * j,
      });
    }
    pts.push({ x: x1, y: y1 });
    return pts;
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.chargeParticles = [];
    this.bolts = [];
    this.glowGfx.clear();
    this.arcGfx.clear();
    this.boltGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
