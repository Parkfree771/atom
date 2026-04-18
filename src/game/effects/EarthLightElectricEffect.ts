import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+빛+전기 3단계 — 크리스탈 뇌격 (Crystal Thunder)
 *
 * 크리스탈 유도 미사일 + 전기 케이지:
 *   - 플레이어 주변 8개 크리스탈이 tight follow로 팔각형 링 배치 (tangent orientation)
 *   - 각 크리스탈은 인접 크리스탈과 전기 라인으로 상시 연결 (8 벽)
 *   - 각 크리스탈은 독립 충전 → 가장 가까운 적으로 직선 유도 미사일 발사 (푱푱푱푱)
 *   - 명중 시: 피해 + 스턴 + 체인 확산
 *   - 전기 벽에 적이 닿으면: 강한 슬로우 + DoT
 *
 * 개발서 규칙 준수:
 *   - 규칙 5: 유도 미사일은 enemyIdx + lastSafeX/Y fallback
 *   - 규칙 6(1): 크리스탈 lineStyle 아웃라인 + 작은 셀
 *   - 흰색 금지: cyan-200/순백 X
 */

// ── 상수 ──
const CRYSTAL_COUNT = 8;
const CIRCLE_RADIUS = 130;

const CRYSTAL_H = 32;
const CRYSTAL_W = 20;

const CONNECTION_REFRESH_INTERVAL = 5;

// 크리스탈 충전 (푱푱푱푱 빠른 발사)
const CRYSTAL_CHARGE_DURATION = 35;
const MAX_STRIKE_TARGETS = 8; // 크리스탈 수와 동일

// 유도 미사일
const MISSILE_SPEED = 9.5;
const MISSILE_HIT_RADIUS = 28;
const MISSILE_MAX_LIFE = 100;
const HOMING_TURN_RATE = 0.20; // 빠른 유도 (직선에 가깝게)
const TRAIL_LENGTH = 7;
const NODE_MAX_TRAVEL2 = 120 * 120;

const IMPACT_SHARDS = 12;
const IMPACT_CHUNKS = 14;
const IMPACT_SPARKS = 10;
const IMPACT_RING_COUNT = 1;
const RING_SEGS = 12;

// ── 타입 ──
interface Crystal {
  worldX: number; worldY: number;
  anchorAngle: number;
  rotation: number;
  pulseOffset: number;
  chargeT: number;         // 0 → 1
  readyPending: boolean;
}

interface Connection {
  fromIdx: number;
  toIdx: number;
  path: Array<{ x: number; y: number }>;
}

interface Projectile {
  x: number; y: number;
  vx: number; vy: number;
  targetIdx: number;
  lastSafeX: number; lastSafeY: number;
  life: number;
  color: number;
  trailPts: Array<{ x: number; y: number }>;
}

interface ProjectileHit {
  targetIdx: number;
  hitX: number;
  hitY: number;
}

interface ChainLink {
  fromX: number; fromY: number;
  toX: number; toY: number;
  life: number; maxLife: number;
  path: Array<{ x: number; y: number }>;
}

interface RingPulse {
  x: number; y: number;
  life: number; maxLife: number;
  delay: number;
  colorOffset: number;
  rotOffset: number;
  maxRadius: number;
}

interface Shard {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

interface StoneChunk {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
}

interface Spark {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
}

interface EnemyRef {
  x: number; y: number;
  active: boolean;
}

export class EarthLightElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // ── 팔레트 (흰색 금지) ──
  private readonly COL_YELLOW_300 = 0xfde047;
  private readonly COL_YELLOW_400 = 0xfacc15;
  private readonly COL_YELLOW_500 = 0xeab308;
  private readonly COL_AMBER_300 = 0xfcd34d;
  private readonly COL_AMBER_400 = 0xfbbf24;
  private readonly COL_AMBER_600 = 0xd97706;
  private readonly COL_STONE_600 = 0x57534e;
  private readonly COL_STONE_700 = 0x44403c;
  private readonly COL_SKY_300 = 0x7dd3fc;
  private readonly COL_CYAN_300 = 0x67e8f9;
  private readonly COL_CYAN_400 = 0x22d3ee;

  private readonly RING_COLORS = [
    0xfde047, 0xfacc15, 0xfcd34d, 0xfbbf24,
    0xd97706, 0x7dd3fc, 0x67e8f9, 0xeab308,
  ];

  active = false;
  private time = 0;
  private posX = 0;
  private posY = 0;

  private crystals: Crystal[] = [];
  private connections: Connection[] = [];
  private connectionRefreshTimer = 0;

  private projectiles: Projectile[] = [];
  private hitsBuffer: ProjectileHit[] = [];

  private chainLinks: ChainLink[] = [];
  private ringPulses: RingPulse[] = [];
  private shards: Shard[] = [];
  private stoneChunks: StoneChunk[] = [];
  private sparks: Spark[] = [];

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
    this.time = 0;
    this.projectiles = [];
    this.hitsBuffer = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.stoneChunks = [];
    this.sparks = [];
    this.connectionRefreshTimer = 0;
    this.container.visible = true;
    this.initCrystals();
    this.initConnections();
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  // ── 크리스탈 8개 초기화 (각 tangent orientation + 시차 chargeT) ──
  private initCrystals() {
    this.crystals = [];
    for (let i = 0; i < CRYSTAL_COUNT; i++) {
      const anchorAngle = (i / CRYSTAL_COUNT) * Math.PI * 2;
      const tx = this.posX + Math.cos(anchorAngle) * CIRCLE_RADIUS;
      const ty = this.posY + Math.sin(anchorAngle) * CIRCLE_RADIUS;
      // 시차 충전: i × 0.125 × max = 0, 0.125, 0.25, ..., 0.875
      const initialCharge = (i / CRYSTAL_COUNT) * 0.95;
      this.crystals.push({
        worldX: tx,
        worldY: ty,
        anchorAngle,
        rotation: anchorAngle + Math.PI, // tangent orientation
        pulseOffset: Math.random() * Math.PI * 2,
        chargeT: initialCharge,
        readyPending: false,
      });
    }
  }

  // ── 크리스탈 간 연결 초기화 ──
  private initConnections() {
    this.connections = [];
    for (let i = 0; i < CRYSTAL_COUNT; i++) {
      const fromIdx = i;
      const toIdx = (i + 1) % CRYSTAL_COUNT;
      const from = this.crystals[fromIdx];
      const to = this.crystals[toIdx];
      this.connections.push({
        fromIdx,
        toIdx,
        path: this.makeZigzagPath(from.worldX, from.worldY, to.worldX, to.worldY),
      });
    }
  }

  // ── 외부 통신 ──

  /** 준비 완료된 크리스탈 리스트 (chargeT = 1) */
  readyCrystals(): Array<{ crystalIdx: number; worldX: number; worldY: number }> {
    const out: Array<{ crystalIdx: number; worldX: number; worldY: number }> = [];
    for (let i = 0; i < this.crystals.length; i++) {
      const c = this.crystals[i];
      if (c.readyPending) {
        out.push({ crystalIdx: i, worldX: c.worldX, worldY: c.worldY });
      }
    }
    return out;
  }

  /** engine이 타겟 수집 후 유도 미사일 spawn */
  fireMissiles(fires: Array<{
    crystalIdx: number;
    targetX: number;
    targetY: number;
    enemyIdx: number;
  }>) {
    for (const f of fires) {
      const c = this.crystals[f.crystalIdx];
      if (!c) continue;
      const sx = c.worldX;
      const sy = c.worldY;
      const dx = f.targetX - sx;
      const dy = f.targetY - sy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // 직선 방향 + 아주 살짝의 곡선 편향
      const perpX = -dy / len;
      const perpY = dx / len;
      const curveBias = (Math.random() - 0.5) * 0.3; // 약한 초기 편향
      const forwardBias = 0.85 + Math.random() * 0.15;
      const ivx = (dx / len) * forwardBias + perpX * curveBias;
      const ivy = (dy / len) * forwardBias + perpY * curveBias;
      const iMag = Math.sqrt(ivx * ivx + ivy * ivy) || 1;

      this.projectiles.push({
        x: sx,
        y: sy,
        vx: (ivx / iMag) * MISSILE_SPEED,
        vy: (ivy / iMag) * MISSILE_SPEED,
        targetIdx: f.enemyIdx,
        lastSafeX: f.targetX,
        lastSafeY: f.targetY,
        life: MISSILE_MAX_LIFE,
        color: this.COL_YELLOW_300,
        trailPts: [],
      });

      // 크리스탈 리셋
      c.chargeT = 0;
      c.readyPending = false;
    }
  }

  hitsThisFrame(): ProjectileHit[] {
    return this.hitsBuffer;
  }

  maxStrikeTargets(): number {
    return MAX_STRIKE_TARGETS;
  }

  /** 크리스탈 간 연결 세그먼트 (월드 좌표) — 엔진 콜리전 체크용 */
  getCrystalConnectionSegments(): Array<{ x0: number; y0: number; x1: number; y1: number }> {
    const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const conn of this.connections) {
      const from = this.crystals[conn.fromIdx];
      const to = this.crystals[conn.toIdx];
      out.push({
        x0: from.worldX, y0: from.worldY,
        x1: to.worldX, y1: to.worldY,
      });
    }
    return out;
  }

  /** 명중 지점 임팩트 입자 spawn */
  spawnImpactAt(x: number, y: number) {
    for (let r = 0; r < IMPACT_RING_COUNT; r++) {
      const baseLife = 22;
      this.ringPulses.push({
        x, y,
        life: baseLife,
        maxLife: baseLife,
        delay: 0,
        colorOffset: Math.floor(Math.random() * 8),
        rotOffset: Math.random() * Math.PI * 2,
        maxRadius: 40,
      });
    }
    for (let i = 0; i < IMPACT_SHARDS; i++) {
      const angle = (i / IMPACT_SHARDS) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 3.0 + Math.random() * 2.8;
      const maxLife = 22 + Math.random() * 12;
      const r = Math.random();
      const color = r < 0.4 ? this.COL_YELLOW_300 : (r < 0.7 ? this.COL_AMBER_300 : this.COL_SKY_300);
      this.shards.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 1.8 + Math.random() * 1.6,
        color,
      });
    }
    for (let i = 0; i < IMPACT_CHUNKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.8 + Math.random() * 2.4;
      const maxLife = 26 + Math.random() * 14;
      this.stoneChunks.push({
        x: x + (Math.random() - 0.5) * 5,
        y: y + (Math.random() - 0.5) * 5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.0,
        life: maxLife, maxLife,
        size: 1.5 + Math.random() * 1.4,
      });
    }
    for (let i = 0; i < IMPACT_SPARKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.6 + Math.random() * 3.2;
      const maxLife = 12 + Math.random() * 8;
      this.sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 1.3 + Math.random() * 1.2,
      });
    }
  }

  addChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    for (const l of lines) {
      const life = 18;
      this.chainLinks.push({
        fromX: l.x0, fromY: l.y0,
        toX: l.x1, toY: l.y1,
        life, maxLife: life,
        path: this.makeZigzagPath(l.x0, l.y0, l.x1, l.y1),
      });
    }
  }

  // ── 메인 업데이트 ──
  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // 크리스탈 tight follow + 충전 틱
    for (const c of this.crystals) {
      c.worldX = this.posX + Math.cos(c.anchorAngle) * CIRCLE_RADIUS;
      c.worldY = this.posY + Math.sin(c.anchorAngle) * CIRCLE_RADIUS;
      if (!c.readyPending) {
        c.chargeT += dt / CRYSTAL_CHARGE_DURATION;
        if (c.chargeT >= 1) {
          c.chargeT = 1;
          c.readyPending = true;
        }
      }
    }

    // 연결 zigzag 재생성
    this.connectionRefreshTimer += dt;
    if (this.connectionRefreshTimer >= CONNECTION_REFRESH_INTERVAL) {
      this.connectionRefreshTimer = 0;
      for (const conn of this.connections) {
        const from = this.crystals[conn.fromIdx];
        const to = this.crystals[conn.toIdx];
        conn.path = this.makeZigzagPath(from.worldX, from.worldY, to.worldX, to.worldY);
      }
    }

    // 체인 번개
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      const c = this.chainLinks[i];
      c.life -= dt;
      if (c.life <= 0) swapPop(this.chainLinks, i);
    }

    // 링 펄스
    for (let i = this.ringPulses.length - 1; i >= 0; i--) {
      const r = this.ringPulses[i];
      if (r.delay > 0) {
        r.delay -= dt;
        continue;
      }
      r.life -= dt;
      if (r.life <= 0) swapPop(this.ringPulses, i);
    }

    // 파편
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.955;
      s.vy *= 0.955;
      s.life -= dt;
      if (s.life <= 0) swapPop(this.shards, i);
    }

    // 돌 조각
    for (let i = this.stoneChunks.length - 1; i >= 0; i--) {
      const c = this.stoneChunks[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vy += 0.18 * dt;
      c.vx *= 0.97;
      c.life -= dt;
      if (c.life <= 0) swapPop(this.stoneChunks, i);
    }

    // 스파크
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.88;
      s.vy *= 0.88;
      s.life -= dt;
      if (s.life <= 0) swapPop(this.sparks, i);
    }

    this.draw();
  }

  /** 유도 미사일 호밍 업데이트 — engine이 매 프레임 enemies 넘김 (rule 5) */
  updateHoming(dt: number, enemies: EnemyRef[]) {
    if (!this.active) return;
    this.hitsBuffer = [];
    const enemyCount = enemies.length;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // Rule 5: safe 타겟 좌표
      let tx = p.lastSafeX;
      let ty = p.lastSafeY;
      let targetAlive = false;
      if (p.targetIdx < enemyCount) {
        const e = enemies[p.targetIdx];
        if (e && e.active) {
          const dxn = e.x - p.lastSafeX;
          const dyn = e.y - p.lastSafeY;
          if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL2) {
            p.lastSafeX = e.x;
            p.lastSafeY = e.y;
            tx = e.x;
            ty = e.y;
            targetAlive = true;
          }
        }
      }

      // 호밍 스티어
      const ddx = tx - p.x;
      const ddy = ty - p.y;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > 0.1) {
        const ux = ddx / dist;
        const uy = ddy / dist;
        p.vx += (ux * MISSILE_SPEED - p.vx) * HOMING_TURN_RATE;
        p.vy += (uy * MISSILE_SPEED - p.vy) * HOMING_TURN_RATE;
        const vMag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (vMag > 0.1) {
          p.vx = (p.vx / vMag) * MISSILE_SPEED;
          p.vy = (p.vy / vMag) * MISSILE_SPEED;
        }
      }

      // 이동
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // 트레일
      p.trailPts.push({ x: p.x, y: p.y });
      if (p.trailPts.length > TRAIL_LENGTH) p.trailPts.shift();

      // 명중 체크
      if (targetAlive && dist < MISSILE_HIT_RADIUS) {
        this.hitsBuffer.push({
          targetIdx: p.targetIdx,
          hitX: tx,
          hitY: ty,
        });
        swapPop(this.projectiles, i);
        continue;
      }

      // 수명
      p.life -= dt;
      if (p.life <= 0 || !targetAlive) {
        swapPop(this.projectiles, i);
      }
    }
  }

  // ── 지그재그 경로 생성 ──
  private makeZigzagPath(x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number }> {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 2) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    const segs = Math.max(6, Math.floor(dist / 14));
    const jitter = dist * 0.16;
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

  // ── 그리기 ──
  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    // 1. 크리스탈 간 연결 번개 (상시 벽)
    for (const conn of this.connections) {
      this.drawConnectionBolt(conn.path);
    }

    // 2. 크리스탈 8개
    for (const c of this.crystals) {
      this.drawCrystal(c);
    }

    // 3. 유도 미사일 (푱푱푱푱)
    for (const p of this.projectiles) {
      this.drawProjectile(p);
    }

    // 4. 체인 확산 번개
    for (const c of this.chainLinks) {
      this.drawChainBolt(c);
    }

    // 5. 임팩트 입자
    for (const r of this.ringPulses) {
      if (r.delay > 0) continue;
      this.drawRingPulse(r);
    }
    for (const s of this.shards) this.drawShard(s);
    for (const c of this.stoneChunks) this.drawStoneChunk(c);
    for (const s of this.sparks) this.drawSpark(s);
  }

  // ── 크리스탈 그리기 ──
  private drawCrystal(c: Crystal) {
    const cx = c.worldX;
    const cy = c.worldY;
    const rotation = c.rotation;

    const pulse = 0.78 + Math.sin(this.time * 0.16 + c.pulseOffset) * 0.22;
    const alpha = 0.88 * pulse;
    // 충전 진행도로 크기 약간 맥동
    const chargeBoost = 1 + c.chargeT * 0.12;

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const rot = (lx: number, ly: number) => ({
      x: cx + (lx * cosR - ly * sinR) * chargeBoost,
      y: cy + (lx * sinR + ly * cosR) * chargeBoost,
    });

    const top = rot(0, -CRYSTAL_H);
    const topR = rot(CRYSTAL_W, -CRYSTAL_H * 0.35);
    const botR = rot(CRYSTAL_W, CRYSTAL_H * 0.35);
    const bot = rot(0, CRYSTAL_H);
    const botL = rot(-CRYSTAL_W, CRYSTAL_H * 0.35);
    const topL = rot(-CRYSTAL_W, -CRYSTAL_H * 0.35);

    const vertices = [top, topR, botR, bot, botL, topL];

    const drawOutline = (gfx: PIXI.Graphics, width: number, color: number, a: number) => {
      gfx.lineStyle(width, color, a);
      gfx.moveTo(vertices[0].x, vertices[0].y);
      for (let i = 1; i < vertices.length; i++) {
        gfx.lineTo(vertices[i].x, vertices[i].y);
      }
      gfx.lineTo(vertices[0].x, vertices[0].y);
      gfx.lineStyle(0);
    };

    drawOutline(this.glowGfx, 9, this.COL_SKY_300, alpha * 0.45);
    drawOutline(this.glowGfx, 5, this.COL_CYAN_300, alpha * 0.60);
    drawOutline(this.gfx, 3, this.COL_CYAN_400, alpha * 0.98);

    // 코어 스파인
    this.glowGfx.lineStyle(6, this.COL_YELLOW_400, alpha * 0.55);
    this.glowGfx.moveTo(top.x, top.y);
    this.glowGfx.lineTo(bot.x, bot.y);
    this.gfx.lineStyle(2.5, this.COL_YELLOW_300, alpha * 0.98);
    this.gfx.moveTo(top.x, top.y);
    this.gfx.lineTo(bot.x, bot.y);
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);

    // 중심 점
    this.gfx.beginFill(this.COL_YELLOW_300, alpha);
    this.gfx.drawCircle(cx, cy, 2.5);
    this.gfx.endFill();

    // 6 정점 하이라이트
    for (const v of vertices) {
      this.glowGfx.beginFill(this.COL_AMBER_300, alpha * 0.65);
      this.glowGfx.drawCircle(v.x, v.y, 4.5);
      this.glowGfx.endFill();
      this.gfx.beginFill(this.COL_YELLOW_300, alpha * 0.98);
      this.gfx.drawCircle(v.x, v.y, 2.2);
      this.gfx.endFill();
    }
  }

  // ── 크리스탈 간 연결 번개 (4패스, 플리커) ──
  private drawConnectionBolt(pts: Array<{ x: number; y: number }>) {
    if (pts.length < 2) return;
    const flicker = 0.82 + Math.random() * 0.18;

    const drawPath = (gfx: PIXI.Graphics, w: number, color: number, alpha: number) => {
      gfx.lineStyle(w, color, alpha);
      gfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
      gfx.lineStyle(0);
    };

    drawPath(this.glowGfx, 18, this.COL_AMBER_600, 0.30 * flicker);
    drawPath(this.glowGfx, 12, this.COL_YELLOW_500, 0.48 * flicker);
    drawPath(this.gfx, 5, this.COL_YELLOW_300, 0.92 * flicker);
    drawPath(this.gfx, 2, this.COL_SKY_300, 0.98 * flicker);
  }

  // ── 유도 미사일 (직선 광선 트레일) ──
  private drawProjectile(p: Projectile) {
    const pts = p.trailPts;
    if (pts.length >= 2) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ageT = i / (pts.length - 1);
        const alpha = ageT * 0.92;
        const width = 3.0 + ageT * 4.5;
        // ADD glow
        this.glowGfx.lineStyle(width * 2.1, this.COL_AMBER_400, alpha * 0.55);
        this.glowGfx.moveTo(pts[i].x, pts[i].y);
        this.glowGfx.lineTo(pts[i + 1].x, pts[i + 1].y);
        // Core
        this.gfx.lineStyle(width * 0.55, this.COL_YELLOW_300, alpha * 0.98);
        this.gfx.moveTo(pts[i].x, pts[i].y);
        this.gfx.lineTo(pts[i + 1].x, pts[i + 1].y);
      }
      this.gfx.lineStyle(0);
      this.glowGfx.lineStyle(0);
    }

    // 헤드
    this.glowGfx.beginFill(this.COL_AMBER_300, 0.85);
    this.glowGfx.drawCircle(p.x, p.y, 12);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(this.COL_YELLOW_300, 0.9);
    this.glowGfx.drawCircle(p.x, p.y, 6);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_YELLOW_300, 1.0);
    this.gfx.drawCircle(p.x, p.y, 3);
    this.gfx.endFill();
  }

  // ── 체인 확산 번개 ──
  private drawChainBolt(c: ChainLink) {
    const life = c.life / c.maxLife;
    const flicker = 0.75 + Math.random() * 0.25;
    const a = life * flicker;
    const pts = c.path;
    if (pts.length < 2) return;

    const drawPath = (gfx: PIXI.Graphics, w: number, color: number, alpha: number) => {
      gfx.lineStyle(w, color, alpha);
      gfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
      gfx.lineStyle(0);
    };

    drawPath(this.glowGfx, 16, this.COL_AMBER_600, a * 0.28);
    drawPath(this.glowGfx, 10, this.COL_YELLOW_500, a * 0.42);
    drawPath(this.gfx, 4.5, this.COL_YELLOW_300, a * 0.90);
    drawPath(this.gfx, 1.8, this.COL_SKY_300, a * 0.95);
  }

  private drawRingPulse(r: RingPulse) {
    const life = r.life / r.maxLife;
    const t = 1 - life;
    const radius = 6 + t * (r.maxRadius - 6);
    const alpha = life * life;
    for (let i = 0; i < RING_SEGS; i++) {
      const angle = (i / RING_SEGS) * Math.PI * 2 + r.rotOffset + t * 0.55;
      const px = r.x + Math.cos(angle) * radius;
      const py = r.y + Math.sin(angle) * radius;
      const size = 2.4 * life;
      const col = this.RING_COLORS[(i + r.colorOffset + Math.floor(t * 8)) % this.RING_COLORS.length];
      this.glowGfx.beginFill(col, alpha * 0.55);
      this.glowGfx.drawCircle(px, py, size * 2);
      this.glowGfx.endFill();
      this.gfx.beginFill(col, alpha * 0.95);
      this.gfx.drawCircle(px, py, size);
      this.gfx.endFill();
    }
  }

  private drawShard(s: Shard) {
    const life = s.life / s.maxLife;
    const alpha = life;
    const sz = s.size * (0.65 + life * 0.35);
    this.glowGfx.beginFill(s.color, alpha * 0.45);
    this.glowGfx.drawCircle(s.x, s.y, sz * 2.0);
    this.glowGfx.endFill();
    this.gfx.beginFill(s.color, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  private drawStoneChunk(c: StoneChunk) {
    const life = c.life / c.maxLife;
    const alpha = life * 0.92;
    const sz = c.size * (0.7 + life * 0.3);
    const color = life > 0.55 ? this.COL_STONE_600 : this.COL_STONE_700;
    this.gfx.beginFill(color, alpha);
    this.gfx.drawCircle(c.x, c.y, sz);
    this.gfx.endFill();
  }

  private drawSpark(s: Spark) {
    const life = s.life / s.maxLife;
    const alpha = life;
    const sz = s.size * (0.65 + life * 0.35);
    this.glowGfx.beginFill(this.COL_CYAN_300, alpha * 0.55);
    this.glowGfx.drawCircle(s.x, s.y, sz * 1.8);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_SKY_300, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  stop() {
    this.active = false;
    this.crystals = [];
    this.connections = [];
    this.projectiles = [];
    this.hitsBuffer = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.stoneChunks = [];
    this.sparks = [];
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
