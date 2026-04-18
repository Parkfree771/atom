import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+불+빛 3단계 — 무지개 장마 포격 (Rainbow Deluge)
 *
 * 컨셉: 캐릭터 머리 위 상시 **무지개 증기 구름대** — 내부에서 무지개 wisp가
 *        천천히 흐르고, 가끔 프리즘 번쩍임이 터짐. 구름 하단 5개 drip outlet에서
 *        색색의 **끓는 빗방울**이 쏟아져 내리며 **가장 가까운 적 방향으로 미세 호밍**.
 *        낙하 중 빗방울은 빨→주→노→초→파→남→보 색 순환, 뒤로 무지개 꼬리.
 *        적 히트 시 **수평 방사 증기 폭발** (파편 + 링 + 무지개 스파크).
 *
 * 3원소 정체성:
 *   💧 물 — 끓는 빗방울, 물방울 트레일, 히트 시 튀는 물방울
 *   🔥 불 — 구름 하단 뜨거운 열기(빨강/주황), 빗방울 코어 열광, 히트 증기 파편
 *   💡 빛 — 무지개 색 전이, 구름 내부 프리즘 wisp, 번쩍임, 히트 무지개 스파크
 *
 * 기둥 없음. 바닥형 매커니즘 (수평 방사 폭발).
 *
 * 좌표계: 월드 좌표 (effectLayer = worldContainer 자식).
 *   - 구름: player.x/y 기준 매 프레임 재계산 (캐릭터 추적)
 *   - 빗방울/임팩트: 월드 좌표 고정 (캐릭터 움직여도 그 자리)
 *
 * 엔진 연결:
 *   - start(x, y) / setPosition(x, y) — 캐릭터 추적
 *   - updateHoming(dt, enemies) — 빗방울 호밍 + 히트 감지 (rule 5)
 *   - hitsThisFrame(): {x, y, enemyIdx}[] — 엔진이 데미지 처리
 */

// ═══════════════════════════════════════════════════════════════
//  상수
// ═══════════════════════════════════════════════════════════════

const CLOUD_Y_OFFSET = -140;
const CLOUD_WIDTH = 260;
const CLOUD_HEIGHT = 58;

const RAIN_PER_SEC = 24;           // 더 촘촘한 폭우
const RAIN_FALL_SPEED = 2.0;       // 초기 수직 속도
const RAIN_MAX_SPEED = 7.0;        // 최대 낙하 속도 (차분한 유도)
const RAIN_GRAVITY = 0.08;
const RAIN_HOMING_BIAS = 0.085;    // 적 방향 lerp (또렷한 유도)
const RAIN_HOMING_RANGE = 520;     // 탐지 반경
const RAIN_MAX_LIFE = 150;         // 느려진 만큼 수명 연장
const RAIN_HIT_RADIUS = 26;
const RAIN_TRAIL_LEN = 7;
const RAIN_COLOR_CYCLE_SPEED = 0.035; // phase/frame

const NODE_MAX_TRAVEL = 120;       // rule 5

const IMPACT_MAX_AGE = 28;         // 폭발 수명 (f)
const IMPACT_SHARDS = 8;
const IMPACT_SPARKS = 6;
const IMPACT_DROPLETS = 5;
const IMPACT_RING_MAX_R = 62;

// ═══════════════════════════════════════════════════════════════
//  타입
// ═══════════════════════════════════════════════════════════════

/**
 * 구름 로브 — 적란운 볼륨감을 위한 로브 단위.
 * 로브마다 6-layer 셰이딩 (halo → shadow crescent → mid → inner → highlight → specular).
 * 광원은 좌상단 고정 (highlight offset: -0.28, -0.38 × r).
 */
interface CloudLobe {
  /** 캐릭터 머리 기준 로컬 offset */
  ox: number; oy: number;
  /** 반경 */
  r: number;
  /** 0(뒤/어둡게) ~ 1(앞/밝게) — 드로우 순서 + 하이라이트 강도 */
  depth: number;
  wobblePhase: number;
  wobbleSpeed: number;
}

interface Raindrop {
  /** 월드 좌표 */
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  size: number;
  /** 색 phase (시간 따라 순환) */
  colorPhase: number;
  /** 호밍 타겟 인덱스 (-1 = 호밍 없음) */
  targetIdx: number;
  /** rule 5: 마지막 안전 타겟 좌표 */
  lastTargetX: number;
  lastTargetY: number;
  /** 트레일 — 과거 프레임 위치 + 당시 색 */
  trail: { x: number; y: number; phase: number }[];
}

interface ImpactShard {
  vx: number; vy: number;
  size: number;
  colorIdx: number;
  /** 0 = 증기 파편 (열색), 1 = 무지개 스파크, 2 = 물방울 */
  kind: 0 | 1 | 2;
  life: number;
  maxLife: number;
}

interface Impact {
  /** 월드 좌표 */
  x: number; y: number;
  age: number;
  /** 시작 색 phase (빗방울이 낙하하던 색) */
  colorPhase: number;
  shards: ImpactShard[];
  /** 바닥에 남은 작은 무지개 얼룩 offset/phase */
  scorchPhase: number;
}

/** 적 못 맞추고 수명 소멸한 빗방울용 작은 스플래시 */
interface MissSplash {
  x: number; y: number;
  age: number;
  colorPhase: number;
  shards: ImpactShard[];
}

// ═══════════════════════════════════════════════════════════════
//  무지개 팔레트 + 색 lerp
// ═══════════════════════════════════════════════════════════════

const RAINBOW: number[] = [
  0xef4444, // 빨강 red-500
  0xf97316, // 주황 orange-500
  0xfacc15, // 노랑 yellow-400
  0x22c55e, // 초록 green-500
  0x3b82f6, // 파랑 blue-500
  0x6366f1, // 남색 indigo-500
  0xa855f7, // 보라 purple-500
];

/** 뜨거운 증기 톤 (하단 구름, 히트 파편) */
const HEAT_COLORS: number[] = [
  0xdc2626, // red-600
  0xf97316, // orange-500
  0xfb923c, // orange-400
  0xfbbf24, // amber-400
];

const DROPLET_COLOR = 0x38bdf8; // sky-400
const DROPLET_GLOW = 0x7dd3fc;  // sky-300

function rainbowLerp(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const i = p * 7;
  const idx = Math.floor(i) % 7;
  const next = (idx + 1) % 7;
  const t = i - Math.floor(i);
  const c1 = RAINBOW[idx];
  const c2 = RAINBOW[next];
  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;
  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return (r << 16) | (g << 8) | b;
}

// ═══════════════════════════════════════════════════════════════
//  메인 클래스
// ═══════════════════════════════════════════════════════════════

export class WaterFireLightEffect {
  private container: PIXI.Container;

  // ── 레이어 분리 ──
  /** ADD — 구름 바깥 halo + 내부 글로우 */
  private cloudGlow: PIXI.Graphics;
  /** NORMAL — 구름 blob 몸체 */
  private cloudBody: PIXI.Graphics;
  /** NORMAL — 구름 내부 wisp + 상단 puff */
  private cloudDetail: PIXI.Graphics;
  /** ADD — 빗방울 글로우 + 트레일 */
  private rainGlow: PIXI.Graphics;
  /** NORMAL — 빗방울 코어 */
  private rainCore: PIXI.Graphics;
  /** ADD — 임팩트 글로우 + 링 */
  private impactGlow: PIXI.Graphics;
  /** NORMAL — 임팩트 파편/코어 */
  private impactCore: PIXI.Graphics;

  active = false;
  private time = 0;

  // 캐릭터 위치 (월드)
  private playerX = 0;
  private playerY = 0;

  // 구름 로브 (시작 시 생성, 유지)
  private cloudLobes: CloudLobe[] = [];

  // 프리즘 번쩍임
  private flickerCooldown = 80;
  private flickerActive = 0;       // 0~10 (진행)
  private flickerColorPhase = 0;

  // 빗방울 spawn 타이머
  private spawnAcc = 0;

  // 풀
  private raindrops: Raindrop[] = [];
  private impacts: Impact[] = [];
  private missSplashes: MissSplash[] = [];

  // 엔진 히트 버퍼
  private hitsBuffer: { x: number; y: number; enemyIdx: number }[] = [];

  // 구름 drip outlet offsets (구름 하단 스폰 위치 후보)
  private readonly outletOffsets: number[] = [-104, -54, -8, 42, 96];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.cloudGlow = new PIXI.Graphics();
    this.cloudGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.cloudGlow);

    this.cloudBody = new PIXI.Graphics();
    this.container.addChild(this.cloudBody);

    this.cloudDetail = new PIXI.Graphics();
    this.container.addChild(this.cloudDetail);

    this.rainGlow = new PIXI.Graphics();
    this.rainGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.rainGlow);

    this.rainCore = new PIXI.Graphics();
    this.container.addChild(this.rainCore);

    this.impactGlow = new PIXI.Graphics();
    this.impactGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.impactGlow);

    this.impactCore = new PIXI.Graphics();
    this.container.addChild(this.impactCore);

    this.buildCloud();
  }

  private buildCloud() {
    // ── 손으로 배치한 적란운 로브 레이아웃 ──
    // 3단 타워 구조: 바닥(평평, 뒤/어둡) → 몸체(두툼) → 상단(뭉게뭉게 탑, 앞/밝)
    // depth: 0=뒤/어두움, 1=앞/밝음. 드로우 순서 + 하이라이트 강도에 영향.
    // 광원은 좌상단 고정 — 상단 로브가 가장 강한 highlight 받음.
    const layout: Array<{ ox: number; oy: number; r: number; depth: number }> = [
      // 바닥 가장자리 (평평, 뒤쪽 — 그림자 짙음)
      { ox: -132, oy: 14, r: 16, depth: 0.10 },
      { ox: -95, oy: 22, r: 24, depth: 0.15 },
      { ox: -42, oy: 26, r: 30, depth: 0.20 },
      { ox: 18, oy: 28, r: 32, depth: 0.22 },
      { ox: 72, oy: 24, r: 28, depth: 0.18 },
      { ox: 122, oy: 18, r: 20, depth: 0.12 },
      // 하단 몸체 (메인 바닥 bulk)
      { ox: -108, oy: 6, r: 22, depth: 0.30 },
      { ox: -66, oy: 10, r: 34, depth: 0.40 },
      { ox: -14, oy: 13, r: 42, depth: 0.48 },
      { ox: 42, oy: 12, r: 38, depth: 0.44 },
      { ox: 92, oy: 8, r: 28, depth: 0.36 },
      // 중단 몸체 (중심 bulk)
      { ox: -88, oy: -10, r: 26, depth: 0.52 },
      { ox: -36, oy: -12, r: 38, depth: 0.62 },
      { ox: 16, oy: -14, r: 40, depth: 0.66 },
      { ox: 66, oy: -10, r: 32, depth: 0.58 },
      { ox: 110, oy: -4, r: 22, depth: 0.48 },
      // 상단 뭉게 탑 (가장 밝게, 광원 직사)
      { ox: -58, oy: -32, r: 24, depth: 0.80 },
      { ox: -18, oy: -40, r: 32, depth: 0.95 }, // 최정점
      { ox: 28, oy: -36, r: 28, depth: 0.88 },
      { ox: 70, oy: -26, r: 22, depth: 0.76 },
      { ox: -92, oy: -22, r: 18, depth: 0.70 },
    ];

    for (const l of layout) {
      this.cloudLobes.push({
        ox: l.ox,
        oy: l.oy,
        r: l.r,
        depth: l.depth,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.012 + Math.random() * 0.012, // 느린 호흡
      });
    }

    // 뒤→앞 순서로 정렬 (depth 오름차순)
    this.cloudLobes.sort((a, b) => a.depth - b.depth);
  }

  // ═══════════════════════════════════════════════════════════
  //  외부 API
  // ═══════════════════════════════════════════════════════════

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.playerX = x;
    this.playerY = y;
    this.raindrops = [];
    this.impacts = [];
    this.missSplashes = [];
    this.hitsBuffer = [];
    this.flickerActive = 0;
    this.flickerCooldown = 80;
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.playerX = x;
    this.playerY = y;
  }

  /** 엔진이 프레임 시작에 호출 — 호밍/착지 판정. rule 5 내장. */
  updateHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    if (!this.active) return;
    this.hitsBuffer = [];

    // ── 빗방울별 타겟 재탐색 (없거나 죽었으면) + 호밍 lerp + 히트 체크 ──
    for (let i = this.raindrops.length - 1; i >= 0; i--) {
      const r = this.raindrops[i];

      // 타겟 유효성 체크 (rule 5)
      let target: { x: number; y: number } | null = null;
      if (r.targetIdx >= 0) {
        const e = enemies[r.targetIdx];
        if (e && e.active) {
          const dxn = e.x - r.lastTargetX;
          const dyn = e.y - r.lastTargetY;
          if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
            // 정상 — 갱신
            r.lastTargetX = e.x;
            r.lastTargetY = e.y;
            target = { x: e.x, y: e.y };
          } else {
            // 풀 재사용 의심 — 마지막 안전 좌표 사용, 타겟 드롭
            target = { x: r.lastTargetX, y: r.lastTargetY };
            r.targetIdx = -1;
          }
        } else {
          target = null;
          r.targetIdx = -1;
        }
      }
      // 타겟 없으면 범위 내 활성 적 중 랜덤 하나 (빗방울마다 다른 적 분산)
      if (!target) {
        const rangeSq = RAIN_HOMING_RANGE * RAIN_HOMING_RANGE;
        const candidates: number[] = [];
        for (let ei = 0; ei < enemies.length; ei++) {
          const e = enemies[ei];
          if (!e.active) continue;
          const dx = e.x - r.x;
          const dy = e.y - r.y;
          if (dx * dx + dy * dy <= rangeSq) {
            candidates.push(ei);
          }
        }
        if (candidates.length > 0) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          r.targetIdx = pick;
          r.lastTargetX = enemies[pick].x;
          r.lastTargetY = enemies[pick].y;
          target = { x: enemies[pick].x, y: enemies[pick].y };
        }
      }

      // 호밍 lerp
      if (target) {
        const dx = target.x - r.x;
        const dy = target.y - r.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const tvx = (dx / d) * RAIN_MAX_SPEED;
        const tvy = (dy / d) * RAIN_MAX_SPEED;
        r.vx += (tvx - r.vx) * RAIN_HOMING_BIAS * dt;
        r.vy += (tvy - r.vy) * RAIN_HOMING_BIAS * dt;
      } else {
        // 호밍 없음: 중력 낙하 (수직 비)
        r.vy = Math.min(r.vy + RAIN_GRAVITY * dt, RAIN_MAX_SPEED);
        if (r.vy < 1.0) r.vy = 1.0;
      }

      // 속도 크기 제한
      const sp = Math.sqrt(r.vx * r.vx + r.vy * r.vy);
      if (sp > RAIN_MAX_SPEED) {
        r.vx = (r.vx / sp) * RAIN_MAX_SPEED;
        r.vy = (r.vy / sp) * RAIN_MAX_SPEED;
      }

      // 트레일 push (현재 위치 + 색)
      r.trail.push({ x: r.x, y: r.y, phase: r.colorPhase });
      if (r.trail.length > RAIN_TRAIL_LEN) r.trail.shift();

      // 이동
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.life += dt;
      r.colorPhase += RAIN_COLOR_CYCLE_SPEED * dt;

      // 히트 판정 — 모든 활성 적 스캔
      let hit = false;
      for (let ei = 0; ei < enemies.length; ei++) {
        const e = enemies[ei];
        if (!e.active) continue;
        const ddx = e.x - r.x;
        const ddy = e.y - r.y;
        if (ddx * ddx + ddy * ddy <= RAIN_HIT_RADIUS * RAIN_HIT_RADIUS) {
          this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: ei });
          this.spawnImpact(e.x, e.y, r.colorPhase);
          hit = true;
          break;
        }
      }
      if (hit) {
        swapPop(this.raindrops, i);
        continue;
      }

      // 수명 만료 — 미스 스플래시 (데미지 X, 비주얼만)
      if (r.life >= RAIN_MAX_LIFE) {
        this.spawnMissSplash(r.x, r.y, r.colorPhase);
        swapPop(this.raindrops, i);
      }
    }
  }

  /** 엔진이 매 프레임 호출 — 이번 프레임 히트 리스트 소비 (1회용) */
  hitsThisFrame(): { x: number; y: number; enemyIdx: number }[] {
    return this.hitsBuffer;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트 (EffectManager가 호출, update(dt))
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // ── 번쩍임 ──
    if (this.flickerActive > 0) {
      this.flickerActive -= dt;
      if (this.flickerActive < 0) this.flickerActive = 0;
    } else {
      this.flickerCooldown -= dt;
      if (this.flickerCooldown <= 0) {
        this.flickerActive = 12;
        this.flickerColorPhase = Math.random();
        this.flickerCooldown = 90 + Math.random() * 120;
      }
    }

    // ── 빗방울 spawn ──
    this.spawnAcc += (RAIN_PER_SEC / 60) * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawnRaindrop();
    }

    // ── 임팩트 진행 ──
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      im.age += dt;
      for (const s of im.shards) {
        s.life += dt;
        // 마찰 감속
        s.vx *= 0.93;
        s.vy *= 0.93;
        // 물방울은 살짝 중력
        if (s.kind === 2) s.vy += 0.05 * dt;
      }
      if (im.age >= IMPACT_MAX_AGE) swapPop(this.impacts, i);
    }

    // ── 미스 스플래시 진행 ──
    for (let i = this.missSplashes.length - 1; i >= 0; i--) {
      const m = this.missSplashes[i];
      m.age += dt;
      for (const s of m.shards) {
        s.life += dt;
        s.vx *= 0.92;
        s.vy *= 0.92;
      }
      if (m.age >= 18) swapPop(this.missSplashes, i);
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  빗방울 spawn
  // ═══════════════════════════════════════════════════════════

  private spawnRaindrop() {
    // drip outlet 중 하나 선택
    const outletIdx = Math.floor(Math.random() * this.outletOffsets.length);
    const outletOx = this.outletOffsets[outletIdx] + (Math.random() - 0.5) * 10;
    // 구름 하단 살짝 아래서 시작
    const wx = this.playerX + outletOx;
    const wy = this.playerY + CLOUD_Y_OFFSET + CLOUD_HEIGHT * 0.45 + Math.random() * 6;
    // 색 phase = outlet에 따라 다른 시작점 (시각적 스펙트럼 효과)
    const colorPhase = (outletIdx / this.outletOffsets.length) + Math.random() * 0.12;

    this.raindrops.push({
      x: wx, y: wy,
      vx: (Math.random() - 0.5) * 0.6,
      vy: RAIN_FALL_SPEED + Math.random() * 0.6,
      life: 0,
      size: 2.3 + Math.random() * 1.0,
      colorPhase,
      targetIdx: -1,
      lastTargetX: 0, lastTargetY: 0,
      trail: [],
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  임팩트 spawn (적 히트)
  // ═══════════════════════════════════════════════════════════

  private spawnImpact(wx: number, wy: number, colorPhase: number) {
    const shards: ImpactShard[] = [];
    // 증기 파편 8 (뜨거운 열색, 위쪽 편향)
    for (let i = 0; i < IMPACT_SHARDS; i++) {
      const a = (i / IMPACT_SHARDS) * Math.PI * 2 + Math.random() * 0.25;
      const sp = 2.2 + Math.random() * 1.4;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.8, // 위쪽 편향 (증기)
        size: 2.2 + Math.random() * 1.4,
        colorIdx: Math.floor(Math.random() * HEAT_COLORS.length),
        kind: 0,
        life: 0,
        maxLife: 18 + Math.random() * 6,
      });
    }
    // 무지개 스파크 6 (사방)
    for (let i = 0; i < IMPACT_SPARKS; i++) {
      const a = (i / IMPACT_SPARKS) * Math.PI * 2 + Math.PI / IMPACT_SPARKS;
      const sp = 3.0 + Math.random() * 1.8;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.3,
        size: 1.4 + Math.random() * 0.7,
        colorIdx: i % 7,
        kind: 1,
        life: 0,
        maxLife: 14 + Math.random() * 6,
      });
    }
    // 물방울 5 (사방, 중력)
    for (let i = 0; i < IMPACT_DROPLETS; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * 1.2;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.2, // 위로 튐
        size: 1.2 + Math.random() * 0.6,
        colorIdx: 0,
        kind: 2,
        life: 0,
        maxLife: 16 + Math.random() * 6,
      });
    }
    this.impacts.push({
      x: wx, y: wy,
      age: 0,
      colorPhase,
      shards,
      scorchPhase: colorPhase + 0.15,
    });
  }

  /** 적 못 맞춘 빗방울 — 작은 파편만, 데미지 X */
  private spawnMissSplash(wx: number, wy: number, colorPhase: number) {
    const shards: ImpactShard[] = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.0 + Math.random() * 0.8;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.5,
        size: 1.1 + Math.random() * 0.5,
        colorIdx: i % 7,
        kind: 1,
        life: 0,
        maxLife: 10 + Math.random() * 4,
      });
    }
    this.missSplashes.push({ x: wx, y: wy, age: 0, colorPhase, shards });
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.cloudGlow.clear();
    this.cloudBody.clear();
    this.cloudDetail.clear();
    this.rainGlow.clear();
    this.rainCore.clear();
    this.impactGlow.clear();
    this.impactCore.clear();

    this.drawCloud();
    this.drawRaindrops();
    this.drawImpacts();
    this.drawMissSplashes();
  }

  // ───────────────────────────────────────────────────────────
  //  구름 (월드 좌표, player 기준)
  // ───────────────────────────────────────────────────────────

  private drawCloud() {
    const cx = this.playerX;
    const cy = this.playerY + CLOUD_Y_OFFSET;

    // ═════════════════════════════════════════════════════════
    //  광원 방향: 좌상단 (upper-left), 그림자: 우하단 (lower-right)
    //  highlight offset = -0.28, -0.38 × r  (화면 기준 좌상단 방향)
    //  shadow offset    = +0.22, +0.30 × r  (우하단)
    // ═════════════════════════════════════════════════════════

    // ── (A) 전역 드롭섀도우 — 구름 아래쪽에 부드러운 슬레이트 기초 ──
    // 적란운의 "평평한 바닥" + 아래쪽 응달 느낌
    this.cloudBody.beginFill(0x64748b, 0.14); // slate-500
    this.cloudBody.drawEllipse(cx + 6, cy + 28, CLOUD_WIDTH * 0.50, CLOUD_HEIGHT * 0.34);
    this.cloudBody.endFill();
    this.cloudBody.beginFill(0x475569, 0.08); // slate-600 (더 아래)
    this.cloudBody.drawEllipse(cx + 10, cy + 34, CLOUD_WIDTH * 0.42, CLOUD_HEIGHT * 0.20);
    this.cloudBody.endFill();

    // ── (B) 로브별 6-layer 셰이딩 — 뒤→앞 순서 ──
    for (const l of this.cloudLobes) {
      l.wobblePhase += l.wobbleSpeed;
      const wob = 1 + Math.sin(l.wobblePhase) * 0.035; // 느린 호흡
      const x = cx + l.ox;
      const y = cy + l.oy;
      const r = l.r * wob;

      // depth 기반 톤 — 뒤쪽은 어두운 slate, 앞쪽은 밝은 흰색
      // base: slate-300 (back) → slate-100 (front)
      const baseR = Math.round(226 + (248 - 226) * l.depth); // 226→248
      const baseG = Math.round(232 + (250 - 232) * l.depth); // 232→250
      const baseB = Math.round(240 + (252 - 240) * l.depth); // 240→252
      const baseColor = (baseR << 16) | (baseG << 8) | baseB;

      // 1. 외곽 soft halo (경계 부드럽게, 퍼진 fuzz) — 2겹
      this.cloudBody.beginFill(0xe2e8f0, 0.14); // slate-200
      this.cloudBody.drawCircle(x, y, r * 1.42);
      this.cloudBody.endFill();
      this.cloudBody.beginFill(0xf1f5f9, 0.22); // slate-100
      this.cloudBody.drawCircle(x, y, r * 1.18);
      this.cloudBody.endFill();

      // 2. 그림자 crescent (우하단 offset, 로브 뒤편 응달)
      // — slate-500 색, 본체보다 살짝 작음, offset 덕분에 아래쪽만 삐져나옴
      const shadowStrength = 0.32 + (1 - l.depth) * 0.14; // 뒤쪽일수록 진함
      this.cloudBody.beginFill(0x64748b, shadowStrength); // slate-500
      this.cloudBody.drawCircle(x + r * 0.22, y + r * 0.30, r * 0.92);
      this.cloudBody.endFill();

      // 3. 중간 몸체 (본체) — depth에 따라 밝기 변화
      this.cloudBody.beginFill(baseColor, 0.88);
      this.cloudBody.drawCircle(x, y, r);
      this.cloudBody.endFill();

      // 4. 내부 밝은 zone (좌상단 offset, 본체 안 주광면) — 넓고 흐릿
      this.cloudBody.beginFill(0xf8fafc, 0.65); // near-white
      this.cloudBody.drawCircle(x - r * 0.12, y - r * 0.16, r * 0.78);
      this.cloudBody.endFill();

      // 5. 하이라이트 (좌상단 offset 더 크게, 주광면 peak) — 밝게
      const hlAlpha = 0.45 + l.depth * 0.30; // 앞쪽일수록 강함
      this.cloudDetail.beginFill(0xffffff, hlAlpha);
      this.cloudDetail.drawCircle(x - r * 0.28, y - r * 0.34, r * 0.54);
      this.cloudDetail.endFill();

      // 6. 스펙큘러 (tiny 최고점, 순백) — 상단 로브만 강하게
      if (l.depth > 0.55) {
        const spA = 0.70 + l.depth * 0.25;
        this.cloudDetail.beginFill(0xffffff, spA);
        this.cloudDetail.drawCircle(x - r * 0.40, y - r * 0.44, r * 0.22);
        this.cloudDetail.endFill();
      }
    }

    // ── (C) 전역 상단 림 하이라이트 (광원 사선에서 구름 상부 전체에 살짝 밝은 띠) ──
    this.cloudDetail.beginFill(0xffffff, 0.16);
    this.cloudDetail.drawEllipse(cx - 14, cy - 30, CLOUD_WIDTH * 0.42, CLOUD_HEIGHT * 0.26);
    this.cloudDetail.endFill();
    this.cloudDetail.beginFill(0xfef9c3, 0.10); // amber-50 (아주 살짝 따뜻)
    this.cloudDetail.drawEllipse(cx - 18, cy - 34, CLOUD_WIDTH * 0.32, CLOUD_HEIGHT * 0.18);
    this.cloudDetail.endFill();

    // ── (D) 전역 바닥 응달 (구름 아래쪽 톤 다운) ──
    this.cloudBody.beginFill(0x475569, 0.18); // slate-600
    this.cloudBody.drawEllipse(cx + 8, cy + 22, CLOUD_WIDTH * 0.40, CLOUD_HEIGHT * 0.18);
    this.cloudBody.endFill();

    // ── (E) drip outlet (무지개 스폰 힌트 — 정체성 유지, 매우 작고 은근) ──
    // 구름 하단 살짝 뒤에 5개, 무지개 맥동
    for (const offX of this.outletOffsets) {
      const wx = cx + offX;
      const wy = cy + CLOUD_HEIGHT * 0.36;
      const pulse = 0.55 + Math.sin(this.time * 0.13 + offX * 0.035) * 0.45;
      const color = rainbowLerp(this.time * 0.009 + offX * 0.004);

      // 작은 무지개 글로우 (ADD)
      this.cloudGlow.beginFill(color, 0.42 * pulse);
      this.cloudGlow.drawCircle(wx, wy, 5.5);
      this.cloudGlow.endFill();
      // 미세 코어 (NORMAL) — 터질 것 같은 드립 물방울
      this.cloudDetail.beginFill(color, 0.80 * pulse);
      this.cloudDetail.drawCircle(wx, wy, 1.4 + pulse * 0.6);
      this.cloudDetail.endFill();
      // 백색 하이라이트
      this.cloudDetail.beginFill(0xffffff, 0.85 * pulse);
      this.cloudDetail.drawCircle(wx - 0.5, wy - 0.5, 0.7);
      this.cloudDetail.endFill();
    }

    // ── (F) 프리즘 번쩍임 (2~4초 간격 subtle flicker — 구름 상단에만) ──
    if (this.flickerActive > 0) {
      const f = this.flickerActive / 12;
      // 구름 상단만 밝게 (전체 섬광 X, 광원 쪽 국소 brighten)
      this.cloudGlow.beginFill(0xffffff, 0.28 * f);
      this.cloudGlow.drawEllipse(cx - 12, cy - 28, CLOUD_WIDTH * 0.32 * f, CLOUD_HEIGHT * 0.22 * f);
      this.cloudGlow.endFill();
      // 3~4개 작은 무지개 점 (drip outlet 위치에 근접)
      for (let i = 0; i < 4; i++) {
        const color = rainbowLerp(this.flickerColorPhase + i / 4);
        const offX = (i - 1.5) * 44 + (Math.random() - 0.5) * 10;
        const offY = -6 + (Math.random() - 0.5) * 16;
        this.cloudGlow.beginFill(color, 0.45 * f);
        this.cloudGlow.drawCircle(cx + offX, cy + offY, 9 * f);
        this.cloudGlow.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  빗방울 (월드 좌표)
  // ───────────────────────────────────────────────────────────

  private drawRaindrops() {
    for (const r of this.raindrops) {
      const headColor = rainbowLerp(r.colorPhase);

      // ── 트레일 (연속 세그먼트, 과거 색 그대로) ──
      if (r.trail.length > 1) {
        for (let i = 0; i < r.trail.length - 1; i++) {
          const p1 = r.trail[i];
          const p2 = r.trail[i + 1];
          const ageFrac = (i + 1) / r.trail.length; // 오래될수록 0에 가까움 → 어두움/얇음
          const segColor = rainbowLerp(p1.phase);
          const width = 0.6 + ageFrac * (r.size * 1.4);
          const alpha = ageFrac * 0.85;
          // 외곽 글로우 (ADD)
          this.rainGlow.lineStyle(width * 2.2, segColor, alpha * 0.55);
          this.rainGlow.moveTo(p1.x, p1.y);
          this.rainGlow.lineTo(p2.x, p2.y);
          this.rainGlow.lineStyle(0);
        }
        // 트레일 마지막 → 현재 위치 (가장 진함)
        const last = r.trail[r.trail.length - 1];
        this.rainGlow.lineStyle(r.size * 1.8, headColor, 0.75);
        this.rainGlow.moveTo(last.x, last.y);
        this.rainGlow.lineTo(r.x, r.y);
        this.rainGlow.lineStyle(0);
        // 코어 심선 (NORMAL)
        this.rainCore.lineStyle(r.size * 0.5, 0xffffff, 0.75);
        this.rainCore.moveTo(last.x, last.y);
        this.rainCore.lineTo(r.x, r.y);
        this.rainCore.lineStyle(0);
      }

      // ── 헤드 — 물방울 모양 (teardrop: 회전된 타원 + 작은 꼬리) ──
      const vLen = Math.sqrt(r.vx * r.vx + r.vy * r.vy) || 1;
      const angle = Math.atan2(r.vy, r.vx);

      // 외곽 글로우 halo (ADD, 진행 방향 길게)
      this.rainGlow.beginFill(headColor, 0.55);
      this.drawRotatedEllipse(this.rainGlow, r.x, r.y, r.size * 2.8, r.size * 1.6, angle);
      this.rainGlow.endFill();

      // 2차 외곽 (시안, 물 정체성)
      this.rainGlow.beginFill(DROPLET_GLOW, 0.30);
      this.drawRotatedEllipse(this.rainGlow, r.x, r.y, r.size * 3.6, r.size * 1.9, angle);
      this.rainGlow.endFill();

      // 본체 (NORMAL) — 무지개 코어
      this.rainCore.beginFill(headColor, 0.96);
      this.drawRotatedEllipse(this.rainCore, r.x, r.y, r.size * 1.5, r.size * 0.95, angle);
      this.rainCore.endFill();

      // 안쪽 밝은 링 (물방울 인상)
      this.rainCore.beginFill(0xfef9c3, 0.65);
      this.drawRotatedEllipse(this.rainCore, r.x - Math.cos(angle) * r.size * 0.1, r.y - Math.sin(angle) * r.size * 0.1, r.size * 0.85, r.size * 0.55, angle);
      this.rainCore.endFill();

      // 머리(진행 방향) 백색 하이라이트
      const hx = r.x + Math.cos(angle) * r.size * 0.6;
      const hy = r.y + Math.sin(angle) * r.size * 0.6;
      this.rainCore.beginFill(0xffffff, 0.90);
      this.rainCore.drawCircle(hx, hy, r.size * 0.45);
      this.rainCore.endFill();
    }
  }

  private drawRotatedEllipse(
    g: PIXI.Graphics,
    cx: number, cy: number,
    rx: number, ry: number,
    angle: number,
  ) {
    // Pixi는 rotate된 ellipse가 없어서 polygon 근사
    const seg = 14;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const pts: number[] = [];
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const lx = Math.cos(t) * rx;
      const ly = Math.sin(t) * ry;
      const wx = cx + lx * cosA - ly * sinA;
      const wy = cy + lx * sinA + ly * cosA;
      pts.push(wx, wy);
    }
    g.drawPolygon(pts);
  }

  // ───────────────────────────────────────────────────────────
  //  임팩트 (적 히트 폭발)
  // ───────────────────────────────────────────────────────────

  private drawImpacts() {
    for (const im of this.impacts) {
      const ageFrac = im.age / IMPACT_MAX_AGE;
      const eased = 1 - Math.pow(1 - ageFrac, 3);

      // ── 중앙 백색 플래시 (첫 5f 강렬) ──
      if (im.age < 7) {
        const flashT = 1 - im.age / 7;
        // 백색 코어
        this.impactGlow.beginFill(0xffffff, 0.85 * flashT);
        this.impactGlow.drawCircle(im.x, im.y, 22 * flashT);
        this.impactGlow.endFill();
        // 무지개 코어
        this.impactGlow.beginFill(rainbowLerp(im.colorPhase), 0.55 * flashT);
        this.impactGlow.drawCircle(im.x, im.y, 38 * flashT);
        this.impactGlow.endFill();
        // 코어 점
        this.impactCore.beginFill(0xffffff, flashT);
        this.impactCore.drawCircle(im.x, im.y, 7 * flashT);
        this.impactCore.endFill();
      }

      // ── 팽창 링 2겹 (얇은 무지개 + 붉은 코로나) ──
      const ringR = IMPACT_RING_MAX_R * eased;
      const ringAlpha = 1 - ageFrac;

      // 코로나 (붉은, 바깥)
      this.impactGlow.lineStyle(4 * (1 - ageFrac * 0.6), 0xb91c1c, 0.45 * ringAlpha);
      this.impactGlow.drawCircle(im.x, im.y, ringR * 1.08);
      this.impactGlow.lineStyle(0);

      // 무지개 링 (순환 컬러)
      this.impactGlow.lineStyle(2.5 * (1 - ageFrac * 0.5), rainbowLerp(im.colorPhase + ageFrac * 0.5), 0.85 * ringAlpha);
      this.impactGlow.drawCircle(im.x, im.y, ringR);
      this.impactGlow.lineStyle(0);

      // 가장 안쪽 백색 링 (첫 절반만)
      if (ageFrac < 0.5) {
        const innerA = 1 - ageFrac / 0.5;
        this.impactCore.lineStyle(1.8 * innerA, 0xffffff, 0.75 * innerA);
        this.impactCore.drawCircle(im.x, im.y, ringR * 0.62);
        this.impactCore.lineStyle(0);
      }

      // ── 파편 ──
      for (const s of im.shards) {
        const sAgeFrac = s.life / s.maxLife;
        if (sAgeFrac >= 1) continue;
        const sx = im.x + s.vx * s.life;
        const sy = im.y + s.vy * s.life;
        const a = 1 - sAgeFrac;
        const sz = s.size * (1 - sAgeFrac * 0.5);

        if (s.kind === 0) {
          // 증기 파편 — 뜨거운 색, 위로 상승 (수명 따라 색 냉각)
          const color = sAgeFrac < 0.3 ? HEAT_COLORS[0]
                      : sAgeFrac < 0.55 ? HEAT_COLORS[1]
                      : sAgeFrac < 0.80 ? HEAT_COLORS[2]
                      : HEAT_COLORS[3];
          this.impactGlow.beginFill(color, a * 0.55);
          this.impactGlow.drawCircle(sx, sy, sz * 2.3);
          this.impactGlow.endFill();
          this.impactCore.beginFill(color, a * 0.92);
          this.impactCore.drawCircle(sx, sy, sz);
          this.impactCore.endFill();
        } else if (s.kind === 1) {
          // 무지개 스파크 — 긴 꼬리
          const color = RAINBOW[s.colorIdx];
          // 꼬리
          const tailX = sx - s.vx * 3;
          const tailY = sy - s.vy * 3;
          this.impactGlow.lineStyle(sz * 1.4, color, a * 0.75);
          this.impactGlow.moveTo(tailX, tailY);
          this.impactGlow.lineTo(sx, sy);
          this.impactGlow.lineStyle(0);
          // 헤드
          this.impactGlow.beginFill(color, a * 0.7);
          this.impactGlow.drawCircle(sx, sy, sz * 1.8);
          this.impactGlow.endFill();
          this.impactCore.beginFill(0xffffff, a * 0.85);
          this.impactCore.drawCircle(sx, sy, sz * 0.6);
          this.impactCore.endFill();
        } else {
          // 물방울 — 시안, 작은 원 + 하이라이트
          this.impactGlow.beginFill(DROPLET_GLOW, a * 0.55);
          this.impactGlow.drawCircle(sx, sy, sz * 1.9);
          this.impactGlow.endFill();
          this.impactCore.beginFill(DROPLET_COLOR, a * 0.95);
          this.impactCore.drawCircle(sx, sy, sz);
          this.impactCore.endFill();
          this.impactCore.beginFill(0xffffff, a * 0.8);
          this.impactCore.drawCircle(sx - sz * 0.3, sy - sz * 0.3, sz * 0.35);
          this.impactCore.endFill();
        }
      }
    }
  }

  // ── 미스 스플래시 (데미지 없는 소형 파편) ──
  private drawMissSplashes() {
    for (const m of this.missSplashes) {
      const frac = m.age / 18;
      const ringA = 1 - frac;
      // 작은 ring
      this.impactGlow.lineStyle(1.4 * ringA, rainbowLerp(m.colorPhase), 0.6 * ringA);
      this.impactGlow.drawCircle(m.x, m.y, 8 + 14 * frac);
      this.impactGlow.lineStyle(0);
      // 파편
      for (const s of m.shards) {
        const sAgeFrac = s.life / s.maxLife;
        if (sAgeFrac >= 1) continue;
        const sx = m.x + s.vx * s.life;
        const sy = m.y + s.vy * s.life;
        const a = 1 - sAgeFrac;
        const color = RAINBOW[s.colorIdx];
        this.impactGlow.beginFill(color, a * 0.55);
        this.impactGlow.drawCircle(sx, sy, s.size * 1.4);
        this.impactGlow.endFill();
        this.impactCore.beginFill(color, a * 0.85);
        this.impactCore.drawCircle(sx, sy, s.size * 0.6);
        this.impactCore.endFill();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.raindrops = [];
    this.impacts = [];
    this.missSplashes = [];
    this.hitsBuffer = [];
    this.cloudGlow.clear();
    this.cloudBody.clear();
    this.cloudDetail.clear();
    this.rainGlow.clear();
    this.rainCore.clear();
    this.impactGlow.clear();
    this.impactCore.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
