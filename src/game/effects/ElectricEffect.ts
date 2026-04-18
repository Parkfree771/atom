import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 전기 속성 1단계 — 감전 체인
 *
 * 순차 전염: 플레이어→적1→적2→적3→적4→적5
 * 하나씩 하나씩 탁! 탁! 탁! 전이.
 * 빛 레이저처럼 두껍고 강렬한 볼트.
 *
 * 컨테이너 (0,0) — 월드 좌표 직접 그림
 */

interface LightningBolt {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number;
  maxLife: number;
  delay: number;
  chainIndex: number;
  path: Array<{ x: number; y: number }>;
}

export class ElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;

  private bolts: LightningBolt[] = [];

  private readonly COL_OUTER = 0x8b5cf6; // 진한 보라
  private readonly COL_MID   = 0xa78bfa; // 보라
  private readonly COL_INNER = 0xe0e7ff; // 밝은 라벤더
  private readonly COL_CORE  = 0xffffff; // 백

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  /** 순차 체인: points[0]=플레이어 → [1]=적1 → [2]=적2 → ... */
  fireChain(points: Array<{ x: number; y: number }>) {
    if (points.length < 2) return;

    const CHAIN_DELAY = 5;
    const chainCount = points.length - 1;
    for (let i = 0; i < chainCount; i++) {
      // 뒤쪽 볼트일수록 수명 짧게 → 전체가 비슷한 타이밍에 소멸
      const life = Math.max(15, 35 - i * 2);
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

  private makePath(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];

    const segs = Math.max(5, Math.floor(dist / 16));
    const jitter = dist * 0.18;
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

  /** bolts가 비어있지 않을 때만 update 필요 (hot path 최적화) */
  hasActiveBolts(): boolean {
    return this.bolts.length > 0;
  }

  update(dt: number) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];

      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }

      b.life -= dt;
      if (b.life <= 0) {
        swapPop(this.bolts, i);
        continue;
      }
    }

    this.draw();
  }

  private draw() {
    this.gfx.clear();
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      this.drawBolt(b);
    }
  }

  private drawBolt(b: LightningBolt) {
    const life = b.life / b.maxLife;
    const age = b.maxLife - b.life;

    // 등장 순간 과하게 밝게 (탁!)
    const flash = age < 4 ? 1.5 - (age / 4) * 0.5 : 1;

    // 플리커
    const flicker = 0.7 + Math.random() * 0.3;

    const a = life * flicker * flash;
    const pts = b.path;

    // ── 4패스: 빛 레이저처럼 과하게 ──

    // 1) 최외곽: 진한 보라
    this.gfx.lineStyle(22 * flash, this.COL_OUTER, a * 0.25);
    this.gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.gfx.lineTo(pts[i].x, pts[i].y);

    // 2) 외곽: 보라
    this.gfx.lineStyle(14 * flash, this.COL_MID, a * 0.45);
    this.gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.gfx.lineTo(pts[i].x, pts[i].y);

    // 3) 코어: 밝은 라벤더
    this.gfx.lineStyle(6 * flash, this.COL_INNER, a * 0.75);
    this.gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.gfx.lineTo(pts[i].x, pts[i].y);

    // 4) 심선: 순백
    this.gfx.lineStyle(2.5 * flash, this.COL_CORE, a * 0.9);
    this.gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.gfx.lineTo(pts[i].x, pts[i].y);

    // ── 분기 볼트 (25%) ──
    const dx = b.toX - b.fromX;
    const dy = b.toY - b.fromY;
    for (let i = 1; i < pts.length - 1; i++) {
      if (Math.random() < 0.25) {
        const brLen = 10 + Math.random() * 22;
        const brAng = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2.2;
        const bx = pts[i].x + Math.cos(brAng) * brLen;
        const by = pts[i].y + Math.sin(brAng) * brLen;
        const mx = (pts[i].x + bx) / 2 + (Math.random() - 0.5) * 8;
        const my = (pts[i].y + by) / 2 + (Math.random() - 0.5) * 8;

        this.gfx.lineStyle(5 * flash, this.COL_MID, a * 0.3);
        this.gfx.moveTo(pts[i].x, pts[i].y);
        this.gfx.lineTo(mx, my);
        this.gfx.lineTo(bx, by);

        this.gfx.lineStyle(1.5, this.COL_INNER, a * 0.5);
        this.gfx.moveTo(pts[i].x, pts[i].y);
        this.gfx.lineTo(mx, my);
        this.gfx.lineTo(bx, by);
      }
    }
    this.gfx.lineStyle(0);
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
      // 좌표 바뀌었으니 경로도 즉시 재생성
      b.path = this.makePath(b.fromX, b.fromY, b.toX, b.toY);
    }
  }

  stop() {
    this.bolts = [];
    this.gfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
