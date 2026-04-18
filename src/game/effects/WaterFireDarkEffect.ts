import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+불+암흑 3단계 — 종말의 먹구름 (Doomcloud)
 *
 * 컨셉: 캐릭터 머리 위 상시 **검은 뇌운**. 구름 내부에 **진홍 번개 혈관**이
 *        맥박에 맞춰 번쩍이고, 구름 자체가 GLSL radial pulse로 **박동**한다.
 *        구름에서 **검은 사슬/촉수**가 뻗어나와 가까운 적들에게 이어짐.
 *        사슬은 구불구불 파동치며 연결된 적을 **구름(=플레이어) 쪽으로 빨아들임**.
 *        적은 사슬 연결 중 **지속 DoT**, 너무 가까워지면 구름이 삼켜 증발.
 *
 * 3원소 정체성:
 *   💧 물 — 흐르는 사슬 파동 (유체 곡선), 흡인된 적 주변 검은 물방울
 *   🔥 불 — 진홍 번개 혈관 (cloud 내부 flicker), 사슬 외곽 crimson glow,
 *            heartbeat 정점 시 빨간 flash
 *   🖤 암흑 — 검은 구름 전체, 검은 사슬 코어, 흡인 입자, 소멸 연기
 *
 * 사용자 지시 반영:
 *   - "공중부양 X, 구름으로 빨아들이는 느낌" — 흡인은 수평 방향 중심 (적을 위로 들어올리지 X)
 *   - "사슬이 적과 이어지고" — visual은 적 → 구름 상단 wavy line
 *   - "구름이 박동하는 glsl로 느낌" — cloudBody Graphics에만 custom filter 적용,
 *     다른 레이어는 안 건드림 (규칙 7 회피)
 *   - "이펙트/구름 디자인 Rainbow Deluge 잘했던 거 유지, 색감 살려봐"
 *     → 21 lobe 아키텍처 + 6-layer 셰이딩 재활용, 다크 팔레트로 전면 교체
 *
 * 좌표계: 월드 좌표 (effectLayer = worldContainer 자식).
 *   - 구름: player.x, player.y + CLOUD_Y_OFFSET 기준 매 프레임 재계산
 *   - 사슬 끝점: 적 월드 좌표 (rule 5 거리 체크)
 *   - 흡인: enemy.x/y를 player 방향으로 pull
 *
 * 엔진 연결:
 *   - start / setPosition
 *   - updatePull(dt, enemies) — 사슬 재연결 + 흡인 + DoT 틱 집계
 *   - hitsThisFrame() — 이번 프레임 적 손상 이벤트 {x, y, enemyIdx, damage}
 */

// ═══════════════════════════════════════════════════════════════
//  상수
// ═══════════════════════════════════════════════════════════════

const CLOUD_Y_OFFSET = -140;
const CLOUD_WIDTH = 270;
const CLOUD_HEIGHT = 62;

// 사슬
const MAX_TETHERS = 16;            // 더 많은 사슬 (8 → 16)
const TETHER_RANGE = 500;          // 범위 내 적 찾음
const TETHER_RELEASE_RANGE = 620;  // 이 거리 넘으면 연결 끊김
const TETHER_PULL_STRENGTH = 1.35; // 기본 흡인 속도 (px/f)
const TETHER_PULL_ACCEL = 0.012;   // 가까워질수록 가속
const TETHER_MIN_DIST = 44;        // 이 거리 내 진입 = 구름이 삼킴
const TETHER_DOT_INTERVAL = 14;    // 프레임당 DoT 틱
const TETHER_DOT_DAMAGE = 7;       // 틱당 피해
const TETHER_CONSUME_DAMAGE = 40;  // 삼킴 보너스
const TETHER_SEGMENTS = 14;        // 라인 세그먼트 수
const TETHER_WAVE_AMP = 7;         // 파동 진폭
const TETHER_SPAWN_COOLDOWN = 4;   // 새 사슬 생성 쿨 (10 → 4, 빠른 재연결)
const NODE_MAX_TRAVEL = 120;       // rule 5

// 구름 박동 (heartbeat) — 더블비트 (쿵쿵 쉬는 패턴)
const HEARTBEAT_CYCLE = 60;        // 60f = 1초 사이클
const HEARTBEAT_FIRST = 0;         // 0f에 첫번째 쿵
const HEARTBEAT_SECOND = 14;       // 14f에 두번째 쿵
const HEARTBEAT_PEAK_LEN = 10;     // 각 쿵 피크 지속

// 흡인 입자 (적 → 구름)
const SUCK_PARTICLE_RATE = 2;      // 연결된 적 1마리당 n개/f 가능성

// 사슬 끊김/소멸 연기
const DEATH_PUFF_COUNT = 10;

// ═══════════════════════════════════════════════════════════════
//  타입
// ═══════════════════════════════════════════════════════════════

interface CloudLobe {
  ox: number; oy: number;
  r: number;
  /** 0(뒤/어둡) ~ 1(앞/크림슨 혈관 강함) */
  depth: number;
  wobblePhase: number;
  wobbleSpeed: number;
}

interface LightningVein {
  /** 로브 인덱스 (붙어있는 위치) */
  lobeIdx: number;
  /** 현재 세기 0~1 */
  intensity: number;
  /** 지그재그 포인트 (lobe 중심 기준 로컬 offset) */
  points: { ox: number; oy: number }[];
  /** 남은 수명 (f) */
  life: number;
}

interface Tether {
  /** 타겟 적 인덱스 */
  enemyIdx: number;
  /** rule 5: 마지막 안전 좌표 */
  lastX: number; lastY: number;
  /** 사슬 wave 위상 */
  phase: number;
  phaseSpeed: number;
  /** 생성 후 경과 (f) */
  age: number;
  /** 연결 확립 fade-in (0~1, 초기 0에서 증가) */
  establish: number;
  /** 다음 DoT 틱까지 남은 프레임 */
  dotTimer: number;
  /** 사슬 전체 sin noise용 시드 */
  seed: number;
}

interface SuckParticle {
  /** 월드 좌표 */
  x: number; y: number;
  /** 타겟 (구름 방향) — 매 프레임 계산됨 */
  life: number;
  maxLife: number;
  size: number;
  /** 0 = 검은 연기, 1 = crimson 스파크 */
  kind: 0 | 1;
}

interface DeathPuff {
  x: number; y: number;
  age: number;
  shards: { vx: number; vy: number; size: number; life: number; maxLife: number; kind: 0 | 1 }[];
}

/**
 * DoT 틱 + 삼킴 시 적 위치에서 튀어나오는 입자 스플래시.
 * 불+암흑+크림슨 3톤 혼합으로 "타격감" 강화.
 *  kind 0 = 불 (orange→amber→red 수명 그라데이션, 위로 상승)
 *  kind 1 = 암흑 (slate-800/900 연기, 작은 드래그)
 *  kind 2 = 크림슨 스파크 (red-500/400 밝은 플래시, 꼬리 있음)
 *  kind 3 = 화염 불씨 (amber-300 밝은 점, 빠른 페이드 — 기름 튀는 느낌)
 */
interface DotSpark {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  kind: 0 | 1 | 2 | 3;
  /** 회전 효과 (불씨 반짝임용) */
  spin: number;
}

// ═══════════════════════════════════════════════════════════════
//  팔레트 (전부 다크 + 크림슨)
// ═══════════════════════════════════════════════════════════════

// 구름 본체 — 슬레이트 다크
const CLOUD_DEEP = 0x0b1120;      // 거의 검정 (slate-950 근사)
const CLOUD_DARK = 0x0f172a;      // slate-900
const CLOUD_MID = 0x1e293b;       // slate-800
const CLOUD_SOFT = 0x334155;      // slate-700
const CLOUD_HILITE = 0x475569;    // slate-600 (미세 하이라이트)

// 크림슨 혈관 (번개, 박동 때 번쩍)
const VEIN_DEEP = 0x7f1d1d;       // red-900
const VEIN_MID = 0xb91c1c;        // red-700
const VEIN_BRIGHT = 0xef4444;     // red-500
const VEIN_FLASH = 0xfca5a5;      // red-300 (피크만)

// 사슬
const CHAIN_CORE = 0x020617;      // 거의 검정
const CHAIN_GLOW = 0x991b1b;      // red-800
const CHAIN_FLASH = 0xf87171;     // red-400 (flash peak)

// 흡인 입자
const SUCK_SMOKE = 0x1a1033;      // 어두운 보라검정
const SUCK_SPARK = 0xdc2626;      // red-600

// ═══════════════════════════════════════════════════════════════
//  GLSL — 구름 박동 필터 (cloudBody Graphics에만 적용)
// ═══════════════════════════════════════════════════════════════

const HEARTBEAT_FRAG = `
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uTime;
uniform float uPulse;

void main(void) {
  vec2 coord = vTextureCoord;

  // 필터 영역 중심 (보통 0.5,0.5) 기준
  vec2 center = vec2(0.5, 0.55);
  vec2 delta = coord - center;
  float dist = length(delta);

  // radial wave 변위 — pulse peak일수록 강함
  float wave = sin(dist * 18.0 - uTime * 3.5);
  float disp = wave * 0.009 * uPulse;
  vec2 dir = delta / (dist + 0.0001);
  coord = clamp(coord + dir * disp, vec2(0.001), vec2(0.999));

  vec4 c = texture2D(uSampler, coord);

  // 크림슨 틴트 — pulse peak일수록 붉게 빛남
  vec3 crimson = vec3(1.4, 0.55, 0.58);
  float tintStrength = uPulse * 0.32 * c.a;
  c.rgb = mix(c.rgb, c.rgb * crimson, tintStrength);

  gl_FragColor = c;
}
`;

// ═══════════════════════════════════════════════════════════════
//  메인 클래스
// ═══════════════════════════════════════════════════════════════

export class WaterFireDarkEffect {
  private container: PIXI.Container;

  private cloudGlow: PIXI.Graphics;
  private cloudBody: PIXI.Graphics;
  private cloudDetail: PIXI.Graphics;
  private tetherGlow: PIXI.Graphics;
  private tetherCore: PIXI.Graphics;
  private suckGfx: PIXI.Graphics;

  /** 박동 필터 (cloudBody에만 적용) */
  private heartbeatFilter: PIXI.Filter | null = null;

  active = false;
  private time = 0;

  private playerX = 0;
  private playerY = 0;

  private cloudLobes: CloudLobe[] = [];
  private veins: LightningVein[] = [];
  private veinSpawnCooldown = 0;

  private tethers: Tether[] = [];
  private spawnCooldown = 0;

  private suckParticles: SuckParticle[] = [];
  private deathPuffs: DeathPuff[] = [];
  private dotSparks: DotSpark[] = [];

  // 현재 박동 세기 (0~1, heartbeat 피크 시 1)
  private pulseIntensity = 0;

  // 엔진에 전달 — 이번 프레임 피해 이벤트
  private hitsBuffer: Array<{ x: number; y: number; enemyIdx: number; damage: number }> = [];

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // (아래→위) 흡인 입자 → 구름 글로우 → 구름 본체(+필터) → 구름 디테일 → 사슬 글로우 → 사슬 코어
    this.suckGfx = new PIXI.Graphics();
    this.container.addChild(this.suckGfx);

    this.cloudGlow = new PIXI.Graphics();
    this.cloudGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.cloudGlow);

    this.cloudBody = new PIXI.Graphics();
    this.container.addChild(this.cloudBody);

    this.cloudDetail = new PIXI.Graphics();
    this.container.addChild(this.cloudDetail);

    this.tetherGlow = new PIXI.Graphics();
    this.tetherGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.tetherGlow);

    this.tetherCore = new PIXI.Graphics();
    this.container.addChild(this.tetherCore);

    this.buildCloud();
    this.setupFilter();
  }

  private setupFilter() {
    try {
      this.heartbeatFilter = new PIXI.Filter(undefined, HEARTBEAT_FRAG, {
        uTime: 0,
        uPulse: 0,
      });
      this.heartbeatFilter.padding = 8;
      // cloudBody에만 적용 — 다른 레이어 안 건드림
      this.cloudBody.filters = [this.heartbeatFilter];
    } catch {
      // 필터 생성 실패 시 박동은 Graphics만으로 표현
      this.heartbeatFilter = null;
    }
  }

  private buildCloud() {
    // Rainbow Deluge와 동일한 21개 lobe 3단 타워 구조 (아키텍처 재활용)
    const layout: Array<{ ox: number; oy: number; r: number; depth: number }> = [
      // 바닥 가장자리
      { ox: -136, oy: 16, r: 16, depth: 0.10 },
      { ox: -98, oy: 24, r: 25, depth: 0.15 },
      { ox: -44, oy: 28, r: 31, depth: 0.20 },
      { ox: 18, oy: 30, r: 34, depth: 0.22 },
      { ox: 74, oy: 26, r: 29, depth: 0.18 },
      { ox: 126, oy: 20, r: 21, depth: 0.12 },
      // 하단 몸체
      { ox: -110, oy: 8, r: 23, depth: 0.30 },
      { ox: -68, oy: 12, r: 35, depth: 0.40 },
      { ox: -14, oy: 15, r: 43, depth: 0.48 },
      { ox: 44, oy: 14, r: 39, depth: 0.44 },
      { ox: 94, oy: 10, r: 29, depth: 0.36 },
      // 중단 몸체
      { ox: -90, oy: -10, r: 27, depth: 0.52 },
      { ox: -36, oy: -12, r: 39, depth: 0.62 },
      { ox: 16, oy: -14, r: 41, depth: 0.66 },
      { ox: 68, oy: -10, r: 33, depth: 0.58 },
      { ox: 112, oy: -4, r: 23, depth: 0.48 },
      // 상단 탑
      { ox: -58, oy: -34, r: 24, depth: 0.80 },
      { ox: -18, oy: -42, r: 33, depth: 0.95 },
      { ox: 28, oy: -36, r: 28, depth: 0.88 },
      { ox: 72, oy: -28, r: 22, depth: 0.76 },
      { ox: -92, oy: -22, r: 19, depth: 0.70 },
    ];

    for (const l of layout) {
      this.cloudLobes.push({
        ox: l.ox,
        oy: l.oy,
        r: l.r,
        depth: l.depth,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.010 + Math.random() * 0.012,
      });
    }
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
    this.tethers = [];
    this.veins = [];
    this.suckParticles = [];
    this.deathPuffs = [];
    this.dotSparks = [];
    this.hitsBuffer = [];
    this.spawnCooldown = 0;
    this.veinSpawnCooldown = 0;
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.playerX = x;
    this.playerY = y;
  }

  /** 엔진이 매 프레임 호출 — 사슬 흡인 + DoT 틱 + 소멸 처리. rule 5 내장. */
  updatePull(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    if (!this.active) return;
    this.hitsBuffer = [];

    // ── 사슬 유지/끊김/흡인 ──
    for (let i = this.tethers.length - 1; i >= 0; i--) {
      const t = this.tethers[i];
      t.age += dt;
      t.phase += t.phaseSpeed * dt;
      if (t.establish < 1) {
        t.establish = Math.min(1, t.establish + dt * 0.11);
      }

      const e = enemies[t.enemyIdx];
      if (!e || !e.active) {
        // 적 소멸 — 사슬 끊김 연기
        this.spawnDeathPuff(t.lastX, t.lastY, false);
        swapPop(this.tethers, i);
        continue;
      }

      // rule 5 거리 체크
      const dxn = e.x - t.lastX;
      const dyn = e.y - t.lastY;
      let ex: number, ey: number;
      if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
        t.lastX = e.x;
        t.lastY = e.y;
        ex = e.x;
        ey = e.y;
      } else {
        // 풀 재사용 감지 — 마지막 안전 좌표 사용하며 끊음
        this.spawnDeathPuff(t.lastX, t.lastY, false);
        swapPop(this.tethers, i);
        continue;
      }

      // 적과 구름(player)의 거리
      const dxp = this.playerX - ex;
      const dyp = this.playerY - ey;
      const distP = Math.sqrt(dxp * dxp + dyp * dyp);

      // 거리 초과 — **재조준** (끊김 대신 가까운 적으로 옮김)
      if (distP > TETHER_RELEASE_RANGE) {
        const newIdx = this.findRetargetCandidate(enemies, t.enemyIdx);
        if (newIdx >= 0) {
          const newE = enemies[newIdx];
          // 조준 옮김 — 짧은 transition flicker용 establish 재설정
          t.enemyIdx = newIdx;
          t.lastX = newE.x;
          t.lastY = newE.y;
          t.establish = 0.35; // 빠른 재확립
          t.phase = Math.random() * Math.PI * 2;
          t.seed = Math.random() * 1000;
          continue;
        }
        // 근처에 후보 없음 — 그제야 끊음
        this.spawnDeathPuff(ex, ey, false);
        swapPop(this.tethers, i);
        continue;
      }

      // 적을 플레이어 방향으로 끌어당김 (수평 흡인, 공중부양 X)
      if (distP > TETHER_MIN_DIST) {
        const nx = dxp / (distP || 1);
        const ny = dyp / (distP || 1);
        // 가까울수록 가속
        const proximity = 1 - Math.min(1, distP / TETHER_RANGE);
        const pullSpeed = TETHER_PULL_STRENGTH + proximity * proximity * 2.5;
        e.x += nx * pullSpeed * dt;
        e.y += ny * pullSpeed * dt;
      }

      // DoT 틱
      t.dotTimer -= dt;
      if (t.dotTimer <= 0) {
        t.dotTimer += TETHER_DOT_INTERVAL;
        this.hitsBuffer.push({
          x: e.x, y: e.y,
          enemyIdx: t.enemyIdx,
          damage: TETHER_DOT_DAMAGE,
        });
        // 불+암흑+크림슨 입자 스플래시 (기존 엔진 hit particle 대체)
        this.spawnDotBurst(e.x, e.y, false);
      }

      // 삼킴 — 너무 가까이 도달 시 보너스 데미지 + 끊고 연기
      if (distP < TETHER_MIN_DIST) {
        this.hitsBuffer.push({
          x: e.x, y: e.y,
          enemyIdx: t.enemyIdx,
          damage: TETHER_CONSUME_DAMAGE,
        });
        // 삼킴 = 대형 스플래시 + 연기
        this.spawnDotBurst(e.x, e.y, true);
        this.spawnDeathPuff(e.x, e.y, true);
        swapPop(this.tethers, i);
        continue;
      }

      // 흡인 연기 입자 스폰 (적 위치에서 구름 방향)
      if (Math.random() < 0.35 * dt) {
        this.spawnSuckParticle(ex, ey);
      }
    }

    // ── 새 사슬 생성 (쿨다운) ──
    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= 0 && this.tethers.length < MAX_TETHERS) {
      this.trySpawnTether(enemies);
      this.spawnCooldown = TETHER_SPAWN_COOLDOWN;
    }
  }

  private trySpawnTether(enemies: Array<{ x: number; y: number; active: boolean }>) {
    const rangeSq = TETHER_RANGE * TETHER_RANGE;
    const alreadyTethered = new Set<number>();
    for (const t of this.tethers) alreadyTethered.add(t.enemyIdx);

    const candidates: number[] = [];
    for (let ei = 0; ei < enemies.length; ei++) {
      const e = enemies[ei];
      if (!e.active || alreadyTethered.has(ei)) continue;
      const dx = e.x - this.playerX;
      const dy = e.y - this.playerY;
      if (dx * dx + dy * dy <= rangeSq) {
        candidates.push(ei);
      }
    }
    if (candidates.length === 0) return;

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const e = enemies[pick];
    this.tethers.push({
      enemyIdx: pick,
      lastX: e.x,
      lastY: e.y,
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: 0.10 + Math.random() * 0.06,
      age: 0,
      establish: 0,
      dotTimer: TETHER_DOT_INTERVAL * 0.5, // 첫 틱 빠르게
      seed: Math.random() * 1000,
    });
  }

  hitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number; damage: number }> {
    return this.hitsBuffer;
  }

  /** 현재 연결된 적 인덱스 리스트 — 엔진이 슬로우 처리에 사용 */
  tetheredEnemyIds(): number[] {
    const out: number[] = [];
    for (const t of this.tethers) out.push(t.enemyIdx);
    return out;
  }

  // ═══════════════════════════════════════════════════════════
  //  update (EffectManager 호출, draw 포함)
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // ── 박동 세기 계산 (heartbeat) ──
    const beatT = this.time % HEARTBEAT_CYCLE;
    const distFirst = Math.abs(beatT - HEARTBEAT_FIRST);
    const distSecond = Math.abs(beatT - HEARTBEAT_SECOND);
    // 두 피크 중 가까운 것에서 세기 계산 (cycle wrap-around 고려)
    const distA = Math.min(distFirst, HEARTBEAT_CYCLE - distFirst);
    const distB = Math.min(distSecond, HEARTBEAT_CYCLE - distSecond);
    const peakA = Math.max(0, 1 - distA / HEARTBEAT_PEAK_LEN);
    const peakB = Math.max(0, 1 - distB / HEARTBEAT_PEAK_LEN) * 0.7;
    this.pulseIntensity = Math.max(peakA, peakB);

    // GLSL 유니폼 업데이트
    if (this.heartbeatFilter) {
      this.heartbeatFilter.uniforms.uTime = this.time * 0.04;
      this.heartbeatFilter.uniforms.uPulse = this.pulseIntensity;
    }

    // ── 번개 혈관 생성/업데이트 ──
    this.updateVeins(dt);

    // ── 흡인 입자 업데이트 ──
    this.updateSuckParticles(dt);

    // ── 소멸 연기 업데이트 ──
    this.updateDeathPuffs(dt);

    // ── DoT 입자 스플래시 업데이트 ──
    this.updateDotSparks(dt);

    this.draw();
  }

  private updateDotSparks(dt: number) {
    for (let i = this.dotSparks.length - 1; i >= 0; i--) {
      const s = this.dotSparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        swapPop(this.dotSparks, i);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      // kind별 물리
      if (s.kind === 0) {
        // 불: 더 많이 상승, 약한 드래그
        s.vy -= 0.05 * dt;
        s.vx *= 0.93;
      } else if (s.kind === 1) {
        // 암흑 연기: 느린 상승, 강한 드래그
        s.vy -= 0.02 * dt;
        s.vx *= 0.90;
        s.vy *= 0.94;
      } else if (s.kind === 2) {
        // 크림슨: 선형 이동 + 약한 드래그
        s.vx *= 0.92;
        s.vy *= 0.92;
      } else {
        // 불씨: 약한 중력 (아래로 떨어지려고 함 — 기름 튀는 느낌)
        s.vy += 0.045 * dt;
        s.vx *= 0.95;
        s.spin += 0.3 * dt;
      }
    }
  }

  private updateVeins(dt: number) {
    // 박동 피크 시 여러 혈관 동시 생성
    if (this.pulseIntensity > 0.75 && this.veinSpawnCooldown <= 0) {
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        const lobeIdx = Math.floor(Math.random() * this.cloudLobes.length);
        const lobe = this.cloudLobes[lobeIdx];
        // 지그재그 포인트 (로브 중심 기준 로컬)
        const points: { ox: number; oy: number }[] = [];
        const segs = 5 + Math.floor(Math.random() * 3);
        const spread = lobe.r * 0.8;
        for (let s = 0; s < segs; s++) {
          points.push({
            ox: (Math.random() - 0.5) * spread * 2,
            oy: (Math.random() - 0.5) * spread * 1.4,
          });
        }
        this.veins.push({
          lobeIdx,
          intensity: 0,
          points,
          life: 18 + Math.random() * 10,
        });
      }
      this.veinSpawnCooldown = 8;
    }
    this.veinSpawnCooldown = Math.max(0, this.veinSpawnCooldown - dt);

    for (let i = this.veins.length - 1; i >= 0; i--) {
      const v = this.veins[i];
      v.life -= dt;
      // intensity: 빠른 fade-in, 천천히 fade-out
      if (v.intensity < 1) v.intensity = Math.min(1, v.intensity + dt * 0.3);
      if (v.life < 10) v.intensity *= 0.92;
      if (v.life <= 0) swapPop(this.veins, i);
    }
  }

  private updateSuckParticles(dt: number) {
    for (let i = this.suckParticles.length - 1; i >= 0; i--) {
      const p = this.suckParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.suckParticles, i);
        continue;
      }
      // 구름 방향으로 가속 (플레이어 상공)
      const targetX = this.playerX;
      const targetY = this.playerY + CLOUD_Y_OFFSET;
      const dx = targetX - p.x;
      const dy = targetY - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const speed = 2.5 + p.life * 0.15;
      p.x += (dx / d) * speed * dt;
      p.y += (dy / d) * speed * dt;
    }
  }

  private updateDeathPuffs(dt: number) {
    for (let i = this.deathPuffs.length - 1; i >= 0; i--) {
      const p = this.deathPuffs[i];
      p.age += dt;
      for (const s of p.shards) {
        s.life += dt;
        s.vx *= 0.92;
        s.vy = s.vy * 0.92 - 0.04 * dt; // 연기 상승
      }
      if (p.age >= 22) swapPop(this.deathPuffs, i);
    }
  }

  private spawnSuckParticle(x: number, y: number) {
    const kind: 0 | 1 = Math.random() < 0.75 ? 0 : 1;
    this.suckParticles.push({
      x: x + (Math.random() - 0.5) * 16,
      y: y + (Math.random() - 0.5) * 14,
      life: 0,
      maxLife: 26 + Math.random() * 12,
      size: kind === 0 ? 2.6 + Math.random() * 1.8 : 1.4 + Math.random() * 0.7,
      kind,
    });
  }

  /** 재조준 후보 — 범위 내, 다른 사슬에 이미 안 걸린 가장 가까운 적 */
  private findRetargetCandidate(
    enemies: Array<{ x: number; y: number; active: boolean }>,
    excludeIdx: number,
  ): number {
    const alreadyTethered = new Set<number>();
    for (const other of this.tethers) {
      if (other.enemyIdx !== excludeIdx) alreadyTethered.add(other.enemyIdx);
    }
    let bestIdx = -1;
    let bestD2 = TETHER_RANGE * TETHER_RANGE;
    for (let ei = 0; ei < enemies.length; ei++) {
      if (ei === excludeIdx) continue;
      if (alreadyTethered.has(ei)) continue;
      const e = enemies[ei];
      if (!e.active) continue;
      const dx = e.x - this.playerX;
      const dy = e.y - this.playerY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = ei;
      }
    }
    return bestIdx;
  }

  /**
   * DoT/삼킴 시 적 위치에서 불+암흑+크림슨 입자 스플래시.
   * consumed=true면 더 크고 많은 스플래시.
   */
  private spawnDotBurst(x: number, y: number, consumed: boolean) {
    const fireCount = consumed ? 10 : 6;
    const darkCount = consumed ? 6 : 4;
    const crimsonCount = consumed ? 5 : 3;
    const emberCount = consumed ? 8 : 5;

    // 불 (orange, 위쪽 편향 + 약한 상승)
    for (let i = 0; i < fireCount; i++) {
      const a = (i / fireCount) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 1.4 + Math.random() * 1.5 + (consumed ? 0.8 : 0);
      this.dotSparks.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.0 - Math.random() * 0.5,
        life: 0,
        maxLife: 18 + Math.random() * 8,
        size: 1.8 + Math.random() * 1.1 + (consumed ? 0.6 : 0),
        kind: 0,
        spin: 0,
      });
    }
    // 암흑 (slate 연기, 약간 무겁게 퍼짐)
    for (let i = 0; i < darkCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.9 + Math.random() * 0.8;
      this.dotSparks.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.5 - 0.3,
        life: 0,
        maxLife: 22 + Math.random() * 10,
        size: 2.3 + Math.random() * 1.6 + (consumed ? 1.0 : 0),
        kind: 1,
        spin: 0,
      });
    }
    // 크림슨 (red-500, 빠른 방사 플래시)
    for (let i = 0; i < crimsonCount; i++) {
      const a = (i / crimsonCount) * Math.PI * 2 + Math.PI / crimsonCount;
      const sp = 2.2 + Math.random() * 1.4;
      this.dotSparks.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.4,
        life: 0,
        maxLife: 12 + Math.random() * 5,
        size: 1.2 + Math.random() * 0.6,
        kind: 2,
        spin: 0,
      });
    }
    // 불씨 (amber-300 작은 반짝이, 기름 튀는 느낌)
    for (let i = 0; i < emberCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.8 + Math.random() * 2.2;
      this.dotSparks.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.7,
        life: 0,
        maxLife: 10 + Math.random() * 5,
        size: 0.9 + Math.random() * 0.5,
        kind: 3,
        spin: Math.random() * Math.PI * 2,
      });
    }
  }

  private spawnDeathPuff(x: number, y: number, consumed: boolean) {
    const count = consumed ? DEATH_PUFF_COUNT + 6 : DEATH_PUFF_COUNT;
    const shards: DeathPuff['shards'] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const sp = 0.8 + Math.random() * 1.4;
      shards.push({
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.3,
        size: 2.0 + Math.random() * 1.6,
        life: 0,
        maxLife: 16 + Math.random() * 8,
        kind: Math.random() < 0.65 ? 0 : 1,
      });
    }
    this.deathPuffs.push({ x, y, age: 0, shards });
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.cloudGlow.clear();
    this.cloudBody.clear();
    this.cloudDetail.clear();
    this.tetherGlow.clear();
    this.tetherCore.clear();
    this.suckGfx.clear();

    this.drawCloud();
    this.drawSuckParticles();
    this.drawTethers();
    this.drawDeathPuffs();
    this.drawDotSparks();
  }

  // ───────────────────────────────────────────────────────────
  //  DoT 입자 스플래시 — 4톤 혼합 (불/암흑/크림슨/불씨)
  // ───────────────────────────────────────────────────────────

  private drawDotSparks() {
    for (const s of this.dotSparks) {
      const frac = s.life / s.maxLife;
      const a = 1 - frac;

      if (s.kind === 0) {
        // 불 — 주황→앰버→빨강 수명 그라데이션, 글로우 큼
        const color = frac < 0.28 ? 0xfcd34d   // amber-300 (시작 밝음)
                    : frac < 0.50 ? 0xfb923c   // orange-400
                    : frac < 0.72 ? 0xf97316   // orange-500
                    : frac < 0.90 ? 0xea580c   // orange-600
                    : 0xb91c1c;                // red-700 (꺼지기 직전)
        const glowCol = frac < 0.5 ? 0xf97316 : 0x991b1b;
        const sz = s.size * (1 - frac * 0.35);
        this.tetherGlow.beginFill(glowCol, a * 0.55);
        this.tetherGlow.drawCircle(s.x, s.y, sz * 2.3);
        this.tetherGlow.endFill();
        this.tetherCore.beginFill(color, a * 0.92);
        this.tetherCore.drawCircle(s.x, s.y, sz);
        this.tetherCore.endFill();
      } else if (s.kind === 1) {
        // 암흑 연기 — slate, 천천히 팽창
        const sz = s.size * (1 + frac * 0.55);
        const color = frac < 0.45 ? 0x1e293b : 0x0f172a; // slate-800 → slate-900
        this.suckGfx.beginFill(0x334155, a * 0.45);
        this.suckGfx.drawCircle(s.x, s.y, sz * 1.8);
        this.suckGfx.endFill();
        this.suckGfx.beginFill(color, a * 0.88);
        this.suckGfx.drawCircle(s.x, s.y, sz);
        this.suckGfx.endFill();
      } else if (s.kind === 2) {
        // 크림슨 스파크 — 꼬리 있는 플래시
        const color = frac < 0.4 ? 0xef4444 : 0xb91c1c; // red-500 → red-700
        const sz = s.size * (1 - frac * 0.4);
        // 꼬리 (짧은 ADD 라인)
        const tailX = s.x - s.vx * 2.5;
        const tailY = s.y - s.vy * 2.5;
        this.tetherGlow.lineStyle(sz * 1.2, color, a * 0.75);
        this.tetherGlow.moveTo(tailX, tailY);
        this.tetherGlow.lineTo(s.x, s.y);
        this.tetherGlow.lineStyle(0);
        // 헤드 글로우
        this.tetherGlow.beginFill(0xf87171, a * 0.7);
        this.tetherGlow.drawCircle(s.x, s.y, sz * 1.8);
        this.tetherGlow.endFill();
        // 코어
        this.tetherCore.beginFill(0xfecaca, a * 0.9);
        this.tetherCore.drawCircle(s.x, s.y, sz * 0.55);
        this.tetherCore.endFill();
      } else {
        // 불씨 — amber-300, 작고 빠름, 회전 반짝
        const flicker = 0.65 + Math.sin(s.spin) * 0.35;
        const sz = s.size * (1 - frac * 0.3) * flicker;
        this.tetherGlow.beginFill(0xfbbf24, a * 0.75 * flicker);
        this.tetherGlow.drawCircle(s.x, s.y, sz * 1.6);
        this.tetherGlow.endFill();
        this.tetherCore.beginFill(0xfef3c7, a * 0.95);
        this.tetherCore.drawCircle(s.x, s.y, sz * 0.55);
        this.tetherCore.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  구름
  // ───────────────────────────────────────────────────────────

  private drawCloud() {
    const cx = this.playerX;
    const cy = this.playerY + CLOUD_Y_OFFSET;
    const pulse = this.pulseIntensity;

    // ── (A) 박동 외곽 halo — pulse에 따라 팽창 + crimson 빛남 ──
    const haloExpand = 1 + pulse * 0.15;
    // 어두운 외곽 (NORMAL, 배경 어둡게 깔아줌)
    this.cloudBody.beginFill(CLOUD_DEEP, 0.28);
    this.cloudBody.drawEllipse(cx + 6, cy + 32, CLOUD_WIDTH * 0.52 * haloExpand, CLOUD_HEIGHT * 0.38 * haloExpand);
    this.cloudBody.endFill();

    // crimson 박동 halo (ADD, 피크 시 강렬)
    if (pulse > 0.08) {
      const a = pulse * 0.38;
      this.cloudGlow.beginFill(VEIN_DEEP, a * 0.55);
      this.cloudGlow.drawEllipse(cx, cy, CLOUD_WIDTH * 0.55 * haloExpand, CLOUD_HEIGHT * 0.82 * haloExpand);
      this.cloudGlow.endFill();
      this.cloudGlow.beginFill(VEIN_MID, a * 0.35);
      this.cloudGlow.drawEllipse(cx, cy, CLOUD_WIDTH * 0.42 * haloExpand, CLOUD_HEIGHT * 0.62 * haloExpand);
      this.cloudGlow.endFill();
    }

    // ── (B) 로브별 6-layer 셰이딩 (다크 버전) ──
    // 광원: 좌상단에서 약하게 비침 (하이라이트 최소, depth 높은 로브만 희미한 slate-600)
    // 그림자: 우하단 offset, 매우 짙은 slate-950
    for (const l of this.cloudLobes) {
      l.wobblePhase += l.wobbleSpeed;
      // pulse 피크에 크기 살짝 부풀기 (박동 느낌)
      const wob = 1 + Math.sin(l.wobblePhase) * 0.03 + pulse * 0.025 * l.depth;
      const x = cx + l.ox;
      const y = cy + l.oy;
      const r = l.r * wob;

      // 1. 외곽 soft halo (매우 어두운 slate, 경계 부드럽게)
      this.cloudBody.beginFill(CLOUD_DARK, 0.18);
      this.cloudBody.drawCircle(x, y, r * 1.44);
      this.cloudBody.endFill();
      this.cloudBody.beginFill(CLOUD_MID, 0.26);
      this.cloudBody.drawCircle(x, y, r * 1.18);
      this.cloudBody.endFill();

      // 2. 그림자 crescent (매우 짙은, 우하단)
      this.cloudBody.beginFill(CLOUD_DEEP, 0.5);
      this.cloudBody.drawCircle(x + r * 0.22, y + r * 0.30, r * 0.94);
      this.cloudBody.endFill();

      // 3. 본체 — depth에 따라 CLOUD_DARK → CLOUD_SOFT 보간
      const baseR = Math.round(15 + (51 - 15) * l.depth);
      const baseG = Math.round(23 + (65 - 23) * l.depth);
      const baseB = Math.round(42 + (85 - 42) * l.depth);
      const baseColor = (baseR << 16) | (baseG << 8) | baseB;
      this.cloudBody.beginFill(baseColor, 0.92);
      this.cloudBody.drawCircle(x, y, r);
      this.cloudBody.endFill();

      // 4. 내부 미세 주광면 (좌상단, slate-700 약함)
      this.cloudBody.beginFill(CLOUD_SOFT, 0.4);
      this.cloudBody.drawCircle(x - r * 0.12, y - r * 0.16, r * 0.78);
      this.cloudBody.endFill();

      // 5. 최소 하이라이트 (depth 높은 로브만, slate-600 희미)
      if (l.depth > 0.45) {
        const hlA = 0.18 + l.depth * 0.22;
        this.cloudDetail.beginFill(CLOUD_HILITE, hlA);
        this.cloudDetail.drawCircle(x - r * 0.28, y - r * 0.34, r * 0.48);
        this.cloudDetail.endFill();
      }

      // 6. 크림슨 맥동 (pulse 시 로브 내부에 red-900 tint)
      if (pulse > 0.2 && l.depth > 0.3) {
        const ta = pulse * 0.3 * l.depth;
        this.cloudGlow.beginFill(VEIN_DEEP, ta * 0.55);
        this.cloudGlow.drawCircle(x + r * 0.05, y + r * 0.08, r * 0.7);
        this.cloudGlow.endFill();
      }
    }

    // ── (C) 번개 혈관 (lobe 내부 지그재그) ──
    for (const v of this.veins) {
      const lobe = this.cloudLobes[v.lobeIdx];
      const lx = cx + lobe.ox;
      const ly = cy + lobe.oy;
      const intensity = v.intensity * Math.min(1, v.life / 10);

      // 지그재그 라인 3겹 (glow + mid + flash core)
      const n = v.points.length;
      if (n < 2) continue;

      // 외곽 glow (ADD)
      this.tetherGlow.lineStyle(5, VEIN_DEEP, intensity * 0.55);
      this.tetherGlow.moveTo(lx + v.points[0].ox, ly + v.points[0].oy);
      for (let i = 1; i < n; i++) {
        this.tetherGlow.lineTo(lx + v.points[i].ox, ly + v.points[i].oy);
      }
      this.tetherGlow.lineStyle(0);

      // 중간 crimson
      this.tetherGlow.lineStyle(2.5, VEIN_MID, intensity * 0.85);
      this.tetherGlow.moveTo(lx + v.points[0].ox, ly + v.points[0].oy);
      for (let i = 1; i < n; i++) {
        this.tetherGlow.lineTo(lx + v.points[i].ox, ly + v.points[i].oy);
      }
      this.tetherGlow.lineStyle(0);

      // 코어 bright flash
      this.tetherCore.lineStyle(1.2, VEIN_FLASH, intensity);
      this.tetherCore.moveTo(lx + v.points[0].ox, ly + v.points[0].oy);
      for (let i = 1; i < n; i++) {
        this.tetherCore.lineTo(lx + v.points[i].ox, ly + v.points[i].oy);
      }
      this.tetherCore.lineStyle(0);

      // 분기점에 dots
      for (const p of v.points) {
        this.tetherGlow.beginFill(VEIN_BRIGHT, intensity * 0.7);
        this.tetherGlow.drawCircle(lx + p.ox, ly + p.oy, 1.8);
        this.tetherGlow.endFill();
      }
    }

    // ── (D) 구름 하단 어두운 기류 — 사슬 뿌리부 어둠 ──
    this.cloudBody.beginFill(CLOUD_DEEP, 0.35);
    this.cloudBody.drawEllipse(cx + 4, cy + 22, CLOUD_WIDTH * 0.38, CLOUD_HEIGHT * 0.20);
    this.cloudBody.endFill();
  }

  // ───────────────────────────────────────────────────────────
  //  사슬 (tethers)
  // ───────────────────────────────────────────────────────────

  private drawTethers() {
    const cloudX = this.playerX;
    const cloudY = this.playerY + CLOUD_Y_OFFSET + CLOUD_HEIGHT * 0.25;

    for (const t of this.tethers) {
      // 사슬 시작점: 구름 하단에서 적 방향으로 살짝 치우친 위치
      const dxp = t.lastX - cloudX;
      const dyp = t.lastY - cloudY;
      const distP = Math.sqrt(dxp * dxp + dyp * dyp) || 1;
      const startX = cloudX + (dxp / distP) * 30;
      const startY = cloudY + (dyp / distP) * 18;
      const endX = t.lastX;
      const endY = t.lastY;

      // 진행 방향 단위 벡터
      const dx = endX - startX;
      const dy = endY - startY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / len;
      const ny = dy / len;
      // 수직 방향 (파동용)
      const px = -ny;
      const py = nx;

      // 사슬 세그먼트 포인트 계산 (sin 웨이브)
      const pts: { x: number; y: number }[] = [];
      const segs = TETHER_SEGMENTS;
      for (let i = 0; i <= segs; i++) {
        const tf = i / segs;
        // 기본 위치
        const bx = startX + dx * tf;
        const by = startY + dy * tf;
        // 파동 (끝 부분엔 작고, 중간에 크게)
        const amp = TETHER_WAVE_AMP * Math.sin(tf * Math.PI);
        const waveOffset = Math.sin(tf * 6 + t.phase + t.seed) * amp;
        // 2차 고조 (미세)
        const wave2 = Math.sin(tf * 13 - t.phase * 1.6 + t.seed * 0.7) * amp * 0.3;
        const total = (waveOffset + wave2) * t.establish;
        pts.push({
          x: bx + px * total,
          y: by + py * total,
        });
      }

      const alpha = t.establish;

      // ── 외곽 글로우 (ADD, crimson) ──
      this.tetherGlow.lineStyle(7, CHAIN_GLOW, alpha * 0.45);
      this.tetherGlow.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        this.tetherGlow.lineTo(pts[i].x, pts[i].y);
      }
      this.tetherGlow.lineStyle(0);

      // ── 중간 red-900 ──
      this.tetherGlow.lineStyle(3.5, VEIN_DEEP, alpha * 0.75);
      this.tetherGlow.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        this.tetherGlow.lineTo(pts[i].x, pts[i].y);
      }
      this.tetherGlow.lineStyle(0);

      // ── 검은 코어 (NORMAL) ──
      this.tetherCore.lineStyle(1.8, CHAIN_CORE, alpha);
      this.tetherCore.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        this.tetherCore.lineTo(pts[i].x, pts[i].y);
      }
      this.tetherCore.lineStyle(0);

      // ── 박동 시 사슬에 붉은 flash 파동 흘러내림 ──
      if (this.pulseIntensity > 0.5) {
        const flashPos = ((this.time * 0.08 + t.seed) % 1);
        const idx = Math.min(pts.length - 1, Math.floor(flashPos * pts.length));
        const fp = pts[idx];
        const fa = this.pulseIntensity;
        this.tetherGlow.beginFill(CHAIN_FLASH, fa * 0.85);
        this.tetherGlow.drawCircle(fp.x, fp.y, 4 * fa);
        this.tetherGlow.endFill();
        this.tetherCore.beginFill(0xffeaea, fa * 0.9);
        this.tetherCore.drawCircle(fp.x, fp.y, 1.6 * fa);
        this.tetherCore.endFill();
      }

      // ── 적 부착점: 작은 검붉은 매듭 + 안쪽 빨간 불꽃 ──
      this.tetherGlow.beginFill(VEIN_DEEP, alpha * 0.85);
      this.tetherGlow.drawCircle(endX, endY, 7 * alpha);
      this.tetherGlow.endFill();
      this.tetherGlow.beginFill(VEIN_MID, alpha);
      this.tetherGlow.drawCircle(endX, endY, 4 * alpha);
      this.tetherGlow.endFill();
      this.tetherCore.beginFill(CHAIN_CORE, alpha);
      this.tetherCore.drawCircle(endX, endY, 2.2 * alpha);
      this.tetherCore.endFill();
      this.tetherCore.beginFill(VEIN_BRIGHT, alpha * 0.95);
      this.tetherCore.drawCircle(endX, endY, 1.2 * alpha);
      this.tetherCore.endFill();

      // ── 구름 쪽 뿌리: crimson 맥동 점 ──
      const rootPulse = 0.5 + Math.sin(this.time * 0.14 + t.seed) * 0.5;
      this.tetherGlow.beginFill(VEIN_MID, alpha * 0.65 * rootPulse);
      this.tetherGlow.drawCircle(startX, startY, 6);
      this.tetherGlow.endFill();
      this.tetherCore.beginFill(CHAIN_CORE, alpha * 0.9);
      this.tetherCore.drawCircle(startX, startY, 2.4);
      this.tetherCore.endFill();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  흡인 입자 (적→구름)
  // ───────────────────────────────────────────────────────────

  private drawSuckParticles() {
    for (const p of this.suckParticles) {
      const lifeFrac = p.life / p.maxLife;
      const fadeIn = Math.min(1, lifeFrac / 0.15);
      const fadeOut = Math.min(1, (1 - lifeFrac) / 0.45);
      const a = fadeIn * fadeOut;
      const sz = p.size * (1 + lifeFrac * 0.35);

      if (p.kind === 0) {
        // 검은 연기
        this.suckGfx.beginFill(SUCK_SMOKE, a * 0.75);
        this.suckGfx.drawCircle(p.x, p.y, sz * 1.4);
        this.suckGfx.endFill();
        this.suckGfx.beginFill(CLOUD_DARK, a * 0.9);
        this.suckGfx.drawCircle(p.x, p.y, sz);
        this.suckGfx.endFill();
      } else {
        // crimson 스파크 (ADD 아님 — Graphics 하나로 처리)
        this.tetherGlow.beginFill(SUCK_SPARK, a * 0.7);
        this.tetherGlow.drawCircle(p.x, p.y, sz * 1.6);
        this.tetherGlow.endFill();
        this.tetherCore.beginFill(VEIN_FLASH, a * 0.85);
        this.tetherCore.drawCircle(p.x, p.y, sz * 0.5);
        this.tetherCore.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  소멸 연기 (death puff)
  // ───────────────────────────────────────────────────────────

  private drawDeathPuffs() {
    for (const p of this.deathPuffs) {
      for (const s of p.shards) {
        const frac = s.life / s.maxLife;
        if (frac >= 1) continue;
        const a = 1 - frac;
        const sz = s.size * (1 + frac * 0.4);
        const sx = p.x + s.vx * s.life;
        const sy = p.y + s.vy * s.life;
        if (s.kind === 0) {
          this.suckGfx.beginFill(SUCK_SMOKE, a * 0.65);
          this.suckGfx.drawCircle(sx, sy, sz * 1.3);
          this.suckGfx.endFill();
          this.suckGfx.beginFill(CLOUD_DEEP, a * 0.85);
          this.suckGfx.drawCircle(sx, sy, sz * 0.85);
          this.suckGfx.endFill();
        } else {
          this.tetherGlow.beginFill(SUCK_SPARK, a * 0.55);
          this.tetherGlow.drawCircle(sx, sy, sz * 1.5);
          this.tetherGlow.endFill();
          this.tetherCore.beginFill(VEIN_FLASH, a * 0.9);
          this.tetherCore.drawCircle(sx, sy, sz * 0.55);
          this.tetherCore.endFill();
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
    this.tethers = [];
    this.veins = [];
    this.suckParticles = [];
    this.deathPuffs = [];
    this.dotSparks = [];
    this.hitsBuffer = [];
    this.cloudGlow.clear();
    this.cloudBody.clear();
    this.cloudDetail.clear();
    this.tetherGlow.clear();
    this.tetherCore.clear();
    this.suckGfx.clear();
  }

  destroy() {
    this.stop();
    if (this.heartbeatFilter) {
      this.cloudBody.filters = null;
      this.heartbeatFilter = null;
    }
    this.container.destroy({ children: true });
  }
}
