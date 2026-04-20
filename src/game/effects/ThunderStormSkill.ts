import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles } from '../particles';

/**
 * 전기 액티브 스킬 — 뇌전폭풍 (Tesla Grid Field)
 *
 * 컨셉:
 *   - 화면 전체에 일정 간격 8×5 격자로 "전기 장치"(다이아몬드 모듈) 배치
 *   - 4-connected 로 이웃 장치끼리 진한 파란 번개로 연결 → 전기장 격자
 *   - 5초 유지, 번개 선에 닿는 적에게 지속 tick 데미지
 *   - 감전된 적들끼리 시안 연쇄 번개 전이 (hop delay 순차 점프)
 *   - 체인 타격점에서 방사 스파이크 폭발
 *
 * 디자인 규칙:
 *   - 장치는 원 없음 — 다이아몬드(회전 사각형) + 내부 크로스 + 코너 핀
 *   - 번개는 1/2/3단계 무기 볼트 패턴 (5-pass stroke + 분기)
 *   - GLSL 미사용 — 순수 Graphics NORMAL 블렌드 (흰 배경 대응)
 *
 * 팔레트:
 *   - 장치 : 슬레이트 네이비 (다크 금속 바디) + 블루-500 코어 + 흰 중심
 *   - 격자 번개 : 진한 블루 (blue-900 → blue-400 + 흰 심선)
 *   - 체인 번개 : 시안 (cyan-700 → cyan-300 + 흰 심선) — 격자와 차별화
 *
 * 좌표계 (개발서 규칙 4/7):
 *   - 월드좌표 기준. worldWrap 을 overlayLayer 에 추가, 매 프레임 -camera 시프트.
 */

// ── 팔레트 ──
// 격자 번개 : 진한 블루
const BOLT_DEEP   = 0x1e3a8a; // blue-900 외곽 halo
const BOLT_WIDE   = 0x1d4ed8; // blue-700
const BOLT_MID    = 0x2563eb; // blue-600
const BOLT_INNER  = 0x60a5fa; // blue-400
const BOLT_CORE   = 0xffffff;

// 적-적 체인 : 시안
const CHAIN_DEEP  = 0x0e7490; // cyan-700
const CHAIN_WIDE  = 0x0891b2; // cyan-600
const CHAIN_MID   = 0x06b6d4; // cyan-500
const CHAIN_INNER = 0x67e8f9; // cyan-300
const CHAIN_CORE  = 0xffffff;

// 장치 : 다크 슬레이트 바디 + 블루 에너지
const DEV_SHADOW  = 0x020617; // slate-950 외곽 그림자
const DEV_BODY    = 0x1e293b; // slate-800 바디
const DEV_BODY_HI = 0x334155; // slate-700 하이라이트 페이스
const DEV_EDGE    = 0x60a5fa; // blue-400 에지 라인
const DEV_SLOT    = 0x3b82f6; // blue-500 에너지 슬롯
const DEV_BRIGHT  = 0x93c5fd; // blue-300 에너지 bright
const DEV_CENTER  = 0xffffff;

// 파티클 액센트
const ACC_CYAN    = 0x22d3ee; // cyan-400
const ACC_BLUE    = 0x3b82f6; // blue-500

// ── 페이즈 ──
const PHASE_SEED   = 22;
const PHASE_CHARGE = 30;
const PHASE_ACTIVE = 300;
const PHASE_FADE   = 28;
const PHASE_TOTAL  = PHASE_SEED + PHASE_CHARGE + PHASE_ACTIVE + PHASE_FADE;

const T_CHARGE_START = PHASE_SEED;
const T_ACTIVE_START = T_CHARGE_START + PHASE_CHARGE;
const T_FADE_START   = T_ACTIVE_START + PHASE_ACTIVE;

// ── 격자 ──
const GRID_COLS = 8;
const GRID_ROWS = 5;
const GRID_MARGIN = 40;               // canvas 가장자리 여백

// ── 장치 치수 ──
const DEV_R_OUTER    = 15;            // 외곽 다이아몬드 반경
const DEV_R_INNER    = 11;            // 내부 플레이트 반경
const DEV_SLOT_LEN   = 18;            // 크로스 슬롯 길이
const DEV_SLOT_WIDTH = 3.2;
const DEV_CENTER_SZ  = 2.6;
const DEV_CORNER_SZ  = 2.2;

// ── 데미지 ──
const TICK_INTERVAL  = 10;
const TICK_DMG_REG   = 40;
const TICK_DMG_BOSS  = 26;
const TICK_STUN_REG  = 8;
const TICK_STUN_BOSS = 4;
const LINE_HIT_DIST  = 24;

// ── 경로 지터 ──
const PATH_REPATH_INTERVAL = 4;
const PATH_JITTER_FRAC = 0.16;
const PATH_SEG_SPACING = 18;

// ── 체인 ──
const CHAIN_LIFE = 22;
const CHAIN_MAX_DIST = 190;
const CHAIN_HOP_DELAY = 3;
const CHAIN_SPOKE_YOUNG_FRAMES = 8;

// ── 엣지 전류 pulse (작은 사각 dot 왕복) ──
const EDGE_PULSE_SPEED = 0.022;       // frame 당 frac 진행

interface Device {
  wx: number; wy: number;
  spawnDelay: number;
  spawned: boolean;
  spawnAgeFrames: number;
  seed: number;                       // pulse 위상
}

interface GridEdge {
  a: number;
  b: number;
  path: Array<{ x: number; y: number }>;
  repathTimer: number;
  bornDelay: number;
  activated: boolean;
  activatedAge: number;
  pulseFrac: number;
  pulseDir: 1 | -1;
}

interface ChainBolt {
  fromX: number; fromY: number;
  toX: number; toY: number;
  path: Array<{ x: number; y: number }>;
  repathTimer: number;
  life: number;
  maxLife: number;
  delay: number;
  spawnedParticles: boolean;
  spokes: number[];
}

interface ThunderRuntime {
  frame: number;
  devices: Device[];
  edges: GridEdge[];
  chains: ChainBolt[];
  active: boolean;
  tickTimer: number;
  tickIdx: number;
}

function makeArcPath(
  x0: number, y0: number, x1: number, y1: number,
  segSpacing = PATH_SEG_SPACING,
): Array<{ x: number; y: number }> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];

  const segs = Math.max(4, Math.floor(dist / segSpacing));
  const jitter = dist * PATH_JITTER_FRAC;
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

function distPointToSegmentSq(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  const t = lenSq ? dot / lenSq : -1;
  let xx: number, yy: number;
  if (t < 0) { xx = x1; yy = y1; }
  else if (t > 1) { xx = x2; yy = y2; }
  else { xx = x1 + t * C; yy = y1 + t * D; }
  const dx = px - xx;
  const dy = py - yy;
  return dx * dx + dy * dy;
}

function pointOnPath(path: Array<{ x: number; y: number }>, frac: number): { x: number; y: number } {
  if (path.length < 2) return { x: path[0]?.x ?? 0, y: path[0]?.y ?? 0 };
  const f = Math.max(0, Math.min(1, frac));
  const scaled = f * (path.length - 1);
  const i = Math.floor(scaled);
  const localT = scaled - i;
  const p0 = path[i];
  const p1 = path[Math.min(path.length - 1, i + 1)];
  return { x: p0.x + (p1.x - p0.x) * localT, y: p0.y + (p1.y - p0.y) * localT };
}

export class ThunderStormSkill {
  private overlayLayer: PIXI.Container;

  private worldWrap: PIXI.Container;
  private boltGfx: PIXI.Graphics;
  private pulseGfx: PIXI.Graphics;
  private chainGfx: PIXI.Graphics;
  private deviceGfx: PIXI.Graphics;

  private runtime: ThunderRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, _groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    void _groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    // Z-order: bolt → pulse dot → chain → device (최상위, 장치가 가장 위)
    this.boltGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.boltGfx);

    this.pulseGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.pulseGfx);

    this.chainGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.chainGfx);

    this.deviceGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.deviceGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  start(cameraX: number, cameraY: number, canvasW: number, canvasH: number) {
    if (this.runtime && this.runtime.active) return;

    // 일정한 간격 — canvas 내부를 margin 만큼 줄인 뒤 균등 분할
    const innerW = canvasW - GRID_MARGIN * 2;
    const innerH = canvasH - GRID_MARGIN * 2;
    const stepX = innerW / (GRID_COLS - 1);
    const stepY = innerH / (GRID_ROWS - 1);

    const devices: Device[] = [];
    for (let cy = 0; cy < GRID_ROWS; cy++) {
      for (let cx = 0; cx < GRID_COLS; cx++) {
        const sx = GRID_MARGIN + stepX * cx;
        const sy = GRID_MARGIN + stepY * cy;
        const wx = cameraX + sx;
        const wy = cameraY + sy;

        const sweepT = cy / GRID_ROWS + (cx / GRID_COLS) * 0.15;
        const spawnDelay = Math.floor(sweepT * (PHASE_SEED - 2));

        devices.push({
          wx, wy,
          spawnDelay,
          spawned: false,
          spawnAgeFrames: 0,
          seed: Math.random() * Math.PI * 2,
        });
      }
    }

    // 4-connected 엣지 (가로 + 세로만)
    const edges: GridEdge[] = [];
    const idx = (cx: number, cy: number) => cy * GRID_COLS + cx;
    // 가로
    for (let cy = 0; cy < GRID_ROWS; cy++) {
      for (let cx = 0; cx < GRID_COLS - 1; cx++) {
        const a = idx(cx, cy);
        const b = idx(cx + 1, cy);
        const na = devices[a];
        const nb = devices[b];
        edges.push({
          a, b,
          path: makeArcPath(na.wx, na.wy, nb.wx, nb.wy),
          repathTimer: Math.floor(Math.random() * PATH_REPATH_INTERVAL),
          bornDelay: Math.floor((cy / GRID_ROWS) * PHASE_CHARGE * 0.6 + Math.random() * 4),
          activated: false,
          activatedAge: 0,
          pulseFrac: Math.random(),
          pulseDir: Math.random() < 0.5 ? 1 : -1,
        });
      }
    }
    // 세로
    for (let cx = 0; cx < GRID_COLS; cx++) {
      for (let cy = 0; cy < GRID_ROWS - 1; cy++) {
        const a = idx(cx, cy);
        const b = idx(cx, cy + 1);
        const na = devices[a];
        const nb = devices[b];
        edges.push({
          a, b,
          path: makeArcPath(na.wx, na.wy, nb.wx, nb.wy),
          repathTimer: Math.floor(Math.random() * PATH_REPATH_INTERVAL),
          bornDelay: Math.floor((cx / GRID_COLS) * PHASE_CHARGE * 0.6 + Math.random() * 4),
          activated: false,
          activatedAge: 0,
          pulseFrac: Math.random(),
          pulseDir: Math.random() < 0.5 ? 1 : -1,
        });
      }
    }

    this.runtime = {
      frame: 0,
      devices,
      edges,
      chains: [],
      active: true,
      tickTimer: 0,
      tickIdx: 0,
    };
    this.time = 0;
  }

  update(
    dt: number,
    enemies: EnemyState[],
    particles: ParticleState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
    onKill: (idx: number) => void,
  ) {
    const rt = this.runtime;
    if (!rt || !rt.active) return;
    void canvasW; void canvasH;

    this.time += dt;
    rt.frame += dt;

    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    const f = rt.frame;
    const inCharge  = f >= T_CHARGE_START && f < T_ACTIVE_START;
    const inActive  = f >= T_ACTIVE_START && f < T_FADE_START;
    const inFade    = f >= T_FADE_START;
    const fCharge   = Math.max(0, f - T_CHARGE_START);

    // 1) 장치 스폰
    for (const d of rt.devices) {
      if (!d.spawned) {
        if (f >= d.spawnDelay) {
          d.spawned = true;
          d.spawnAgeFrames = 0;
          spawnHitParticles(particles, d.wx, d.wy, DEV_BRIGHT);
          spawnHitParticles(particles, d.wx, d.wy, DEV_SLOT);
          spawnHitParticles(particles, d.wx, d.wy, ACC_CYAN);
        }
      } else {
        d.spawnAgeFrames += dt;
      }
    }

    // 2) 엣지 활성화
    if (inCharge || inActive || inFade) {
      for (const e of rt.edges) {
        if (!e.activated && fCharge >= e.bornDelay) {
          e.activated = true;
          e.activatedAge = 0;
          const na = rt.devices[e.a];
          const nb = rt.devices[e.b];
          const mx = (na.wx + nb.wx) * 0.5;
          const my = (na.wy + nb.wy) * 0.5;
          spawnHitParticles(particles, mx, my, BOLT_MID);
          spawnHitParticles(particles, mx, my, BOLT_INNER);
          spawnHitParticles(particles, mx, my, BOLT_CORE);
        }
        if (e.activated) e.activatedAge += dt;
      }
    }

    // 3) 엣지 경로 지터 + 전류 pulse 진행
    for (const e of rt.edges) {
      if (!e.activated) continue;
      e.repathTimer -= dt;
      if (e.repathTimer <= 0) {
        e.repathTimer = PATH_REPATH_INTERVAL;
        const na = rt.devices[e.a];
        const nb = rt.devices[e.b];
        e.path = makeArcPath(na.wx, na.wy, nb.wx, nb.wy);
      }
      e.pulseFrac += EDGE_PULSE_SPEED * e.pulseDir * dt;
      if (e.pulseFrac > 1) { e.pulseFrac = 1; e.pulseDir = -1; }
      else if (e.pulseFrac < 0) { e.pulseFrac = 0; e.pulseDir = 1; }
    }

    // 4) ACTIVE tick 데미지
    if (inActive) {
      rt.tickTimer -= dt;
      if (rt.tickTimer <= 0) {
        rt.tickTimer += TICK_INTERVAL;
        rt.tickIdx++;
        this.dealTick(rt, enemies, particles, onKill);
      }
    }

    // 5) chain bolt 관리
    if (rt.chains.length > 0) {
      for (const c of rt.chains) {
        if (c.delay > 0) { c.delay -= dt; continue; }
        c.life -= dt;
        c.repathTimer -= dt;
        if (c.repathTimer <= 0) {
          c.repathTimer = PATH_REPATH_INTERVAL;
          c.path = makeArcPath(c.fromX, c.fromY, c.toX, c.toY, 14);
        }
        if (!c.spawnedParticles) {
          c.spawnedParticles = true;
          this.spawnChainHit(particles, c.toX, c.toY);
        }
      }
      rt.chains = rt.chains.filter((c) => c.delay > 0 || c.life > 0);
    }

    // 6) 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.clearGfx();
      return;
    }

    this.render(rt);
  }

  private dealTick(
    rt: ThunderRuntime,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
  ) {
    const r2 = LINE_HIT_DIST * LINE_HIT_DIST;
    const hitOrder: Array<{ idx: number; x: number; y: number }> = [];
    const hitSet = new Set<number>();

    for (const e of rt.edges) {
      if (!e.activated) continue;
      const na = rt.devices[e.a];
      const nb = rt.devices[e.b];
      for (let i = 0; i < enemies.length; i++) {
        if (hitSet.has(i)) continue;
        const en = enemies[i];
        if (!en.active) continue;
        const d2 = distPointToSegmentSq(en.x, en.y, na.wx, na.wy, nb.wx, nb.wy);
        if (d2 > r2) continue;
        hitSet.add(i);
        const isB = isBossType(en.type);
        en.hp -= isB ? TICK_DMG_BOSS : TICK_DMG_REG;
        en.stunFrames = Math.max(en.stunFrames ?? 0, isB ? TICK_STUN_BOSS : TICK_STUN_REG);
        spawnHitParticles(particles, en.x, en.y, CHAIN_CORE);
        spawnHitParticles(particles, en.x, en.y, CHAIN_INNER);
        spawnHitParticles(particles, en.x, en.y, CHAIN_MID);
        spawnHitParticles(particles, en.x, en.y, ACC_CYAN);
        spawnHitParticles(particles, en.x, en.y, ACC_BLUE);
        if (en.hp <= 0) onKill(i);
        else hitOrder.push({ idx: i, x: en.x, y: en.y });
      }
    }

    if (hitOrder.length >= 2) this.buildChainBolts(rt, hitOrder);
  }

  private buildChainBolts(
    rt: ThunderRuntime,
    hits: Array<{ idx: number; x: number; y: number }>,
  ) {
    const remaining = hits.slice();
    remaining.sort((a, b) => a.x - b.x);
    let cur = remaining.shift()!;
    let hopIdx = 0;
    const maxD2 = CHAIN_MAX_DIST * CHAIN_MAX_DIST;

    while (remaining.length > 0) {
      let bestI = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const dx = remaining[i].x - cur.x;
        const dy = remaining[i].y - cur.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestI = i; }
      }
      if (bestI < 0 || bestD2 > maxD2) break;
      const nxt = remaining.splice(bestI, 1)[0];
      const spokes: number[] = [];
      for (let s = 0; s < 5; s++) {
        spokes.push(s * Math.PI * 2 / 5 + Math.random() * 0.4);
      }
      rt.chains.push({
        fromX: cur.x, fromY: cur.y,
        toX: nxt.x, toY: nxt.y,
        path: makeArcPath(cur.x, cur.y, nxt.x, nxt.y, 14),
        repathTimer: PATH_REPATH_INTERVAL,
        life: CHAIN_LIFE,
        maxLife: CHAIN_LIFE,
        delay: hopIdx * CHAIN_HOP_DELAY,
        spawnedParticles: false,
        spokes,
      });
      cur = nxt;
      hopIdx++;
    }
  }

  private spawnChainHit(particles: ParticleState[], x: number, y: number) {
    spawnHitParticles(particles, x, y, CHAIN_CORE);
    spawnHitParticles(particles, x, y, CHAIN_INNER);
    spawnHitParticles(particles, x, y, CHAIN_MID);
    spawnHitParticles(particles, x, y, CHAIN_WIDE);
    spawnHitParticles(particles, x, y, ACC_CYAN);
    spawnHitParticles(particles, x, y, ACC_BLUE);
    spawnHitParticles(particles, x, y, BOLT_INNER);
  }

  private clearGfx() {
    this.boltGfx.clear();
    this.pulseGfx.clear();
    this.chainGfx.clear();
    this.deviceGfx.clear();
  }

  private render(rt: ThunderRuntime) {
    this.clearGfx();

    const t = this.time;
    const f = rt.frame;
    const inFade = f >= T_FADE_START;
    const fadeK = inFade ? 1 - (f - T_FADE_START) / PHASE_FADE : 1;
    const globalAlpha = Math.max(0, fadeK);

    // ── 격자 번개 ──
    for (const e of rt.edges) {
      if (!e.activated) continue;
      const pts = e.path;
      if (pts.length < 2) continue;

      const age = e.activatedAge;
      const flash = age < 4 ? 1.4 - (age / 4) * 0.4 : 1;
      const flick = 0.72 + Math.random() * 0.28;
      const a = globalAlpha * flick;

      this.drawBoltPath(this.boltGfx, pts, flash, a, 1,
        BOLT_DEEP, BOLT_WIDE, BOLT_MID, BOLT_INNER, BOLT_CORE);

      // 분기 25%
      const dx = pts[pts.length - 1].x - pts[0].x;
      const dy = pts[pts.length - 1].y - pts[0].y;
      for (let i = 1; i < pts.length - 1; i++) {
        if (Math.random() < 0.25) {
          const brLen = 8 + Math.random() * 18;
          const brAng = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2.2;
          const bx = pts[i].x + Math.cos(brAng) * brLen;
          const by = pts[i].y + Math.sin(brAng) * brLen;
          const mx = (pts[i].x + bx) / 2 + (Math.random() - 0.5) * 6;
          const my = (pts[i].y + by) / 2 + (Math.random() - 0.5) * 6;

          this.boltGfx.lineStyle(4 * flash, BOLT_WIDE, a * 0.55);
          this.boltGfx.moveTo(pts[i].x, pts[i].y);
          this.boltGfx.lineTo(mx, my);
          this.boltGfx.lineTo(bx, by);

          this.boltGfx.lineStyle(1.4, BOLT_INNER, a * 0.75);
          this.boltGfx.moveTo(pts[i].x, pts[i].y);
          this.boltGfx.lineTo(mx, my);
          this.boltGfx.lineTo(bx, by);
        }
      }
      this.boltGfx.lineStyle(0);

      // 전류 pulse — 작은 흰 사각 dot (원 아님)
      const pp = pointOnPath(pts, e.pulseFrac);
      // outer glow rect
      this.pulseGfx.beginFill(BOLT_INNER, 0.55 * a);
      this.pulseGfx.drawRect(pp.x - 4, pp.y - 4, 8, 8);
      this.pulseGfx.endFill();
      // mid
      this.pulseGfx.beginFill(BOLT_MID, 0.70 * a);
      this.pulseGfx.drawRect(pp.x - 2.5, pp.y - 2.5, 5, 5);
      this.pulseGfx.endFill();
      // 흰 코어
      this.pulseGfx.beginFill(BOLT_CORE, 0.95 * a);
      this.pulseGfx.drawRect(pp.x - 1, pp.y - 1, 2, 2);
      this.pulseGfx.endFill();
    }

    // ── 체인 번개 (시안, 방사 스파이크 포함) ──
    for (const c of rt.chains) {
      if (c.delay > 0) continue;
      const lifeK = c.life / c.maxLife;
      if (lifeK <= 0) continue;
      const age = c.maxLife - c.life;
      const flash = age < 4 ? 1.6 - (age / 4) * 0.5 : 1;
      const flick = 0.68 + Math.random() * 0.32;
      const a = globalAlpha * flick * lifeK;

      this.drawBoltPath(this.chainGfx, c.path, flash, a, 1.15,
        CHAIN_DEEP, CHAIN_WIDE, CHAIN_MID, CHAIN_INNER, CHAIN_CORE);

      // 본체 분기 35%
      const pts = c.path;
      const dx = c.toX - c.fromX;
      const dy = c.toY - c.fromY;
      for (let i = 1; i < pts.length - 1; i++) {
        if (Math.random() < 0.35) {
          const brLen = 10 + Math.random() * 20;
          const brAng = Math.atan2(dy, dx) + (Math.random() - 0.5) * 2.4;
          const bx = pts[i].x + Math.cos(brAng) * brLen;
          const by = pts[i].y + Math.sin(brAng) * brLen;
          const mx = (pts[i].x + bx) / 2 + (Math.random() - 0.5) * 6;
          const my = (pts[i].y + by) / 2 + (Math.random() - 0.5) * 6;

          this.chainGfx.lineStyle(4.5 * flash, CHAIN_MID, a * 0.65);
          this.chainGfx.moveTo(pts[i].x, pts[i].y);
          this.chainGfx.lineTo(mx, my);
          this.chainGfx.lineTo(bx, by);

          this.chainGfx.lineStyle(1.6, CHAIN_CORE, a * 0.9);
          this.chainGfx.moveTo(pts[i].x, pts[i].y);
          this.chainGfx.lineTo(mx, my);
          this.chainGfx.lineTo(bx, by);
        }
      }

      // 방사 스파이크 (5방향, young 동안만)
      if (age < CHAIN_SPOKE_YOUNG_FRAMES) {
        const youngK = 1 - age / CHAIN_SPOKE_YOUNG_FRAMES;
        const spokeLen = 16 + youngK * 14;
        for (const sAng of c.spokes) {
          const ex = c.toX + Math.cos(sAng) * spokeLen;
          const ey = c.toY + Math.sin(sAng) * spokeLen;
          const mx = (c.toX + ex) * 0.5 + (Math.random() - 0.5) * 5;
          const my = (c.toY + ey) * 0.5 + (Math.random() - 0.5) * 5;

          this.chainGfx.lineStyle(3.2 * youngK, CHAIN_WIDE, a * 0.75);
          this.chainGfx.moveTo(c.toX, c.toY);
          this.chainGfx.lineTo(mx, my);
          this.chainGfx.lineTo(ex, ey);
          this.chainGfx.lineStyle(1.6 * youngK, CHAIN_INNER, a * 0.9);
          this.chainGfx.moveTo(c.toX, c.toY);
          this.chainGfx.lineTo(mx, my);
          this.chainGfx.lineTo(ex, ey);
          this.chainGfx.lineStyle(0.7 * youngK, CHAIN_CORE, a * 0.95);
          this.chainGfx.moveTo(c.toX, c.toY);
          this.chainGfx.lineTo(mx, my);
          this.chainGfx.lineTo(ex, ey);
        }
      }
      this.chainGfx.lineStyle(0);
    }

    // ── 장치 (다이아몬드 + 크로스 + 코너 핀 · 원 없음) ──
    for (const d of rt.devices) {
      if (!d.spawned) continue;
      const popK = Math.min(1, d.spawnAgeFrames / 6);
      const pulse = 0.90 + 0.10 * Math.sin(t * 0.22 + d.seed);  // 미세 박동
      const scale = popK;
      const a = globalAlpha;

      const rOuter = DEV_R_OUTER * scale;
      const rInner = DEV_R_INNER * scale;
      const slotL  = DEV_SLOT_LEN * scale * pulse;
      const slotW  = DEV_SLOT_WIDTH * scale;
      const centerSz = DEV_CENTER_SZ * scale * (0.9 + 0.1 * Math.sin(t * 0.35 + d.seed));
      const cornerSz = DEV_CORNER_SZ * scale;

      // (1) 외곽 다이아몬드 — slate-950 shadow (1px 바깥)
      this.deviceGfx.beginFill(DEV_SHADOW, 0.70 * a);
      this.deviceGfx.drawPolygon([
        d.wx, d.wy - rOuter - 1.5,
        d.wx + rOuter + 1.5, d.wy,
        d.wx, d.wy + rOuter + 1.5,
        d.wx - rOuter - 1.5, d.wy,
      ]);
      this.deviceGfx.endFill();

      // (2) 바디 다이아몬드 — slate-800 fill + slate-700 하이라이트 3각면
      this.deviceGfx.lineStyle(1.4, DEV_EDGE, 0.95 * a);
      this.deviceGfx.beginFill(DEV_BODY, 0.98 * a);
      this.deviceGfx.drawPolygon([
        d.wx, d.wy - rOuter,
        d.wx + rOuter, d.wy,
        d.wx, d.wy + rOuter,
        d.wx - rOuter, d.wy,
      ]);
      this.deviceGfx.endFill();
      this.deviceGfx.lineStyle(0);

      // (2b) 상단/좌측 하이라이트 삼각 (slate-700 으로 음영 표현)
      this.deviceGfx.beginFill(DEV_BODY_HI, 0.95 * a);
      this.deviceGfx.drawPolygon([
        d.wx, d.wy - rOuter + 1,
        d.wx + rOuter - 1, d.wy,
        d.wx, d.wy,
      ]);
      this.deviceGfx.endFill();

      // (3) 내부 다이아몬드 플레이트 (어두운 컷아웃 느낌)
      this.deviceGfx.beginFill(DEV_SHADOW, 0.85 * a);
      this.deviceGfx.drawPolygon([
        d.wx, d.wy - rInner,
        d.wx + rInner, d.wy,
        d.wx, d.wy + rInner,
        d.wx - rInner, d.wy,
      ]);
      this.deviceGfx.endFill();

      // (4) 크로스 에너지 슬롯 — 블루 2겹 (mid + bright)
      // 수직
      this.deviceGfx.beginFill(DEV_SLOT, 0.95 * a);
      this.deviceGfx.drawRect(d.wx - slotW / 2, d.wy - slotL / 2, slotW, slotL);
      this.deviceGfx.endFill();
      // 수평
      this.deviceGfx.beginFill(DEV_SLOT, 0.95 * a);
      this.deviceGfx.drawRect(d.wx - slotL / 2, d.wy - slotW / 2, slotL, slotW);
      this.deviceGfx.endFill();
      // 밝은 inner (더 얇게)
      const slotWi = slotW * 0.45;
      this.deviceGfx.beginFill(DEV_BRIGHT, 0.95 * a);
      this.deviceGfx.drawRect(d.wx - slotWi / 2, d.wy - slotL / 2 + 1, slotWi, slotL - 2);
      this.deviceGfx.endFill();
      this.deviceGfx.beginFill(DEV_BRIGHT, 0.95 * a);
      this.deviceGfx.drawRect(d.wx - slotL / 2 + 1, d.wy - slotWi / 2, slotL - 2, slotWi);
      this.deviceGfx.endFill();

      // (5) 중심 사각 — 흰색 코어
      this.deviceGfx.beginFill(DEV_CENTER, 0.98 * a);
      this.deviceGfx.drawRect(d.wx - centerSz, d.wy - centerSz, centerSz * 2, centerSz * 2);
      this.deviceGfx.endFill();

      // (6) 코너 핀 — 4개 다이아몬드 꼭짓점 근처에 작은 사각
      const cornerOffset = rOuter * 0.75;
      const pinPositions = [
        [d.wx,                d.wy - cornerOffset],   // top
        [d.wx + cornerOffset, d.wy],                  // right
        [d.wx,                d.wy + cornerOffset],   // bottom
        [d.wx - cornerOffset, d.wy],                  // left
      ];
      for (const [px, py] of pinPositions) {
        this.deviceGfx.beginFill(DEV_BRIGHT, 0.95 * a);
        this.deviceGfx.drawRect(px - cornerSz, py - cornerSz, cornerSz * 2, cornerSz * 2);
        this.deviceGfx.endFill();
      }
    }
  }

  private drawBoltPath(
    g: PIXI.Graphics,
    pts: Array<{ x: number; y: number }>,
    flash: number,
    alpha: number,
    widthMul: number,
    colDeep: number,
    colWide: number,
    colMid: number,
    colInner: number,
    colCore: number,
  ) {
    if (pts.length < 2) return;
    const wMul = widthMul;

    g.lineStyle(18 * flash * wMul, colDeep, alpha * 0.22);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);

    g.lineStyle(11 * flash * wMul, colWide, alpha * 0.42);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);

    g.lineStyle(6 * flash * wMul, colMid, alpha * 0.65);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);

    g.lineStyle(3 * flash * wMul, colInner, alpha * 0.85);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);

    g.lineStyle(1.3 * flash * wMul, colCore, alpha * 0.95);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);

    g.lineStyle(0);
  }

  destroy() {
    this.worldWrap.destroy({ children: true });
    this.runtime = null;
  }
}
