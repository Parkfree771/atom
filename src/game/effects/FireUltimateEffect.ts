import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불 × 3 (AAA) — 태양 (Sun + Volcanic Burst)
 *
 * 슬롯 3칸이 모두 불일 때만 발동. 1단계 화염방사기와 별개의 고유 클래스.
 *
 * 거동:
 *   - 캐릭터 머리 위에 작은 태양 구체 (호흡, 표면 화염 셀이 끓음)
 *   - 매 30f마다 태양에서 사방 10발 화염 발사체 분출 (포물선 궤적, 화산 분출)
 *   - 발사체 수명 종료 시 그 자리에서 펑 + 입자 30개+ 폭발 (광역 데미지)
 *   - 주기적 반복 (매 30f 분출 → 발사체 떨어짐 → 임팩트)
 *
 * 시각 디자인 원칙 (전기³에서 배운 교훈):
 *   - 태양 구체 자체는 깔끔/정적 (호흡 펄스만, 정신사납지 X)
 *   - 모든 random은 spawn 시점 1번만 결정
 *   - 임팩트는 풍부 (입자 30개+, 코어 플래시, 사용자 "파바박")
 *   - 백색은 백열 코어 1점 OK (불 1단계도 백열 사용)
 *
 * 검증된 컴포넌트:
 *   - FireEffect COLOR_STOPS + lerpFlameColor (11스톱 백열→깊은빨강)
 *   - WaterFireEffect.spawnBurst 폭발 셀 패턴
 *   - EarthDarkEffect 다중 인스턴스 풀 패턴
 *   - 1단계 ElectricEffect 컨테이너/좌표 패턴
 *
 * 좌표계:
 *   - 컨테이너 = effectLayer 자식, (0,0) 고정
 *   - 모든 좌표는 월드 좌표 직접
 *   - 캐릭터 위치는 매 프레임 setPosition으로 갱신 (태양은 그 머리 위)
 *   - 발사체는 spawn 시점 위치 캡처 후 자체 포물선 궤적 (캐릭터와 무관)
 */

interface Burster {
  // 발사체 (화염 유성)
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  // 트레일 (이전 위치 6개)
  trail: Array<{ x: number; y: number }>;
  size: number;
  exploded: boolean;
}

interface ExplosionCell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  type: number; // 0=백열, 1=화염, 2=잔해
  // 색 보간 시작/끝 (lerpFlameColor t 구간)
  tStart: number;
  tEnd: number;
}

interface ImpactFlash {
  x: number; y: number;
  life: number; maxLife: number;
}

interface LavaChunk {
  // 폭발에서 튀어나온 잔해 — 자체 포물선 비행 + 떨어진 자리에서 미니 폭발
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  trail: Array<{ x: number; y: number }>;
  size: number;
  exploded: boolean;
}

interface SunCoronaCell {
  // 태양 표면에서 끓는 화염 셀 (머리 위 작은 셀, 빠르게 사라짐)
  angle: number;     // 태양 중심에서의 각도
  dist: number;      // 태양 중심에서의 거리 (R 안)
  life: number; maxLife: number;
  size: number;
  driftSpeed: number; // 바깥으로 천천히 이동
}

const SUN_OFFSET_Y = -38;     // 캐릭터 머리 위 거리
const SUN_RADIUS = 14;        // 태양 구체 반경
const BURST_INTERVAL = 90;    // 분출 주기 (~1.5초, "팡 → 떨어지고 → 팡" 박자)
const BURSTERS_PER_BURST = 10;// 분출 발사체 수
const GRAVITY = 0.18;         // 발사체 중력
const TRAIL_MAX = 6;          // 트레일 길이

export class FireUltimateEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // 색상 — 마그마 톤 (백열/금색 X, 진한 오렌지~검적색 위주)
  private readonly COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
    { t: 0.00, r: 251, g: 146, b:  60 }, // orange-400 (가장 밝음 — 백열 X)
    { t: 0.10, r: 249, g: 115, b:  22 }, // orange-500
    { t: 0.20, r: 234, g:  88, b:  12 }, // orange-600
    { t: 0.32, r: 194, g:  65, b:  12 }, // orange-700
    { t: 0.45, r: 220, g:  38, b:  38 }, // red-600
    { t: 0.58, r: 185, g:  28, b:  28 }, // red-700
    { t: 0.70, r: 153, g:  27, b:  27 }, // red-800
    { t: 0.82, r: 127, g:  29, b:  29 }, // red-900
    { t: 0.92, r:  87, g:  13, b:  13 }, // 검적
    { t: 1.00, r:  44, g:  10, b:  10 }, // 거의 검정
  ];

  // 마그마 팔레트 (백/금 X)
  private readonly COL_MAGMA_HOT    = 0xfb923c; // orange-400 (코어, 가장 밝음)
  private readonly COL_MAGMA_BRIGHT = 0xf97316; // orange-500
  private readonly COL_MAGMA_ORANGE = 0xea580c; // orange-600
  private readonly COL_MAGMA_DEEP   = 0xc2410c; // orange-700
  private readonly COL_MAGMA_RED    = 0xb91c1c; // red-700
  private readonly COL_MAGMA_DARK   = 0x7f1d1d; // red-900
  private readonly COL_MAGMA_BLACK  = 0x44181a; // 검적

  active = false;
  private bursters: Burster[] = [];
  private cells: ExplosionCell[] = [];
  private flashes: ImpactFlash[] = [];
  private chunks: LavaChunk[] = [];
  private corona: SunCoronaCell[] = [];

  // 캐릭터 위치 (engine이 매 프레임 갱신)
  private posX = 0;
  private posY = 0;

  private burstTimer = 0;
  private time = 0;

  // 이번 프레임에 폭발한 위치들 (engine이 popImpacts로 가져감 — 광역 데미지 처리)
  // type: 'main' = 메인 폭발 (50px, 32뎀) / 'chunk' = 잔해 미니 폭발 (25px, 10뎀)
  private pendingImpacts: Array<{ x: number; y: number; type: 'main' | 'chunk' }> = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.bursters = [];
    this.cells = [];
    this.flashes = [];
    this.chunks = [];
    this.corona = [];
    this.burstTimer = 0;
    this.time = 0;
    this.pendingImpacts = [];
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  popImpacts(): Array<{ x: number; y: number; type: 'main' | 'chunk' }> {
    const arr = this.pendingImpacts;
    this.pendingImpacts = [];
    return arr;
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // ── 분출 주기 ──
    this.burstTimer += dt;
    if (this.burstTimer >= BURST_INTERVAL) {
      this.burstTimer = 0;
      this.spawnBurst();
    }

    // ── 태양 표면 화염 셀 spawn (매 프레임 1~2개) ──
    if (this.corona.length < 18 && Math.random() < 0.7) {
      this.spawnCoronaCell();
    }

    // ── 코로나 셀 업데이트 ──
    for (let i = this.corona.length - 1; i >= 0; i--) {
      const c = this.corona[i];
      c.dist += c.driftSpeed * dt;
      c.life -= dt;
      if (c.life <= 0) {
        swapPop(this.corona, i);
      }
    }

    // ── 발사체 업데이트 (포물선 궤적) ──
    const sunX = this.posX;
    const sunY = this.posY + SUN_OFFSET_Y;
    for (let i = this.bursters.length - 1; i >= 0; i--) {
      const b = this.bursters[i];
      // 트레일 갱신
      b.trail.unshift({ x: b.x, y: b.y });
      if (b.trail.length > TRAIL_MAX) b.trail.length = TRAIL_MAX;
      // 위치 + 중력
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vy += GRAVITY * dt;
      b.life -= dt;
      if (b.life <= 0 && !b.exploded) {
        b.exploded = true;
        this.spawnExplosion(b.x, b.y);
        this.spawnChunks(b.x, b.y);
        this.pendingImpacts.push({ x: b.x, y: b.y, type: 'main' });
        swapPop(this.bursters, i);
      }
    }

    // ── 잔해 chunks 업데이트 (자체 포물선 비행 + 떨어지면 미니 폭발) ──
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      // 트레일
      c.trail.unshift({ x: c.x, y: c.y });
      if (c.trail.length > 5) c.trail.length = 5;
      // 위치 + 중력
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vy += GRAVITY * dt;
      c.life -= dt;
      if (c.life <= 0 && !c.exploded) {
        c.exploded = true;
        this.spawnMiniExplosion(c.x, c.y);
        this.pendingImpacts.push({ x: c.x, y: c.y, type: 'chunk' });
        swapPop(this.chunks, i);
      }
    }

    // ── 폭발 셀 업데이트 ──
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.prevX = c.x;
      c.prevY = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.93;
      c.vy *= 0.93;
      c.life -= dt;
      if (c.life <= 0) {
        swapPop(this.cells, i);
      }
    }

    // ── 코어 플래시 페이드 ──
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        swapPop(this.flashes, i);
      }
    }

    this.draw();

    // 사용 후 반환 (engine이 setPosition 다음 프레임 호출 전 popImpacts 호출)
    void sunX; void sunY;
  }

  // ── 분출: 사방 10발 화염 발사체 ──
  private spawnBurst() {
    const sunX = this.posX;
    const sunY = this.posY + SUN_OFFSET_Y;
    for (let i = 0; i < BURSTERS_PER_BURST; i++) {
      // 360도 균등 + 살짝 jitter
      const angle = (i / BURSTERS_PER_BURST) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      // 위쪽 가중치 (화산 분출 — 솟구침)
      const speed = 3 + Math.random() * 3;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed - 2.0; // 위쪽 2.0만큼 가중 (더 솟구침)
      const life = 36 + Math.random() * 14;
      this.bursters.push({
        x: sunX, y: sunY,
        vx, vy,
        life, maxLife: life,
        trail: [],
        size: 4.0 + Math.random() * 1.8,
        exploded: false,
      });
    }
  }

  // ── 폭발 셀 30개 사방 (WaterFireEffect/FireDarkEffect 패턴) ──
  private spawnExplosion(x: number, y: number) {
    const N = 30;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 4 + Math.random() * 7;
      const r = Math.random();
      let type: number;
      let size: number;
      let life: number;
      let tStart: number;
      let tEnd: number;
      if (r < 0.18) {
        // 백열 코어 (작고 짧음)
        type = 0;
        size = 2.0 + Math.random() * 1.6;
        life = 18 + Math.random() * 14;
        tStart = 0.00;
        tEnd = 0.35;
      } else if (r < 0.78) {
        // 화염 본체 (메인)
        type = 1;
        size = 1.6 + Math.random() * 2.2;
        life = 28 + Math.random() * 18;
        tStart = 0.12;
        tEnd = 0.76;
      } else {
        // 잔해 (어두운 적/검댕)
        type = 2;
        size = 1.4 + Math.random() * 1.8;
        life = 32 + Math.random() * 22;
        tStart = 0.62;
        tEnd = 1.00;
      }
      this.cells.push({
        x, y,
        prevX: x, prevY: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size,
        type,
        tStart,
        tEnd,
      });
    }
    // 코어 플래시
    this.flashes.push({ x, y, life: 8, maxLife: 8 });
  }

  // ── 잔해 chunks (메인 폭발에서 튀어나옴) ──
  private spawnChunks(x: number, y: number) {
    const N = 3; // 3개 잔해 (한 메인 폭발당)
    for (let i = 0; i < N; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3.5 + Math.random() * 3.5;
      const life = 30 + Math.random() * 14; // 충분히 비행 (박자감)
      this.chunks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3.0, // 위쪽으로 강하게 튐
        life, maxLife: life,
        trail: [],
        size: 3.0 + Math.random() * 1.2,
        exploded: false,
      });
    }
  }

  // ── 잔해 미니 폭발 (chunk가 떨어진 자리) ──
  private spawnMiniExplosion(x: number, y: number) {
    const N = 12;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 2.5 + Math.random() * 4;
      const life = 14 + Math.random() * 12;
      const r = Math.random();
      let type: number;
      let size: number;
      let tStart: number;
      let tEnd: number;
      if (r < 0.30) {
        type = 1;
        size = 1.4 + Math.random() * 1.4;
        tStart = 0.10;
        tEnd = 0.55;
      } else {
        type = 2;
        size = 1.2 + Math.random() * 1.2;
        tStart = 0.45;
        tEnd = 0.92;
      }
      this.cells.push({
        x, y,
        prevX: x, prevY: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size,
        type,
        tStart,
        tEnd,
      });
    }
    // 작은 코어 플래시
    this.flashes.push({ x, y, life: 5, maxLife: 5 });
  }

  // ── 태양 표면 코로나 셀 ──
  private spawnCoronaCell() {
    const angle = Math.random() * Math.PI * 2;
    const dist = SUN_RADIUS * (0.3 + Math.random() * 0.5);
    const life = 8 + Math.random() * 8;
    this.corona.push({
      angle,
      dist,
      life, maxLife: life,
      size: 0.8 + Math.random() * 1.4,
      driftSpeed: 0.2 + Math.random() * 0.3,
    });
  }

  // ── 올챙이 폴리곤 (방향 회전, 진행 방향 길쭉) ──
  // gfx.beginFill 호출 후 사용 (호출자가 색/알파 설정)
  private drawTadpolePoly(x: number, y: number, len: number, wid: number, angle: number) {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    // 8각형 (운석 패턴 차용, 뒤쪽이 살짝 가늘어지는 느낌은 폴리곤 점 분포로)
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      // 노이즈 (불규칙)
      const noise = Math.sin(a * 3) * 0.10;
      // 진행 방향 길쭉, 뒤쪽 살짝 가늘게 (sin(a) 기반 변조)
      const tailFactor = 1 - Math.max(0, -Math.cos(a)) * 0.25;
      const rx = Math.cos(a) * len * (1 + noise);
      const ry = Math.sin(a) * wid * (1 + noise * 0.5) * tailFactor;
      // angle 회전
      const wx = rx * cosA - ry * sinA;
      const wy = rx * sinA + ry * cosA;
      if (i === 0) this.gfx.moveTo(x + wx, y + wy);
      else this.gfx.lineTo(x + wx, y + wy);
    }
    this.gfx.closePath();
  }

  // ── 색 보간 (FireEffect 패턴 그대로) ──
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

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // 발사체 → chunks → 폭발 셀 → 플래시 → 태양 (위쪽)
    this.drawBursters();
    this.drawChunks();
    this.drawExplosionCells();
    this.drawFlashes();
    this.drawSun();
  }

  private drawBursters() {
    this.gfx.lineStyle(0);
    for (const b of this.bursters) {
      // 트레일: 6 segment, 시작 흐림 → 현재 진함, 마그마 색 보간
      const trail = b.trail;
      for (let i = trail.length - 1; i > 0; i--) {
        const t1 = trail[i];
        const t2 = trail[i - 1];
        const segT = (trail.length - i) / trail.length; // 0=오래된 → 1=최근
        const alpha = segT * 0.85;
        // 트레일 끝(오래된)이 더 어두움
        const colorT = 0.55 + (1 - segT) * 0.30; // 0.55(진한 적) → 0.85(검적)
        const color = this.lerpFlameColor(colorT);
        const w = b.size * (0.4 + segT * 0.6);
        this.gfx.lineStyle(w, color, alpha);
        this.gfx.moveTo(t1.x, t1.y);
        this.gfx.lineTo(t2.x, t2.y);
      }
      this.gfx.lineStyle(0);

      // 현재 위치 — 올챙이 폴리곤 (진행 방향 길쭉, 마그마 톤)
      const lifeFrac = b.life / b.maxLife;
      const innerSz = b.size * (0.7 + lifeFrac * 0.3);
      const outerSz = innerSz * 1.7;
      // 진행 방향 (현재 속도 기준)
      const dirAngle = Math.atan2(b.vy, b.vx);

      // ADD 글로우 (원형, 진한 적색)
      this.glowGfx.beginFill(this.COL_MAGMA_RED, 0.32);
      this.glowGfx.drawCircle(b.x, b.y, outerSz);
      this.glowGfx.endFill();

      // NORMAL 본체 — 올챙이 (length × 1.5, width × 0.85)
      this.gfx.beginFill(this.COL_MAGMA_DEEP, 0.92);
      this.drawTadpolePoly(b.x, b.y, outerSz * 1.5, outerSz * 0.85, dirAngle);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_ORANGE, 0.95);
      this.drawTadpolePoly(b.x, b.y, outerSz * 1.05, outerSz * 0.55, dirAngle);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_HOT, 0.95);
      this.drawTadpolePoly(b.x, b.y, innerSz * 0.7, innerSz * 0.35, dirAngle);
      this.gfx.endFill();
    }
  }

  private drawChunks() {
    this.gfx.lineStyle(0);
    for (const c of this.chunks) {
      // 트레일 (5 segment, 짧음)
      const trail = c.trail;
      for (let i = trail.length - 1; i > 0; i--) {
        const t1 = trail[i];
        const t2 = trail[i - 1];
        const segT = (trail.length - i) / trail.length;
        const alpha = segT * 0.75;
        const colorT = 0.65 + (1 - segT) * 0.25; // 진한 적 → 검적
        const color = this.lerpFlameColor(colorT);
        const w = c.size * (0.4 + segT * 0.5);
        this.gfx.lineStyle(w, color, alpha);
        this.gfx.moveTo(t1.x, t1.y);
        this.gfx.lineTo(t2.x, t2.y);
      }
      this.gfx.lineStyle(0);

      // 잔해 본체 (올챙이, 진한 마그마 톤)
      const lifeFrac = c.life / c.maxLife;
      const sz = c.size * (0.7 + lifeFrac * 0.3);
      const dirAngle = Math.atan2(c.vy, c.vx);

      this.glowGfx.beginFill(this.COL_MAGMA_RED, 0.28);
      this.glowGfx.drawCircle(c.x, c.y, sz * 1.3);
      this.glowGfx.endFill();

      this.gfx.beginFill(this.COL_MAGMA_DARK, 0.92);
      this.drawTadpolePoly(c.x, c.y, sz * 1.5, sz * 0.85, dirAngle);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_DEEP, 0.92);
      this.drawTadpolePoly(c.x, c.y, sz * 1.0, sz * 0.55, dirAngle);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_ORANGE, 0.92);
      this.drawTadpolePoly(c.x, c.y, sz * 0.6, sz * 0.32, dirAngle);
      this.gfx.endFill();
    }
  }

  private drawExplosionCells() {
    this.gfx.lineStyle(0);
    for (const c of this.cells) {
      const lifeFrac = c.life / c.maxLife; // 1→0
      const t = c.tStart + (1 - lifeFrac) * (c.tEnd - c.tStart);
      const color = this.lerpFlameColor(t);
      const alpha = lifeFrac * 0.92;
      const sz = c.size * (0.6 + lifeFrac * 0.4);

      // 백열 셀만 작은 ADD 글로우
      if (c.type === 0) {
        this.glowGfx.beginFill(color, alpha * 0.35);
        this.glowGfx.drawCircle(c.x, c.y, sz * 1.6);
        this.glowGfx.endFill();
      }

      // 트레일 (작게)
      this.gfx.lineStyle(sz * 0.6, color, alpha * 0.50);
      this.gfx.moveTo(c.prevX, c.prevY);
      this.gfx.lineTo(c.x, c.y);
      this.gfx.lineStyle(0);

      // 코어 점
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(c.x, c.y, sz);
      this.gfx.endFill();
    }
  }

  private drawFlashes() {
    for (const f of this.flashes) {
      const t = f.life / f.maxLife; // 1→0
      const r = 12 + (1 - t) * 8;

      // 작은 ADD 글로우 (마그마 적색)
      this.glowGfx.beginFill(this.COL_MAGMA_RED, 0.32 * t);
      this.glowGfx.drawCircle(f.x, f.y, r);
      this.glowGfx.endFill();

      // NORMAL 코어 3겹 (진한 오렌지 → 마그마 코어)
      this.gfx.beginFill(this.COL_MAGMA_HOT, 0.92 * t);
      this.gfx.drawCircle(f.x, f.y, r * 0.32);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_BRIGHT, 0.78 * t);
      this.gfx.drawCircle(f.x, f.y, r * 0.55);
      this.gfx.endFill();
      this.gfx.beginFill(this.COL_MAGMA_DEEP, 0.55 * t);
      this.gfx.drawCircle(f.x, f.y, r * 0.85);
      this.gfx.endFill();
    }
  }

  private drawSun() {
    const sunX = this.posX;
    const sunY = this.posY + SUN_OFFSET_Y;
    const breath = 1 + Math.sin(this.time * 0.06) * 0.06; // 부드러운 호흡
    const R = SUN_RADIUS * breath;

    // 코로나 셀 (태양 표면 끓는 마그마 셀, 아래 레이어)
    this.gfx.lineStyle(0);
    for (const c of this.corona) {
      const cx = sunX + Math.cos(c.angle) * c.dist;
      const cy = sunY + Math.sin(c.angle) * c.dist;
      const lifeFrac = c.life / c.maxLife;
      const alpha = lifeFrac * 0.85;
      const sz = c.size * (0.5 + lifeFrac * 0.5);
      const colorT = 0.10 + (1 - lifeFrac) * 0.35; // 진한 오렌지 → 적색
      const color = this.lerpFlameColor(colorT);
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(cx, cy, sz);
      this.gfx.endFill();
    }

    // ADD 글로우 (마그마 적색 아우라)
    this.glowGfx.beginFill(this.COL_MAGMA_RED, 0.32);
    this.glowGfx.drawCircle(sunX, sunY, R * 1.4);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(this.COL_MAGMA_DEEP, 0.42);
    this.glowGfx.drawCircle(sunX, sunY, R * 1.05);
    this.glowGfx.endFill();

    // 태양 본체 NORMAL 4겹 — 외곽 어두운 적 → 코어 마그마 (백열 X)
    this.gfx.beginFill(this.COL_MAGMA_DARK, 0.92);
    this.gfx.drawCircle(sunX, sunY, R);
    this.gfx.endFill();
    this.gfx.beginFill(this.COL_MAGMA_DEEP, 0.92);
    this.gfx.drawCircle(sunX, sunY, R * 0.80);
    this.gfx.endFill();
    this.gfx.beginFill(this.COL_MAGMA_ORANGE, 0.95);
    this.gfx.drawCircle(sunX, sunY, R * 0.55);
    this.gfx.endFill();
    this.gfx.beginFill(this.COL_MAGMA_HOT, 0.95);
    this.gfx.drawCircle(sunX, sunY, R * 0.30);
    this.gfx.endFill();
  }

  stop() {
    this.active = false;
    this.bursters = [];
    this.cells = [];
    this.flashes = [];
    this.chunks = [];
    this.corona = [];
    this.pendingImpacts = [];
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
