import * as PIXI from 'pixi.js';
import { swapPop } from './utils';
import { isBossType, type EnemyType } from '../types';

/**
 * 물+전기+암흑 3단계 — 흑뢰 토네이도 (Dark Thunder Tornado)
 *
 * 컨셉: **설치형** — 첫 활성 시 플레이어 위치에 **수직 토네이도**가 꽂혀서 고정.
 *       나선 밴드 4겹 + 수직 foreshortening으로 원통 볼륨감, 내부 흡인 + 체인 번개.
 *       물(시안) + 전기(노랑) + 암흑(슬레이트)의 3톤 혼합, 상단 검은 구름 + 크림슨 혈관.
 *
 * 설치형 패턴 (WaterDarkEffect / DarkUltimateEffect 유사):
 *   - 첫 활성 시 `start(px, py)` — 좌표 저장
 *   - `setPosition`는 호출해도 무시 (위치 고정)
 *   - combo 해제 시 `stop()`
 *
 * 3원소 정체성:
 *   💧 물 — 시안 나선 밴드 (sky-400/cyan-300), 흡인 debris의 푸른 연기
 *   ⚡ 전기 — 노란 나선 밴드 (yellow-300/amber-300), 외곽 zigzag 아크, 체인 번개
 *   🖤 암흑 — 슬레이트 다크 base (slate-900/800), 상단 검은 구름 + 크림슨 혈관, 중심 어두운 코어
 *
 * 볼륨감 기법 (Rainbow Deluge 구름 퀄리티 재현):
 *   - 나선 밴드 4겹을 FORESHORTEN=0.32로 세로로 압축 → 원통처럼 보임
 *   - 각 band 포인트의 orbit angle에 따라 전/후 판별 (sin(angle) > 0 → 앞, 밝음)
 *   - 전/후 밝기 차이로 3D 느낌 살림
 *   - band마다 glow(ADD) + body(NORMAL) + core(밝은 라인) 3겹
 *   - 토네이도 body에 GLSL radial swirl 필터 — 실시간 왜곡으로 회오리 살아움직이는 느낌
 *
 * 게임플레이:
 *   - 흡인 반경 260px (radius²로 체크) — 적을 설치 지점 중심으로 끌어당김
 *   - 중심 근접(40px) 도달 시 강타 (CENTER_DAMAGE)
 *   - DoT 6/14f (흡인 반경 내)
 *   - **체인 번개** — 45f마다 내부 적 1마리에서 시작, 4 hop 천천히 전이 (hop 10f 딜레이)
 *   - 체인 라인 = 3색 그라데이션 (시안/노랑/보라) 겹층
 *
 * 좌표계: 월드 좌표 (effectLayer 자식). 설치 지점 anchor, 모든 요소 anchor 기준 오프셋.
 */

// ═══════════════════════════════════════════════════════════════
//  상수
// ═══════════════════════════════════════════════════════════════

// 토네이도 기하 — 실사 적란운 토네이도 형태 (상단 살짝 넓고 바닥 좁음)
const TORNADO_TOP_Y = -250;        // 상단 (y 음수=위), 구름 안쪽까지 살짝 들어감
const TORNADO_BOT_Y = 14;          // 바닥
const TORNADO_TOP_R = 88;          // 상단 반경 (약간 좁아짐)
const TORNADO_MID_R = 58;          // 중단 반경 (병목)
const TORNADO_BOT_R = 26;          // 바닥 반경 (접지점은 좁음)
const TORNADO_BASE_FLARE_R = 70;   // 바닥 흙먼지 펼쳐지는 반경
const FORESHORTEN = 0.34;          // 세로 foreshortening

// 회전
const TORNADO_ROTATION_SPEED = 0.095; // 빠른 회전 (rad/f, 사용자 요청)

// Wisp 입자 (구름처럼 + 느리게 회전 + 외곽 fuzz)
const WISP_COUNT = 180;            // 더 두꺼운 dust column
const WISP_INNER_FRAC = 0.20;      // 내부 입자 비율
const WISP_EDGE_FUZZ_FRAC = 0.32;  // 외곽 바깥으로 삐져나오는 fuzz 비율 (messy edge)

// 흡인
const PULL_RADIUS = 260;
const PULL_RADIUS_SQ = PULL_RADIUS * PULL_RADIUS;
const PULL_STRENGTH = 1.6;         // 기본 (px/f)
const PULL_CENTER_DAMAGE_RADIUS = 42;
const PULL_CENTER_DAMAGE_RSQ = PULL_CENTER_DAMAGE_RADIUS * PULL_CENTER_DAMAGE_RADIUS;
const CENTER_DAMAGE = 28;          // 중심 도달 시 강타
const CENTER_COOLDOWN = 12;        // 적별 중심 강타 쿨 (f)
const DOT_INTERVAL = 14;
const DOT_DAMAGE = 6;

// 체인 번개
const CHAIN_INTERVAL = 45;         // 새 체인 시작 주기 (f)
const CHAIN_HOPS = 4;              // 최대 hop 수
const CHAIN_HOP_DELAY = 10;        // 각 hop 딜레이 (천천히 전이)
const CHAIN_HOP_RANGE = 150;       // hop 탐색 반경
const CHAIN_HOP_RANGE_SQ = CHAIN_HOP_RANGE * CHAIN_HOP_RANGE;
const CHAIN_DAMAGES = [26, 20, 14, 10];
const CHAIN_LINK_LIFE = 28;        // 체인 라인 visible 지속 (f)
const NODE_MAX_TRAVEL = 120;       // rule 5

// 전기 외곽 아크
const EXTERNAL_ARC_MAX = 3;
const EXTERNAL_ARC_LIFE_MIN = 8;
const EXTERNAL_ARC_LIFE_MAX = 16;
const EXTERNAL_ARC_COOLDOWN_MIN = 4;
const EXTERNAL_ARC_COOLDOWN_MAX = 10;

// 흡인 debris
const DEBRIS_SPAWN_RATE = 1.2;     // per frame
const DEBRIS_MAX = 80;

// 외부 흡인 debris (사용자 요청 핵심)
const INCOMING_SPAWN_RATE = 2.5;   // /f, 끊임없이 빨려들어오는 느낌
const INCOMING_MAX = 110;
const INCOMING_DIST_MIN = 180;     // 최소 시작 거리
const INCOMING_DIST_MAX = 320;     // 최대 시작 거리
const INCOMING_TRAIL_LEN = 6;
const INCOMING_KILL_DIST = 60;     // 이 안으로 들어오면 토네이도와 합쳐짐 (소멸)

// 상단 구름 혈관 flicker
const VEIN_COOLDOWN_MIN = 50;
const VEIN_COOLDOWN_MAX = 110;

// ═══════════════════════════════════════════════════════════════
//  팔레트
// ═══════════════════════════════════════════════════════════════

// 암흑 base
const DARK_DEEP = 0x020617;        // slate-950
const DARK_900 = 0x0f172a;         // slate-900
const DARK_800 = 0x1e293b;         // slate-800
const DARK_700 = 0x334155;         // slate-700

// 물 (시안)
const WATER_CYAN_300 = 0x67e8f9;   // cyan-300
const WATER_SKY_400 = 0x38bdf8;    // sky-400
const WATER_SKY_500 = 0x0ea5e9;    // sky-500
const WATER_BLUE_600 = 0x2563eb;   // blue-600

// 전기 (노랑/앰버)
const ELEC_YELLOW_300 = 0xfde047;
const ELEC_YELLOW_400 = 0xfacc15;
const ELEC_AMBER_300 = 0xfcd34d;
const ELEC_AMBER_400 = 0xfbbf24;

// 크림슨 혈관 (상단 구름)
const VEIN_RED_700 = 0xb91c1c;
const VEIN_RED_500 = 0xef4444;

// 체인 번개 (3톤 혼합)
const CHAIN_OUTER = 0x0ea5e9;      // sky-500 (외곽)
const CHAIN_MID = 0xfacc15;        // yellow-400 (중간)
const CHAIN_INNER = 0xa855f7;      // purple-500 (심선, 암흑 정체성)
const CHAIN_CORE_WHITE = 0xf0f9ff; // 거의 흰 코어

// ═══════════════════════════════════════════════════════════════
//  토네이도 형상 헬퍼 — 높이별 반경 (상단=넓고, 중단=병목, 바닥=좁음)
//  실사 토네이도 funnel 곡선 모방 (s-curve)
// ═══════════════════════════════════════════════════════════════

function radiusAtT(t: number): number {
  // t: 0(상단) ~ 1(바닥)
  // 상단(0~0.4): TOP_R → MID_R 살짝 좁아짐
  // 중단(0.4~0.7): MID_R 유지 (병목)
  // 바닥(0.7~1.0): MID_R → BOT_R 빠르게 좁아짐
  if (t < 0.4) {
    const lt = t / 0.4;
    return TORNADO_TOP_R + (TORNADO_MID_R - TORNADO_TOP_R) * (lt * lt);
  } else if (t < 0.7) {
    const lt = (t - 0.4) / 0.3;
    // 살짝 흔들리며 유지 (perlin-like sinus)
    return TORNADO_MID_R + Math.sin(lt * Math.PI) * 4;
  } else {
    const lt = (t - 0.7) / 0.3;
    return TORNADO_MID_R + (TORNADO_BOT_R - TORNADO_MID_R) * Math.pow(lt, 1.4);
  }
}

// ═══════════════════════════════════════════════════════════════
//  타입
// ═══════════════════════════════════════════════════════════════

interface ExternalArc {
  /** 지그재그 포인트 (anchor 기준) */
  points: { ox: number; oy: number }[];
  life: number;
  maxLife: number;
}

interface TopVein {
  /** 상단 구름 내부 지그재그 포인트 (anchor + 구름 offset 기준) */
  points: { ox: number; oy: number }[];
  life: number;
  maxLife: number;
  intensity: number;
}

interface Debris {
  /** 현재 각도/반경/y (anchor 기준 cylindrical) */
  angle: number;
  radius: number;
  y: number;
  vy: number;
  /** 각속도 */
  angSpeed: number;
  /** 반경 수축 속도 (가까워지면 가속) */
  radialSpeed: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=slate 연기, 1=cyan, 2=yellow, 3=bright core spark */
  kind: 0 | 1 | 2 | 3;
}

interface ChainEnemyNode {
  enemyIdx: number;
  /** rule 5 */
  lastX: number;
  lastY: number;
}

interface ChainLink {
  /** 월드 좌표 (시작/끝) */
  x0: number; y0: number;
  x1: number; y1: number;
  life: number;
  maxLife: number;
}

interface ChainWave {
  /** 이미 맞은 적 인덱스 */
  nodes: ChainEnemyNode[];
  /** 현재 hop (0 = 시작점) */
  currentHop: number;
  /** 다음 hop까지 남은 프레임 */
  hopTimer: number;
  /** 이번 wave 종료 여부 */
  done: boolean;
}

/**
 * 외부 흡인 debris — 토네이도 밖 멀리서 spawn → 나선 궤적으로 빨려들어옴.
 * 사용자 요청 "빨려들어가는 주변 효과" 핵심.
 */
interface IncomingDebris {
  /** 월드 좌표 */
  x: number; y: number;
  /** anchor 기준 angular position */
  angle: number;
  /** anchor로부터 거리 */
  distance: number;
  /** 각속도 (회전 흡인) */
  angSpeed: number;
  /** 반경 수축 속도 (가속) */
  inwardSpeed: number;
  /** 트레일 (모션 블러) */
  trail: { x: number; y: number }[];
  size: number;
  life: number;
  maxLife: number;
  /** 0=먼지(slate-500 작은) / 1=조각(slate-700 큰) / 2=시안(물 hint) */
  kind: 0 | 1 | 2;
}

interface GroundSpark {
  angle: number;
  speed: number;
  /** anchor 기준 distance */
  distance: number;
  life: number;
  maxLife: number;
  size: number;
  colorIdx: 0 | 1 | 2; // cyan / yellow / white
}

// ═══════════════════════════════════════════════════════════════
//  Wisp 입자 — 토네이도 본체 구성 (구름 lobe 응용 + 회전)
// ═══════════════════════════════════════════════════════════════

interface WispParticle {
  /** 기본 orbital 각도 */
  baseAngle: number;
  /** 0(상단)~1(바닥) */
  baseT: number;
  /** 0(중심축)~1(외곽) */
  radiusFrac: number;
  /** 입자 크기 */
  size: number;
  /** 개별 회전 속도 변동 (organic 느낌) */
  angularSpeed: number;
  /** wobble 위상 */
  wobblePhase: number;
  wobbleSpeed: number;
  baseAlpha: number;
  /**
   *  0 = 다크 슬레이트 (메인, 70%)
   *  1 = 시안 액센트 (물 hint)
   *  2 = 앰버 액센트 (전기 hint, 내부 flicker)
   *  3 = 미세 밝은 슬레이트 (front-only highlight)
   */
  tint: 0 | 1 | 2 | 3;
}

// ═══════════════════════════════════════════════════════════════
//  메인 클래스
// ═══════════════════════════════════════════════════════════════

export class WaterElectricDarkEffect {
  private container: PIXI.Container;

  /** NORMAL — 바닥 그림자, 접지 halo */
  private groundGfx: PIXI.Graphics;
  /** NORMAL — 흡인 debris */
  private debrisGfx: PIXI.Graphics;
  /** NORMAL — 토네이도 body 후면 (어두움) */
  private tornadoBackGfx: PIXI.Graphics;
  /** NORMAL — 토네이도 body 메인 (GLSL 필터 적용) */
  private tornadoBodyGfx: PIXI.Graphics;
  /** ADD — 토네이도 body 글로우 + 외곽 아크 */
  private tornadoGlowGfx: PIXI.Graphics;
  /** NORMAL — 토네이도 body core (밝은 라인) */
  private tornadoCoreGfx: PIXI.Graphics;
  /** NORMAL — 상단 구름 */
  private topCloudGfx: PIXI.Graphics;
  /** ADD — 상단 구름 혈관 + 크림슨 halo */
  private topCloudGlowGfx: PIXI.Graphics;
  /** ADD — 중심 코어 column + 접지 flare */
  private coreGlowGfx: PIXI.Graphics;
  /** ADD — 체인 번개 */
  private chainGfx: PIXI.Graphics;
  /** NORMAL — 체인 심선, 접지 sparks */
  private chainCoreGfx: PIXI.Graphics;

  /** Wisp 입자 풀 (한 번 생성, 회전만 함) */
  private wisps: WispParticle[] = [];

  active = false;
  private time = 0;

  /** 설치 지점 (고정) */
  private anchorX = 0;
  private anchorY = 0;

  /** 글로벌 회전 */
  private rotation = 0;

  // Pools
  private externalArcs: ExternalArc[] = [];
  private externalArcCooldown = 0;
  private topVeins: TopVein[] = [];
  private veinCooldown = 0;
  private debris: Debris[] = [];
  private debrisSpawnAcc = 0;
  private incomingDebris: IncomingDebris[] = [];
  private incomingSpawnAcc = 0;
  private chainWaves: ChainWave[] = [];
  private chainLinks: ChainLink[] = [];
  private chainCooldown = 0;
  private groundSparks: GroundSpark[] = [];

  /** 적별 DoT 타이머 ({idx: framesUntilTick}) */
  private dotTimers = new Map<number, number>();
  /** 적별 중심 강타 쿨 */
  private centerCooldowns = new Map<number, number>();

  /** 엔진 피해 이벤트 */
  private hitsBuffer: Array<{ x: number; y: number; enemyIdx: number; damage: number }> = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    this.groundGfx = new PIXI.Graphics();
    this.container.addChild(this.groundGfx);

    this.debrisGfx = new PIXI.Graphics();
    this.container.addChild(this.debrisGfx);

    this.tornadoBackGfx = new PIXI.Graphics();
    this.container.addChild(this.tornadoBackGfx);

    this.tornadoBodyGfx = new PIXI.Graphics();
    this.container.addChild(this.tornadoBodyGfx);

    this.tornadoGlowGfx = new PIXI.Graphics();
    this.tornadoGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.tornadoGlowGfx);

    this.tornadoCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.tornadoCoreGfx);

    this.coreGlowGfx = new PIXI.Graphics();
    this.coreGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.coreGlowGfx);

    this.topCloudGfx = new PIXI.Graphics();
    this.container.addChild(this.topCloudGfx);

    this.topCloudGlowGfx = new PIXI.Graphics();
    this.topCloudGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.topCloudGlowGfx);

    this.chainGfx = new PIXI.Graphics();
    this.chainGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.chainGfx);

    this.chainCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.chainCoreGfx);

    // wisp 입자 시스템 사용자 요청으로 제거됨 (drawTornadoMotionStreaks가 대체).
  }

  /**
   * Wisp 입자 풀 생성 — 한 번만, 토네이도 funnel 부피 안에 분산.
   * 외곽 78% (0.55~1.0 radiusFrac), 내부 22% (0.0~0.55).
   * t (높이): 균일 분포. 색 tint: 65% 다크 슬레이트 + 13% 밝은 슬레이트 + 13% 시안 + 9% 앰버.
   */
  private buildWisps() {
    for (let i = 0; i < WISP_COUNT; i++) {
      const t = Math.random();
      const baseAngle = Math.random() * Math.PI * 2;

      // 3그룹: 내부 / 외곽 / edge fuzz (바깥으로 삐져나옴)
      const cat = Math.random();
      let radiusFrac: number;
      if (cat < WISP_INNER_FRAC) {
        radiusFrac = Math.random() * 0.55;            // 내부
      } else if (cat < 1 - WISP_EDGE_FUZZ_FRAC) {
        radiusFrac = 0.55 + Math.random() * 0.45;     // 일반 외곽
      } else {
        radiusFrac = 0.95 + Math.random() * 0.30;     // edge fuzz (1.0~1.25, 토네이도 경계 밖)
      }

      // 크기: 상단 큼, 바닥 작음 (원근감)
      const sizeBase = (5.5 + Math.random() * 4.5) * (1 - t * 0.35);

      // tint 분포
      const tr = Math.random();
      let tint: 0 | 1 | 2 | 3;
      if (tr < 0.65) tint = 0;       // 다크 슬레이트 (메인)
      else if (tr < 0.78) tint = 3;  // 밝은 슬레이트
      else if (tr < 0.91) tint = 1;  // 시안 액센트
      else tint = 2;                  // 앰버 액센트

      this.wisps.push({
        baseAngle,
        baseT: t,
        radiusFrac,
        size: sizeBase,
        angularSpeed: 0.85 + Math.random() * 0.30,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.030 + Math.random() * 0.04,    // 약간 더 활발한 wobble
        baseAlpha: 0.45 + Math.random() * 0.35,
        tint,
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
    this.rotation = 0;
    this.externalArcs = [];
    this.topVeins = [];
    this.debris = [];
    this.incomingDebris = [];
    this.chainWaves = [];
    this.chainLinks = [];
    this.groundSparks = [];
    this.dotTimers.clear();
    this.centerCooldowns.clear();
    this.hitsBuffer = [];
    this.chainCooldown = 20;
    this.container.visible = true;
  }

  /** 설치형이라 위치 이동 무시 — 앵커 고정 */
  setPosition(_x: number, _y: number) {
    // no-op
  }

  /** 현재 설치 위치 (엔진이 직접 참조) */
  getAnchor(): { x: number; y: number } {
    return { x: this.anchorX, y: this.anchorY };
  }

  /** 엔진이 프레임마다 호출 — 적 흡인, DoT, 체인 등 처리 */
  updatePull(dt: number, enemies: Array<{ x: number; y: number; active: boolean; type: EnemyType }>) {
    if (!this.active) return;
    this.hitsBuffer = [];

    // 흡인 & DoT & 중심 강타
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = this.anchorX - e.x;
      const dy = this.anchorY - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > PULL_RADIUS_SQ) {
        // 범위 벗어난 적은 DoT/쿨 제거
        this.dotTimers.delete(i);
        this.centerCooldowns.delete(i);
        continue;
      }
      const dist = Math.sqrt(d2) || 1;
      const nx = dx / dist;
      const ny = dy / dist;

      // 흡인 — 가까울수록 강함 (proximity²)
      const proximity = 1 - dist / PULL_RADIUS;
      const pullSp = PULL_STRENGTH + proximity * proximity * 2.8;
      // 탄젠셜 회전도 살짝 추가 (소용돌이 느낌)
      const tx = -ny;
      const ty = nx;
      const tanSp = 0.45 + proximity * 0.7;
      if (!isBossType(e.type)) {
        e.x += (nx * pullSp + tx * tanSp) * dt;
        e.y += (ny * pullSp + ty * tanSp) * dt;
      }

      // DoT
      let dotT = this.dotTimers.get(i);
      if (dotT === undefined) dotT = DOT_INTERVAL * 0.5;
      dotT -= dt;
      if (dotT <= 0) {
        dotT += DOT_INTERVAL;
        this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: i, damage: DOT_DAMAGE });
        this.spawnGroundSparks(e.x, e.y, 3);
      }
      this.dotTimers.set(i, dotT);

      // 중심 도달 강타
      let cd = this.centerCooldowns.get(i);
      if (cd === undefined) cd = 0;
      cd = Math.max(0, cd - dt);
      if (d2 <= PULL_CENTER_DAMAGE_RSQ && cd <= 0) {
        this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: i, damage: CENTER_DAMAGE });
        this.spawnGroundSparks(e.x, e.y, 7);
        cd = CENTER_COOLDOWN;
      }
      this.centerCooldowns.set(i, cd);
    }

    // 체인 웨이브 — 내부 적 사이로 천천히 전이
    this.chainCooldown -= dt;
    if (this.chainCooldown <= 0) {
      this.startChainWave(enemies);
      this.chainCooldown = CHAIN_INTERVAL;
    }

    // 기존 wave 전이 진행
    this.advanceChainWaves(dt, enemies);
  }

  hitsThisFrame() {
    return this.hitsBuffer;
  }

  // ═══════════════════════════════════════════════════════════
  //  체인 웨이브
  // ═══════════════════════════════════════════════════════════

  private startChainWave(enemies: Array<{ x: number; y: number; active: boolean }>) {
    // 흡인 범위 내 적 중 랜덤 1마리 시작
    const candidates: number[] = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = this.anchorX - e.x;
      const dy = this.anchorY - e.y;
      if (dx * dx + dy * dy <= PULL_RADIUS_SQ) candidates.push(i);
    }
    if (candidates.length === 0) return;
    const startIdx = candidates[Math.floor(Math.random() * candidates.length)];
    const e = enemies[startIdx];

    // 사용자 요청: "토네이도에서 발사되는 전기 체인"
    // 시작점 = 토네이도 본체 안 (상단~중단 어딘가 랜덤)
    const launchT = 0.2 + Math.random() * 0.4; // 상단 20%~60% 사이
    const launchAngle = Math.random() * Math.PI * 2;
    const launchR = radiusAtT(launchT) * (0.4 + Math.random() * 0.4);
    const launchX = this.anchorX + Math.cos(launchAngle) * launchR;
    const launchY = this.anchorY
      + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * launchT
      + Math.sin(launchAngle) * launchR * FORESHORTEN;

    this.chainWaves.push({
      nodes: [{ enemyIdx: startIdx, lastX: e.x, lastY: e.y }],
      currentHop: 0,
      hopTimer: 0,
      done: false,
    });
    // 토네이도 → 첫 적 link 즉시 추가
    this.chainLinks.push({
      x0: launchX, y0: launchY,
      x1: e.x, y1: e.y,
      life: 0,
      maxLife: CHAIN_LINK_LIFE,
    });
    // 시작 노드 즉시 피해
    this.hitsBuffer.push({ x: e.x, y: e.y, enemyIdx: startIdx, damage: CHAIN_DAMAGES[0] });
    this.spawnGroundSparks(e.x, e.y, 5);
  }

  private advanceChainWaves(
    dt: number,
    enemies: Array<{ x: number; y: number; active: boolean }>,
  ) {
    for (let i = this.chainWaves.length - 1; i >= 0; i--) {
      const w = this.chainWaves[i];
      if (w.done) {
        swapPop(this.chainWaves, i);
        continue;
      }
      w.hopTimer += dt;
      if (w.hopTimer < CHAIN_HOP_DELAY) continue;
      w.hopTimer = 0;

      if (w.nodes.length >= CHAIN_HOPS) {
        w.done = true;
        continue;
      }

      // 현재 마지막 노드 위치 (rule 5)
      const last = w.nodes[w.nodes.length - 1];
      const lastEnemy = enemies[last.enemyIdx];
      let curX = last.lastX;
      let curY = last.lastY;
      if (lastEnemy && lastEnemy.active) {
        const dxn = lastEnemy.x - last.lastX;
        const dyn = lastEnemy.y - last.lastY;
        if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
          last.lastX = lastEnemy.x;
          last.lastY = lastEnemy.y;
          curX = lastEnemy.x;
          curY = lastEnemy.y;
        }
      }

      // 다음 타겟 — 반경 내, 이미 맞지 않은 적
      const used = new Set<number>();
      for (const n of w.nodes) used.add(n.enemyIdx);
      let bestIdx = -1;
      let bestD2 = CHAIN_HOP_RANGE_SQ;
      for (let ei = 0; ei < enemies.length; ei++) {
        if (used.has(ei)) continue;
        const e = enemies[ei];
        if (!e.active) continue;
        const dx = e.x - curX;
        const dy = e.y - curY;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = ei;
        }
      }
      if (bestIdx < 0) {
        w.done = true;
        continue;
      }
      const nextE = enemies[bestIdx];
      const hop = w.nodes.length; // 0-index, 시작은 이미 hop 0
      const dmgIdx = Math.min(hop, CHAIN_DAMAGES.length - 1);
      this.hitsBuffer.push({
        x: nextE.x, y: nextE.y, enemyIdx: bestIdx,
        damage: CHAIN_DAMAGES[dmgIdx],
      });
      // 체인 라인 추가 (월드좌표)
      this.chainLinks.push({
        x0: curX, y0: curY,
        x1: nextE.x, y1: nextE.y,
        life: 0,
        maxLife: CHAIN_LINK_LIFE,
      });
      this.spawnGroundSparks(nextE.x, nextE.y, 4);
      w.nodes.push({ enemyIdx: bestIdx, lastX: nextE.x, lastY: nextE.y });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.rotation += TORNADO_ROTATION_SPEED * dt;

    // 외곽 아크
    this.updateExternalArcs(dt);
    // 외부 흡인 debris (토네이도 주변, 빨려들어옴)
    this.updateIncomingDebris(dt);
    // 체인 라인 (수명)
    for (let i = this.chainLinks.length - 1; i >= 0; i--) {
      const l = this.chainLinks[i];
      l.life += dt;
      if (l.life >= l.maxLife) swapPop(this.chainLinks, i);
    }
    // 접지 스파크
    for (let i = this.groundSparks.length - 1; i >= 0; i--) {
      const s = this.groundSparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        swapPop(this.groundSparks, i);
        continue;
      }
      s.distance += s.speed * dt;
      s.speed *= 0.94;
    }

    this.draw();
  }

  private updateExternalArcs(dt: number) {
    this.externalArcCooldown -= dt;
    if (this.externalArcCooldown <= 0 && this.externalArcs.length < EXTERNAL_ARC_MAX) {
      this.spawnExternalArc();
      this.externalArcCooldown = EXTERNAL_ARC_COOLDOWN_MIN
        + Math.random() * (EXTERNAL_ARC_COOLDOWN_MAX - EXTERNAL_ARC_COOLDOWN_MIN);
    }
    for (let i = this.externalArcs.length - 1; i >= 0; i--) {
      const a = this.externalArcs[i];
      a.life += dt;
      if (a.life >= a.maxLife) swapPop(this.externalArcs, i);
    }
  }

  private spawnExternalArc() {
    // 위→아래 방향 지그재그 (토네이도 옆면 외곽)
    const startT = 0.10 + Math.random() * 0.15;
    const endT = 0.80 + Math.random() * 0.15;
    // 회전 기준 각도 — 카메라쪽(앞면)으로 살짝 치우치게
    const baseAngle = (Math.random() * 2 - 1) * Math.PI * 0.7 + this.rotation;
    const segs = 7 + Math.floor(Math.random() * 4);
    const points: { ox: number; oy: number }[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = startT + ((endT - startT) * i) / segs;
      const r = radiusAtT(t) * (1.0 + Math.random() * 0.15); // 외곽 살짝 바깥
      const angle = baseAngle + (Math.random() - 0.5) * 0.3;
      const y = TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
      points.push({
        ox: Math.cos(angle) * r + (Math.random() - 0.5) * 14,
        oy: Math.sin(angle) * r * FORESHORTEN + y + (Math.random() - 0.5) * 10,
      });
    }
    this.externalArcs.push({
      points,
      life: 0,
      maxLife: EXTERNAL_ARC_LIFE_MIN + Math.random() * (EXTERNAL_ARC_LIFE_MAX - EXTERNAL_ARC_LIFE_MIN),
    });
  }

  private updateTopVeins(dt: number) {
    this.veinCooldown -= dt;
    if (this.veinCooldown <= 0 && this.topVeins.length < 4) {
      this.spawnTopVein();
      this.veinCooldown = VEIN_COOLDOWN_MIN + Math.random() * (VEIN_COOLDOWN_MAX - VEIN_COOLDOWN_MIN);
    }
    for (let i = this.topVeins.length - 1; i >= 0; i--) {
      const v = this.topVeins[i];
      v.life -= dt;
      if (v.intensity < 1) v.intensity = Math.min(1, v.intensity + dt * 0.25);
      if (v.life < 8) v.intensity *= 0.92;
      if (v.life <= 0) swapPop(this.topVeins, i);
    }
  }

  private spawnTopVein() {
    // 상단 구름 영역 안에서 지그재그
    const segs = 4 + Math.floor(Math.random() * 3);
    const spreadX = 80;
    const spreadY = 20;
    const baseY = TORNADO_TOP_Y - 18; // 구름 중앙
    const points: { ox: number; oy: number }[] = [];
    let curX = (Math.random() - 0.5) * spreadX;
    let curY = baseY - spreadY * 0.5;
    for (let i = 0; i < segs; i++) {
      points.push({ ox: curX, oy: curY });
      curX += (Math.random() - 0.5) * 40;
      curY += spreadY / segs + (Math.random() - 0.5) * 8;
    }
    this.topVeins.push({
      points,
      life: 18 + Math.random() * 10,
      maxLife: 20,
      intensity: 0,
    });
  }

  private updateDebris(dt: number) {
    this.debrisSpawnAcc += DEBRIS_SPAWN_RATE * dt;
    while (this.debrisSpawnAcc >= 1 && this.debris.length < DEBRIS_MAX) {
      this.debrisSpawnAcc -= 1;
      this.spawnDebris();
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life += dt;
      if (d.life >= d.maxLife || d.radius < 8) {
        swapPop(this.debris, i);
        continue;
      }
      d.angle += d.angSpeed * dt;
      d.radius -= d.radialSpeed * dt;
      d.radialSpeed += 0.018 * dt; // 가속
      d.angSpeed += 0.0012 * dt;   // 회전 가속 (Kepler-ish)
      d.y += d.vy * dt;
      // 위로 드리프트
      if (d.y > TORNADO_TOP_Y + 10) d.vy = Math.max(d.vy - 0.015 * dt, -1.2);
    }
  }

  private spawnDebris() {
    // 바닥 가장자리에서 spawn → 회전하며 위+안으로
    const angle = Math.random() * Math.PI * 2;
    const startR = TORNADO_BOT_R + 10 + Math.random() * 40;
    const startY = TORNADO_BOT_Y - Math.random() * 30;
    const kindRand = Math.random();
    const kind: 0 | 1 | 2 | 3 =
      kindRand < 0.4 ? 0 :
      kindRand < 0.70 ? 1 :
      kindRand < 0.92 ? 2 : 3;
    this.debris.push({
      angle,
      radius: startR,
      y: startY,
      vy: -(0.4 + Math.random() * 0.4),
      angSpeed: 0.05 + Math.random() * 0.03,
      radialSpeed: 0.3 + Math.random() * 0.4,
      life: 0,
      maxLife: 70 + Math.random() * 40,
      size: kind === 3 ? 1.0 + Math.random() * 0.6 : 1.8 + Math.random() * 1.5,
      kind,
    });
  }

  // ───────────────────────────────────────────────────────────
  //  외부 흡인 debris (사용자 요청: 빨려들어가는 효과 강화)
  // ───────────────────────────────────────────────────────────

  private updateIncomingDebris(dt: number) {
    this.incomingSpawnAcc += INCOMING_SPAWN_RATE * dt;
    while (this.incomingSpawnAcc >= 1 && this.incomingDebris.length < INCOMING_MAX) {
      this.incomingSpawnAcc -= 1;
      this.spawnIncomingDebris();
    }

    for (let i = this.incomingDebris.length - 1; i >= 0; i--) {
      const d = this.incomingDebris[i];
      d.life += dt;

      // 거리 수축 (점점 빨라짐)
      d.inwardSpeed += 0.05 * dt;
      d.distance -= d.inwardSpeed * dt;

      // 각속도 가속 (Kepler-ish — 가까울수록 빨리 회전)
      const distFrac = Math.max(0.05, d.distance / INCOMING_DIST_MAX);
      d.angSpeed += (0.0015 / distFrac) * dt;
      d.angle += d.angSpeed * dt;

      // 월드 좌표 재계산
      d.x = this.anchorX + Math.cos(d.angle) * d.distance;
      // y는 살짝 위로 떠올리는 효과 (흙먼지 상승)
      d.y = this.anchorY + Math.sin(d.angle) * d.distance * 0.55 - d.life * 0.15;

      // 트레일 push
      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > INCOMING_TRAIL_LEN) d.trail.shift();

      // 토네이도 안으로 흡수 OR 수명 만료
      if (d.distance < INCOMING_KILL_DIST || d.life >= d.maxLife) {
        swapPop(this.incomingDebris, i);
      }
    }
  }

  private spawnIncomingDebris() {
    // 사방에서 spawn (anchor 기준)
    const angle = Math.random() * Math.PI * 2;
    const distance = INCOMING_DIST_MIN + Math.random() * (INCOMING_DIST_MAX - INCOMING_DIST_MIN);
    // y bias — 좌우 흙먼지가 바닥에서 spawn해서 빨려들어옴
    const x = this.anchorX + Math.cos(angle) * distance;
    const y = this.anchorY + Math.sin(angle) * distance * 0.55;

    const kindR = Math.random();
    const kind: 0 | 1 | 2 =
      kindR < 0.55 ? 0 : kindR < 0.85 ? 1 : 2;

    this.incomingDebris.push({
      x, y,
      angle,
      distance,
      // 시작 각속도 — 회전 방향과 일치 (양수)
      angSpeed: 0.022 + Math.random() * 0.02,
      // 시작 inward 속도 (느림 → 가속)
      inwardSpeed: 0.6 + Math.random() * 0.5,
      trail: [{ x, y }],
      size: kind === 0 ? 1.4 + Math.random() * 0.8
          : kind === 1 ? 2.2 + Math.random() * 1.4
          : 1.6 + Math.random() * 0.7,
      life: 0,
      maxLife: 90 + Math.random() * 30,
      kind,
    });
  }

  private spawnGroundSparks(worldX: number, worldY: number, count: number) {
    // 월드좌표 → anchor-기준 거리
    const dx = worldX - this.anchorX;
    const dy = worldY - this.anchorY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const baseAngle = Math.atan2(dy, dx);
    for (let i = 0; i < count; i++) {
      const a = baseAngle + (Math.random() - 0.5) * 1.0;
      const kindR = Math.random();
      const ci: 0 | 1 | 2 = kindR < 0.45 ? 1 : kindR < 0.8 ? 0 : 2;
      this.groundSparks.push({
        angle: a,
        speed: 1.8 + Math.random() * 1.6,
        distance: dist,
        life: 0,
        maxLife: 12 + Math.random() * 6,
        size: 1.2 + Math.random() * 0.7,
        colorIdx: ci,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.groundGfx.clear();
    this.debrisGfx.clear();
    this.tornadoBackGfx.clear();
    this.tornadoBodyGfx.clear();
    this.tornadoGlowGfx.clear();
    this.tornadoCoreGfx.clear();
    this.topCloudGfx.clear();
    this.topCloudGlowGfx.clear();
    this.coreGlowGfx.clear();
    this.chainGfx.clear();
    this.chainCoreGfx.clear();

    // 사용자 요청: 바닥 장판/상단 구름 제거.
    // 사용자 요청: 토네이도 안 동그란 입자 모두 제거.
    // 흐르는 곡선 + spiral wisp + 내부 음영으로 퀄리티 살림.
    this.drawIncomingDebris();           // 외부 흡인 (뒤쪽 패스)
    this.drawTornadoBack();              // funnel 실루엣 (어두운 mass)
    this.drawTornadoInnerShadows();      // 내부 수직 음영 ribs (깊이감)
    this.drawTornadoMotionStreaks();     // funnel 표면 회전 streak
    this.drawTornadoSpiralWisps();       // 긴 spiral 흐름 (top→bottom)
    this.drawTornadoCore();
    this.drawIncomingDebrisFront();      // 외부 흡인 (앞쪽)
    this.drawExternalArcs();
    this.drawChains();
    this.drawGroundSparks();
  }

  private drawGround() {
    // 사용자 요청: 바닥 장판/그림자 모두 제거.
    // 토네이도 본체와 흡인 입자만으로 visual 완성.
  }

  /**
   * 토네이도 실루엣 — 부드러운 타원 18 tier 누적으로 어두운 본체 mass 형성.
   * 폴리곤 함수 X (각진 느낌). 타원 알파 0.10~0.18로 자연스럽게 겹쳐 funnel 윤곽.
   */
  private drawTornadoBack() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const tiers = 22;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
      const r = radiusAtT(t);
      // 외곽 부드러운 halo (slate-700, 매우 약함 → 모이면 dust mass)
      this.tornadoBackGfx.beginFill(DARK_700, 0.10);
      this.tornadoBackGfx.drawEllipse(ax, y, r * 1.30, r * FORESHORTEN * 1.4);
      this.tornadoBackGfx.endFill();
      // 중간 톤
      this.tornadoBackGfx.beginFill(DARK_900, 0.18);
      this.tornadoBackGfx.drawEllipse(ax, y, r * 1.05, r * FORESHORTEN * 1.15);
      this.tornadoBackGfx.endFill();
      // 깊은 코어 어둠
      this.tornadoBackGfx.beginFill(DARK_DEEP, 0.28);
      this.tornadoBackGfx.drawEllipse(ax, y, r * 0.78, r * FORESHORTEN * 0.85);
      this.tornadoBackGfx.endFill();
    }
  }

  /**
   * 토네이도 회전 motion streaks — funnel 표면을 따라 휘어진 호를 그려서
   * 회전감을 표현. 동그란 입자 ❌, 흐르는 곡선만.
   * 각 tier에서 카메라 앞쪽 호(약 70%)를 그리는데, tier마다 회전 위상이
   * 살짝 어긋나 자연스러운 spiral 패턴 형성.
   */
  private drawTornadoMotionStreaks() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const tiers = 26;
    // 회전 sway (전체 column 흔들림)
    const swayX = Math.sin(this.time * 0.025) * 5;
    const swayTopMul = (t: number) => swayX * (1 - t) + Math.sin(this.time * 0.018 + 0.7) * 6 * Math.pow(1 - t, 2);

    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const baseY = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
      const colSway = swayTopMul(t);
      const cx = ax + colSway;
      const rx = radiusAtT(t);
      const ry = rx * FORESHORTEN;

      // 각 tier마다 다른 회전 위상 → spiral 패턴
      // tier가 아래로 갈수록 위상이 더 진행됨 (회전이 위→아래로 흘러내림 felt)
      const phase = this.rotation + t * Math.PI * 1.6;

      // 호 시작/끝 (앞쪽 약 70%)
      const arcSpan = Math.PI * 0.72;
      const arcCenter = phase;
      // 호 양 끝이 커브의 fade out

      // 3겹 폭으로 그라데이션 두께
      // 외곽 dust glow (slate-700)
      this.drawArcOnEllipse(this.tornadoBackGfx, cx, baseY, rx, ry, arcCenter, arcSpan, 9, DARK_700, 0.22);
      // 중간 dust (slate-800)
      this.drawArcOnEllipse(this.tornadoBackGfx, cx, baseY, rx, ry, arcCenter, arcSpan * 0.85, 5, DARK_900, 0.42);
      // 코어 어두운 stroke (slate-950)
      this.drawArcOnEllipse(this.tornadoBackGfx, cx, baseY, rx, ry, arcCenter, arcSpan * 0.65, 2.5, DARK_DEEP, 0.65);

      // 액센트 streak — 5 tier에 한 번, 시안/앰버 hint
      if (i % 5 === 2) {
        const accentColor = (i % 10 === 2) ? WATER_SKY_500 : ELEC_AMBER_300;
        const accentAlpha = (i % 10 === 2) ? 0.20 : 0.16;
        this.drawArcOnEllipse(this.tornadoGlowGfx, cx, baseY, rx * 1.02, ry * 1.02, arcCenter, arcSpan * 0.5, 3, accentColor, accentAlpha);
      }
    }

    // 외곽 fuzz streak — funnel 경계 밖으로 살짝 삐져나오는 dust 흐름
    // 6 tier에 fuzz arcs
    for (let i = 0; i < 6; i++) {
      const t = 0.15 + (i / 5) * 0.7;
      const baseY = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
      const colSway = swayTopMul(t);
      const cx = ax + colSway;
      const fuzzR = radiusAtT(t) * 1.18; // 1.18× 외곽
      const ry = fuzzR * FORESHORTEN;
      const phase = this.rotation * 1.1 + t * Math.PI * 1.4 + i * 0.3;
      this.drawArcOnEllipse(this.tornadoBackGfx, cx, baseY, fuzzR, ry, phase, Math.PI * 0.4, 6, DARK_800, 0.14);
      this.drawArcOnEllipse(this.tornadoBackGfx, cx, baseY, fuzzR, ry, phase, Math.PI * 0.3, 2.5, DARK_900, 0.30);
    }
  }

  /**
   * 토네이도 내부 음영 — 수직 살짝 휘어진 어두운 ribs로 깊이감 표현.
   * funnel 안쪽이 비어있는 게 아니라 dust로 가득 찬 느낌.
   * 4개 rib, 각 다른 위상 + 미세 sway.
   */
  private drawTornadoInnerShadows() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const ribCount = 4;
    const samples = 16;
    const swayX = Math.sin(this.time * 0.025) * 5;

    for (let r = 0; r < ribCount; r++) {
      // 각 rib은 funnel 안쪽 narrow 영역 (radiusFrac 0.15~0.55) 사이 수직 곡선
      const phaseOffset = (r / ribCount) * Math.PI * 2 + this.rotation * 0.4;
      const radiusFrac = 0.15 + (r % 2) * 0.30; // 0.15 또는 0.45 교대로
      const pts: { x: number; y: number; visible: number }[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const colSway = swayX * (1 - t) + Math.sin(this.time * 0.018 + 0.7) * 6 * Math.pow(1 - t, 2);
        const cx = ax + colSway;
        const baseY = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
        const tornadoR = radiusAtT(t);
        const ribR = tornadoR * radiusFrac;
        const angle = phaseOffset + t * Math.PI * 0.8; // 살짝 trace
        const sinA = Math.sin(angle);
        pts.push({
          x: cx + Math.cos(angle) * ribR,
          y: baseY + sinA * ribR * FORESHORTEN,
          visible: sinA + 0.5,
        });
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const visAvg = Math.max(0, (p0.visible + p1.visible) * 0.5);
        if (visAvg <= 0) continue;
        const a = Math.min(1, visAvg) * 0.45;
        // 깊은 어둠 — funnel 안쪽 그림자
        this.tornadoBackGfx.lineStyle(8, DARK_DEEP, a * 0.45);
        this.tornadoBackGfx.moveTo(p0.x, p0.y);
        this.tornadoBackGfx.lineTo(p1.x, p1.y);
        this.tornadoBackGfx.lineStyle(0);
      }
    }
  }

  /**
   * 긴 spiral 흐름 — top에서 bottom까지 휘감는 curves.
   * 10개, 다른 phase. front-facing 부분만 진하게, back은 fade.
   * dust가 위→아래로 spiral 흘러내리는 felt sense.
   */
  private drawTornadoSpiralWisps() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const wispCount = 10;
    const samples = 38;
    const spiralTurns = 2.4;
    const swayX = Math.sin(this.time * 0.025) * 5;

    for (let w = 0; w < wispCount; w++) {
      const phaseOffset = (w / wispCount) * Math.PI * 2;
      // 각 wisp별 미세 회전 속도 변동 + 위상 흔들림 (organic)
      const wispRotSpeed = 0.65 + (w % 3) * 0.10;
      const wobble = Math.sin(this.time * 0.04 + w * 1.7) * 0.15;

      const pts: { x: number; y: number; visible: number }[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const colSway = swayX * (1 - t) + Math.sin(this.time * 0.018 + 0.7) * 6 * Math.pow(1 - t, 2);
        const cx = ax + colSway;
        const baseY = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
        const rx = radiusAtT(t);
        const ry = rx * FORESHORTEN;
        // spiral angle — t가 늘면서 회전 진행
        const angle = phaseOffset + t * spiralTurns * Math.PI * 2 + this.rotation * wispRotSpeed + wobble;
        const sinA = Math.sin(angle);
        const cosA = Math.cos(angle);
        pts.push({
          x: cx + cosA * rx,
          y: baseY + sinA * ry,
          visible: sinA + 0.4, // 앞쪽 (sin > -0.4) 영역만 보임
        });
      }

      // 폴리라인 — segment별 visible로 alpha 결정
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (p0.visible <= 0 && p1.visible <= 0) continue;
        const visAvg = Math.max(0, (p0.visible + p1.visible) * 0.5);
        const segAlpha = Math.min(1, visAvg);

        // 외곽 dust glow (slate-700, 두꺼움)
        this.tornadoBackGfx.lineStyle(7 + visAvg * 2, DARK_700, segAlpha * 0.18);
        this.tornadoBackGfx.moveTo(p0.x, p0.y);
        this.tornadoBackGfx.lineTo(p1.x, p1.y);
        this.tornadoBackGfx.lineStyle(0);

        // 중간 (slate-900)
        this.tornadoBackGfx.lineStyle(3.5 + visAvg * 1.5, DARK_900, segAlpha * 0.55);
        this.tornadoBackGfx.moveTo(p0.x, p0.y);
        this.tornadoBackGfx.lineTo(p1.x, p1.y);
        this.tornadoBackGfx.lineStyle(0);

        // 코어 (slate-950)
        this.tornadoBackGfx.lineStyle(1.4 + visAvg * 0.6, DARK_DEEP, segAlpha * 0.85);
        this.tornadoBackGfx.moveTo(p0.x, p0.y);
        this.tornadoBackGfx.lineTo(p1.x, p1.y);
        this.tornadoBackGfx.lineStyle(0);
      }
    }
  }

  /**
   * 역방향 회전 액센트 — 메인 spiral과 반대 방향으로 흐르는 시안/앰버 라인.
   * 4개, 미세하게 보이는 정도. 전기/물 정체성 + 회전 다이나믹스 강화.
   */
  private drawTornadoCounterAccents() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const accentCount = 4;
    const samples = 30;
    const counterTurns = -1.6; // 역방향
    const swayX = Math.sin(this.time * 0.025) * 5;

    for (let w = 0; w < accentCount; w++) {
      const phaseOffset = (w / accentCount) * Math.PI * 2 + 0.4;
      const isCyan = w % 2 === 0;
      const accentColor = isCyan ? WATER_SKY_500 : ELEC_AMBER_300;
      const accentBright = isCyan ? WATER_CYAN_300 : ELEC_YELLOW_300;

      const pts: { x: number; y: number; visible: number }[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const colSway = swayX * (1 - t) + Math.sin(this.time * 0.018 + 0.7) * 6 * Math.pow(1 - t, 2);
        const cx = ax + colSway;
        const baseY = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * t;
        const rx = radiusAtT(t) * 1.04; // 살짝 외곽
        const ry = rx * FORESHORTEN;
        const angle = phaseOffset + t * counterTurns * Math.PI * 2 + this.rotation * 0.3;
        const sinA = Math.sin(angle);
        const cosA = Math.cos(angle);
        pts.push({
          x: cx + cosA * rx,
          y: baseY + sinA * ry,
          visible: sinA + 0.3,
        });
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (p0.visible <= 0 && p1.visible <= 0) continue;
        const visAvg = Math.max(0, (p0.visible + p1.visible) * 0.5);
        const segAlpha = Math.min(1, visAvg);

        // ADD glow (subtle)
        this.tornadoGlowGfx.lineStyle(4, accentColor, segAlpha * 0.18);
        this.tornadoGlowGfx.moveTo(p0.x, p0.y);
        this.tornadoGlowGfx.lineTo(p1.x, p1.y);
        this.tornadoGlowGfx.lineStyle(0);

        // 코어 thin bright
        this.tornadoCoreGfx.lineStyle(1.0, accentBright, segAlpha * 0.42);
        this.tornadoCoreGfx.moveTo(p0.x, p0.y);
        this.tornadoCoreGfx.lineTo(p1.x, p1.y);
        this.tornadoCoreGfx.lineStyle(0);
      }
    }
  }

  /** 헬퍼: 타원 호를 폴리라인으로 그림 */
  private drawArcOnEllipse(
    g: PIXI.Graphics,
    cx: number, cy: number,
    rx: number, ry: number,
    centerAngle: number, spanAngle: number,
    width: number, color: number, alpha: number,
  ) {
    const segs = 14;
    const startA = centerAngle - spanAngle * 0.5;
    g.lineStyle(width, color, alpha);
    for (let i = 0; i <= segs; i++) {
      const a = startA + (spanAngle * i) / segs;
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a) * ry;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.lineStyle(0);
  }

  /** 사용자 요청으로 wisp 입자 (drawTornadoBodyAndFront) 제거됨. drawTornadoMotionStreaks가 대체. */
  private drawTornadoBodyAndFront_REMOVED() {
    const ax = this.anchorX;
    const ay = this.anchorY;

    // 컬럼 sway — 토네이도 전체가 살짝 좌우로 흔들림 (실사 토네이도처럼)
    const swayX = Math.sin(this.time * 0.025) * 4;
    const swayTop = Math.sin(this.time * 0.018 + 0.7) * 6; // 상단이 더 흔들림

    for (const w of this.wisps) {
      // 현재 orbital angle (입자별 속도 변동)
      const angle = w.baseAngle + this.rotation * w.angularSpeed;
      const sinA = Math.sin(angle);
      const cosA = Math.cos(angle);
      const frontness = sinA * 0.5 + 0.5; // 0(뒤)~1(앞)

      // wobble (정적이지 않게) + 위로 부유 (rising dust)
      const wobX = Math.sin(this.time * w.wobbleSpeed + w.wobblePhase) * 5;
      const wobY = Math.cos(this.time * w.wobbleSpeed * 1.3 + w.wobblePhase) * 4
                 - Math.sin(this.time * 0.04 + w.wobblePhase * 0.7) * 3; // 살짝 위로

      // 위치 — sway는 상단일수록 강함 (얇은 바닥은 안정적)
      const tornadoR = radiusAtT(w.baseT);
      const r = tornadoR * w.radiusFrac;
      const y = ay + TORNADO_TOP_Y + (TORNADO_BOT_Y - TORNADO_TOP_Y) * w.baseT;
      // 컬럼 sway: 상단(t=0)에 강하고 바닥(t=1)에 0
      const colSway = swayX * (1 - w.baseT) + swayTop * Math.pow(1 - w.baseT, 2);
      const screenX = ax + cosA * r + wobX + colSway;
      const screenY = y + sinA * r * FORESHORTEN + wobY;

      // 크기 — 앞쪽이 살짝 큼
      const sz = w.size * (0.85 + frontness * 0.30);

      // 색 결정 — tint × height
      let bodyColor: number;
      let haloColor: number;
      let highlightColor: number;
      let glowOnFront = false; // ADD glow 사용 여부
      switch (w.tint) {
        case 1: // 시안 액센트
          bodyColor = DARK_800;
          haloColor = WATER_SKY_500;
          highlightColor = WATER_CYAN_300;
          glowOnFront = true;
          break;
        case 2: // 앰버 액센트 (전기)
          bodyColor = DARK_800;
          haloColor = 0xb45309; // amber-700 (어두운 ember)
          highlightColor = ELEC_YELLOW_300;
          glowOnFront = true;
          break;
        case 3: // 밝은 슬레이트
          bodyColor = DARK_700;
          haloColor = 0x475569; // slate-600
          highlightColor = 0x64748b; // slate-500
          break;
        default: // 0 = 다크 슬레이트 (메인)
          bodyColor = DARK_900;
          haloColor = DARK_800;
          highlightColor = DARK_700;
          break;
      }

      // 높이별 톤 변조 — 바닥은 더 dirty/dark, 상단은 살짝 lighter
      if (w.baseT > 0.78) {
        bodyColor = DARK_DEEP;
        haloColor = DARK_900;
      }

      // depth 기반 알파
      const depthMul = 0.45 + frontness * 0.55;
      const finalAlpha = w.baseAlpha * depthMul;

      // ── 1. 외곽 halo (NORMAL, 자연스러운 dust 경계) ──
      this.tornadoBodyGfx.beginFill(haloColor, finalAlpha * 0.30);
      this.tornadoBodyGfx.drawCircle(screenX, screenY, sz * 1.55);
      this.tornadoBodyGfx.endFill();

      // ── 2. 본체 ──
      this.tornadoBodyGfx.beginFill(bodyColor, finalAlpha);
      this.tornadoBodyGfx.drawCircle(screenX, screenY, sz);
      this.tornadoBodyGfx.endFill();

      // ── 3. 앞쪽 살짝 하이라이트 (좌상단 가짜 광원) ──
      if (frontness > 0.5) {
        const hlA = (frontness - 0.5) * 2 * 0.55 * w.baseAlpha;
        this.tornadoBodyGfx.beginFill(highlightColor, hlA);
        this.tornadoBodyGfx.drawCircle(screenX - sz * 0.25, screenY - sz * 0.30, sz * 0.55);
        this.tornadoBodyGfx.endFill();
      }

      // ── 4. 액센트 입자만 ADD glow + 강한 highlight (앞쪽에만) ──
      if (glowOnFront && frontness > 0.55) {
        const ga = (frontness - 0.55) * 2.2 * w.baseAlpha;
        this.tornadoGlowGfx.beginFill(haloColor, ga * 0.55);
        this.tornadoGlowGfx.drawCircle(screenX, screenY, sz * 1.8);
        this.tornadoGlowGfx.endFill();
        this.tornadoCoreGfx.beginFill(highlightColor, ga * 0.85);
        this.tornadoCoreGfx.drawCircle(screenX, screenY, sz * 0.45);
        this.tornadoCoreGfx.endFill();
      }
    }
  }

  private drawTornadoCore() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const cx = ax;
    const topY = ay + TORNADO_TOP_Y + 30;
    const botY = ay + TORNADO_BOT_Y - 4;

    // 미묘한 내부 전기 column (얇고 어두운 크림슨/시안 hint)
    // 토네이도 안에서 살짝 비치는 전기 충전 느낌만
    this.coreGlowGfx.lineStyle(5, WATER_SKY_500, 0.10);
    this.coreGlowGfx.moveTo(cx, topY);
    this.coreGlowGfx.lineTo(cx, botY);
    this.coreGlowGfx.lineStyle(0);

    // 코어 flicker — 가끔 노란 전기 점이 토네이도 내부에 보임
    const flickCount = 5;
    for (let i = 0; i < flickCount; i++) {
      const flickerSeed = Math.sin(this.time * 0.18 + i * 2.1) * 0.5 + 0.5;
      if (flickerSeed < 0.7) continue; // 가끔만 보임
      const ft = 0.1 + (i / flickCount) * 0.8;
      const fy = topY + (botY - topY) * ft;
      // 미세하게 좌우 흔들림
      const fx = cx + Math.sin(this.time * 0.4 + i) * 6;
      const fa = (flickerSeed - 0.7) * 3.3;
      this.coreGlowGfx.beginFill(ELEC_YELLOW_300, fa * 0.5);
      this.coreGlowGfx.drawCircle(fx, fy, 4 * fa);
      this.coreGlowGfx.endFill();
      this.tornadoCoreGfx.beginFill(ELEC_AMBER_300, fa * 0.7);
      this.tornadoCoreGfx.drawCircle(fx, fy, 1.4 * fa);
      this.tornadoCoreGfx.endFill();
    }
  }

  private drawDebris(frontPass: boolean) {
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (const d of this.debris) {
      const sinA = Math.sin(d.angle);
      const isFront = sinA > 0;
      if (frontPass !== isFront) continue;

      const x = ax + Math.cos(d.angle) * d.radius;
      const y = ay + sinA * d.radius * FORESHORTEN + d.y;
      const lifeFrac = d.life / d.maxLife;
      const fadeIn = Math.min(1, lifeFrac / 0.1);
      const fadeOut = Math.min(1, (1 - lifeFrac) / 0.25);
      const a = fadeIn * fadeOut;
      const sz = d.size * (1 + (1 - (d.radius / TORNADO_TOP_R)) * 0.4);

      // 앞/뒤 밝기 차이 (볼륨감)
      const depthA = isFront ? 1.0 : 0.45;

      if (d.kind === 0) {
        // 암흑 연기
        this.debrisGfx.beginFill(DARK_700, a * 0.6 * depthA);
        this.debrisGfx.drawCircle(x, y, sz * 1.6);
        this.debrisGfx.endFill();
        this.debrisGfx.beginFill(DARK_900, a * 0.9 * depthA);
        this.debrisGfx.drawCircle(x, y, sz);
        this.debrisGfx.endFill();
      } else if (d.kind === 1) {
        // 시안 안개
        this.tornadoGlowGfx.beginFill(WATER_SKY_400, a * 0.55 * depthA);
        this.tornadoGlowGfx.drawCircle(x, y, sz * 1.8);
        this.tornadoGlowGfx.endFill();
        this.debrisGfx.beginFill(WATER_SKY_500, a * 0.75 * depthA);
        this.debrisGfx.drawCircle(x, y, sz);
        this.debrisGfx.endFill();
      } else if (d.kind === 2) {
        // 노란 불씨
        this.tornadoGlowGfx.beginFill(ELEC_YELLOW_300, a * 0.65 * depthA);
        this.tornadoGlowGfx.drawCircle(x, y, sz * 1.7);
        this.tornadoGlowGfx.endFill();
        this.debrisGfx.beginFill(ELEC_AMBER_300, a * 0.85 * depthA);
        this.debrisGfx.drawCircle(x, y, sz);
        this.debrisGfx.endFill();
      } else {
        // 밝은 core spark (전기 튄 느낌)
        this.tornadoGlowGfx.beginFill(ELEC_YELLOW_300, a * 0.85 * depthA);
        this.tornadoGlowGfx.drawCircle(x, y, sz * 2.0);
        this.tornadoGlowGfx.endFill();
        this.tornadoCoreGfx.beginFill(0xfffbeb, a * 0.95 * depthA);
        this.tornadoCoreGfx.drawCircle(x, y, sz * 0.7);
        this.tornadoCoreGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  외부 흡인 debris 드로우 — 뒤/앞 패스 분리 (토네이도 본체 occlusion)
  // ───────────────────────────────────────────────────────────

  /** 뒤쪽 패스 — 토네이도 본체 뒤로 가는 입자 (sin > 0 = 뒤편) */
  private drawIncomingDebris() {
    for (const d of this.incomingDebris) {
      // 뒤쪽 = sin(angle) > 0 (foreshortening 좌표계에서 위쪽이 뒤)
      if (Math.sin(d.angle) <= 0) continue;
      this.drawSingleIncomingDebris(d, false);
    }
  }

  /** 앞쪽 패스 — 토네이도 본체 앞으로 보이는 입자 */
  private drawIncomingDebrisFront() {
    for (const d of this.incomingDebris) {
      if (Math.sin(d.angle) > 0) continue;
      this.drawSingleIncomingDebris(d, true);
    }
  }

  private drawSingleIncomingDebris(d: IncomingDebris, isFront: boolean) {
    const lifeFrac = d.life / d.maxLife;
    const fadeIn = Math.min(1, lifeFrac / 0.1);
    const baseAlpha = fadeIn * 0.85;
    // 거리 기반 알파 (가까울수록 흐려짐 = 토네이도와 합쳐지는 felt)
    const distFrac = Math.max(0, d.distance / INCOMING_DIST_MAX);
    const distFade = Math.max(0.3, distFrac);
    const alpha = baseAlpha * distFade;
    const depthMul = isFront ? 1.0 : 0.55;
    const finalA = alpha * depthMul;

    // 색
    let bodyColor: number;
    let trailColor: number;
    let cyanHint = false;
    if (d.kind === 0) {
      bodyColor = DARK_700; trailColor = DARK_800;
    } else if (d.kind === 1) {
      bodyColor = DARK_900; trailColor = DARK_DEEP;
    } else {
      bodyColor = WATER_SKY_500; trailColor = WATER_BLUE_600; cyanHint = true;
    }

    // 트레일 (모션 블러 — 가속감 표현)
    if (d.trail.length > 1) {
      for (let i = 0; i < d.trail.length - 1; i++) {
        const p0 = d.trail[i];
        const p1 = d.trail[i + 1];
        const segFrac = i / d.trail.length;
        const segA = finalA * segFrac * 0.6;
        const w = d.size * (0.4 + segFrac * 0.7);
        const layer = isFront ? this.debrisGfx : this.tornadoBackGfx;
        layer.lineStyle(w, trailColor, segA);
        layer.moveTo(p0.x, p0.y);
        layer.lineTo(p1.x, p1.y);
        layer.lineStyle(0);
      }
    }

    // 본체
    const layer = isFront ? this.debrisGfx : this.tornadoBackGfx;
    layer.beginFill(bodyColor, finalA);
    layer.drawCircle(d.x, d.y, d.size);
    layer.endFill();
    // halo
    layer.beginFill(trailColor, finalA * 0.4);
    layer.drawCircle(d.x, d.y, d.size * 1.6);
    layer.endFill();

    // 시안 액센트 입자만 미세 ADD glow (전기/물 hint)
    if (cyanHint && isFront) {
      this.tornadoGlowGfx.beginFill(WATER_CYAN_300, finalA * 0.45);
      this.tornadoGlowGfx.drawCircle(d.x, d.y, d.size * 1.8);
      this.tornadoGlowGfx.endFill();
    }
  }

  private drawExternalArcs() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (const a of this.externalArcs) {
      if (a.points.length < 2) continue;
      const lifeFrac = a.life / a.maxLife;
      const alpha = 1 - lifeFrac;
      // 3겹: 외곽(sky-500) + 중간(yellow-300) + 코어(white)
      this.tornadoGlowGfx.lineStyle(5, WATER_SKY_500, alpha * 0.55);
      this.tornadoGlowGfx.moveTo(ax + a.points[0].ox, ay + a.points[0].oy);
      for (let i = 1; i < a.points.length; i++) {
        this.tornadoGlowGfx.lineTo(ax + a.points[i].ox, ay + a.points[i].oy);
      }
      this.tornadoGlowGfx.lineStyle(0);

      this.tornadoGlowGfx.lineStyle(2.5, ELEC_YELLOW_300, alpha * 0.85);
      this.tornadoGlowGfx.moveTo(ax + a.points[0].ox, ay + a.points[0].oy);
      for (let i = 1; i < a.points.length; i++) {
        this.tornadoGlowGfx.lineTo(ax + a.points[i].ox, ay + a.points[i].oy);
      }
      this.tornadoGlowGfx.lineStyle(0);

      this.tornadoCoreGfx.lineStyle(1.2, 0xffffff, alpha);
      this.tornadoCoreGfx.moveTo(ax + a.points[0].ox, ay + a.points[0].oy);
      for (let i = 1; i < a.points.length; i++) {
        this.tornadoCoreGfx.lineTo(ax + a.points[i].ox, ay + a.points[i].oy);
      }
      this.tornadoCoreGfx.lineStyle(0);
    }
  }

  /**
   * 상단 구름 — 사용자 요청으로 제거.
   * 토네이도 본체 상단(wisp가 가장 sparse한 부분)이 자연스럽게 페이드아웃.
   */
  private drawTopCloudRemoved() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    const cy = ay + TORNADO_TOP_Y - 38; // 토네이도 상단 살짝 위
    const cw = 240;
    const ch = 64;

    // 가장 외곽 soft halo (어두운 슬레이트, 자연스러운 경계)
    this.topCloudGlowGfx.beginFill(DARK_800, 0.18);
    this.topCloudGlowGfx.drawEllipse(ax, cy + 6, cw * 0.65, ch * 1.1);
    this.topCloudGlowGfx.endFill();
    // 크림슨 박동 halo (subtle, 폭풍의 분노)
    const stormPulse = 0.55 + Math.sin(this.time * 0.08) * 0.35;
    this.topCloudGlowGfx.beginFill(VEIN_RED_700, 0.18 * stormPulse);
    this.topCloudGlowGfx.drawEllipse(ax, cy, cw * 0.50, ch * 0.85);
    this.topCloudGlowGfx.endFill();

    // ── 다층 lobe (Doomcloud 응용, 더 작은 스케일) ──
    // depth 기반 셰이딩 — 뒤=어두움, 앞=살짝 밝음
    const lobes: Array<{ ox: number; oy: number; r: number; depth: number }> = [
      // 바닥 가장자리 (토네이도 쪽으로 매달림)
      { ox: -110, oy: 18, r: 18, depth: 0.10 },
      { ox: -68, oy: 22, r: 22, depth: 0.18 },
      { ox: -18, oy: 24, r: 26, depth: 0.22 },
      { ox: 30, oy: 23, r: 24, depth: 0.20 },
      { ox: 80, oy: 18, r: 20, depth: 0.14 },
      // 하단 본체
      { ox: -88, oy: 4, r: 24, depth: 0.32 },
      { ox: -36, oy: 6, r: 32, depth: 0.42 },
      { ox: 16, oy: 7, r: 36, depth: 0.48 },
      { ox: 60, oy: 4, r: 28, depth: 0.38 },
      // 중단 본체 — 가장 뚜렷
      { ox: -65, oy: -10, r: 28, depth: 0.55 },
      { ox: -16, oy: -12, r: 36, depth: 0.65 },
      { ox: 36, oy: -10, r: 32, depth: 0.58 },
      { ox: -110, oy: -2, r: 18, depth: 0.40 },
      { ox: 92, oy: -4, r: 20, depth: 0.42 },
      // 상단 (앞으로 솟구침, depth 가장 높음)
      { ox: -42, oy: -28, r: 22, depth: 0.78 },
      { ox: -4, oy: -34, r: 28, depth: 0.92 }, // 정점
      { ox: 36, oy: -28, r: 24, depth: 0.82 },
      { ox: -78, oy: -20, r: 16, depth: 0.62 },
      { ox: 70, oy: -22, r: 18, depth: 0.66 },
    ];
    // depth 오름차순 (뒤→앞)
    lobes.sort((a, b) => a.depth - b.depth);
    for (const b of lobes) {
      const x = ax + b.ox;
      const y = cy + b.oy;
      const r = b.r;
      // 1. 외곽 halo (slate-800)
      this.topCloudGfx.beginFill(DARK_800, 0.16);
      this.topCloudGfx.drawCircle(x, y, r * 1.30);
      this.topCloudGfx.endFill();
      // 2. 그림자 crescent (우하단)
      this.topCloudGfx.beginFill(DARK_DEEP, 0.45);
      this.topCloudGfx.drawCircle(x + r * 0.22, y + r * 0.30, r * 0.92);
      this.topCloudGfx.endFill();
      // 3. 본체 — depth 따라 slate-900 → slate-700
      const baseR = Math.round(15 + (51 - 15) * b.depth);
      const baseG = Math.round(23 + (65 - 23) * b.depth);
      const baseB = Math.round(42 + (85 - 42) * b.depth);
      const baseColor = (baseR << 16) | (baseG << 8) | baseB;
      this.topCloudGfx.beginFill(baseColor, 0.92);
      this.topCloudGfx.drawCircle(x, y, r);
      this.topCloudGfx.endFill();
      // 4. 좌상단 미세 주광 (slate-700)
      this.topCloudGfx.beginFill(DARK_700, 0.32);
      this.topCloudGfx.drawCircle(x - r * 0.14, y - r * 0.18, r * 0.74);
      this.topCloudGfx.endFill();
      // 5. 하이라이트 (depth 높을수록 강함)
      if (b.depth > 0.45) {
        const hlA = (b.depth - 0.45) * 1.5 * 0.42;
        this.topCloudGlowGfx.beginFill(0x64748b, hlA); // slate-500
        this.topCloudGlowGfx.drawCircle(x - r * 0.28, y - r * 0.34, r * 0.50);
        this.topCloudGlowGfx.endFill();
      }
    }

    // 바닥 응달 (토네이도 연결부 어두움)
    this.topCloudGfx.beginFill(DARK_DEEP, 0.6);
    this.topCloudGfx.drawEllipse(ax, cy + 28, cw * 0.42, ch * 0.18);
    this.topCloudGfx.endFill();

    // 혈관 (크림슨 flicker)
    for (const v of this.topVeins) {
      if (v.points.length < 2) continue;
      const intensity = v.intensity;
      this.topCloudGlowGfx.lineStyle(4, VEIN_RED_700, intensity * 0.7);
      this.topCloudGlowGfx.moveTo(ax + v.points[0].ox, ay + v.points[0].oy);
      for (let i = 1; i < v.points.length; i++) {
        this.topCloudGlowGfx.lineTo(ax + v.points[i].ox, ay + v.points[i].oy);
      }
      this.topCloudGlowGfx.lineStyle(0);
      this.topCloudGlowGfx.lineStyle(1.8, VEIN_RED_500, intensity);
      this.topCloudGlowGfx.moveTo(ax + v.points[0].ox, ay + v.points[0].oy);
      for (let i = 1; i < v.points.length; i++) {
        this.topCloudGlowGfx.lineTo(ax + v.points[i].ox, ay + v.points[i].oy);
      }
      this.topCloudGlowGfx.lineStyle(0);
    }
  }

  private drawChains() {
    for (const l of this.chainLinks) {
      const lifeFrac = l.life / l.maxLife;
      const alpha = 1 - lifeFrac;
      // 3색 그라데이션 — 세그먼트 3등분해서 각 다른 색
      // 세그먼트 시작점/끝점 기준으로 각 중간점 보간
      const segs = 3;
      const mx1 = l.x0 + (l.x1 - l.x0) * (1 / segs);
      const my1 = l.y0 + (l.y1 - l.y0) * (1 / segs);
      const mx2 = l.x0 + (l.x1 - l.x0) * (2 / segs);
      const my2 = l.y0 + (l.y1 - l.y0) * (2 / segs);

      // 외곽 글로우 (세 구간 각 색)
      this.chainGfx.lineStyle(6, CHAIN_OUTER, alpha * 0.55);
      this.chainGfx.moveTo(l.x0, l.y0);
      this.chainGfx.lineTo(mx1, my1);
      this.chainGfx.lineStyle(0);
      this.chainGfx.lineStyle(6, CHAIN_MID, alpha * 0.55);
      this.chainGfx.moveTo(mx1, my1);
      this.chainGfx.lineTo(mx2, my2);
      this.chainGfx.lineStyle(0);
      this.chainGfx.lineStyle(6, CHAIN_INNER, alpha * 0.55);
      this.chainGfx.moveTo(mx2, my2);
      this.chainGfx.lineTo(l.x1, l.y1);
      this.chainGfx.lineStyle(0);

      // 중간 두께
      this.chainGfx.lineStyle(2.8, CHAIN_OUTER, alpha * 0.85);
      this.chainGfx.moveTo(l.x0, l.y0);
      this.chainGfx.lineTo(mx1, my1);
      this.chainGfx.lineStyle(2.8, CHAIN_MID, alpha * 0.85);
      this.chainGfx.lineTo(mx2, my2);
      this.chainGfx.lineStyle(2.8, CHAIN_INNER, alpha * 0.85);
      this.chainGfx.lineTo(l.x1, l.y1);
      this.chainGfx.lineStyle(0);

      // 심선 (NORMAL 밝은)
      this.chainCoreGfx.lineStyle(1.2, CHAIN_CORE_WHITE, alpha);
      this.chainCoreGfx.moveTo(l.x0, l.y0);
      this.chainCoreGfx.lineTo(l.x1, l.y1);
      this.chainCoreGfx.lineStyle(0);

      // 시작/끝점 강조
      this.chainGfx.beginFill(CHAIN_OUTER, alpha * 0.9);
      this.chainGfx.drawCircle(l.x0, l.y0, 4);
      this.chainGfx.endFill();
      this.chainGfx.beginFill(CHAIN_INNER, alpha * 0.9);
      this.chainGfx.drawCircle(l.x1, l.y1, 4);
      this.chainGfx.endFill();
      this.chainCoreGfx.beginFill(CHAIN_CORE_WHITE, alpha);
      this.chainCoreGfx.drawCircle(l.x0, l.y0, 1.6);
      this.chainCoreGfx.drawCircle(l.x1, l.y1, 1.6);
      this.chainCoreGfx.endFill();
    }
  }

  private drawGroundSparks() {
    const ax = this.anchorX;
    const ay = this.anchorY;
    for (const s of this.groundSparks) {
      const x = ax + Math.cos(s.angle) * s.distance;
      const y = ay + Math.sin(s.angle) * s.distance;
      const frac = s.life / s.maxLife;
      const a = 1 - frac;
      const sz = s.size * (1 - frac * 0.4);
      const color = s.colorIdx === 0 ? WATER_SKY_400
                  : s.colorIdx === 1 ? ELEC_YELLOW_300
                  : 0xffffff;
      this.chainGfx.beginFill(color, a * 0.7);
      this.chainGfx.drawCircle(x, y, sz * 1.8);
      this.chainGfx.endFill();
      this.chainCoreGfx.beginFill(0xffffff, a * 0.9);
      this.chainCoreGfx.drawCircle(x, y, sz * 0.6);
      this.chainCoreGfx.endFill();
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.externalArcs = [];
    this.topVeins = [];
    this.debris = [];
    this.incomingDebris = [];
    this.chainWaves = [];
    this.chainLinks = [];
    this.groundSparks = [];
    this.dotTimers.clear();
    this.centerCooldowns.clear();
    this.hitsBuffer = [];
    this.groundGfx.clear();
    this.debrisGfx.clear();
    this.tornadoBackGfx.clear();
    this.tornadoBodyGfx.clear();
    this.tornadoGlowGfx.clear();
    this.tornadoCoreGfx.clear();
    this.topCloudGfx.clear();
    this.topCloudGlowGfx.clear();
    this.coreGlowGfx.clear();
    this.chainGfx.clear();
    this.chainCoreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
