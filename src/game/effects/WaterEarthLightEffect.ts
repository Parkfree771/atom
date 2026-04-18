import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+흙+빛 3단계 — 사구아로 선인장 (Saguaro Sentinel)
 *
 * 컨셉: **설치형** — 첫 활성 시 플레이어 위치에 선인장이 솟아오름. 그 자리 고정.
 *        사구아로 선인장 (T자형 두 팔), 사막 모래 base, 가시(spine) 30+ 위치에서
 *        **시안/금색 유도 레이저**가 촥촥촥촥 빠르게 발사. 가까운 적 자동 추적.
 *        피격 시 시안 물방울 + 금색 빛 파편 + 백색 스파크 호화 폭발.
 *
 * 3원소 정체성:
 *   💧 물 — 시안/sky 레이저 외곽, 피격 물방울 (sky-400/cyan-300), 정상 부 cyan 꽃잎
 *   🌍 흙 — 선인장 본체 (그린 셰이딩), 사막 모래 base + 자갈 + 모래알, 가시 (amber)
 *   ✨ 빛 — 금색 레이저 코어, 백색 심선, 피격 yellow shard, 정상 백색 꽃 + 노란 수술
 *
 * 디자인 우선순위 (사용자: "선인장 디자인 진짜 중요"):
 *   - 사구아로 형태 (사막 영화 클래식): 기둥 + T자 두 팔 + 둥근 정상
 *   - 7겹 셰이딩: 외곽선 → 다크 → 베이스 → 라이트 stripe → 브라이트 catch
 *   - 5개 vertical ridge per 부분 (세로 골)
 *   - 가시 클러스터 (3겹 fan, dark amber→cream tip)
 *   - 정상 꽃 (sky/cyan 꽃잎 + yellow 수술 + white 하이라이트)
 *
 * 게임플레이:
 *   - 설치 후 영구 (combo 활성 동안)
 *   - 13발/초 빠른 격발 (촥촥촥촥)
 *   - 호밍 lerp 0.18 (강한 추적, 빠른 명중)
 *   - 600px 사거리, 22 데미지/발 (DPS ~286)
 *
 * 좌표계: 월드 (effectLayer = worldContainer 자식). 모든 요소 anchor(설치 지점) 기준.
 */

// ═══════════════════════════════════════════════════════════════
//  상수
// ═══════════════════════════════════════════════════════════════

const SAND_RADIUS = 95;            // 모래 base 외곽
const NODE_MAX_TRAVEL = 120;       // rule 5

// ── LASER (멀리, 정상 꽃에서 발사 — 큰 호밍 빔) ──
const LASER_RANGE_MIN = 200;       // 이거리 이상이 "멀리" (우선 타겟)
const LASER_RANGE_MAX = 700;       // 탐지 사거리
const LASER_RANGE_MAX_SQ = LASER_RANGE_MAX * LASER_RANGE_MAX;
const LASER_RANGE_MIN_SQ = LASER_RANGE_MIN * LASER_RANGE_MIN;
const LASER_FIRE_RATE = 7;         // /s (5 flower 분산 → 약 1.4/s/flower)
const LASER_SPEED = 9.5;
const LASER_HOMING_BIAS = 0.20;
const LASER_HIT_RADIUS = 18;
const LASER_HIT_RADIUS_SQ = LASER_HIT_RADIUS * LASER_HIT_RADIUS;
const LASER_MAX_LIFE = 75;
const LASER_TRAIL_LEN = 7;
const LASER_DAMAGE = 32;

// ── NEEDLE (가까이, 가시 끝에서 발사 — 차분한 dart) ──
const NEEDLE_RANGE = 180;          // 가시별 탐지 반경 (좁힘)
const NEEDLE_RANGE_SQ = NEEDLE_RANGE * NEEDLE_RANGE;
const NEEDLE_SPEED = 6.5;          // 차분한 속도 (12 → 6.5)
const NEEDLE_HOMING_BIAS = 0.10;
const NEEDLE_HIT_RADIUS = 12;
const NEEDLE_HIT_RADIUS_SQ = NEEDLE_HIT_RADIUS * NEEDLE_HIT_RADIUS;
const NEEDLE_MAX_LIFE = 45;        // 속도 느려진 만큼 수명 연장
const NEEDLE_TRAIL_LEN = 4;
const NEEDLE_DAMAGE = 12;          // 발사 빈도 줄어든 만큼 데미지 살짝 ↑
const NEEDLE_COOLDOWN_BASE = 75;   // 가시당 발사 쿨 (28 → 75, 1.25초)
const NEEDLE_COOLDOWN_VAR = 25;    // 변동 ±0.4s (분산 stagger)

// ── 가시 형상 ──
const SPINE_FAN_SPREAD = 0.42;     // 가시 fan 각도
const SPINE_CENTER_LEN = 9;        // 중앙 가시 길이 (= needle 발사점)
const SPINE_SIDE_LEN = 6.5;        // 양옆 가시 길이

// ═══════════════════════════════════════════════════════════════
//  타입
// ═══════════════════════════════════════════════════════════════

interface CactusPart {
  /** local 좌표 (anchor 기준), 캡슐의 두 endpoint */
  x1: number; y1: number;
  x2: number; y2: number;
  width: number;
}

interface SpineLauncher {
  /** local pos */
  x: number; y: number;
  /** outward direction (laser 발사 방향) */
  outAngle: number;
}

interface Laser {
  /** 월드 좌표 */
  x: number; y: number;
  vx: number; vy: number;
  trail: { x: number; y: number }[];
  /** 호밍 타겟 (rule 5) */
  targetIdx: number;
  lastTargetX: number;
  lastTargetY: number;
  life: number;
}

interface Needle {
  /** 월드 좌표 */
  x: number; y: number;
  vx: number; vy: number;
  trail: { x: number; y: number }[];
  targetIdx: number;
  lastTargetX: number;
  lastTargetY: number;
  life: number;
}

interface FlowerLauncher {
  /** local 좌표 (anchor 기준) */
  x: number; y: number;
  /** 외부 방향 (꽃 axis) */
  outAngle: number;
}

interface ImpactShard {
  vx: number; vy: number;
  size: number;
  life: number;
  maxLife: number;
  /** 0=cyan droplet / 1=yellow shard with tail / 2=white spark / 3=blue droplet (gravity) */
  kind: 0 | 1 | 2 | 3;
}

interface Impact {
  /** 월드 */
  x: number; y: number;
  age: number;
  shards: ImpactShard[];
}

interface Pebble {
  ox: number; oy: number;
  r: number;
  color: number;
}

interface SandGrain {
  ox: number; oy: number;
  alpha: number;
  size: number;
}

/** 바람에 의해 형성된 dune ripple — 고운 사막 정체성 */
interface SandRipple {
  /** 호 시작 점 */
  x1: number; y1: number;
  /** 호 끝 점 */
  x2: number; y2: number;
  /** 호 굽음 정도 (위쪽으로 부풀림) */
  curve: number;
  alpha: number;
  /** 두께 */
  width: number;
}

// ═══════════════════════════════════════════════════════════════
//  팔레트
// ═══════════════════════════════════════════════════════════════

// 선인장 그린 (7단계)
const CACTUS_DEEP = 0x052e16;       // green-950 외곽선
const CACTUS_DARK = 0x14532d;       // green-900
const CACTUS_BASE = 0x166534;       // green-800 본체
const CACTUS_MID = 0x15803d;        // green-700
const CACTUS_LIGHT = 0x16a34a;      // green-600 (밝은 stripe)
const CACTUS_BRIGHT = 0x22c55e;     // green-500 (catch)
const CACTUS_SHEEN = 0x4ade80;      // green-400 (top sheen)

// 가시 (amber 톤)
const SPINE_BASE_COL = 0xb45309;    // amber-700 (어두운 base)
const SPINE_MID = 0xfde68a;         // amber-200
const SPINE_TIP = 0xfffbeb;         // amber-50

// 모래 사막
const SAND_OUTER = 0xfef3c7;        // amber-100
const SAND_MID_COL = 0xfde68a;      // amber-200
const SAND_DARK = 0xfcd34d;         // amber-300
const SAND_DEEPER = 0xf59e0b;       // amber-500
const SAND_PEBBLE_DARK = 0x92400e;  // amber-800 (자갈)
const SAND_PEBBLE_LIGHT = 0xd97706; // amber-600
const SAND_GRAIN_COL = 0xfffbeb;    // amber-50

// 꽃 (정상, water+light)
const FLOWER_OUTER = 0xbae6fd;      // sky-200 외곽 꽃잎
const FLOWER_MID = 0x67e8f9;        // cyan-300 (subtle)
const FLOWER_WHITE = 0xf8fafc;      // 거의 흰 petal
const FLOWER_YELLOW = 0xfef08a;     // yellow-200 수술

// 레이저 (멀리, 꽃 발사) — 파란 빔 (water + light core)
const LASER_OUTER_COL = 0x38bdf8;   // sky-400 외곽
const LASER_MID_COL = 0x7dd3fc;     // sky-300
const LASER_INNER = 0xfef9c3;       // yellow-100 (warm core)
const LASER_CORE = 0xffffff;

// Needle (가시에서 발사) — 가시(spine) 색 그대로 사용 (cactus identity 통일)
// SPINE_BASE_COL #b45309 (amber-700) + SPINE_MID #fde68a (amber-200) + SPINE_TIP #fffbeb 사용

// 피격 효과
const IMPACT_CYAN = 0x67e8f9;
const IMPACT_GOLD = 0xfde047;       // yellow-300
const IMPACT_AMBER = 0xfacc15;      // yellow-400
const IMPACT_DROP_BLUE = 0x2563eb;  // blue-600
const IMPACT_DROP_SKY = 0x38bdf8;   // sky-400

// ═══════════════════════════════════════════════════════════════
//  사구아로 선인장 형상 (local 좌표, anchor=base 중심)
//  T자형: 기둥 + 좌 horizontal+vertical 팔 + 우 horizontal+vertical 팔
// ═══════════════════════════════════════════════════════════════

const CACTUS_PARTS: CactusPart[] = [
  // 메인 기둥 (가장 큼)
  { x1: 0, y1: -10, x2: 0, y2: -200, width: 42 },
  // 좌 팔: horizontal 부분 (몸통에서 옆으로)
  { x1: -2, y1: -90, x2: -58, y2: -90, width: 28 },
  // 좌 팔: vertical 부분 (위로)
  { x1: -58, y1: -90, x2: -58, y2: -165, width: 26 },
  // 우 팔: horizontal (살짝 더 높게)
  { x1: 2, y1: -110, x2: 54, y2: -110, width: 26 },
  // 우 팔: vertical
  { x1: 54, y1: -110, x2: 54, y2: -158, width: 24 },
];

// ═══════════════════════════════════════════════════════════════
//  헬퍼: 캡슐 그리기 (rectangle + 2 caps)
// ═══════════════════════════════════════════════════════════════

function drawCapsule(
  g: PIXI.Graphics,
  x1: number, y1: number,
  x2: number, y2: number,
  width: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  g.moveTo(x1 + nx, y1 + ny);
  g.lineTo(x2 + nx, y2 + ny);
  g.lineTo(x2 - nx, y2 - ny);
  g.lineTo(x1 - nx, y1 - ny);
  g.closePath();
  g.drawCircle(x1, y1, width / 2);
  g.drawCircle(x2, y2, width / 2);
}

// ═══════════════════════════════════════════════════════════════
//  메인 클래스
// ═══════════════════════════════════════════════════════════════

export class WaterEarthLightEffect {
  private container: PIXI.Container;

  // ── 레이어 (아래→위) ──
  /** 사막 모래 base */
  private groundGfx: PIXI.Graphics;
  /** 선인장 드롭섀도우 */
  private shadowGfx: PIXI.Graphics;
  /** 외곽선 (가장 어두운 그린) */
  private outlineGfx: PIXI.Graphics;
  /** 본체 (다크 + 베이스 그린) */
  private bodyGfx: PIXI.Graphics;
  /** 좌측 highlight stripe + bright catch */
  private highlightGfx: PIXI.Graphics;
  /** 세로 ridges (5/part) */
  private ridgeGfx: PIXI.Graphics;
  /** 가시 클러스터 + 발사 flash */
  private spineGfx: PIXI.Graphics;
  /** 정상 꽃 (cyan/white/yellow) */
  private flowerGfx: PIXI.Graphics;
  /** 레이저 ADD glow + 트레일 */
  private laserGlowGfx: PIXI.Graphics;
  /** 레이저 코어 (백색 심선) */
  private laserCoreGfx: PIXI.Graphics;
  /** 피격 ADD glow */
  private impactGlowGfx: PIXI.Graphics;
  /** 피격 코어 파편 */
  private impactCoreGfx: PIXI.Graphics;

  active = false;
  private time = 0;
  private anchorX = 0;
  private anchorY = 0;

  // 가시 launcher 위치 (한 번 생성, needle 발사)
  private spines: SpineLauncher[] = [];
  /** 가시별 needle 발사 쿨다운 (frames remaining) */
  private spineCooldowns: number[] = [];
  // 꽃 launcher (5개, 정상 위치, 큰 레이저 발사)
  private flowerLaunchers: FlowerLauncher[] = [];
  // 모래 디테일 (한 번 생성)
  private pebbles: Pebble[] = [];
  private sandGrains: SandGrain[] = [];
  private sandRipples: SandRipple[] = [];

  // 활성 풀
  private lasers: Laser[] = [];
  private needles: Needle[] = [];
  private impacts: Impact[] = [];

  // spawn
  private laserSpawnAcc = 0;

  // 선인장 wobble (살아있는 felt)
  private bodyWobble = 0;

  // 가시 needle 발사 flash (spineIdx → 0~1)
  private spineFireFlash: Map<number, number> = new Map();
  // 꽃 레이저 발사 flash (launcherIdx → 0~1)
  private flowerFireFlash: Map<number, number> = new Map();

  /** 엔진 피해 이벤트 */
  private hitsBuffer: Array<{ x: number; y: number; enemyIdx: number; damage: number }> = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.groundGfx = new PIXI.Graphics();
    this.container.addChild(this.groundGfx);

    this.shadowGfx = new PIXI.Graphics();
    this.container.addChild(this.shadowGfx);

    this.outlineGfx = new PIXI.Graphics();
    this.container.addChild(this.outlineGfx);

    this.bodyGfx = new PIXI.Graphics();
    this.container.addChild(this.bodyGfx);

    this.highlightGfx = new PIXI.Graphics();
    this.container.addChild(this.highlightGfx);

    this.ridgeGfx = new PIXI.Graphics();
    this.container.addChild(this.ridgeGfx);

    this.spineGfx = new PIXI.Graphics();
    this.container.addChild(this.spineGfx);

    this.flowerGfx = new PIXI.Graphics();
    this.container.addChild(this.flowerGfx);

    this.laserGlowGfx = new PIXI.Graphics();
    this.laserGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.laserGlowGfx);

    this.laserCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.laserCoreGfx);

    this.impactGlowGfx = new PIXI.Graphics();
    this.impactGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.impactGlowGfx);

    this.impactCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.impactCoreGfx);

    this.generateSpineLaunchers();
    this.generateFlowerLaunchers();
    this.generateSandDetails();
    // 가시 쿨다운 stagger 초기화 (한꺼번에 발사 안 되게)
    for (let i = 0; i < this.spines.length; i++) {
      this.spineCooldowns.push(Math.random() * NEEDLE_COOLDOWN_BASE);
    }
  }

  private generateFlowerLaunchers() {
    // 각 캡슐의 끝점 = 꽃 위치 = 레이저 launcher
    for (const part of CACTUS_PARTS) {
      const dx = part.x2 - part.x1;
      const dy = part.y2 - part.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      this.flowerLaunchers.push({
        x: part.x2,
        y: part.y2,
        outAngle: Math.atan2(dy / len, dx / len),
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  //  초기 데이터 생성
  // ───────────────────────────────────────────────────────────

  private generateSpineLaunchers() {
    // launcher 위치 = 중앙 가시 끝 (TIP). root는 캡슐 표면.
    // 시각적: 가시 root → tip 방향으로 fan 그림 + 레이저는 tip에서 발사.
    for (const part of CACTUS_PARTS) {
      const dx = part.x2 - part.x1;
      const dy = part.y2 - part.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len; // perpendicular
      const ny = dx / len;
      const halfW = part.width / 2;
      const interval = 17;
      const count = Math.max(2, Math.floor(len / interval));
      for (let i = 1; i < count; i++) {
        const t = i / count;
        const cx = part.x1 + dx * t;
        const cy = part.y1 + dy * t;
        // 양쪽 (left/right of capsule axis) — TIP 위치 = root + outDir × CENTER_LEN
        this.spines.push({
          x: cx + nx * (halfW + SPINE_CENTER_LEN),
          y: cy + ny * (halfW + SPINE_CENTER_LEN),
          outAngle: Math.atan2(ny, nx),
        });
        this.spines.push({
          x: cx - nx * (halfW + SPINE_CENTER_LEN),
          y: cy - ny * (halfW + SPINE_CENTER_LEN),
          outAngle: Math.atan2(-ny, -nx),
        });
      }
      // Top spine on capsule end (위 방향) — 캡슐 끝 + outDir
      const tipNx = dx / len; // along axis
      const tipNy = dy / len;
      this.spines.push({
        x: part.x2 + tipNx * SPINE_CENTER_LEN,
        y: part.y2 + tipNy * SPINE_CENTER_LEN,
        outAngle: Math.atan2(tipNy, tipNx),
      });
    }
  }

  private generateSandDetails() {
    // 자갈 — 작고 적게 (5개), 메인 분위기는 고운 모래라 자갈 minimal
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 35 + Math.random() * 50;
      this.pebbles.push({
        ox: Math.cos(a) * d,
        oy: Math.sin(a) * d * 0.32 + 9,
        r: 0.9 + Math.random() * 1.0, // 작게
        color: Math.random() < 0.5 ? SAND_PEBBLE_DARK : SAND_PEBBLE_LIGHT,
      });
    }

    // 모래알 highlights — 60개 (촘촘하게, 크기 변동)
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 88;
      this.sandGrains.push({
        ox: Math.cos(a) * d,
        oy: Math.sin(a) * d * 0.32 + 5,
        alpha: 0.45 + Math.random() * 0.50,
        size: 0.4 + Math.random() * 0.45, // 0.4~0.85 (고운 모래)
      });
    }

    // Dune ripple — 바람에 형성된 굽은 호 (8~10개)
    // 사막 모래 정체성 — 잔잔한 dune ridges
    const rippleCount = 9;
    for (let i = 0; i < rippleCount; i++) {
      // 캐릭터 주위 다양한 위치 (원형으로 분포, 살짝 위 편향)
      const a = (i / rippleCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const d = 25 + Math.random() * 65;
      const cx = Math.cos(a) * d;
      const cy = Math.sin(a) * d * 0.32 + 6;
      // 호 길이/방향 (대체로 수평, 살짝 sway)
      const length = 14 + Math.random() * 22;
      const horizAngle = (Math.random() - 0.5) * 0.5; // -0.25 ~ +0.25 rad
      const halfL = length / 2;
      this.sandRipples.push({
        x1: cx - Math.cos(horizAngle) * halfL,
        y1: cy - Math.sin(horizAngle) * halfL,
        x2: cx + Math.cos(horizAngle) * halfL,
        y2: cy + Math.sin(horizAngle) * halfL,
        curve: -1.5 - Math.random() * 1.5, // 위로 굽음 (음수 = -y 방향)
        alpha: 0.32 + Math.random() * 0.30,
        width: 0.6 + Math.random() * 0.4,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  외부 API
  // ═══════════════════════════════════════════════════════════

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.anchorX = x;
    this.anchorY = y;
    this.lasers = [];
    this.needles = [];
    this.impacts = [];
    this.laserSpawnAcc = 0;
    this.spineFireFlash.clear();
    this.flowerFireFlash.clear();
    // 가시 쿨다운 재설정
    for (let i = 0; i < this.spineCooldowns.length; i++) {
      this.spineCooldowns[i] = Math.random() * NEEDLE_COOLDOWN_BASE;
    }
    this.hitsBuffer = [];
    this.container.visible = true;
  }

  /** 설치형 — 위치 변경 무시 */
  setPosition(_x: number, _y: number) {
    // no-op
  }

  /** 엔진이 매 프레임 호출 — 레이저(원거리) + needle(근거리 가시) 동시 처리 */
  updateLasers(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    if (!this.active) return;
    this.hitsBuffer = [];

    // ── (1) LASER spawn — 꽃에서 발사, 멀리 적 우선 ──
    this.laserSpawnAcc += (LASER_FIRE_RATE / 60) * dt;
    while (this.laserSpawnAcc >= 1) {
      this.laserSpawnAcc -= 1;
      this.spawnLaser(enemies);
    }
    this.updateLaserList(dt, enemies);

    // ── (2) NEEDLE spawn — 가시별 쿨다운 + 가까운 적 발견 시 발사 ──
    this.updateNeedleSpawning(dt, enemies);
    this.updateNeedleList(dt, enemies);

    // ── flash 감소 ──
    this.decayFlash(this.spineFireFlash, dt, 0.18);
    this.decayFlash(this.flowerFireFlash, dt, 0.14);
  }

  private decayFlash(map: Map<number, number>, dt: number, rate: number) {
    const toDelete: number[] = [];
    for (const [k, v] of map) {
      const newV = v - dt * rate;
      if (newV <= 0) toDelete.push(k);
      else map.set(k, newV);
    }
    for (const k of toDelete) map.delete(k);
  }

  private updateLaserList(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const l = this.lasers[i];

      // rule 5
      if (l.targetIdx >= 0) {
        const e = enemies[l.targetIdx];
        if (e && e.active) {
          const dxn = e.x - l.lastTargetX;
          const dyn = e.y - l.lastTargetY;
          if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
            l.lastTargetX = e.x;
            l.lastTargetY = e.y;
          } else {
            l.targetIdx = -1;
          }
        } else {
          l.targetIdx = -1;
        }
      }
      // 재탐색 (멀리 적 우선 — laser는 원거리 임무)
      if (l.targetIdx < 0) {
        l.targetIdx = this.pickFarTarget(l.x, l.y, enemies);
        if (l.targetIdx >= 0) {
          l.lastTargetX = enemies[l.targetIdx].x;
          l.lastTargetY = enemies[l.targetIdx].y;
        }
      }
      // 호밍
      if (l.targetIdx >= 0) {
        const dx = l.lastTargetX - l.x;
        const dy = l.lastTargetY - l.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const tvx = (dx / d) * LASER_SPEED;
        const tvy = (dy / d) * LASER_SPEED;
        l.vx += (tvx - l.vx) * LASER_HOMING_BIAS * dt;
        l.vy += (tvy - l.vy) * LASER_HOMING_BIAS * dt;
        const sp = Math.sqrt(l.vx * l.vx + l.vy * l.vy) || 1;
        l.vx = (l.vx / sp) * LASER_SPEED;
        l.vy = (l.vy / sp) * LASER_SPEED;
      }
      l.trail.push({ x: l.x, y: l.y });
      if (l.trail.length > LASER_TRAIL_LEN) l.trail.shift();
      l.x += l.vx * dt;
      l.y += l.vy * dt;
      l.life += dt;

      let hit = false;
      for (let ei = 0; ei < enemies.length; ei++) {
        const e = enemies[ei];
        if (!e.active) continue;
        const dx = e.x - l.x;
        const dy = e.y - l.y;
        if (dx * dx + dy * dy <= LASER_HIT_RADIUS_SQ) {
          this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: ei, damage: LASER_DAMAGE });
          this.spawnImpact(e.x, e.y, true); // big impact
          hit = true;
          break;
        }
      }
      if (hit || l.life >= LASER_MAX_LIFE) swapPop(this.lasers, i);
    }
  }

  private updateNeedleSpawning(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    // 가시별 쿨다운 + 가까운 적 있으면 발사
    for (let i = 0; i < this.spines.length; i++) {
      this.spineCooldowns[i] -= dt;
      if (this.spineCooldowns[i] > 0) continue;

      const spine = this.spines[i];
      const sx = this.anchorX + spine.x;
      const sy = this.anchorY + spine.y;

      // 가까운 적 찾음 (NEEDLE_RANGE 내 가장 가까움)
      let bestIdx = -1;
      let bestD2 = NEEDLE_RANGE_SQ;
      for (let ei = 0; ei < enemies.length; ei++) {
        const e = enemies[ei];
        if (!e.active) continue;
        const dx = e.x - sx;
        const dy = e.y - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = ei;
        }
      }
      if (bestIdx < 0) {
        // 적 없음 — 짧게 쿨 (다시 빠르게 체크)
        this.spineCooldowns[i] = 6 + Math.random() * 6;
        continue;
      }

      // 발사
      this.spawnNeedleFromSpine(i, bestIdx, enemies);
      this.spineCooldowns[i] = NEEDLE_COOLDOWN_BASE + (Math.random() - 0.5) * NEEDLE_COOLDOWN_VAR * 2;
    }
  }

  private updateNeedleList(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    for (let i = this.needles.length - 1; i >= 0; i--) {
      const n = this.needles[i];

      // rule 5
      if (n.targetIdx >= 0) {
        const e = enemies[n.targetIdx];
        if (e && e.active) {
          const dxn = e.x - n.lastTargetX;
          const dyn = e.y - n.lastTargetY;
          if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
            n.lastTargetX = e.x;
            n.lastTargetY = e.y;
          } else {
            n.targetIdx = -1;
          }
        } else {
          n.targetIdx = -1;
        }
      }
      // 약한 호밍 (거의 직선 — needle은 빠른 다트)
      if (n.targetIdx >= 0) {
        const dx = n.lastTargetX - n.x;
        const dy = n.lastTargetY - n.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const tvx = (dx / d) * NEEDLE_SPEED;
        const tvy = (dy / d) * NEEDLE_SPEED;
        n.vx += (tvx - n.vx) * NEEDLE_HOMING_BIAS * dt;
        n.vy += (tvy - n.vy) * NEEDLE_HOMING_BIAS * dt;
        const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1;
        n.vx = (n.vx / sp) * NEEDLE_SPEED;
        n.vy = (n.vy / sp) * NEEDLE_SPEED;
      }
      n.trail.push({ x: n.x, y: n.y });
      if (n.trail.length > NEEDLE_TRAIL_LEN) n.trail.shift();
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.life += dt;

      let hit = false;
      for (let ei = 0; ei < enemies.length; ei++) {
        const e = enemies[ei];
        if (!e.active) continue;
        const dx = e.x - n.x;
        const dy = e.y - n.y;
        if (dx * dx + dy * dy <= NEEDLE_HIT_RADIUS_SQ) {
          this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: ei, damage: NEEDLE_DAMAGE });
          this.spawnImpact(e.x, e.y, false); // small impact
          hit = true;
          break;
        }
      }
      if (hit || n.life >= NEEDLE_MAX_LIFE) swapPop(this.needles, i);
    }
  }

  /** 멀리 적 우선 선택 — 200~700 거리, 멀수록 우선 (50% 가중) */
  private pickFarTarget(fromX: number, fromY: number, enemies: Array<{ x: number; y: number; active: boolean }>): number {
    // 후보 수집 (LASER_RANGE_MAX 안의 모든 적)
    const candidates: Array<{ idx: number; d2: number }> = [];
    for (let ei = 0; ei < enemies.length; ei++) {
      const e = enemies[ei];
      if (!e.active) continue;
      const dx = e.x - fromX;
      const dy = e.y - fromY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= LASER_RANGE_MAX_SQ) candidates.push({ idx: ei, d2 });
    }
    if (candidates.length === 0) return -1;

    // 멀리 있는 적 (LASER_RANGE_MIN 이상) 우선
    const farOnes = candidates.filter((c) => c.d2 >= LASER_RANGE_MIN_SQ);
    if (farOnes.length > 0) {
      // 멀리 있는 것 중 랜덤
      return farOnes[Math.floor(Math.random() * farOnes.length)].idx;
    }
    // 멀리 적 없으면 가까운 거 중에 가장 먼 거
    candidates.sort((a, b) => b.d2 - a.d2);
    return candidates[0].idx;
  }

  hitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number; damage: number }> {
    return this.hitsBuffer;
  }

  // ───────────────────────────────────────────────────────────
  //  spawn 헬퍼
  // ───────────────────────────────────────────────────────────

  /** 레이저 spawn — 꽃에서 발사, 멀리 적 우선 */
  private spawnLaser(enemies: Array<{ x: number; y: number; active: boolean }>) {
    if (this.flowerLaunchers.length === 0) return;
    // 라운드로빈으로 5개 flower 골고루 사용
    const fIdx = Math.floor(Math.random() * this.flowerLaunchers.length);
    const f = this.flowerLaunchers[fIdx];
    const wx = this.anchorX + f.x;
    const wy = this.anchorY + f.y;

    const targetIdx = this.pickFarTarget(wx, wy, enemies);
    let vx: number, vy: number, lastTargetX = 0, lastTargetY = 0;
    if (targetIdx >= 0) {
      const e = enemies[targetIdx];
      const dx = e.x - wx;
      const dy = e.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // 50% 꽃 방향 + 50% 타겟 (꽃에서 솟구치는 felt + 정확)
      const targetVx = (dx / d) * LASER_SPEED;
      const targetVy = (dy / d) * LASER_SPEED;
      const flowerVx = Math.cos(f.outAngle) * LASER_SPEED;
      const flowerVy = Math.sin(f.outAngle) * LASER_SPEED;
      vx = flowerVx * 0.5 + targetVx * 0.5;
      vy = flowerVy * 0.5 + targetVy * 0.5;
      const sp = Math.sqrt(vx * vx + vy * vy) || 1;
      vx = (vx / sp) * LASER_SPEED;
      vy = (vy / sp) * LASER_SPEED;
      lastTargetX = e.x;
      lastTargetY = e.y;
    } else {
      // 적 없음 — 꽃 axis 방향으로 직진
      vx = Math.cos(f.outAngle) * LASER_SPEED;
      vy = Math.sin(f.outAngle) * LASER_SPEED;
    }

    this.lasers.push({
      x: wx, y: wy,
      vx, vy,
      trail: [],
      targetIdx,
      lastTargetX, lastTargetY,
      life: 0,
    });

    this.flowerFireFlash.set(fIdx, 1);
  }

  /** 가시에서 needle 발사 — 가까운 적 요격 */
  private spawnNeedleFromSpine(spineIdx: number, targetIdx: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    const spine = this.spines[spineIdx];
    const wx = this.anchorX + spine.x;
    const wy = this.anchorY + spine.y;
    const e = enemies[targetIdx];
    const dx = e.x - wx;
    const dy = e.y - wy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    // 85% 가시 outAngle + 15% 타겟 — 가시 끝에서 강하게 솟구침 (visual: 가시 방향 직진)
    const targetVx = (dx / d) * NEEDLE_SPEED;
    const targetVy = (dy / d) * NEEDLE_SPEED;
    const spineVx = Math.cos(spine.outAngle) * NEEDLE_SPEED;
    const spineVy = Math.sin(spine.outAngle) * NEEDLE_SPEED;
    let vx = spineVx * 0.85 + targetVx * 0.15;
    let vy = spineVy * 0.85 + targetVy * 0.15;
    const sp = Math.sqrt(vx * vx + vy * vy) || 1;
    vx = (vx / sp) * NEEDLE_SPEED;
    vy = (vy / sp) * NEEDLE_SPEED;

    this.needles.push({
      x: wx, y: wy,
      vx, vy,
      trail: [],
      targetIdx,
      lastTargetX: e.x,
      lastTargetY: e.y,
      life: 0,
    });

    this.spineFireFlash.set(spineIdx, 1);
  }

  private spawnImpact(x: number, y: number, big: boolean) {
    const shards: ImpactShard[] = [];
    const cyanCount = big ? 4 : 2;
    const goldCount = big ? 5 : 2;
    const sparkCount = big ? 4 : 2;
    const blueCount = big ? 3 : 1;

    // 시안 물방울
    for (let i = 0; i < cyanCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * 1.2;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.7,
        size: (big ? 1.6 : 1.0) + Math.random() * 0.7,
        life: 0,
        maxLife: 18 + Math.random() * 6,
        kind: 0,
      });
    }
    // 금색 빛 파편 (꼬리)
    for (let i = 0; i < goldCount; i++) {
      const a = (i / Math.max(1, goldCount)) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 2.4 + Math.random() * 1.4;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.4,
        size: (big ? 1.4 : 0.95) + Math.random() * 0.5,
        life: 0,
        maxLife: 14 + Math.random() * 5,
        kind: 1,
      });
    }
    // 백색 스파크
    for (let i = 0; i < sparkCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2.8 + Math.random() * 1.6;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.3,
        size: (big ? 1.0 : 0.7) + Math.random() * 0.3,
        life: 0,
        maxLife: 11 + Math.random() * 4,
        kind: 2,
      });
    }
    // 파란 물방울 (위로 튀고 중력)
    for (let i = 0; i < blueCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.4 + Math.random() * 1.0;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.1,
        size: (big ? 1.2 : 0.85) + Math.random() * 0.4,
        life: 0,
        maxLife: 20 + Math.random() * 6,
        kind: 3,
      });
    }
    this.impacts.push({ x, y, age: 0, shards });
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    // 살아있는 felt — 미세한 sway
    this.bodyWobble = Math.sin(this.time * 0.04) * 0.45;

    // 임팩트 업데이트
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      im.age += dt;
      for (const s of im.shards) {
        s.life += dt;
        s.vx *= 0.92;
        if (s.kind === 0 || s.kind === 3) {
          s.vy += 0.06 * dt; // 물방울 중력
        } else {
          s.vy *= 0.93;
        }
      }
      if (im.age >= 30) swapPop(this.impacts, i);
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.groundGfx.clear();
    this.shadowGfx.clear();
    this.outlineGfx.clear();
    this.bodyGfx.clear();
    this.highlightGfx.clear();
    this.ridgeGfx.clear();
    this.spineGfx.clear();
    this.flowerGfx.clear();
    this.laserGlowGfx.clear();
    this.laserCoreGfx.clear();
    this.impactGlowGfx.clear();
    this.impactCoreGfx.clear();

    this.drawSand();
    this.drawCactusShadow();
    this.drawCactusOutline();
    this.drawCactusBody();
    this.drawCactusHighlights();
    this.drawCactusRidges();
    this.drawSpines();
    this.drawFlowers();
    this.drawFlowerFlash();
    this.drawNeedles();
    this.drawLasers();
    this.drawImpacts();
  }

  // ── 사막 모래 base — 고운 dune 느낌 ──
  private drawSand() {
    const ax = this.anchorX;
    const ay = this.anchorY;

    // 4 그라데이션 layer (밝→어둠 부드럽게, 다크 패치 X)
    // 1. 가장 외곽 halo (페이드 시작)
    this.groundGfx.beginFill(SAND_OUTER, 0.32);
    this.groundGfx.drawEllipse(ax, ay + 10, SAND_RADIUS * 1.30, SAND_RADIUS * 0.50);
    this.groundGfx.endFill();
    // 2. 외곽 (밝은 amber-100)
    this.groundGfx.beginFill(SAND_OUTER, 0.55);
    this.groundGfx.drawEllipse(ax, ay + 7, SAND_RADIUS * 1.10, SAND_RADIUS * 0.42);
    this.groundGfx.endFill();
    // 3. 메인 모래 (amber-200)
    this.groundGfx.beginFill(SAND_MID_COL, 0.68);
    this.groundGfx.drawEllipse(ax, ay + 5, SAND_RADIUS * 0.92, SAND_RADIUS * 0.36);
    this.groundGfx.endFill();
    // 4. 코어 (살짝 짙은 amber-300, 선인장 발 기준 살짝 inset)
    this.groundGfx.beginFill(SAND_DARK, 0.30);
    this.groundGfx.drawEllipse(ax, ay + 3, SAND_RADIUS * 0.68, SAND_RADIUS * 0.26);
    this.groundGfx.endFill();
    // 5. 선인장 발 directly under (가장 짙은 음영, 작게)
    this.groundGfx.beginFill(SAND_DEEPER, 0.25);
    this.groundGfx.drawEllipse(ax + 2, ay + 4, SAND_RADIUS * 0.32, SAND_RADIUS * 0.13);
    this.groundGfx.endFill();

    // ── Dune ripples (바람에 형성된 잔잔한 호) ──
    // 모래 위에 부드러운 호 → 사막 dune wind ridge 정체성
    for (const r of this.sandRipples) {
      // 호 그리기 (sin 곡선으로 부풀기)
      const segs = 8;
      this.groundGfx.lineStyle(r.width, SAND_DEEPER, r.alpha);
      this.groundGfx.moveTo(ax + r.x1, ay + r.y1);
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const lx = r.x1 + (r.x2 - r.x1) * t;
        const ly = r.y1 + (r.y2 - r.y1) * t + Math.sin(t * Math.PI) * r.curve;
        this.groundGfx.lineTo(ax + lx, ay + ly);
      }
      this.groundGfx.lineStyle(0);
      // 호 위쪽에 살짝 밝은 highlight (모래 ridge 정상)
      this.groundGfx.lineStyle(r.width * 0.6, SAND_GRAIN_COL, r.alpha * 0.7);
      this.groundGfx.moveTo(ax + r.x1, ay + r.y1 + r.curve * 0.1);
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const lx = r.x1 + (r.x2 - r.x1) * t;
        const ly = r.y1 + (r.y2 - r.y1) * t + Math.sin(t * Math.PI) * r.curve * 1.1; // 살짝 위
        this.groundGfx.lineTo(ax + lx, ay + ly);
      }
      this.groundGfx.lineStyle(0);
    }

    // ── 자갈 (작고 적게, 분위기 깨지 않게) ──
    for (const p of this.pebbles) {
      this.groundGfx.beginFill(p.color, 0.85);
      this.groundGfx.drawCircle(ax + p.ox, ay + p.oy, p.r);
      this.groundGfx.endFill();
      // 자갈 위 하이라이트
      this.groundGfx.beginFill(SAND_GRAIN_COL, 0.6);
      this.groundGfx.drawCircle(ax + p.ox - p.r * 0.32, ay + p.oy - p.r * 0.32, p.r * 0.45);
      this.groundGfx.endFill();
    }

    // ── 고운 모래알 highlights (60개, 크기 변동) ──
    for (const g of this.sandGrains) {
      this.groundGfx.beginFill(SAND_GRAIN_COL, g.alpha);
      this.groundGfx.drawCircle(ax + g.ox, ay + g.oy, g.size);
      this.groundGfx.endFill();
    }
  }

  // ── 선인장 드롭섀도우 ──
  private drawCactusShadow() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    this.shadowGfx.beginFill(0x14532d, 0.32);
    this.shadowGfx.drawEllipse(ax + 6, ay + 6, 65, 12);
    this.shadowGfx.endFill();
    this.shadowGfx.beginFill(0x052e16, 0.40);
    this.shadowGfx.drawEllipse(ax + 3, ay + 4, 48, 9);
    this.shadowGfx.endFill();
  }

  // ── 외곽선 (가장 어두운 그린, 캡슐+4) ──
  private drawCactusOutline() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;
    this.outlineGfx.beginFill(CACTUS_DEEP, 0.95);
    for (const part of CACTUS_PARTS) {
      drawCapsule(
        this.outlineGfx,
        ax + part.x1 + wob, ay + part.y1,
        ax + part.x2 + wob, ay + part.y2,
        part.width + 4,
      );
    }
    this.outlineGfx.endFill();
  }

  // ── 본체 (다크 → 베이스) ──
  private drawCactusBody() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;

    // 다크 베이스
    this.bodyGfx.beginFill(CACTUS_DARK, 0.96);
    for (const part of CACTUS_PARTS) {
      drawCapsule(
        this.bodyGfx,
        ax + part.x1 + wob, ay + part.y1,
        ax + part.x2 + wob, ay + part.y2,
        part.width,
      );
    }
    this.bodyGfx.endFill();

    // 메인 베이스 그린 (살짝 inset)
    this.bodyGfx.beginFill(CACTUS_BASE, 0.95);
    for (const part of CACTUS_PARTS) {
      drawCapsule(
        this.bodyGfx,
        ax + part.x1 + wob, ay + part.y1,
        ax + part.x2 + wob, ay + part.y2,
        part.width - 3,
      );
    }
    this.bodyGfx.endFill();

    // 미드 그린 (더 안쪽)
    this.bodyGfx.beginFill(CACTUS_MID, 0.55);
    for (const part of CACTUS_PARTS) {
      drawCapsule(
        this.bodyGfx,
        ax + part.x1 + wob, ay + part.y1,
        ax + part.x2 + wob, ay + part.y2,
        part.width - 8,
      );
    }
    this.bodyGfx.endFill();
  }

  // ── 좌측 highlight stripe + bright catch ──
  private drawCactusHighlights() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;

    for (const part of CACTUS_PARTS) {
      const dx = part.x2 - part.x1;
      const dy = part.y2 - part.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len; // perpendicular
      const ny = dx / len;
      const halfW = part.width / 2;

      // 좌상단 offset (광원 좌상단)
      const offX1 = nx * halfW * 0.32;
      const offY1 = ny * halfW * 0.32;

      // Light green stripe (넓고 부드럽게)
      this.highlightGfx.beginFill(CACTUS_LIGHT, 0.65);
      drawCapsule(
        this.highlightGfx,
        ax + part.x1 - offX1 + wob, ay + part.y1 - offY1,
        ax + part.x2 - offX1 + wob, ay + part.y2 - offY1,
        part.width * 0.38,
      );
      this.highlightGfx.endFill();

      // Bright catch (밝고 좁게 — 빛 반사)
      this.highlightGfx.beginFill(CACTUS_BRIGHT, 0.55);
      drawCapsule(
        this.highlightGfx,
        ax + part.x1 - offX1 * 1.5 + wob, ay + part.y1 - offY1 * 1.5,
        ax + part.x2 - offX1 * 1.5 + wob, ay + part.y2 - offY1 * 1.5,
        part.width * 0.20,
      );
      this.highlightGfx.endFill();

      // Sheen (가장 좁고 가장 밝음)
      this.highlightGfx.beginFill(CACTUS_SHEEN, 0.45);
      drawCapsule(
        this.highlightGfx,
        ax + part.x1 - offX1 * 1.8 + wob, ay + part.y1 - offY1 * 1.8,
        ax + part.x2 - offX1 * 1.8 + wob, ay + part.y2 - offY1 * 1.8,
        part.width * 0.10,
      );
      this.highlightGfx.endFill();
    }
  }

  // ── 세로 골 (5/part) ──
  private drawCactusRidges() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;

    for (const part of CACTUS_PARTS) {
      const dx = part.x2 - part.x1;
      const dy = part.y2 - part.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const halfW = part.width / 2;

      const ridgeCount = 5;
      for (let i = 1; i < ridgeCount; i++) {
        const t = (i / ridgeCount) * 2 - 1; // -1 .. 1
        const ridgeOffX = nx * halfW * t * 0.85;
        const ridgeOffY = ny * halfW * t * 0.85;

        this.ridgeGfx.lineStyle(1.3, CACTUS_DEEP, 0.55);
        this.ridgeGfx.moveTo(ax + part.x1 + ridgeOffX + wob, ay + part.y1 + ridgeOffY);
        this.ridgeGfx.lineTo(ax + part.x2 + ridgeOffX + wob, ay + part.y2 + ridgeOffY);
        this.ridgeGfx.lineStyle(0);
      }
    }
  }

  // ── 가시 클러스터 + 발사 flash ──
  private drawSpines() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;

    for (let i = 0; i < this.spines.length; i++) {
      const s = this.spines[i];
      // launcher 위치 = TIP 좌표 (월드)
      const tipX = ax + s.x + wob;
      const tipY = ay + s.y;
      // root = TIP - outDir × CENTER_LEN (캡슐 표면)
      const cosA = Math.cos(s.outAngle);
      const sinA = Math.sin(s.outAngle);
      const rootX = tipX - cosA * SPINE_CENTER_LEN;
      const rootY = tipY - sinA * SPINE_CENTER_LEN;
      const flash = this.spineFireFlash.get(i) ?? 0;

      // 3 가시 fan: 중앙(길고 root→tip), 양옆(짧음, 다른 각도)
      for (let k = -1; k <= 1; k++) {
        const angle = s.outAngle + k * SPINE_FAN_SPREAD;
        const len = k === 0 ? SPINE_CENTER_LEN : SPINE_SIDE_LEN;
        const fanTipX = rootX + Math.cos(angle) * len;
        const fanTipY = rootY + Math.sin(angle) * len;

        // Base (어두운 amber, 두꺼움)
        this.spineGfx.lineStyle(1.6, SPINE_BASE_COL, 0.88);
        this.spineGfx.moveTo(rootX, rootY);
        this.spineGfx.lineTo(fanTipX, fanTipY);
        this.spineGfx.lineStyle(0);

        // Mid (amber 밝은, 25%~끝)
        this.spineGfx.lineStyle(0.9, SPINE_MID, 0.92);
        const m1 = 0.25;
        this.spineGfx.moveTo(
          rootX + Math.cos(angle) * len * m1,
          rootY + Math.sin(angle) * len * m1,
        );
        this.spineGfx.lineTo(fanTipX, fanTipY);
        this.spineGfx.lineStyle(0);

        // Tip (cream/white, 끝부분만 65%~끝)
        this.spineGfx.lineStyle(0.7, SPINE_TIP, 0.95);
        const m2 = 0.65;
        this.spineGfx.moveTo(
          rootX + Math.cos(angle) * len * m2,
          rootY + Math.sin(angle) * len * m2,
        );
        this.spineGfx.lineTo(fanTipX, fanTipY);
        this.spineGfx.lineStyle(0);
      }

      // 가시 root 작은 점 (캡슐 부착)
      this.spineGfx.beginFill(SPINE_BASE_COL, 0.92);
      this.spineGfx.drawCircle(rootX, rootY, 1.4);
      this.spineGfx.endFill();

      // needle 발사 flash — 가시 TIP에 진한 황금 burst (확실한 origin felt)
      if (flash > 0.05) {
        // 외곽 amber-700 부드러운 글로우
        this.laserGlowGfx.beginFill(SPINE_BASE_COL, flash * 0.55);
        this.laserGlowGfx.drawCircle(tipX, tipY, 11 * flash);
        this.laserGlowGfx.endFill();
        // 메인 amber-400 burst
        this.laserGlowGfx.beginFill(SPINE_MID, flash * 0.85);
        this.laserGlowGfx.drawCircle(tipX, tipY, 6 * flash);
        this.laserGlowGfx.endFill();
        // 노랑 코어
        this.laserGlowGfx.beginFill(SPINE_TIP, flash * 0.95);
        this.laserGlowGfx.drawCircle(tipX, tipY, 3 * flash);
        this.laserGlowGfx.endFill();
        // 백색 highlight 점
        this.laserCoreGfx.beginFill(SPINE_TIP, flash);
        this.laserCoreGfx.drawCircle(tipX, tipY, 1.6 * flash);
        this.laserCoreGfx.endFill();
      }
    }
  }

  // ── 정상 꽃 (water+light) ──
  private drawFlowers() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;

    // 각 부분 정상에 꽃
    for (const part of CACTUS_PARTS) {
      const fx = ax + part.x2 + wob;
      const fy = ay + part.y2;
      const petalR = 6;

      // 외곽 sky-200 halo (subtle ADD-like fade)
      this.flowerGfx.beginFill(FLOWER_OUTER, 0.55);
      this.flowerGfx.drawCircle(fx, fy, petalR * 1.4);
      this.flowerGfx.endFill();

      // 5 꽃잎 (sky-200/cyan-300 + white)
      const petalCount = 5;
      for (let i = 0; i < petalCount; i++) {
        const a = (i / petalCount) * Math.PI * 2 + this.time * 0.005;
        const px = fx + Math.cos(a) * petalR * 0.65;
        const py = fy + Math.sin(a) * petalR * 0.65;
        // 꽃잎 외곽 (cyan-300 - 작게)
        this.flowerGfx.beginFill(FLOWER_MID, 0.5);
        this.flowerGfx.drawCircle(px, py, petalR * 0.65);
        this.flowerGfx.endFill();
        // 꽃잎 (sky-200 main)
        this.flowerGfx.beginFill(FLOWER_OUTER, 0.85);
        this.flowerGfx.drawCircle(px, py, petalR * 0.55);
        this.flowerGfx.endFill();
        // 백색 하이라이트
        this.flowerGfx.beginFill(FLOWER_WHITE, 0.92);
        this.flowerGfx.drawCircle(px - 0.6, py - 0.6, petalR * 0.32);
        this.flowerGfx.endFill();
      }

      // 중앙 수술 (yellow + white core)
      this.flowerGfx.beginFill(FLOWER_YELLOW, 1.0);
      this.flowerGfx.drawCircle(fx, fy, petalR * 0.55);
      this.flowerGfx.endFill();
      this.flowerGfx.beginFill(FLOWER_WHITE, 0.9);
      this.flowerGfx.drawCircle(fx - 0.6, fy - 0.6, petalR * 0.28);
      this.flowerGfx.endFill();
    }
  }

  // ── 꽃 launcher 발사 flash (큰 sky-blue 터짐) ──
  private drawFlowerFlash() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wob = this.bodyWobble;
    for (const [fIdx, intensity] of this.flowerFireFlash) {
      const f = this.flowerLaunchers[fIdx];
      if (!f) continue;
      const fx = ax + f.x + wob;
      const fy = ay + f.y;
      // ADD glow (큰 sky 후광)
      this.laserGlowGfx.beginFill(LASER_OUTER_COL, intensity * 0.65);
      this.laserGlowGfx.drawCircle(fx, fy, 14 * intensity);
      this.laserGlowGfx.endFill();
      this.laserGlowGfx.beginFill(LASER_MID_COL, intensity * 0.85);
      this.laserGlowGfx.drawCircle(fx, fy, 8 * intensity);
      this.laserGlowGfx.endFill();
      this.laserGlowGfx.beginFill(LASER_INNER, intensity * 0.85);
      this.laserGlowGfx.drawCircle(fx, fy, 4.5 * intensity);
      this.laserGlowGfx.endFill();
      this.laserCoreGfx.beginFill(LASER_CORE, intensity);
      this.laserCoreGfx.drawCircle(fx, fy, 2.6 * intensity);
      this.laserCoreGfx.endFill();
    }
  }

  // ── Needle (가시에서 발사된 황금 다트 — 뾰족한 spike 형태) ──
  private drawNeedles() {
    for (const n of this.needles) {
      // 진행 방향
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1;
      const cosA = n.vx / speed;
      const sinA = n.vy / speed;
      const perpX = -sinA;
      const perpY = cosA;

      // ── 트레일 (진한 황금 streak, 살짝 두꺼움) ──
      if (n.trail.length > 1) {
        for (let i = 0; i < n.trail.length - 1; i++) {
          const p0 = n.trail[i];
          const p1 = n.trail[i + 1];
          const segFrac = (i + 1) / n.trail.length;
          // 외곽 amber-700 glow (어두운 base)
          this.laserGlowGfx.lineStyle(4 * segFrac, SPINE_BASE_COL, segFrac * 0.45);
          this.laserGlowGfx.moveTo(p0.x, p0.y);
          this.laserGlowGfx.lineTo(p1.x, p1.y);
          this.laserGlowGfx.lineStyle(0);
          // 중간 amber-400 (saturated golden)
          this.laserGlowGfx.lineStyle(2.2 * segFrac, SPINE_MID, segFrac * 0.85);
          this.laserGlowGfx.moveTo(p0.x, p0.y);
          this.laserGlowGfx.lineTo(p1.x, p1.y);
          this.laserGlowGfx.lineStyle(0);
          // 코어 yellow-300
          this.laserGlowGfx.lineStyle(1.0 * segFrac, SPINE_TIP, segFrac * 0.95);
          this.laserGlowGfx.moveTo(p0.x, p0.y);
          this.laserGlowGfx.lineTo(p1.x, p1.y);
          this.laserGlowGfx.lineStyle(0);
        }
        // 마지막 → 현재 (가장 진함)
        const last = n.trail[n.trail.length - 1];
        this.laserGlowGfx.lineStyle(5, SPINE_BASE_COL, 0.6);
        this.laserGlowGfx.moveTo(last.x, last.y);
        this.laserGlowGfx.lineTo(n.x, n.y);
        this.laserGlowGfx.lineStyle(0);
        this.laserGlowGfx.lineStyle(2.8, SPINE_MID, 0.92);
        this.laserGlowGfx.moveTo(last.x, last.y);
        this.laserGlowGfx.lineTo(n.x, n.y);
        this.laserGlowGfx.lineStyle(0);
        this.laserGlowGfx.lineStyle(1.3, SPINE_TIP, 1.0);
        this.laserGlowGfx.moveTo(last.x, last.y);
        this.laserGlowGfx.lineTo(n.x, n.y);
        this.laserGlowGfx.lineStyle(0);
      }

      // ── 다트/spike 헤드 (다이아몬드 모양, 진행 방향 정렬) ──
      const tipLen = 6.5;     // 앞쪽 (날카로운 끝)
      const tailLen = 4.0;    // 뒤쪽
      const sideOff = 1.9;    // 좌우 폭

      const tipPx = n.x + cosA * tipLen;
      const tipPy = n.y + sinA * tipLen;
      const rearPx = n.x - cosA * tailLen;
      const rearPy = n.y - sinA * tailLen;
      const leftPx = n.x + perpX * sideOff;
      const leftPy = n.y + perpY * sideOff;
      const rightPx = n.x - perpX * sideOff;
      const rightPy = n.y - perpY * sideOff;

      // 외곽 후광 (다이아몬드 살짝 큼)
      const halo = 1.8;
      this.laserGlowGfx.beginFill(SPINE_BASE_COL, 0.45);
      this.laserGlowGfx.moveTo(n.x + cosA * (tipLen + halo), n.y + sinA * (tipLen + halo));
      this.laserGlowGfx.lineTo(n.x + perpX * (sideOff + halo * 0.6), n.y + perpY * (sideOff + halo * 0.6));
      this.laserGlowGfx.lineTo(n.x - cosA * (tailLen + halo * 0.4), n.y - sinA * (tailLen + halo * 0.4));
      this.laserGlowGfx.lineTo(n.x - perpX * (sideOff + halo * 0.6), n.y - perpY * (sideOff + halo * 0.6));
      this.laserGlowGfx.closePath();
      this.laserGlowGfx.endFill();

      // 메인 다이아몬드 (saturated golden)
      this.laserCoreGfx.beginFill(SPINE_MID, 0.95);
      this.laserCoreGfx.moveTo(tipPx, tipPy);
      this.laserCoreGfx.lineTo(leftPx, leftPy);
      this.laserCoreGfx.lineTo(rearPx, rearPy);
      this.laserCoreGfx.lineTo(rightPx, rightPy);
      this.laserCoreGfx.closePath();
      this.laserCoreGfx.endFill();

      // 내부 코어 (yellow-300 inset, 작은 다이아몬드)
      const innerScale = 0.55;
      const innerTipPx = n.x + cosA * tipLen * innerScale;
      const innerTipPy = n.y + sinA * tipLen * innerScale;
      const innerRearPx = n.x - cosA * tailLen * innerScale;
      const innerRearPy = n.y - sinA * tailLen * innerScale;
      const innerLeftPx = n.x + perpX * sideOff * innerScale;
      const innerLeftPy = n.y + perpY * sideOff * innerScale;
      const innerRightPx = n.x - perpX * sideOff * innerScale;
      const innerRightPy = n.y - perpY * sideOff * innerScale;

      this.laserCoreGfx.beginFill(SPINE_TIP, 1.0);
      this.laserCoreGfx.moveTo(innerTipPx, innerTipPy);
      this.laserCoreGfx.lineTo(innerLeftPx, innerLeftPy);
      this.laserCoreGfx.lineTo(innerRearPx, innerRearPy);
      this.laserCoreGfx.lineTo(innerRightPx, innerRightPy);
      this.laserCoreGfx.closePath();
      this.laserCoreGfx.endFill();

      // 끝점 highlight (백색, 작은 점)
      this.laserCoreGfx.beginFill(SPINE_TIP, 1.0);
      this.laserCoreGfx.drawCircle(tipPx - cosA * 1.2, tipPy - sinA * 1.2, 1.0);
      this.laserCoreGfx.endFill();
    }
  }

  // ── 레이저 (호밍 + 트레일) ──
  private drawLasers() {
    for (const l of this.lasers) {
      // 트레일 (segment별 세그)
      if (l.trail.length > 1) {
        for (let i = 0; i < l.trail.length - 1; i++) {
          const p0 = l.trail[i];
          const p1 = l.trail[i + 1];
          const segFrac = (i + 1) / l.trail.length; // 0~1, 끝일수록 1
          // 외곽 sky-400 glow
          this.laserGlowGfx.lineStyle(5 * segFrac, LASER_OUTER_COL, segFrac * 0.55);
          this.laserGlowGfx.moveTo(p0.x, p0.y);
          this.laserGlowGfx.lineTo(p1.x, p1.y);
          this.laserGlowGfx.lineStyle(0);
          // 중간 sky-300
          this.laserGlowGfx.lineStyle(2.6 * segFrac, LASER_MID_COL, segFrac * 0.85);
          this.laserGlowGfx.moveTo(p0.x, p0.y);
          this.laserGlowGfx.lineTo(p1.x, p1.y);
          this.laserGlowGfx.lineStyle(0);
        }
        // 마지막 트레일점 → 현재 위치 (가장 진함)
        const last = l.trail[l.trail.length - 1];
        this.laserGlowGfx.lineStyle(7, LASER_OUTER_COL, 0.85);
        this.laserGlowGfx.moveTo(last.x, last.y);
        this.laserGlowGfx.lineTo(l.x, l.y);
        this.laserGlowGfx.lineStyle(0);
        this.laserGlowGfx.lineStyle(3.5, LASER_MID_COL, 0.95);
        this.laserGlowGfx.moveTo(last.x, last.y);
        this.laserGlowGfx.lineTo(l.x, l.y);
        this.laserGlowGfx.lineStyle(0);
        this.laserCoreGfx.lineStyle(1.2, LASER_INNER, 1.0);
        this.laserCoreGfx.moveTo(last.x, last.y);
        this.laserCoreGfx.lineTo(l.x, l.y);
        this.laserCoreGfx.lineStyle(0);
      }

      // 헤드
      this.laserGlowGfx.beginFill(LASER_OUTER_COL, 0.7);
      this.laserGlowGfx.drawCircle(l.x, l.y, 5);
      this.laserGlowGfx.endFill();
      this.laserGlowGfx.beginFill(LASER_MID_COL, 0.85);
      this.laserGlowGfx.drawCircle(l.x, l.y, 2.8);
      this.laserGlowGfx.endFill();
      this.laserCoreGfx.beginFill(LASER_CORE, 1.0);
      this.laserCoreGfx.drawCircle(l.x, l.y, 1.5);
      this.laserCoreGfx.endFill();
    }
  }

  // ── 피격 효과 (4톤 호화) ──
  private drawImpacts() {
    for (const im of this.impacts) {
      const ageFrac = im.age / 30;
      const ringR = (1 - Math.pow(1 - ageFrac, 2)) * 42; // ease-out
      const ringA = 1 - ageFrac;

      // 초기 백/시안/금 코어 플래시 (첫 7프레임)
      if (im.age < 7) {
        const f = 1 - im.age / 7;
        this.impactGlowGfx.beginFill(IMPACT_AMBER, f * 0.55);
        this.impactGlowGfx.drawCircle(im.x, im.y, 36 * f);
        this.impactGlowGfx.endFill();
        this.impactGlowGfx.beginFill(IMPACT_CYAN, f * 0.75);
        this.impactGlowGfx.drawCircle(im.x, im.y, 26 * f);
        this.impactGlowGfx.endFill();
        this.impactGlowGfx.beginFill(0xffffff, f * 0.92);
        this.impactGlowGfx.drawCircle(im.x, im.y, 16 * f);
        this.impactGlowGfx.endFill();
        this.impactCoreGfx.beginFill(0xffffff, f);
        this.impactCoreGfx.drawCircle(im.x, im.y, 5.5 * f);
        this.impactCoreGfx.endFill();
      }

      // 팽창 링 2겹 (시안 외곽 + 금 안쪽)
      this.impactGlowGfx.lineStyle(2.5, IMPACT_CYAN, ringA * 0.85);
      this.impactGlowGfx.drawCircle(im.x, im.y, ringR);
      this.impactGlowGfx.lineStyle(0);
      this.impactGlowGfx.lineStyle(1.5, IMPACT_GOLD, ringA * 0.7);
      this.impactGlowGfx.drawCircle(im.x, im.y, ringR * 0.78);
      this.impactGlowGfx.lineStyle(0);
      // 백색 inner ring (첫 절반만)
      if (ageFrac < 0.5) {
        const innerA = 1 - ageFrac / 0.5;
        this.impactCoreGfx.lineStyle(1.3 * innerA, 0xffffff, innerA * 0.85);
        this.impactCoreGfx.drawCircle(im.x, im.y, ringR * 0.55);
        this.impactCoreGfx.lineStyle(0);
      }

      // 파편
      for (const s of im.shards) {
        const lf = s.life / s.maxLife;
        if (lf >= 1) continue;
        const sx = im.x + s.vx * s.life;
        const sy = im.y + s.vy * s.life;
        const a = 1 - lf;
        const sz = s.size * (1 - lf * 0.4);

        if (s.kind === 0) {
          // 시안 물방울
          this.impactGlowGfx.beginFill(IMPACT_DROP_SKY, a * 0.6);
          this.impactGlowGfx.drawCircle(sx, sy, sz * 1.9);
          this.impactGlowGfx.endFill();
          this.impactCoreGfx.beginFill(IMPACT_CYAN, a * 0.95);
          this.impactCoreGfx.drawCircle(sx, sy, sz);
          this.impactCoreGfx.endFill();
          this.impactCoreGfx.beginFill(0xffffff, a * 0.85);
          this.impactCoreGfx.drawCircle(sx - sz * 0.3, sy - sz * 0.3, sz * 0.32);
          this.impactCoreGfx.endFill();
        } else if (s.kind === 1) {
          // 금색 빛 파편 (꼬리)
          const tailX = sx - s.vx * 2.8;
          const tailY = sy - s.vy * 2.8;
          this.impactGlowGfx.lineStyle(sz * 1.4, IMPACT_GOLD, a * 0.8);
          this.impactGlowGfx.moveTo(tailX, tailY);
          this.impactGlowGfx.lineTo(sx, sy);
          this.impactGlowGfx.lineStyle(0);
          this.impactGlowGfx.beginFill(IMPACT_AMBER, a * 0.7);
          this.impactGlowGfx.drawCircle(sx, sy, sz * 1.6);
          this.impactGlowGfx.endFill();
          this.impactCoreGfx.beginFill(0xffffff, a * 0.92);
          this.impactCoreGfx.drawCircle(sx, sy, sz * 0.55);
          this.impactCoreGfx.endFill();
        } else if (s.kind === 2) {
          // 백색 스파크
          this.impactGlowGfx.beginFill(0xffffff, a * 0.7);
          this.impactGlowGfx.drawCircle(sx, sy, sz * 2.0);
          this.impactGlowGfx.endFill();
          this.impactCoreGfx.beginFill(0xffffff, a);
          this.impactCoreGfx.drawCircle(sx, sy, sz * 0.65);
          this.impactCoreGfx.endFill();
        } else {
          // 파란 물방울 (중력)
          this.impactGlowGfx.beginFill(IMPACT_DROP_SKY, a * 0.50);
          this.impactGlowGfx.drawCircle(sx, sy, sz * 1.7);
          this.impactGlowGfx.endFill();
          this.impactCoreGfx.beginFill(IMPACT_DROP_BLUE, a * 0.92);
          this.impactCoreGfx.drawCircle(sx, sy, sz);
          this.impactCoreGfx.endFill();
          this.impactCoreGfx.beginFill(0xffffff, a * 0.85);
          this.impactCoreGfx.drawCircle(sx - sz * 0.25, sy - sz * 0.25, sz * 0.30);
          this.impactCoreGfx.endFill();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.lasers = [];
    this.needles = [];
    this.impacts = [];
    this.spineFireFlash.clear();
    this.flowerFireFlash.clear();
    this.hitsBuffer = [];
    this.groundGfx.clear();
    this.shadowGfx.clear();
    this.outlineGfx.clear();
    this.bodyGfx.clear();
    this.highlightGfx.clear();
    this.ridgeGfx.clear();
    this.spineGfx.clear();
    this.flowerGfx.clear();
    this.laserGlowGfx.clear();
    this.laserCoreGfx.clear();
    this.impactGlowGfx.clear();
    this.impactCoreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
