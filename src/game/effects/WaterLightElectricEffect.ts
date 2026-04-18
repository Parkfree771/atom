import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+빛+전기 3단계 — 프리즘 캐스케이드 (Prism Cascade)
 *
 * 구조 (사용자 명시):
 *   - **반원 돔** 이 플레이어 머리 위에 **상시 떠 있음** (콤보 활성 동안 계속)
 *   - 하늘에서 **무지개 입자가 과하게 수렴** → 돔에 기 모임 (chargeT 0→1)
 *   - chargeT=1 → **곡선 유도 레이저**가 최대 20마리 타겟으로 일제 발사
 *   - 레이저 = **매끄러운 빛 트레일** (번개 지그재그 X, 유도탄처럼 커브)
 *   - 명중 → **전기 번개 체인** 이 인접 3마리로 확산 (여기만 번개)
 *   - 사이클 자동 반복: 기 모임 → 발사 → 모임 → 발사
 *
 * 개발서 규칙 준수:
 *   - 규칙 5: 유도 레이저는 enemyIdx 추적 + lastSafeX/Y fallback (풀 재사용 방어)
 *   - 규칙 6(1): 돔/코어/수렴/체인 전부 셀·파티클로 구성. 폴리곤 0
 *   - 규칙 6(2): 장식 없음
 *   - 흰색 금지: cyan-200 사용 X, sky-300/cyan-300까지만
 *
 * 시각 풀:
 *   - domeArcCells:  반원 돔 아크 셀 (상시, chargeT로 펄스)
 *   - domeInnerCells: 돔 내부 오비트 셀
 *   - gatherParticles: 천장에서 돔으로 수렴 (chargeT 비례 spawn 레이트)
 *   - projectiles:   곡선 유도 레이저 (트레일 있음, 번개 X)
 *   - chainLinks:    명중 후 몬스터간 전기 체인 (4패스 번개 — 여기만)
 *   - ringPulses:    명중점 링 펄스 (18셀 회전)
 *   - shards/droplets/sparks: 명중점 3원소 입자 (흰색 없음)
 */

// ── 상수 ──
const DOME_OFFSET_Y = 78;        // 플레이어 머리 바로 위
const DOME_RADIUS = 82;
const DOME_ARC_CELL_COUNT = 26;  // (42 → 26 — 성능)
const DOME_INNER_CELL_COUNT = 10; // (16 → 10)

const CHARGE_DURATION = 90;      // ~1.5초마다 발사
const MAX_STRIKE_TARGETS = 20;

// 수렴 입자 (천장에서, 성능 최적화: 240 → 130)
const GATHER_MAX_COUNT = 130;
const GATHER_SOURCE_Y_ABOVE = 180;
const GATHER_SOURCE_X_RANGE = 360;

// 유도 레이저
const PROJECTILE_SPEED = 9;
const PROJECTILE_HIT_RADIUS = 26;
const PROJECTILE_MAX_LIFE = 110;
const HOMING_TURN_RATE = 0.16;
const TRAIL_LENGTH = 8;          // (12 → 8)
const NODE_MAX_TRAVEL2 = 120 * 120;

// 명중 입자 카운트 (성능 최적화)
const IMPACT_SHARDS = 14;        // (22 → 14)
const IMPACT_DROPLETS = 16;      // (24 → 16)
const IMPACT_SPARKS = 14;        // (22 → 14)
const IMPACT_RING_COUNT = 2;     // (3 → 2)
const RING_SEGS = 12;            // (18 → 12)

// ── 타입 ──
interface DomeCell {
  // 로컬 좌표 (돔 중심 기준)
  lx: number; ly: number;
  size: number;
  color: number;
  pulse: number;
  // 오비트용 (inner cell만)
  orbitR?: number;
  orbitPhase?: number;
  orbitSpeed?: number;
}

interface GatherParticle {
  x: number; y: number;   // 월드 좌표
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
  phase: number;
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
  delay: number;
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

interface Droplet {
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

// 최소 enemy 인터페이스
interface EnemyRef {
  x: number; y: number;
  active: boolean;
}

export class WaterLightElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // 팔레트 (흰색 금지)
  private readonly RAINBOW_COLORS = [
    0xf87171, // red-400
    0xfb923c, // orange-400
    0xfde047, // yellow-300
    0x4ade80, // green-400
    0x67e8f9, // cyan-300
    0x60a5fa, // blue-400
    0xa78bfa, // violet-400
    0xf472b6, // pink-400
  ];
  private readonly COL_SKY_300 = 0x7dd3fc;
  private readonly COL_CYAN_300 = 0x67e8f9;
  private readonly COL_CYAN_400 = 0x22d3ee;
  private readonly COL_BLUE_400 = 0x60a5fa;
  private readonly COL_BLUE_500 = 0x3b82f6;

  active = false;
  private time = 0;
  private posX = 0;
  private posY = 0;

  // 돔/발사 상태
  private chargeT = 0;          // 0 → 1
  private _chargeReadyFlag = false; // engine이 읽고 setStrikeTargets에서 consume
  private postFireFlash = 0;    // 발사 직후 돔 확장 플래시

  // 시각 풀
  private domeArcCells: DomeCell[] = [];
  private domeInnerCells: DomeCell[] = [];
  private gatherParticles: GatherParticle[] = [];
  private projectiles: Projectile[] = [];
  private chainLinks: ChainLink[] = [];
  private ringPulses: RingPulse[] = [];
  private shards: Shard[] = [];
  private droplets: Droplet[] = [];
  private sparks: Spark[] = [];

  // 엔진 통신
  private hitsBuffer: ProjectileHit[] = [];

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
    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 0;
    this.gatherParticles = [];
    this.projectiles = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.droplets = [];
    this.sparks = [];
    this.hitsBuffer = [];
    this.initDomeCells();
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  // ── 돔 셀 초기화 ──
  private initDomeCells() {
    this.domeArcCells = [];
    this.domeInnerCells = [];

    // 아크 셀: 반원 상단 — angle π (왼쪽)에서 2π (오른쪽) 지나는 위쪽 호
    // 스크린 좌표에서 y+ = 아래이므로, π~2π 범위가 위쪽 반원
    for (let i = 0; i < DOME_ARC_CELL_COUNT; i++) {
      const t = i / (DOME_ARC_CELL_COUNT - 1);
      const angle = Math.PI + t * Math.PI; // π ~ 2π
      const lx = Math.cos(angle) * DOME_RADIUS;
      const ly = Math.sin(angle) * DOME_RADIUS;
      this.domeArcCells.push({
        lx, ly,
        size: 2.4 + Math.random() * 1.5,
        color: this.RAINBOW_COLORS[i % this.RAINBOW_COLORS.length],
        pulse: Math.random() * Math.PI * 2,
      });
    }

    // 내부 셀: 반원 내부 (상반원 영역)에 분산
    for (let i = 0; i < DOME_INNER_CELL_COUNT; i++) {
      const angle = Math.PI + Math.random() * Math.PI;
      const r = (0.25 + Math.random() * 0.65) * DOME_RADIUS;
      this.domeInnerCells.push({
        lx: Math.cos(angle) * r,
        ly: Math.sin(angle) * r,
        size: 1.6 + Math.random() * 1.3,
        color: this.RAINBOW_COLORS[i % this.RAINBOW_COLORS.length],
        pulse: Math.random() * Math.PI * 2,
        orbitR: r,
        orbitPhase: angle,
        orbitSpeed: 0.012 + Math.random() * 0.018,
      });
    }
  }

  // ── 외부 통신 ──

  /** 충전 완료 플래그 (engine이 읽고 setStrikeTargets로 consume) */
  chargeReady(): boolean {
    return this._chargeReadyFlag;
  }

  /** 이번 프레임에 곡선 유도 레이저 명중 이벤트들 (engine이 damage 처리) */
  hitsThisFrame(): ProjectileHit[] {
    return this.hitsBuffer;
  }

  /** engine이 수집한 타겟 리스트를 기반으로 projectile spawn */
  setStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    const domeCX = this.posX;
    const domeCY = this.posY - DOME_OFFSET_Y;

    for (const tgt of targets) {
      const dx = tgt.worldX - domeCX;
      const dy = tgt.worldY - domeCY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // 수직 성분 (곡선용)
      const perpX = -dy / len;
      const perpY = dx / len;
      // 초기 방향: 타겟 방향 + 수직 측면 편향 (곡선 출발)
      const curveBias = (Math.random() - 0.5) * 0.95;
      const forwardBias = 0.55 + Math.random() * 0.25;
      const ivx = (dx / len) * forwardBias + perpX * curveBias;
      const ivy = (dy / len) * forwardBias + perpY * curveBias;
      const iMag = Math.sqrt(ivx * ivx + ivy * ivy) || 1;
      const vx = (ivx / iMag) * PROJECTILE_SPEED;
      const vy = (ivy / iMag) * PROJECTILE_SPEED;

      this.projectiles.push({
        x: domeCX + (Math.random() - 0.5) * 12,
        y: domeCY + (Math.random() - 0.5) * 12,
        vx, vy,
        targetIdx: tgt.enemyIdx,
        lastSafeX: tgt.worldX,
        lastSafeY: tgt.worldY,
        life: PROJECTILE_MAX_LIFE,
        color: this.RAINBOW_COLORS[Math.floor(Math.random() * this.RAINBOW_COLORS.length)],
        trailPts: [],
      });
    }

    // 충전 리셋
    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 18;
  }

  maxStrikeTargets(): number {
    return MAX_STRIKE_TARGETS;
  }

  /** 명중 지점에 3원소 임팩트 입자 spawn (engine이 damage 직후 호출) */
  spawnImpactAt(x: number, y: number) {
    // 링 펄스
    for (let r = 0; r < IMPACT_RING_COUNT; r++) {
      const baseLife = 22 + r * 5;
      this.ringPulses.push({
        x, y,
        life: baseLife,
        maxLife: baseLife,
        delay: r * 3,
        colorOffset: Math.floor(Math.random() * 8),
        rotOffset: Math.random() * Math.PI * 2,
        maxRadius: 48 + r * 10,
      });
    }
    // 파편
    for (let i = 0; i < IMPACT_SHARDS; i++) {
      const angle = (i / IMPACT_SHARDS) * Math.PI * 2 + Math.random() * 0.28;
      const speed = 4.2 + Math.random() * 3.4;
      const maxLife = 24 + Math.random() * 12;
      this.shards.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 2.3 + Math.random() * 2.0,
        color: this.RAINBOW_COLORS[i % this.RAINBOW_COLORS.length],
      });
    }
    // 물방울
    for (let i = 0; i < IMPACT_DROPLETS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.2 + Math.random() * 3.0;
      const maxLife = 28 + Math.random() * 16;
      this.droplets.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,
        life: maxLife, maxLife,
        size: 1.7 + Math.random() * 1.5,
      });
    }
    // 스파크
    for (let i = 0; i < IMPACT_SPARKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3.2 + Math.random() * 4.0;
      const maxLife = 13 + Math.random() * 7;
      this.sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 1.5 + Math.random() * 1.3,
      });
    }
  }

  /** 명중 후 몬스터간 전기 체인 라인 추가 */
  addChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    for (const l of lines) {
      const life = 20;
      this.chainLinks.push({
        fromX: l.x0, fromY: l.y0,
        toX: l.x1, toY: l.y1,
        life, maxLife: life,
        delay: 0,
        path: this.makeZigzagPath(l.x0, l.y0, l.x1, l.y1),
      });
    }
  }

  // ── 메인 업데이트 (돔/gather/particles) ──
  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.hitsBuffer = [];

    // 충전
    if (this.chargeT < 1 && !this._chargeReadyFlag) {
      this.chargeT += dt / CHARGE_DURATION;
      if (this.chargeT >= 1) {
        this.chargeT = 1;
        this._chargeReadyFlag = true;
      }
    }

    if (this.postFireFlash > 0) {
      this.postFireFlash -= dt;
      if (this.postFireFlash < 0) this.postFireFlash = 0;
    }

    // ── 수렴 입자 spawn (chargeT 비례) ──
    // 성능 최적화: 1~5 per frame (이전 2~9)
    const spawnIntensity = 1 + this.chargeT * 4;
    const floorN = Math.floor(spawnIntensity);
    for (let i = 0; i < floorN; i++) {
      if (this.gatherParticles.length < GATHER_MAX_COUNT) {
        this.spawnGatherParticle();
      }
    }
    if (Math.random() < spawnIntensity - floorN) {
      if (this.gatherParticles.length < GATHER_MAX_COUNT) {
        this.spawnGatherParticle();
      }
    }

    // 수렴 입자 업데이트 (squared distance 사용, sqrt 최소화)
    const domeCX = this.posX;
    const domeCY = this.posY - DOME_OFFSET_Y;
    const MAX_V2 = 36; // 6²
    for (let i = this.gatherParticles.length - 1; i >= 0; i--) {
      const p = this.gatherParticles[i];
      const dx = domeCX - p.x;
      const dy = domeCY - p.y;
      const d2 = dx * dx + dy * dy;
      // 소멸 체크 먼저 (sqrt 피함)
      if (d2 < 100 /* 10² */) {
        swapPop(this.gatherParticles, i);
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        swapPop(this.gatherParticles, i);
        continue;
      }
      // 여기서만 sqrt (한 번)
      const dist = Math.sqrt(d2);
      const invDist = 1 / dist;
      const ux = dx * invDist;
      const uy = dy * invDist;
      const pull = 0.22 + (1 - Math.min(1, dist / 220)) * 0.35;
      p.vx += ux * pull;
      p.vy += uy * pull;
      // 속도 제한 — vMag²로 체크, 초과 시만 sqrt
      const v2 = p.vx * p.vx + p.vy * p.vy;
      if (v2 > MAX_V2) {
        const vInv = 6 / Math.sqrt(v2);
        p.vx *= vInv;
        p.vy *= vInv;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // 체인 링크 (몬스터간 번개)
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      const c = this.chainLinks[i];
      if (c.delay > 0) {
        c.delay -= dt;
        continue;
      }
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

    // 물방울
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const d = this.droplets[i];
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vy += 0.16 * dt;
      d.vx *= 0.975;
      d.life -= dt;
      if (d.life <= 0) swapPop(this.droplets, i);
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

  /**
   * engine이 매 프레임 호출 — enemies ref를 받아서 유도 레이저 업데이트.
   * 규칙 5: lastSafeX/Y 거리 체크로 풀 재사용 방어.
   */
  updateHoming(dt: number, enemies: EnemyRef[]) {
    if (!this.active) return;
    const enemyCount = enemies.length;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // 타겟 위치 (rule 5)
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

      // 유도 (타겟으로 스티어)
      const ddx = tx - p.x;
      const ddy = ty - p.y;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > 0.1) {
        const ux = ddx / dist;
        const uy = ddy / dist;
        // 속도 방향을 원하는 방향으로 lerp (곡선 유도)
        p.vx += (ux * PROJECTILE_SPEED - p.vx) * HOMING_TURN_RATE;
        p.vy += (uy * PROJECTILE_SPEED - p.vy) * HOMING_TURN_RATE;
        // 속도 정규화
        const vMag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (vMag > 0.1) {
          p.vx = (p.vx / vMag) * PROJECTILE_SPEED;
          p.vy = (p.vy / vMag) * PROJECTILE_SPEED;
        }
      }

      // 이동
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // 트레일
      p.trailPts.push({ x: p.x, y: p.y });
      if (p.trailPts.length > TRAIL_LENGTH) p.trailPts.shift();

      // 명중 체크
      if (targetAlive && dist < PROJECTILE_HIT_RADIUS) {
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

  // ── 수렴 입자 spawn ──
  private spawnGatherParticle() {
    const domeCX = this.posX;
    const domeCY = this.posY - DOME_OFFSET_Y;
    // 돔 위 매우 높은 지점에서 spawn
    const sourceX = domeCX + (Math.random() - 0.5) * GATHER_SOURCE_X_RANGE;
    const sourceY = domeCY - DOME_RADIUS - 60 - Math.random() * GATHER_SOURCE_Y_ABOVE;
    // 초기 속도: 돔 방향으로 느리게 (가속은 update에서)
    const dx = domeCX - sourceX;
    const dy = domeCY - sourceY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = 1.2 + Math.random() * 1.8;
    this.gatherParticles.push({
      x: sourceX,
      y: sourceY,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      life: 90 + Math.random() * 40,
      maxLife: 120,
      size: 2.0 + Math.random() * 2.2,
      color: this.RAINBOW_COLORS[Math.floor(Math.random() * this.RAINBOW_COLORS.length)],
      phase: Math.random() * Math.PI * 2,
    });
  }

  // ── 지그재그 번개 경로 (체인 확산용만) ──
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

    // 1. 수렴 입자 (돔 뒤에)
    this.drawGatherParticles();

    // 2. 반원 돔 (항상 보임)
    this.drawDome();

    // 3. 유도 레이저 + 트레일
    for (const p of this.projectiles) {
      this.drawProjectile(p);
    }

    // 4. 체인 번개 (몬스터간)
    for (const c of this.chainLinks) {
      if (c.delay > 0) continue;
      this.drawChainBolt(c);
    }

    // 5. 명중점 입자
    for (const r of this.ringPulses) {
      if (r.delay > 0) continue;
      this.drawRingPulse(r);
    }
    for (const s of this.shards) this.drawShard(s);
    for (const d of this.droplets) this.drawDroplet(d);
    for (const s of this.sparks) this.drawSpark(s);
  }

  // ── 반원 돔 그리기 (아크 셀 + 내부 오비트 셀) ──
  private drawDome() {
    const cx = this.posX;
    const cy = this.posY - DOME_OFFSET_Y;
    // 기본 알파 + chargeT 부스트 + 발사 플래시
    const flashBoost = this.postFireFlash > 0 ? (this.postFireFlash / 18) * 0.6 : 0;
    const baseAlpha = 0.62 + this.chargeT * 0.32 + flashBoost;
    const sizeBoost = 1 + this.chargeT * 0.25 + (this.postFireFlash > 0 ? 0.3 : 0);

    // 아크 셀
    for (const cell of this.domeArcCells) {
      const pulse = 0.70 + Math.sin(this.time * 0.14 + cell.pulse) * 0.30;
      const alpha = Math.min(1, baseAlpha * pulse);
      const sz = cell.size * sizeBoost * (0.85 + pulse * 0.15);
      const x = cx + cell.lx * sizeBoost;
      const y = cy + cell.ly * sizeBoost;

      this.glowGfx.beginFill(cell.color, alpha * 0.55);
      this.glowGfx.drawCircle(x, y, sz * 2.2);
      this.glowGfx.endFill();
      this.gfx.beginFill(cell.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }

    // 내부 셀 (오비트)
    for (const cell of this.domeInnerCells) {
      const orbit = (cell.orbitPhase ?? 0) + this.time * (cell.orbitSpeed ?? 0.015);
      const r = (cell.orbitR ?? 40) * sizeBoost;
      const x = cx + Math.cos(orbit) * r;
      // y는 상반원 제한
      const yRaw = cy + Math.sin(orbit) * r;
      // 상반원 (yRaw < cy)만 그리고 아니면 mirror
      const y = yRaw < cy ? yRaw : cy - (yRaw - cy);
      const pulse = 0.68 + Math.sin(this.time * 0.16 + cell.pulse) * 0.32;
      const alpha = Math.min(1, baseAlpha * pulse);
      const sz = cell.size * sizeBoost * (0.80 + pulse * 0.20);

      this.glowGfx.beginFill(cell.color, alpha * 0.50);
      this.glowGfx.drawCircle(x, y, sz * 2.0);
      this.glowGfx.endFill();
      this.gfx.beginFill(cell.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  // ── 수렴 입자 ──
  private drawGatherParticles() {
    for (const p of this.gatherParticles) {
      const life = p.life / p.maxLife;
      const alpha = 0.55 + (1 - life) * 0.35; // 가까워질수록 밝게
      const sz = p.size * (0.75 + (1 - life) * 0.3);

      this.glowGfx.beginFill(p.color, alpha * 0.45);
      this.glowGfx.drawCircle(p.x, p.y, sz * 2.0);
      this.glowGfx.endFill();
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(p.x, p.y, sz);
      this.gfx.endFill();
    }
  }

  // ── 유도 레이저 (번개 X, 매끄러운 트레일, 2패스 — 성능) ──
  private drawProjectile(p: Projectile) {
    const pts = p.trailPts;
    // 트레일: 2패스 (outer glow + core sky-300)
    if (pts.length >= 2) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ageT = i / (pts.length - 1);
        const alpha = ageT * 0.85;
        const width = 2.5 + ageT * 4;
        // ADD glow (컬러)
        this.glowGfx.lineStyle(width * 2.0, p.color, alpha * 0.48);
        this.glowGfx.moveTo(pts[i].x, pts[i].y);
        this.glowGfx.lineTo(pts[i + 1].x, pts[i + 1].y);
        // Core (sky-300)
        this.gfx.lineStyle(width * 0.55, this.COL_SKY_300, alpha * 0.95);
        this.gfx.moveTo(pts[i].x, pts[i].y);
        this.gfx.lineTo(pts[i + 1].x, pts[i + 1].y);
      }
      this.gfx.lineStyle(0);
      this.glowGfx.lineStyle(0);
    }

    // 헤드 (레이저 선두, 2층)
    this.glowGfx.beginFill(p.color, 0.72);
    this.glowGfx.drawCircle(p.x, p.y, 10);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_SKY_300, 0.95);
    this.gfx.drawCircle(p.x, p.y, 3);
    this.gfx.endFill();
  }

  // ── 4패스 체인 번개 (몬스터간만) ──
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

    drawPath(this.glowGfx, 16, this.COL_BLUE_500, a * 0.26);
    drawPath(this.glowGfx, 10, this.COL_CYAN_400, a * 0.38);
    drawPath(this.gfx, 4.5, this.COL_SKY_300, a * 0.88);
    drawPath(this.gfx, 1.8, this.COL_CYAN_300, a * 0.95);
  }

  // ── 링 펄스 (12셀 링) ──
  private drawRingPulse(r: RingPulse) {
    const life = r.life / r.maxLife;
    const t = 1 - life;
    const radius = 6 + t * (r.maxRadius - 6);
    const alpha = life * life;
    for (let i = 0; i < RING_SEGS; i++) {
      const angle = (i / RING_SEGS) * Math.PI * 2 + r.rotOffset + t * 0.55;
      const px = r.x + Math.cos(angle) * radius;
      const py = r.y + Math.sin(angle) * radius;
      const size = 2.6 * life;
      const col = this.RAINBOW_COLORS[(i + r.colorOffset + Math.floor(t * 8)) % this.RAINBOW_COLORS.length];
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
    this.glowGfx.drawCircle(s.x, s.y, sz * 2.3);
    this.glowGfx.endFill();
    this.gfx.beginFill(s.color, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  private drawDroplet(d: Droplet) {
    const life = d.life / d.maxLife;
    const alpha = life * 0.88;
    const sz = d.size * (0.7 + life * 0.3);
    const color = life > 0.55 ? this.COL_CYAN_300 : this.COL_BLUE_500;
    this.glowGfx.beginFill(this.COL_BLUE_400, alpha * 0.32);
    this.glowGfx.drawCircle(d.x, d.y, sz * 1.7);
    this.glowGfx.endFill();
    this.gfx.beginFill(color, alpha);
    this.gfx.drawCircle(d.x, d.y, sz);
    this.gfx.endFill();
  }

  private drawSpark(s: Spark) {
    const life = s.life / s.maxLife;
    const alpha = life;
    const sz = s.size * (0.65 + life * 0.35);
    this.glowGfx.beginFill(this.COL_CYAN_400, alpha * 0.58);
    this.glowGfx.drawCircle(s.x, s.y, sz * 1.9);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_SKY_300, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  stop() {
    this.active = false;
    this.domeArcCells = [];
    this.domeInnerCells = [];
    this.gatherParticles = [];
    this.projectiles = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.droplets = [];
    this.sparks = [];
    this.hitsBuffer = [];
    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 0;
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
