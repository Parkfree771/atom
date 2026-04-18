import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불+전기 2단계 — 체인 봄버 (Chain Bomber)
 *
 * 컨셉: 푸른 전기 체인이 적을 차례로 감전시킨 뒤,
 *        시차를 두고 그 자리들에서 화염 폭발이 펑펑펑 터진다.
 *        "지지직 → (10f 후) → 펑펑펑펑"
 *
 * 검증된 컴포넌트 조합:
 *   - 체인 라이트닝 시스템 → ElectricEffect 패턴 (지그재그 볼트 + 4패스 + 분기)
 *     색은 붉은 톤(red-900/600/300 + 백열 코어)으로 변경. 폭발과 톤 통일
 *   - 폭발 셀 시스템 → WaterFireEffect.spawnBurst 작은 버전 (35개/폭발)
 *     백열/화염/잔해 3종 + 충격파 1발
 *   - 색 보간 → FireEffect.lerpFlameColor 11스톱 적색 패턴
 *
 * 구조:
 *   - 컨테이너 (0,0) — 월드 좌표 직접 그림 (ElectricEffect와 동일)
 *   - 폭발 인스턴스 다중 동시 진행 (Explosion 배열)
 *   - 폭발 발동은 engine이 직접 spawnExplosion(x, y) 호출 (시차 타이머는 engine이 관리)
 *   - effect 클래스는 시각만 담당, 게임 로직(폭발 데미지/타이머)은 engine
 *
 * 기존 폭발 이펙트와 차별화:
 *   - 스팀폭발/항성붕괴/마그마균열: 캐릭터 주변 1점 큰 폭발
 *   - 체인 봄버: 적 위치마다 작은 폭발 다중 (체인 사거리만큼 멀리)
 *   - 유일한 "원격 다중 폭발" 카테고리
 */

// ───────────────────────────────────────────────────────────────
//  타입 정의
// ───────────────────────────────────────────────────────────────

interface LightningBolt {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number;
  maxLife: number;
  delay: number;
  chainIndex: number;
  path: Array<{ x: number; y: number }>;
}

/** 폭발 셀: 백열/화염/잔해 3종 (WaterFireEffect 패턴) */
interface BurstParticle {
  /** 폭발 중심 기준 로컬 오프셋 */
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=백열 코어, 1=화염 본체, 2=잔해 */
  type: 0 | 1 | 2;
}

/** 단일 폭발 인스턴스 */
interface Explosion {
  /** 월드 좌표 (생성 시 고정) */
  x: number;
  y: number;
  /** 진행 시간 (프레임) */
  age: number;
  /** 폭발 셀들 */
  particles: BurstParticle[];
  /** 충격파 진행 (0~1) */
  shockwaveProgress: number;
}

// ───────────────────────────────────────────────────────────────
//  색상 보간 — 적색 화염 (FireEffect.lerpFlameColor 패턴)
// ───────────────────────────────────────────────────────────────

interface ColorStop { t: number; r: number; g: number; b: number; }

const FLAME_STOPS: ColorStop[] = [
  { t: 0.00, r: 0xff, g: 0xff, b: 0xff }, // pure white
  { t: 0.05, r: 0xff, g: 0xf7, b: 0xed }, // warm white
  { t: 0.12, r: 0xfd, g: 0xe0, b: 0x47 }, // 황금
  { t: 0.22, r: 0xfb, g: 0x92, b: 0x3c }, // orange-400
  { t: 0.36, r: 0xea, g: 0x58, b: 0x0c }, // orange-600
  { t: 0.52, r: 0xc2, g: 0x41, b: 0x0c }, // orange-700
  { t: 0.68, r: 0x7c, g: 0x2d, b: 0x12 }, // orange-900
  { t: 0.82, r: 0x44, g: 0x18, b: 0x1a }, // 검적색
  { t: 1.00, r: 0x1a, g: 0x08, b: 0x08 }, // 거의 검정
];

function lerpFlameColor(t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < FLAME_STOPS.length - 1; i++) {
    const a = FLAME_STOPS[i];
    const b = FLAME_STOPS[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const u = (tt - a.t) / (b.t - a.t);
      const r = Math.round(a.r + (b.r - a.r) * u);
      const g = Math.round(a.g + (b.g - a.g) * u);
      const bl = Math.round(a.b + (b.b - a.b) * u);
      return (r << 16) | (g << 8) | bl;
    }
  }
  const last = FLAME_STOPS[FLAME_STOPS.length - 1];
  return (last.r << 16) | (last.g << 8) | last.b;
}

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class FireElectricEffect {
  private container: PIXI.Container;
  /** 전기 볼트 (NORMAL 블렌드) */
  private boltGfx: PIXI.Graphics;
  /** 폭발 글로우 (ADD 블렌드) */
  private explosionGlowGfx: PIXI.Graphics;
  /** 폭발 셀 본체 (NORMAL 블렌드) */
  private explosionCellGfx: PIXI.Graphics;
  /** 폭발 코어/스파크 (NORMAL 위) */
  private explosionCoreGfx: PIXI.Graphics;

  private bolts: LightningBolt[] = [];
  private explosions: Explosion[] = [];

  /** 폭발 반경 — 데미지 판정용 (engine이 참조) */
  readonly explosionRadius = 70;

  // ── 붉은 전기 색 팔레트 (1단계 전기의 보라 → 적색, 폭발과 톤 통일) ──
  // 백열 코어는 유지 — 번개 정체성. 1단계 불은 노랑/오렌지 위주라 형태/색 분포 모두 다름
  private readonly COL_OUTER = 0x7f1d1d; // red-900 진한 적색
  private readonly COL_MID   = 0xdc2626; // red-600 적색
  private readonly COL_INNER = 0xfca5a5; // red-300 밝은 적색
  private readonly COL_CORE  = 0xffffff; // 백열 (번개 임팩트 유지)

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 폭발 글로우 (가장 아래, ADD)
    this.explosionGlowGfx = new PIXI.Graphics();
    this.explosionGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.explosionGlowGfx);

    // 폭발 셀 본체 (NORMAL)
    this.explosionCellGfx = new PIXI.Graphics();
    this.container.addChild(this.explosionCellGfx);

    // 전기 볼트 (위)
    this.boltGfx = new PIXI.Graphics();
    this.container.addChild(this.boltGfx);

    // 폭발 코어 (가장 위)
    this.explosionCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.explosionCoreGfx);
  }

  // ═══════════════════════════════════════════════════════════
  //  체인 라이트닝 (ElectricEffect 패턴 그대로)
  // ═══════════════════════════════════════════════════════════

  /** 순차 체인: points[0]=플레이어 → [1]=적1 → [2]=적2 → ... */
  fireChain(points: Array<{ x: number; y: number }>) {
    if (points.length < 2) return;

    const CHAIN_DELAY = 5;
    const chainCount = points.length - 1;
    for (let i = 0; i < chainCount; i++) {
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

  // ═══════════════════════════════════════════════════════════
  //  폭발 (engine이 호출, 시차 타이머는 engine이 관리)
  // ═══════════════════════════════════════════════════════════

  /** 좌표 (x, y)에 폭발 시각 발동. engine이 데미지 처리 후 호출. */
  spawnExplosion(x: number, y: number) {
    const particles: BurstParticle[] = [];
    const total = 35;
    for (let i = 0; i < total; i++) {
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const speed = 3.5 + Math.random() * 4.5;

      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.18) {
        type = 0; // 백열 코어
        size = 2.5 + Math.random() * 2.5;
        maxLife = 18 + Math.random() * 8;
      } else if (r < 0.78) {
        type = 1; // 화염 본체
        size = 1.5 + Math.random() * 2.5;
        maxLife = 22 + Math.random() * 12;
      } else {
        type = 2; // 잔해
        size = 1.0 + Math.random() * 1.8;
        maxLife = 28 + Math.random() * 10;
      }

      const startDist = 3 + Math.random() * 4;
      particles.push({
        ox: Math.cos(angle) * startDist,
        oy: Math.sin(angle) * startDist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife,
        size,
        type,
      });
    }

    this.explosions.push({
      x, y,
      age: 0,
      particles,
      shockwaveProgress: 0,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  /** 작업할 게 있을 때만 update 필요 (hot path 최적화) */
  hasActiveWork(): boolean {
    return this.bolts.length > 0 || this.explosions.length > 0;
  }

  update(dt: number) {
    // 볼트 업데이트
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      b.life -= dt;
      if (b.life <= 0) {
        swapPop(this.bolts, i);
      }
    }

    // 폭발 업데이트
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i];
      ex.age += dt;

      // 셀 이동 + 드래그
      for (let j = ex.particles.length - 1; j >= 0; j--) {
        const p = ex.particles[j];
        p.life += dt;
        if (p.life >= p.maxLife) {
          swapPop(ex.particles, j);
          continue;
        }
        p.ox += p.vx * dt;
        p.oy += p.vy * dt;
        const drag = p.type === 2 ? 0.92 : 0.94;
        p.vx *= drag;
        p.vy *= drag;
      }

      // 충격파 진행
      ex.shockwaveProgress += dt / 22;

      // 폭발 종료: 셀 다 없어졌고 충격파 끝났으면 제거
      if (ex.particles.length === 0 && ex.shockwaveProgress >= 1) {
        swapPop(this.explosions, i);
      }
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.boltGfx.clear();
    this.explosionGlowGfx.clear();
    this.explosionCellGfx.clear();
    this.explosionCoreGfx.clear();

    // 폭발 (아래에 그리고 볼트가 위에 보이도록)
    for (const ex of this.explosions) {
      this.drawExplosion(ex);
    }

    // 전기 볼트 (위)
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      this.drawBolt(b);
    }
  }

  // ───────────────────────────────────────────────────────────
  //  볼트 드로우 (ElectricEffect 패턴 + 푸른 색)
  // ───────────────────────────────────────────────────────────

  private drawBolt(b: LightningBolt) {
    const life = b.life / b.maxLife;
    const age = b.maxLife - b.life;

    const flash = age < 4 ? 1.5 - (age / 4) * 0.5 : 1;
    const flicker = 0.7 + Math.random() * 0.3;

    const a = life * flicker * flash;
    const pts = b.path;

    // 4패스 (1단계 전기와 동일 구조, 색만 푸른)
    this.boltGfx.lineStyle(22 * flash, this.COL_OUTER, a * 0.25);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    this.boltGfx.lineStyle(14 * flash, this.COL_MID, a * 0.45);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    this.boltGfx.lineStyle(6 * flash, this.COL_INNER, a * 0.75);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    this.boltGfx.lineStyle(2.5 * flash, this.COL_CORE, a * 0.9);
    this.boltGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.boltGfx.lineTo(pts[i].x, pts[i].y);

    // 분기 볼트
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

        this.boltGfx.lineStyle(5 * flash, this.COL_MID, a * 0.3);
        this.boltGfx.moveTo(pts[i].x, pts[i].y);
        this.boltGfx.lineTo(mx, my);
        this.boltGfx.lineTo(bx, by);

        this.boltGfx.lineStyle(1.5, this.COL_INNER, a * 0.5);
        this.boltGfx.moveTo(pts[i].x, pts[i].y);
        this.boltGfx.lineTo(mx, my);
        this.boltGfx.lineTo(bx, by);
      }
    }
    this.boltGfx.lineStyle(0);
  }

  // ───────────────────────────────────────────────────────────
  //  폭발 드로우
  // ───────────────────────────────────────────────────────────

  private drawExplosion(ex: Explosion) {
    // ── 셀 ──
    this.explosionCellGfx.lineStyle(0);
    for (const p of ex.particles) {
      const lifeFrac = p.life / p.maxLife;
      const sizePhase = lifeFrac < 0.25
        ? 1 + lifeFrac * 1.0
        : 1.25 - (lifeFrac - 0.25) * 0.5;
      const r = p.size * sizePhase;

      let color: number;
      let alpha: number;
      let glowColor: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        // 백열 코어
        color = lerpFlameColor(lifeFrac * 0.40);
        alpha = (1 - lifeFrac * 0.50) * 0.95;
        glowColor = lerpFlameColor(Math.max(0, lifeFrac * 0.30));
        glowAlpha = (1 - lifeFrac) * 0.60;
        glowMul = 2.6;
      } else if (p.type === 1) {
        // 화염 본체
        color = lerpFlameColor(0.18 + lifeFrac * 0.55);
        alpha = (1 - lifeFrac * 0.40) * 0.78;
        glowColor = lerpFlameColor(0.15 + lifeFrac * 0.40);
        glowAlpha = (1 - lifeFrac) * 0.32;
        glowMul = 2.0;
      } else {
        // 잔해
        color = lerpFlameColor(0.50 + lifeFrac * 0.50);
        alpha = (1 - lifeFrac * 0.30) * 0.70;
        glowColor = lerpFlameColor(0.45 + lifeFrac * 0.40);
        glowAlpha = (1 - lifeFrac) * 0.18;
        glowMul = 1.7;
      }

      const wx = ex.x + p.ox;
      const wy = ex.y + p.oy;

      // 글로우
      this.explosionGlowGfx.beginFill(glowColor, glowAlpha);
      this.explosionGlowGfx.drawCircle(wx, wy, r * glowMul);
      this.explosionGlowGfx.endFill();

      // 본체
      this.explosionCellGfx.beginFill(color, alpha);
      this.explosionCellGfx.drawCircle(wx, wy, r);
      this.explosionCellGfx.endFill();

      // 백열 코어 셀은 한 번 더 작은 흰 점
      if (p.type === 0 && lifeFrac < 0.4) {
        const sparkA = (1 - lifeFrac / 0.4) * 0.75;
        this.explosionCoreGfx.beginFill(0xffffff, sparkA);
        this.explosionCoreGfx.drawCircle(wx, wy, r * 0.4);
        this.explosionCoreGfx.endFill();
      }
    }

    // ── 충격파 (1발) ──
    if (ex.shockwaveProgress < 1) {
      const p = ex.shockwaveProgress;
      const radiusFrac = p < 0.2
        ? (p / 0.2) * 0.7
        : 0.7 + ((p - 0.2) / 0.8) * 0.3;
      const r = radiusFrac * this.explosionRadius;
      const fade = (1 - p) * (1 - p);

      this.explosionGlowGfx.lineStyle(12 * (1 - p * 0.4), 0xc2410c, fade * 0.40);
      this.explosionGlowGfx.drawCircle(ex.x, ex.y, r);

      this.explosionGlowGfx.lineStyle(8 * (1 - p * 0.3), 0xfb923c, fade * 0.55);
      this.explosionGlowGfx.drawCircle(ex.x, ex.y, r);

      this.explosionGlowGfx.lineStyle(5 * (1 - p * 0.25), 0xfde047, fade * 0.65);
      this.explosionGlowGfx.drawCircle(ex.x, ex.y, r);

      this.explosionGlowGfx.lineStyle(2.5, 0xffffff, fade * 0.80);
      this.explosionGlowGfx.drawCircle(ex.x, ex.y, r);

      this.explosionGlowGfx.lineStyle(0);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.bolts = [];
    this.explosions = [];
    this.boltGfx.clear();
    this.explosionGlowGfx.clear();
    this.explosionCellGfx.clear();
    this.explosionCoreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
