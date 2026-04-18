import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 전기 × 3 (AAA) — 뇌신의 분노 (Wrath of Thunder God)
 *
 * 슬롯 3칸이 모두 전기일 때만 발동. 1단계 감전 체인과 별개의 고유 클래스.
 *
 * 거동 — 사방 체인 폭주:
 *   - 매 30f마다 캐릭터에서 가까운 N명 적에게 동시 1단계 5연쇄 체인 발사
 *   - 1단계: 1명 → 5연쇄 = 5타 / AAA: 8명 동시 × 5연쇄 = 최대 40타
 *   - 발사 주기 1단계 120f → AAA 30f
 *
 * 시각 — 1단계 ElectricEffect 100% 동일 (사용자: "1단계가 부드럽게 잘 나간다"):
 *   - 매 프레임 path 재생성 (updateChainPositions에서)
 *   - Math.random() flicker (sin X)
 *   - 매 프레임 random 분기 25%
 *   - 4패스 22/14/6/2.5px, 백색 심선
 *   - flash 1.5x age<4
 *   - 색상 1단계와 동일 (보라/라벤더/백)
 *
 * 차이점 (1단계 vs AAA):
 *   - 그룹 N개 동시 (chainGroup 인덱스로 관리)
 *   - 적중 시점에 파바바박 입자 폭발 (사용자: "맞으면서 전이되면서 파바바박")
 *     → 발사 시점 입자/플래시 없음, 적중점에서만 폭발
 */

interface UltBolt {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number;
  maxLife: number;
  delay: number;
  chainGroup: number; // 어느 체인 그룹에 속하는지 (engine이 그룹별 좌표 갱신)
  hopIndex: number;   // 그 그룹 내 hop 순서
  path: Array<{ x: number; y: number }>;
  particlesSpawned: boolean; // 적중 입자 한 번만 spawn
}

interface UltParticle {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

interface HitFlash {
  x: number; y: number;
  life: number; maxLife: number;
}

const CHAIN_HOP_DELAY = 5; // 1단계와 동일

export class ElectricUltimateEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;

  // 색상 — 1단계 ElectricEffect와 100% 동일
  private readonly COL_OUTER = 0x8b5cf6; // 진한 보라
  private readonly COL_MID   = 0xa78bfa; // 보라
  private readonly COL_INNER = 0xe0e7ff; // 밝은 라벤더
  private readonly COL_CORE  = 0xffffff; // 백
  private readonly COL_CYAN  = 0x67e8f9; // cyan-300 (입자 액센트)

  active = false;
  private bolts: UltBolt[] = [];
  private hitParticles: UltParticle[] = [];
  private hitFlashes: HitFlash[] = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  start() {
    this.active = true;
    this.bolts = [];
    this.hitParticles = [];
    this.hitFlashes = [];
  }

  /**
   * 사방 체인 발사 — engine이 발사 주기마다 호출.
   * chains[g] = [캐릭터, 적1, 적2, ...] (1단계 fireChain 패턴, N개 체인 그룹)
   */
  fireBurst(chains: Array<Array<{ x: number; y: number }>>) {
    for (let g = 0; g < chains.length; g++) {
      const points = chains[g];
      if (points.length < 2) continue;
      const hopCount = points.length - 1;
      for (let h = 0; h < hopCount; h++) {
        // 1단계와 동일: 뒤쪽 hop 짧게 → 전체 비슷한 타이밍에 소멸
        const life = Math.max(15, 35 - h * 2);
        this.bolts.push({
          fromX: points[h].x, fromY: points[h].y,
          toX: points[h + 1].x, toY: points[h + 1].y,
          life, maxLife: life,
          delay: h * CHAIN_HOP_DELAY,
          chainGroup: g,
          hopIndex: h,
          path: this.makePath(points[h].x, points[h].y, points[h + 1].x, points[h + 1].y),
          particlesSpawned: false,
        });
      }
    }
  }

  /**
   * 매 프레임 engine이 호출 — 각 chain 그룹의 좌표를 갱신해서 전달.
   * 1단계 ElectricEffect.updateChainPositions와 동일한 패턴 (매 프레임 path 재생성).
   */
  updateChainPositions(positions: Array<Array<{ x: number; y: number }>>) {
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      const grp = positions[b.chainGroup];
      if (!grp) continue;
      const fromIdx = b.hopIndex;
      const toIdx = b.hopIndex + 1;
      if (fromIdx < grp.length) {
        b.fromX = grp[fromIdx].x;
        b.fromY = grp[fromIdx].y;
      }
      if (toIdx < grp.length) {
        b.toX = grp[toIdx].x;
        b.toY = grp[toIdx].y;
      }
      // 좌표 바뀌었으니 경로도 즉시 재생성 (1단계 패턴)
      b.path = this.makePath(b.fromX, b.fromY, b.toX, b.toY);
    }
  }

  update(dt: number) {
    if (!this.active) return;

    // 볼트 업데이트 (1단계 패턴 + 적중 입자 spawn)
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      if (b.delay > 0) {
        b.delay -= dt;
        // delay가 0 이하로 떨어지면 등장 순간 — 적중 입자 spawn
        if (b.delay <= 0 && !b.particlesSpawned) {
          this.spawnHitParticles(b.toX, b.toY);
          b.particlesSpawned = true;
        }
        continue;
      }
      // 첫 프레임에 등장 (delay 없는 0번 hop)
      if (!b.particlesSpawned) {
        this.spawnHitParticles(b.toX, b.toY);
        b.particlesSpawned = true;
      }
      b.life -= dt;
      if (b.life <= 0) {
        swapPop(this.bolts, i);
      }
    }

    // 입자 업데이트 (트레일 + 드래그)
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= dt;
      if (p.life <= 0) {
        swapPop(this.hitParticles, i);
      }
    }

    // 적중 코어 플래시 페이드
    for (let i = this.hitFlashes.length - 1; i >= 0; i--) {
      const f = this.hitFlashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        swapPop(this.hitFlashes, i);
      }
    }

    this.draw();
  }

  // ── 1단계 ElectricEffect.makePath와 100% 동일 ──
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

  // ── 적중 입자 폭발 (한 적당 ~38개) — 사용자: "맞으면서 전이되면서 파바바박 격렬하게" ──
  private spawnHitParticles(x: number, y: number) {
    const N = 38;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 5 + Math.random() * 9;
      const life = 22 + Math.random() * 26;
      // 70% 보라, 30% 시안 액센트
      const isCyan = Math.random() < 0.30;
      const color = isCyan
        ? this.COL_CYAN
        : (Math.random() < 0.5 ? this.COL_INNER : this.COL_MID);
      this.hitParticles.push({
        x, y,
        prevX: x, prevY: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size: 1.8 + Math.random() * 2.4,
        color,
      });
    }
    // 적중점에 짧은 코어 플래시 (8f)
    this.hitFlashes.push({ x, y, life: 8, maxLife: 8 });
  }

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();

    // 볼트 (1단계 패턴)
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      this.drawBolt(b);
    }

    // 적중 코어 플래시 (입자 뒤에 — 입자가 위에 보이게)
    this.drawHitFlashes();

    // 적중 입자 (파바바박)
    this.drawHitParticles();
  }

  private drawHitFlashes() {
    for (const f of this.hitFlashes) {
      const t = f.life / f.maxLife; // 1→0
      const r = 8 + (1 - t) * 6; // 8→14
      // 코어 3겹 NORMAL (밝은 라벤더 → 보라)
      this.gfx.beginFill(this.COL_INNER, 0.85 * t);
      this.gfx.drawCircle(f.x, f.y, r * 0.4);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MID, 0.55 * t);
      this.gfx.drawCircle(f.x, f.y, r * 0.7);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_OUTER, 0.30 * t);
      this.gfx.drawCircle(f.x, f.y, r);
      this.gfx.endFill();
    }
  }

  // ── 1단계 ElectricEffect.drawBolt와 100% 동일 (그룹 인덱스만 추가) ──
  private drawBolt(b: UltBolt) {
    const life = b.life / b.maxLife;
    const age = b.maxLife - b.life;

    // 등장 순간 과하게 밝게 (탁!) — 1단계와 동일
    const flash = age < 4 ? 1.5 - (age / 4) * 0.5 : 1;

    // 플리커 — 1단계와 동일 (Math.random)
    const flicker = 0.7 + Math.random() * 0.3;

    const a = life * flicker * flash;
    const pts = b.path;

    // ── 4패스 (1단계와 100% 동일 두께/색) ──

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

    // 4) 심선: 순백 (1단계와 동일)
    this.gfx.lineStyle(2.5 * flash, this.COL_CORE, a * 0.9);
    this.gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.gfx.lineTo(pts[i].x, pts[i].y);

    // ── 분기 볼트 (1단계와 100% 동일, 매 프레임 random 25%) ──
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

  private drawHitParticles() {
    this.gfx.lineStyle(0);
    for (const p of this.hitParticles) {
      const t = p.life / p.maxLife;
      const alpha = t * 0.92;
      const sz = p.size * (0.5 + t * 0.5);

      // 트레일 (이전 → 현재)
      this.gfx.lineStyle(sz * 0.7, p.color, alpha * 0.55);
      this.gfx.moveTo(p.prevX, p.prevY);
      this.gfx.lineTo(p.x, p.y);
      this.gfx.lineStyle(0);

      // 코어 점
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(p.x, p.y, sz);
      this.gfx.endFill();
    }
  }

  /** 활성 볼트가 있는지 (engine이 chain 좌표 갱신 호출 여부 결정) */
  hasActiveBolts(): boolean {
    return this.bolts.length > 0;
  }

  stop() {
    this.active = false;
    this.bolts = [];
    this.hitParticles = [];
    this.hitFlashes = [];
    this.gfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
