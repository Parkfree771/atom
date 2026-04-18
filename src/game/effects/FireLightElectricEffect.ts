import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불+빛+전기 3단계 — 솔라 폭주 (Solar Ascension)
 *
 * 프리즘 캐스케이드 아키텍처 미러링, 시각만 태양 컨셉:
 *   - 머리 위 미니 태양 코어 + 3중 코로나 회전 링 (상시)
 *   - 표면 플레어 (솔라 그래뉼) — chargeT 비례 spawn, 기 모임 시각
 *   - 충전 완료 → 최대 18발 플라즈마 웜 (사인 곡선 유도)
 *   - 명중 → 거대 코로나 폭발 + 몬스터간 전기 체인 확산
 *
 * 개발서 규칙 준수:
 *   - 규칙 5: 웜은 enemyIdx + lastSafeX/Y fallback (풀 재사용 방어)
 *   - 규칙 6(1): 폴리곤 금지. 코어/링/플레어/임팩트 전부 셀·파티클
 *   - 규칙 6(2): 장식 금지. 태양+링+플레어+웜+임팩트만
 *   - 흰색 금지: cyan-200/순백 사용 X
 *
 * 시각 풀:
 *   - coreCells:     태양 코어 20셀 (brightness gradient)
 *   - coronaRings:   3링 × 12/14/16셀 (반대 방향 회전)
 *   - surfaceFlares: 표면 플레어 (최대 50, 끓어오름 + 낙하)
 *   - plasmaWorms:   사인 곡선 유도 투사체
 *   - chainLinks:    명중 후 몬스터간 전기 체인
 *   - ringPulses:    명중점 링 펄스 (14셀 × 2겹)
 *   - shards/embers/sparks: 거대 임팩트 입자 (20/24/18)
 */

// ── 상수 ──
const SUN_OFFSET_Y = 78;
const SUN_CORE_RADIUS = 42;

const CORONA_RING_R = [60, 85, 110];
const CORONA_RING_CELLS = [12, 14, 16];
const CORONA_SPEEDS = [0.018, -0.012, 0.008];

const CHARGE_DURATION = 90;
const MAX_WORMS = 18;

const FLARE_MAX_COUNT = 50;

const WORM_SPEED = 9;
const WORM_HIT_RADIUS = 30;
const WORM_MAX_LIFE = 110;
const WORM_SINE_AMP = 12;
const WORM_SINE_FREQ_BASE = 0.18;
const HOMING_TURN_RATE = 0.16;
const TRAIL_LENGTH = 10;
const NODE_MAX_TRAVEL2 = 120 * 120;

// 임팩트 (프리즘보다 크게)
const IMPACT_SHARDS = 20;
const IMPACT_EMBERS = 24;
const IMPACT_SPARKS = 18;
const IMPACT_RING_COUNT = 2;
const RING_SEGS = 14;

// ── 타입 ──
interface CoreCell {
  lx: number; ly: number;
  size: number;
  color: number;
  pulse: number;
}

interface CoronaCell {
  ringIdx: number;       // 0~2
  angleOffset: number;
  size: number;
  color: number;
  pulse: number;
}

interface SurfaceFlare {
  // 로컬 좌표 (태양 중심 기준)
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: number;
}

interface PlasmaWorm {
  baseX: number; baseY: number;  // 월드 좌표 (직선 호밍)
  vx: number; vy: number;
  drawX: number; drawY: number;  // wobble 적용 후 실제 그려질 위치
  targetIdx: number;
  lastSafeX: number; lastSafeY: number;
  life: number;
  sinPhase: number;
  sinFreq: number;
  color: number;
  trailPts: Array<{ x: number; y: number }>;
}

interface WormHit {
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

interface Ember {
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

export class FireLightElectricEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  // ── 팔레트 (흰색 금지) ──
  // 태양 (red → yellow 그라데이션)
  private readonly COL_RED_500 = 0xef4444;
  private readonly COL_RED_600 = 0xdc2626;
  private readonly COL_RED_700 = 0xb91c1c;
  private readonly COL_ORANGE_400 = 0xfb923c;
  private readonly COL_ORANGE_500 = 0xf97316;
  private readonly COL_ORANGE_600 = 0xea580c;
  private readonly COL_YELLOW_200 = 0xfef08a;
  private readonly COL_YELLOW_300 = 0xfde047;
  private readonly COL_YELLOW_400 = 0xfacc15;
  private readonly COL_YELLOW_500 = 0xeab308;
  private readonly COL_AMBER_300 = 0xfcd34d;
  // 전기 (체인/스파크)
  private readonly COL_SKY_300 = 0x7dd3fc;
  private readonly COL_CYAN_300 = 0x67e8f9;

  // 링 펄스 팔레트 (불 계통 무지개)
  private readonly RING_COLORS = [
    0xfde047, // yellow-300
    0xfacc15, // yellow-400
    0xfcd34d, // amber-300
    0xfb923c, // orange-400
    0xf97316, // orange-500
    0xea580c, // orange-600
    0xef4444, // red-500
    0xdc2626, // red-600
  ];

  // 파편 팔레트 (8색 순환, 밝은 태양 톤)
  private readonly SHARD_COLORS = [
    0xfde047,
    0xfacc15,
    0xfcd34d,
    0xfb923c,
    0xf97316,
    0xea580c,
    0xef4444,
    0xdc2626,
  ];

  active = false;
  private time = 0;
  private posX = 0;
  private posY = 0;

  // 충전 상태
  private chargeT = 0;
  private _chargeReadyFlag = false;
  private postFireFlash = 0;

  // 시각 풀
  private coreCells: CoreCell[] = [];
  private coronaRingCells: CoronaCell[] = [];
  private surfaceFlares: SurfaceFlare[] = [];
  private plasmaWorms: PlasmaWorm[] = [];
  private chainLinks: ChainLink[] = [];
  private ringPulses: RingPulse[] = [];
  private shards: Shard[] = [];
  private embers: Ember[] = [];
  private sparks: Spark[] = [];

  // 엔진 통신
  private hitsBuffer: WormHit[] = [];

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
    this.surfaceFlares = [];
    this.plasmaWorms = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.embers = [];
    this.sparks = [];
    this.hitsBuffer = [];
    this.initCoreCells();
    this.initCoronaCells();
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  // ── 태양 코어 셀 초기화 (동심원 구조, 깔끔한 태양 모양) ──
  private initCoreCells() {
    this.coreCells = [];

    // 동심원 레이어 — 중심부터 바깥으로 밝은 노랑 → 주황
    // 각도 균등 분배로 깔끔한 방사형 패턴
    const ringDefs = [
      { r: 0,  count: 1,  color: this.COL_YELLOW_200, size: 4.2 },  // 중심 단일 셀 (가장 밝음)
      { r: 13, count: 8,  color: this.COL_YELLOW_300, size: 3.4 },  // 1층
      { r: 24, count: 12, color: this.COL_YELLOW_400, size: 2.9 },  // 2층
      { r: 35, count: 16, color: this.COL_ORANGE_400, size: 2.4 },  // 3층 (외곽)
    ];

    for (const ring of ringDefs) {
      if (ring.count === 1) {
        this.coreCells.push({
          lx: 0,
          ly: 0,
          size: ring.size,
          color: ring.color,
          pulse: Math.random() * Math.PI * 2,
        });
      } else {
        for (let i = 0; i < ring.count; i++) {
          // 각도 균등 + 레이어마다 rotation offset (링끼리 별 모양으로 안 겹치게)
          const angle = (i / ring.count) * Math.PI * 2 + (ring.r / 13) * 0.2;
          this.coreCells.push({
            lx: Math.cos(angle) * ring.r,
            ly: Math.sin(angle) * ring.r,
            size: ring.size,
            color: ring.color,
            pulse: Math.random() * Math.PI * 2,
          });
        }
      }
    }
  }

  // ── 3중 코로나 링 초기화 (밝은 노랑 → 주황 부드러운 그라데이션) ──
  private initCoronaCells() {
    this.coronaRingCells = [];
    for (let ringIdx = 0; ringIdx < 3; ringIdx++) {
      const count = CORONA_RING_CELLS[ringIdx];
      for (let i = 0; i < count; i++) {
        // 각도 균등 분배 (미세 지터로 딱딱함 방지)
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.04;
        // 링별 색 분포 — 안쪽 링은 밝은 노랑, 바깥은 따뜻한 주황
        let color: number;
        if (ringIdx === 0) {
          // 1링: 코어와 연결감 — 노랑톤
          const r = Math.random();
          color = r < 0.5 ? this.COL_YELLOW_300 : (r < 0.85 ? this.COL_AMBER_300 : this.COL_YELLOW_400);
        } else if (ringIdx === 1) {
          // 2링: 노랑→주황 전환
          const r = Math.random();
          color = r < 0.45 ? this.COL_YELLOW_400 : (r < 0.80 ? this.COL_ORANGE_400 : this.COL_AMBER_300);
        } else {
          // 3링: 주황 주조 (red 제거로 탁함 방지)
          const r = Math.random();
          color = r < 0.50 ? this.COL_ORANGE_400 : (r < 0.85 ? this.COL_ORANGE_500 : this.COL_AMBER_300);
        }
        this.coronaRingCells.push({
          ringIdx,
          angleOffset: angle,
          size: 2.3 + Math.random() * 1.3,
          color,
          pulse: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  // ── 외부 통신 ──

  chargeReady(): boolean {
    return this._chargeReadyFlag;
  }

  hitsThisFrame(): WormHit[] {
    return this.hitsBuffer;
  }

  setStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    const sunCX = this.posX;
    const sunCY = this.posY - SUN_OFFSET_Y;

    for (const tgt of targets) {
      const dx = tgt.worldX - sunCX;
      const dy = tgt.worldY - sunCY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;
      const curveBias = (Math.random() - 0.5) * 0.95;
      const forwardBias = 0.55 + Math.random() * 0.25;
      const ivx = (dx / len) * forwardBias + perpX * curveBias;
      const ivy = (dy / len) * forwardBias + perpY * curveBias;
      const iMag = Math.sqrt(ivx * ivx + ivy * ivy) || 1;
      const vx = (ivx / iMag) * WORM_SPEED;
      const vy = (ivy / iMag) * WORM_SPEED;

      // 웜별 랜덤 sin phase/freq (서로 다른 파형)
      const sinFreq = WORM_SINE_FREQ_BASE + (Math.random() - 0.5) * 0.08;

      this.plasmaWorms.push({
        baseX: sunCX + (Math.random() - 0.5) * 14,
        baseY: sunCY + (Math.random() - 0.5) * 14,
        vx, vy,
        drawX: sunCX,
        drawY: sunCY,
        targetIdx: tgt.enemyIdx,
        lastSafeX: tgt.worldX,
        lastSafeY: tgt.worldY,
        life: WORM_MAX_LIFE,
        sinPhase: Math.random() * Math.PI * 2,
        sinFreq,
        color: this.SHARD_COLORS[Math.floor(Math.random() * this.SHARD_COLORS.length)],
        trailPts: [],
      });
    }

    this.chargeT = 0;
    this._chargeReadyFlag = false;
    this.postFireFlash = 20;
  }

  maxStrikeTargets(): number {
    return MAX_WORMS;
  }

  spawnImpactAt(x: number, y: number) {
    // 링 펄스
    for (let r = 0; r < IMPACT_RING_COUNT; r++) {
      const baseLife = 24 + r * 5;
      this.ringPulses.push({
        x, y,
        life: baseLife,
        maxLife: baseLife,
        delay: r * 3,
        colorOffset: Math.floor(Math.random() * 8),
        rotOffset: Math.random() * Math.PI * 2,
        maxRadius: 54 + r * 12,
      });
    }
    // 파편 (불 톤)
    for (let i = 0; i < IMPACT_SHARDS; i++) {
      const angle = (i / IMPACT_SHARDS) * Math.PI * 2 + Math.random() * 0.28;
      const speed = 4.5 + Math.random() * 3.8;
      const maxLife = 26 + Math.random() * 14;
      this.shards.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 2.4 + Math.random() * 2.1,
        color: this.SHARD_COLORS[i % this.SHARD_COLORS.length],
      });
    }
    // 잉걸 (상향 바이어스)
    for (let i = 0; i < IMPACT_EMBERS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.4 + Math.random() * 3.2;
      const maxLife = 30 + Math.random() * 16;
      this.embers.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        life: maxLife, maxLife,
        size: 1.8 + Math.random() * 1.6,
      });
    }
    // 스파크 (전기)
    for (let i = 0; i < IMPACT_SPARKS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3.4 + Math.random() * 4.0;
      const maxLife = 14 + Math.random() * 8;
      this.sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife, maxLife,
        size: 1.5 + Math.random() * 1.3,
      });
    }
  }

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

  // ── 메인 업데이트 ──
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

    // ── 표면 플레어 spawn (chargeT 비례) ──
    const spawnIntensity = 1 + this.chargeT * 3;
    const floorN = Math.floor(spawnIntensity);
    for (let i = 0; i < floorN; i++) {
      if (this.surfaceFlares.length < FLARE_MAX_COUNT) {
        this.spawnSurfaceFlare();
      }
    }
    if (Math.random() < spawnIntensity - floorN) {
      if (this.surfaceFlares.length < FLARE_MAX_COUNT) {
        this.spawnSurfaceFlare();
      }
    }

    // 플레어 업데이트 (로컬 좌표, 중력으로 돌아옴)
    for (let i = this.surfaceFlares.length - 1; i >= 0; i--) {
      const f = this.surfaceFlares[i];
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 0.18 * dt; // 중력 (태양으로 되돌아옴)
      f.vx *= 0.97;
      f.life -= dt;
      if (f.life <= 0) swapPop(this.surfaceFlares, i);
    }

    // 체인 링크
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

    // 잉걸 (상향 + 중력)
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += 0.14 * dt;
      e.vx *= 0.97;
      e.life -= dt;
      if (e.life <= 0) swapPop(this.embers, i);
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

  /** engine이 매 프레임 호출 — 플라즈마 웜 호밍 업데이트 (rule 5 내장) */
  updateHoming(dt: number, enemies: EnemyRef[]) {
    if (!this.active) return;
    const enemyCount = enemies.length;

    for (let i = this.plasmaWorms.length - 1; i >= 0; i--) {
      const p = this.plasmaWorms[i];

      // Rule 5 safe target
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

      // 직선 호밍 (베이스 위치)
      const ddx = tx - p.baseX;
      const ddy = ty - p.baseY;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist > 0.1) {
        const ux = ddx / dist;
        const uy = ddy / dist;
        p.vx += (ux * WORM_SPEED - p.vx) * HOMING_TURN_RATE;
        p.vy += (uy * WORM_SPEED - p.vy) * HOMING_TURN_RATE;
        const vMag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (vMag > 0.1) {
          p.vx = (p.vx / vMag) * WORM_SPEED;
          p.vy = (p.vy / vMag) * WORM_SPEED;
        }
      }

      // 베이스 이동
      p.baseX += p.vx * dt;
      p.baseY += p.vy * dt;

      // 사인 wobble — 타겟 가까우면 감쇠 (명중 보장)
      const wobbleScale = Math.min(1, dist / 80);
      const wobbleRaw = Math.sin(this.time * p.sinFreq + p.sinPhase) * WORM_SINE_AMP * wobbleScale;
      const perpX = -p.vy / WORM_SPEED;
      const perpY = p.vx / WORM_SPEED;
      p.drawX = p.baseX + perpX * wobbleRaw;
      p.drawY = p.baseY + perpY * wobbleRaw;

      // 트레일 (draw 위치 기준)
      p.trailPts.push({ x: p.drawX, y: p.drawY });
      if (p.trailPts.length > TRAIL_LENGTH) p.trailPts.shift();

      // 명중 체크 (draw 위치 기준)
      if (targetAlive) {
        const hdx = tx - p.drawX;
        const hdy = ty - p.drawY;
        const hd2 = hdx * hdx + hdy * hdy;
        if (hd2 < WORM_HIT_RADIUS * WORM_HIT_RADIUS) {
          this.hitsBuffer.push({
            targetIdx: p.targetIdx,
            hitX: tx,
            hitY: ty,
          });
          swapPop(this.plasmaWorms, i);
          continue;
        }
      }

      // 수명
      p.life -= dt;
      if (p.life <= 0 || !targetAlive) {
        swapPop(this.plasmaWorms, i);
      }
    }
  }

  // ── 표면 플레어 spawn (코어 바깥 엣지에서 분출 — 코어 내부 가리지 않음) ──
  private spawnSurfaceFlare() {
    // 코어 반경 + 2px 지점에서 spawn (코어 완전히 바깥)
    const angle = Math.random() * Math.PI * 2;
    const startR = SUN_CORE_RADIUS + 2;
    const lx = Math.cos(angle) * startR;
    const ly = Math.sin(angle) * startR;
    // 속도: 방사 외측 방향 (코어 바깥으로 분출 → 중력으로 낙하)
    const speed = 1.6 + Math.random() * 1.4;
    const tanX = -Math.sin(angle);
    const tanY = Math.cos(angle);
    const tanJitter = (Math.random() - 0.5) * 0.6;
    const vx = Math.cos(angle) * speed + tanX * tanJitter;
    const vy = Math.sin(angle) * speed + tanY * tanJitter - 0.4;
    const r = Math.random();
    const color = r < 0.4 ? this.COL_YELLOW_300 : (r < 0.75 ? this.COL_AMBER_300 : this.COL_ORANGE_400);
    this.surfaceFlares.push({
      x: lx, y: ly,
      vx, vy,
      life: 26 + Math.random() * 12,
      maxLife: 38,
      size: 1.5 + Math.random() * 1.3,
      color,
    });
  }

  // ── 지그재그 경로 (체인용) ──
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

    // 1. 태양 코어 + 코로나 링 (상시)
    this.drawSun();

    // 2. 표면 플레어
    this.drawSurfaceFlares();

    // 3. 플라즈마 웜 + 트레일
    for (const p of this.plasmaWorms) {
      this.drawPlasmaWorm(p);
    }

    // 4. 체인 번개
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
    for (const e of this.embers) this.drawEmber(e);
    for (const s of this.sparks) this.drawSpark(s);
  }

  // ── 태양 그리기 ──
  private drawSun() {
    const cx = this.posX;
    const cy = this.posY - SUN_OFFSET_Y;
    const flashBoost = this.postFireFlash > 0 ? (this.postFireFlash / 20) * 0.5 : 0;
    const baseAlpha = 0.72 + this.chargeT * 0.22 + flashBoost;
    const sizeBoost = 1 + this.chargeT * 0.18 + (this.postFireFlash > 0 ? 0.25 : 0);

    // 코어 셀 (중앙 쏠림)
    for (const cell of this.coreCells) {
      const pulse = 0.76 + Math.sin(this.time * 0.15 + cell.pulse) * 0.24;
      const alpha = Math.min(1, baseAlpha * pulse);
      const sz = cell.size * sizeBoost * (0.88 + pulse * 0.12);
      const x = cx + cell.lx * sizeBoost;
      const y = cy + cell.ly * sizeBoost;
      // ADD glow
      this.glowGfx.beginFill(cell.color, alpha * 0.55);
      this.glowGfx.drawCircle(x, y, sz * 2.0);
      this.glowGfx.endFill();
      this.gfx.beginFill(cell.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }

    // 코로나 링 셀 (3 링 회전)
    for (const cell of this.coronaRingCells) {
      const ringR = CORONA_RING_R[cell.ringIdx] * sizeBoost;
      const speed = CORONA_SPEEDS[cell.ringIdx];
      const angle = cell.angleOffset + this.time * speed;
      const x = cx + Math.cos(angle) * ringR;
      const y = cy + Math.sin(angle) * ringR;
      const pulse = 0.72 + Math.sin(this.time * 0.17 + cell.pulse) * 0.28;
      const alpha = Math.min(1, baseAlpha * pulse);
      const sz = cell.size * sizeBoost * (0.85 + pulse * 0.15);

      this.glowGfx.beginFill(cell.color, alpha * 0.50);
      this.glowGfx.drawCircle(x, y, sz * 2.1);
      this.glowGfx.endFill();
      this.gfx.beginFill(cell.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  // ── 표면 플레어 (태양 중심 기준 로컬 좌표) ──
  private drawSurfaceFlares() {
    const cx = this.posX;
    const cy = this.posY - SUN_OFFSET_Y;
    for (const f of this.surfaceFlares) {
      const life = f.life / f.maxLife;
      const alpha = life;
      const sz = f.size * (0.65 + life * 0.35);
      const x = cx + f.x;
      const y = cy + f.y;

      this.glowGfx.beginFill(f.color, alpha * 0.50);
      this.glowGfx.drawCircle(x, y, sz * 2.0);
      this.glowGfx.endFill();
      this.gfx.beginFill(f.color, alpha);
      this.gfx.drawCircle(x, y, sz);
      this.gfx.endFill();
    }
  }

  // ── 플라즈마 웜 (사인 곡선 트레일, 번개 X) ──
  private drawPlasmaWorm(p: PlasmaWorm) {
    const pts = p.trailPts;
    // 트레일 2패스 (glow + core)
    if (pts.length >= 2) {
      for (let i = 0; i < pts.length - 1; i++) {
        const ageT = i / (pts.length - 1);
        const alpha = ageT * 0.88;
        const width = 3.0 + ageT * 4.5;
        // ADD glow (웜 색)
        this.glowGfx.lineStyle(width * 2.1, p.color, alpha * 0.52);
        this.glowGfx.moveTo(pts[i].x, pts[i].y);
        this.glowGfx.lineTo(pts[i + 1].x, pts[i + 1].y);
        // Core (yellow-300)
        this.gfx.lineStyle(width * 0.55, this.COL_YELLOW_300, alpha * 0.95);
        this.gfx.moveTo(pts[i].x, pts[i].y);
        this.gfx.lineTo(pts[i + 1].x, pts[i + 1].y);
      }
      this.gfx.lineStyle(0);
      this.glowGfx.lineStyle(0);
    }

    // 헤드 (2층)
    this.glowGfx.beginFill(p.color, 0.78);
    this.glowGfx.drawCircle(p.drawX, p.drawY, 11);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_YELLOW_300, 0.98);
    this.gfx.drawCircle(p.drawX, p.drawY, 3.5);
    this.gfx.endFill();
  }

  // ── 4패스 체인 볼트 (불 톤 + 전기 하이라이트) ──
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

    // 1) 외곽 글로우 (red-700)
    drawPath(this.glowGfx, 16, this.COL_RED_700, a * 0.28);
    // 2) 중간 글로우 (yellow-500)
    drawPath(this.glowGfx, 10, this.COL_YELLOW_500, a * 0.42);
    // 3) 메인 (yellow-300)
    drawPath(this.gfx, 4.5, this.COL_YELLOW_300, a * 0.9);
    // 4) 내심선 (sky-300 — 전기 identity)
    drawPath(this.gfx, 1.8, this.COL_SKY_300, a * 0.95);
  }

  // ── 링 펄스 (14셀 링) ──
  private drawRingPulse(r: RingPulse) {
    const life = r.life / r.maxLife;
    const t = 1 - life;
    const radius = 6 + t * (r.maxRadius - 6);
    const alpha = life * life;
    for (let i = 0; i < RING_SEGS; i++) {
      const angle = (i / RING_SEGS) * Math.PI * 2 + r.rotOffset + t * 0.55;
      const px = r.x + Math.cos(angle) * radius;
      const py = r.y + Math.sin(angle) * radius;
      const size = 2.8 * life;
      const col = this.RING_COLORS[(i + r.colorOffset + Math.floor(t * 8)) % this.RING_COLORS.length];
      this.glowGfx.beginFill(col, alpha * 0.58);
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
    this.glowGfx.beginFill(s.color, alpha * 0.48);
    this.glowGfx.drawCircle(s.x, s.y, sz * 2.3);
    this.glowGfx.endFill();
    this.gfx.beginFill(s.color, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  private drawEmber(e: Ember) {
    const life = e.life / e.maxLife;
    const alpha = life * 0.92;
    const sz = e.size * (0.7 + life * 0.3);
    // 라이프사이클 색 (yellow → orange → red)
    let color: number;
    if (life > 0.65) color = this.COL_YELLOW_400;
    else if (life > 0.35) color = this.COL_ORANGE_500;
    else color = this.COL_RED_600;

    this.glowGfx.beginFill(color, alpha * 0.48);
    this.glowGfx.drawCircle(e.x, e.y, sz * 1.9);
    this.glowGfx.endFill();
    this.gfx.beginFill(color, alpha);
    this.gfx.drawCircle(e.x, e.y, sz);
    this.gfx.endFill();
  }

  private drawSpark(s: Spark) {
    const life = s.life / s.maxLife;
    const alpha = life;
    const sz = s.size * (0.65 + life * 0.35);
    this.glowGfx.beginFill(this.COL_CYAN_300, alpha * 0.58);
    this.glowGfx.drawCircle(s.x, s.y, sz * 1.9);
    this.glowGfx.endFill();
    this.gfx.beginFill(this.COL_SKY_300, alpha);
    this.gfx.drawCircle(s.x, s.y, sz);
    this.gfx.endFill();
  }

  stop() {
    this.active = false;
    this.coreCells = [];
    this.coronaRingCells = [];
    this.surfaceFlares = [];
    this.plasmaWorms = [];
    this.chainLinks = [];
    this.ringPulses = [];
    this.shards = [];
    this.embers = [];
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
