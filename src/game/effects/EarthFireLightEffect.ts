import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 흙+불+빛 3단계 — 천붕 운석 (Empyrean Meteor)
 *
 * 컨셉:
 *  - 사방 360도 넓은 범위에서 운석들이 한 점으로 모임
 *  - 그 자리에 반구(돔) 형태로 에너지가 볼록하게 차오름 (흔들림 + 광자 입자 흡인)
 *  - 임계점 → CRITICAL (강한 진동 + GLSL 일렁임 + 돔 폭주)
 *  - DETONATION → 펑! GLSL 충격파 + 폭발 셀 400 + 화면 flash + 데미지
 *
 * 사이클 (총 300f = 5초):
 *   BUILDUP    (180f) — 매 12f 운석 spawn (총 15발), 에너지 누적, 돔 성장, 광자 흡인
 *   CRITICAL   (30f)  — 돔 폭주 + GLSL 중심 일렁임 + 진동 max
 *   DETONATION (60f)  — GLSL 충격파(uRadius 0→420) + 폭발 셀 400 + 화면 flash + 16 빛줄기
 *   LINGER     (30f)  — 잔화 fade
 *
 * 디자인 차용:
 *   - 운석 본체: EarthDarkEffect 6각형 길쭉 폴리곤 (X 1.6배, motionAngle 회전)
 *   - GLSL: WaterUltimateEffect WAVE_FRAG 변형
 *   - 폭발 셀: WaterUltimateEffect spawnBurst 패턴
 */

// ── GLSL 디스토션 ──
const BLAST_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uStrength;',
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  float wavePos = dist - uRadius;',
  '  float waveWidth = 80.0;',
  '  float wave = exp(-(wavePos * wavePos) / (waveWidth * waveWidth));',
  '',
  '  // CRITICAL 단계 (uRadius=0): 중심 부근 일렁임',
  '  float coreWobble = 0.0;',
  '  if (uRadius < 5.0 && uStrength > 0.05) {',
  '    coreWobble = exp(-(dist * dist) / (130.0 * 130.0));',
  '  }',
  '  float total = wave + coreWobble * 0.7;',
  '',
  '  if (total < 0.01) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  float push = total * uStrength * 110.0;',
  '  float sinePush = sin(dist * 0.05 - uTime * 2.4) * total * uStrength * 26.0;',
  '  vec2 perp = vec2(-dir.y, dir.x);',
  '  float angle = atan(delta.y, delta.x);',
  '  float angularWave = sin(angle * 7.0 + uTime * 1.6) * total * uStrength * 7.0;',
  '',
  '  vec2 distorted = pixCoord - dir * (push + sinePush) + perp * angularWave;',
  '  vec2 distortedUV = distorted / uTexSize;',
  '  vec4 color = texture2D(uSampler, distortedUV);',
  '',
  '  color.rgb += vec3(0.98, 0.45, 0.12) * total * 0.78 * uStrength;',
  '  float coreBand = exp(-(wavePos * wavePos) / (24.0 * 24.0));',
  '  color.rgb += vec3(1.00, 0.82, 0.30) * coreBand * 0.62 * uStrength;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 페이즈 (총 720f = 12초) ──
const PH_BUILDUP = 600;     // 10초 모임
const PH_CRITICAL = 30;     // 0.5초 폭주
const PH_DETONATION = 60;   // 1초 폭발
const PH_LINGER = 30;       // 0.5초 잔화
const PHASE_LEN = [PH_BUILDUP, PH_CRITICAL, PH_DETONATION, PH_LINGER];
const PHASE_BUILDUP = 0;
const PHASE_CRITICAL = 1;
const PHASE_DETONATION = 2;
const PHASE_LINGER = 3;

// ── 운석 (10초 동안 ~75발 모임 → 8f 간격, 바바바바박) ──
const METEOR_SPAWN_INTERVAL = 8;
const METEOR_FALL_DURATION = 28;
const METEOR_IMPACT_DURATION = 8;
const METEOR_SIZE_MIN = 5;
const METEOR_SIZE_MAX = 11;
const METEOR_X_STRETCH = 1.6;
const METEOR_START_DIST_MIN = 220;       // 사방 출발 거리 (넓게)
const METEOR_START_DIST_MAX = 320;
const IMPACT_JITTER = 24;                // 정확한 한 점에 모이도록 jitter 좁힘

// ── 누적 에너지 / 구체 (sphere) ──
const MAX_ENERGY = 75;                   // 75발
const SPHERE_R_BASE = 14;
const SPHERE_R_PER = 1.3;                // max 14 + 97.5 = 111px

// ── 광자 입자 (사방 외곽 → impact 흡인). BUILDUP 10초 길어서 spawn rate 줄임 ──
const PHOTON_SPAWN_PER_FRAME = 2;
const PHOTON_RADIUS = 320;               // spawn 외곽 반경

// ── 폭발 ──
const DET_MAX_RADIUS = 420;              // 강화 (340 → 420)
const DAMAGE_RADIUS = 260;               // 강화 (240 → 260)
const BURST_CELLS = 400;                 // 강화 (280 → 400)
const MINI_SHOCK_R = 55;

// ── 색 (강화된 흙+불+빛 톤) ──
const COL_STONE_950 = 0x0c0a09;
const COL_STONE_900 = 0x1c1917;
const COL_STONE_800 = 0x292524;
const COL_STONE_700 = 0x44403c;
const COL_STONE_600 = 0x57534e;
const COL_STONE_500 = 0x78716c;
const COL_RED_800 = 0x991b1b;
const COL_RED_700 = 0xb91c1c;
const COL_RED_600 = 0xdc2626;
const COL_RED_500 = 0xef4444;
const COL_ORANGE_700 = 0xc2410c;
const COL_ORANGE_600 = 0xea580c;
const COL_ORANGE_500 = 0xf97316;
const COL_ORANGE_400 = 0xfb923c;
const COL_AMBER_500 = 0xf59e0b;
const COL_AMBER_400 = 0xfbbf24;
const COL_AMBER_300 = 0xfcd34d;
const COL_AMBER_200 = 0xfde68a;
const COL_YELLOW_300 = 0xfde047;
const COL_YELLOW_200 = 0xfef08a;
const COL_FLARE = 0xfffbeb;              // amber-50 (백 대체)
// 광자용 보색 (구의 적/주황 대비 cyan)
const COL_SKY_200 = 0xbae6fd;
const COL_SKY_300 = 0x7dd3fc;

// 운석 본체 톤 (강화 — outer 적갈색 짙게 / inner 강렬한 불 색)
const METEOR_TONES: Array<{ outer: number; inner: number; rim: number }> = [
  { outer: COL_RED_800, inner: COL_ORANGE_500, rim: COL_AMBER_300 },
  { outer: COL_STONE_900, inner: COL_RED_500, rim: COL_AMBER_400 },
  { outer: COL_ORANGE_700, inner: COL_AMBER_500, rim: COL_YELLOW_200 },
  { outer: COL_RED_700, inner: COL_ORANGE_400, rim: COL_AMBER_300 },
];

// 폭발 셀 색 보간 (밝게 시작)
const COLOR_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
  { t: 0.00, r: 255, g: 251, b: 235 }, // FLARE
  { t: 0.10, r: 254, g: 240, b: 138 }, // yellow-200
  { t: 0.22, r: 252, g: 211, b: 77 },  // amber-300
  { t: 0.38, r: 251, g: 146, b: 60 },  // orange-400
  { t: 0.55, r: 234, g: 88, b: 12 },   // orange-600
  { t: 0.72, r: 220, g: 38, b: 38 },   // red-600
  { t: 0.88, r: 87, g: 83, b: 78 },    // stone-600
  { t: 1.00, r: 41, g: 37, b: 36 },    // stone-800
];

// ── 타입 ──
interface Meteor {
  targetOX: number; targetOY: number;
  startOX: number; startOY: number;
  phase: number;
  timer: number;
  size: number;
  toneIdx: number;
  hexNoise: number[];
  shockProgress: number;
}

interface Cell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  tStart: number; tEnd: number;
  type: number;
}

// 폭발 시 사방으로 튀어나가는 유성 잔해 (모인 운석이 반대로 날아감)
interface EjectaMeteor {
  x: number; y: number;          // 월드
  prevX: number; prevY: number;
  vx: number; vy: number;
  rotation: number;              // motionAngle (속도 방향)
  size: number;
  toneIdx: number;
  hexNoise: number[];
  life: number; maxLife: number;
}

interface Photon {
  // 컨테이너 로컬 (impactX/Y 기준)
  ox: number; oy: number;
  // 시작 거리/각도 — lerp용
  startR: number; angle: number;
  life: number; maxLife: number;
  size: number;
  color: number;
  // trail용 prev
  prevOX: number; prevOY: number;
}

export class EarthFireLightEffect {
  private container: PIXI.Container;
  private gfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;
  private flashGfx: PIXI.Graphics;        // 화면 flash 전용
  private worldContainer: PIXI.Container;
  private filter: PIXI.Filter | null = null;

  active = false;
  private posX = 0;
  private posY = 0;
  private impactX = 0;
  private impactY = 0;
  private screenX = 0;
  private screenY = 0;

  private time = 0;
  private phase = PHASE_BUILDUP;
  private phaseTimer = 0;

  private spawnTimer = 0;
  private spawnedCount = 0;
  private energy = 0;

  private blastRadius = 0;
  private blastStrength = 0;

  private meteors: Meteor[] = [];
  private cells: Cell[] = [];
  private photons: Photon[] = [];
  private ejecta: EjectaMeteor[] = [];
  private detonationFired = false;
  private flashAlpha = 0;

  // 엔진 통신
  private _impacts: { x: number; y: number }[] = [];

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);

    this.flashGfx = new PIXI.Graphics();
    this.flashGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.flashGfx);
  }

  setPosition(x: number, y: number) { this.posX = x; this.posY = y; }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x; this.posY = y;
    this.time = 0;
    this.phase = PHASE_BUILDUP;
    this.phaseTimer = 0;
    this.spawnTimer = 0;
    this.spawnedCount = 0;
    this.energy = 0;
    this.blastRadius = 0;
    this.blastStrength = 0;
    this.meteors = [];
    this.cells = [];
    this.photons = [];
    this.ejecta = [];
    this._impacts = [];
    this.detonationFired = false;
    this.flashAlpha = 0;

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, BLAST_FRAG, {
        uCenter: [0, 0],
        uRadius: 0,
        uStrength: 0,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;
      const f = this.filter;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      f.apply = function (filterManager: any, input: any, output: any, clearMode: any) {
        if (input && input.width > 0) {
          f.uniforms.uTexSize = [input.width, input.height];
        }
        filterManager.applyFilter(f, input, output, clearMode);
      };
    }

    this.pickImpactPoint();
  }

  impactsThisFrame(): { x: number; y: number }[] { return this._impacts; }
  impactRadius(): number { return DAMAGE_RADIUS; }

  private pickImpactPoint() {
    const a = Math.random() * Math.PI * 2;
    const r = 50 + Math.random() * 110;
    this.impactX = this.posX + Math.cos(a) * r;
    this.impactY = this.posY + Math.sin(a) * r;
  }

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active) return;
    this.time += dt;
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;
    this._impacts = [];

    // 페이즈 전환
    this.phaseTimer += dt;
    const curLen = PHASE_LEN[this.phase];
    if (this.phaseTimer >= curLen) {
      this.phaseTimer -= curLen;
      this.phase = (this.phase + 1) % PHASE_LEN.length;
      if (this.phase === PHASE_BUILDUP) {
        this.detonationFired = false;
        this.spawnedCount = 0;
        this.spawnTimer = 0;
        this.energy = 0;
        this.meteors = [];
        this.photons = [];
        this.flashAlpha = 0;
        this.pickImpactPoint();
      }
      if (this.phase === PHASE_CRITICAL) {
        this.attachFilter();
      }
      if (this.phase === PHASE_DETONATION && !this.detonationFired) {
        this.detonationFired = true;
        this._impacts.push({ x: this.impactX, y: this.impactY });
        this.spawnDetonationBurst();
        this.spawnDetonationEjecta();    // 모인 유성이 반대로 사방 비산
        this.flashAlpha = 1.0;             // 화면 flash 시작
      }
    }

    // BUILDUP — 운석 + 광자 spawn
    if (this.phase === PHASE_BUILDUP) {
      this.spawnTimer += dt;
      while (this.spawnTimer >= METEOR_SPAWN_INTERVAL && this.spawnedCount < MAX_ENERGY) {
        this.spawnTimer -= METEOR_SPAWN_INTERVAL;
        this.spawnMeteor();
        this.spawnedCount++;
      }
      // 광자 흡인 — 매 프레임 4개
      for (let i = 0; i < PHOTON_SPAWN_PER_FRAME; i++) {
        this.spawnPhoton(false);
      }
    }
    if (this.phase === PHASE_CRITICAL) {
      // CRITICAL 동안 더 많은 광자 (폭주)
      for (let i = 0; i < PHOTON_SPAWN_PER_FRAME * 2; i++) {
        this.spawnPhoton(true);
      }
    }

    // 운석 update
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.timer += dt;
      if (m.phase === 0) {
        if (m.timer >= METEOR_FALL_DURATION) {
          m.phase = 1;
          m.timer = 0;
          m.shockProgress = 0;
          this.energy = Math.min(MAX_ENERGY, this.energy + 1);
        }
      } else {
        m.shockProgress += dt / 14;
        if (m.timer >= METEOR_IMPACT_DURATION && m.shockProgress >= 1) {
          swapPop(this.meteors, i);
        }
      }
    }

    // 광자 update — center로 lerp + 수명
    for (let i = this.photons.length - 1; i >= 0; i--) {
      const p = this.photons[i];
      p.life += dt;
      p.prevOX = p.ox;
      p.prevOY = p.oy;
      // 수명 비례 거리 감소 (외곽 → 중심)
      const t = p.life / p.maxLife;
      const easeT = t * t; // 가속
      const r = p.startR * (1 - easeT);
      p.ox = Math.cos(p.angle) * r;
      p.oy = Math.sin(p.angle) * r;
      // 약간 회전 (소용돌이 느낌)
      p.angle += 0.04;
      if (p.life >= p.maxLife) swapPop(this.photons, i);
    }

    // GLSL 상태
    if (this.phase === PHASE_CRITICAL) {
      const t = this.phaseTimer / PH_CRITICAL;
      this.blastRadius = 0;
      this.blastStrength = t * 0.7;
    } else if (this.phase === PHASE_DETONATION) {
      const t = this.phaseTimer / PH_DETONATION;
      this.blastRadius = DET_MAX_RADIUS * Math.sqrt(t);
      this.blastStrength = Math.max(0, 1 - t * 0.85);
    } else if (this.phase === PHASE_LINGER) {
      this.blastRadius = 0;
      this.blastStrength = 0;
      this.detachFilter();
    } else {
      this.blastRadius = 0;
      this.blastStrength = 0;
    }

    if (this.filter) {
      const ix = this.impactX - cameraX;
      const iy = this.impactY - cameraY;
      this.filter.uniforms.uCenter = [ix, iy];
      this.filter.uniforms.uRadius = this.blastRadius;
      this.filter.uniforms.uStrength = this.blastStrength;
      this.filter.uniforms.uTime = this.time * 0.016;
    }

    // ejecta update (사방 비산 운석 + 약중력 + 트레일)
    for (let i = this.ejecta.length - 1; i >= 0; i--) {
      const e = this.ejecta[i];
      e.life += dt;
      e.prevX = e.x; e.prevY = e.y;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vx *= 0.97;
      e.vy = e.vy * 0.97 + 0.10 * dt;
      // rotation은 속도 방향으로 갱신
      const sp2 = e.vx * e.vx + e.vy * e.vy;
      if (sp2 > 0.5) e.rotation = Math.atan2(e.vy, e.vx);
      if (e.life >= e.maxLife) swapPop(this.ejecta, i);
    }

    // 셀 update
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.prevX = c.x; c.prevY = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.94;
      c.vy = c.vy * 0.94 + (c.type === 0 ? -0.06 : 0.05) * dt;
      c.life -= dt;
      if (c.life <= 0) swapPop(this.cells, i);
    }

    // 화면 flash 페이드
    this.flashAlpha *= 0.86;
    if (this.flashAlpha < 0.01) this.flashAlpha = 0;

    this.draw(cameraX, cameraY);
  }

  private attachFilter() {
    if (!this.filter) return;
    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);
    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  private detachFilter() {
    if (!this.filter || !this.worldContainer.filters) return;
    this.worldContainer.filters = this.worldContainer.filters.filter(f => f !== this.filter);
    if (this.worldContainer.filters.length === 0) {
      this.worldContainer.filters = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.worldContainer.filterArea = null as any;
    }
  }

  // ── 운석 spawn (사방 360도 random angle, 한 점으로 모임) ──
  private spawnMeteor() {
    // 충돌점은 거의 동일 (좁은 jitter)
    const ja = Math.random() * Math.PI * 2;
    const jr = Math.random() * IMPACT_JITTER;
    const tox = Math.cos(ja) * jr;
    const toy = Math.sin(ja) * jr;
    // 시작점: 사방 random (각도 0~2π)
    const startAngle = Math.random() * Math.PI * 2;
    const startR = METEOR_START_DIST_MIN + Math.random() * (METEOR_START_DIST_MAX - METEOR_START_DIST_MIN);
    const startOX = Math.cos(startAngle) * startR;
    const startOY = Math.sin(startAngle) * startR;

    const noise: number[] = [];
    for (let i = 0; i < 6; i++) noise.push((Math.random() - 0.5) * 0.4);

    this.meteors.push({
      targetOX: tox,
      targetOY: toy,
      startOX, startOY,
      phase: 0,
      timer: 0,
      size: METEOR_SIZE_MIN + Math.random() * (METEOR_SIZE_MAX - METEOR_SIZE_MIN),
      toneIdx: Math.floor(Math.random() * METEOR_TONES.length),
      hexNoise: noise,
      shockProgress: 0,
    });
  }

  // ── 광자 spawn (사방 외곽에서 random, 중심으로 lerp) ──
  private spawnPhoton(critical: boolean) {
    const angle = Math.random() * Math.PI * 2;
    const startR = PHOTON_RADIUS * (0.6 + Math.random() * 0.5);
    const ox = Math.cos(angle) * startR;
    const oy = Math.sin(angle) * startR;
    // 색: 대비 강한 cyan/sky + amber 혼합 (구의 적/주황 대비 보색)
    const r = Math.random();
    let color: number;
    if (critical) {
      color = r < 0.4 ? COL_SKY_200 : (r < 0.75 ? COL_FLARE : COL_YELLOW_200);
    } else {
      color = r < 0.5 ? COL_SKY_200 : (r < 0.8 ? COL_SKY_300 : COL_AMBER_300);
    }
    this.photons.push({
      ox, oy, prevOX: ox, prevOY: oy,
      startR, angle,
      life: 0,
      maxLife: 34 + Math.random() * 24,
      size: 2.0 + Math.random() * 2.2,    // 1.1~2.7 → 2.0~4.2 (가시성 ↑)
      color,
    });
  }

  // ── DETONATION 비산 운석 (모인 운석이 반대로 사방으로 튀어나감) ──
  private spawnDetonationEjecta() {
    const N = 16;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 8 + Math.random() * 7;     // 빠르게 튐
      const noise: number[] = [];
      for (let j = 0; j < 6; j++) noise.push((Math.random() - 0.5) * 0.4);
      const startR = 8 + Math.random() * 14;
      this.ejecta.push({
        x: this.impactX + Math.cos(angle) * startR,
        y: this.impactY + Math.sin(angle) * startR,
        prevX: this.impactX, prevY: this.impactY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,     // 살짝 위쪽 편향
        rotation: angle,
        size: METEOR_SIZE_MIN + Math.random() * (METEOR_SIZE_MAX - METEOR_SIZE_MIN),
        toneIdx: Math.floor(Math.random() * METEOR_TONES.length),
        hexNoise: noise,
        life: 0,
        maxLife: 36 + Math.random() * 22,
      });
    }
  }

  // ── DETONATION 폭발 셀 ──
  private spawnDetonationBurst() {
    for (let i = 0; i < BURST_CELLS; i++) {
      const angle = (i / BURST_CELLS) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const baseR = 16 + Math.random() * 32;
      const r = baseR + Math.sin(angle * 5 + this.time * 0.2) * 8;
      const sx = this.impactX + Math.cos(angle) * r;
      const sy = this.impactY + Math.sin(angle) * r;
      const speed = 5 + Math.random() * 13;

      const rType = Math.random();
      let type: number; let size: number; let life: number; let tStart: number; let tEnd: number;
      if (rType < 0.40) {
        type = 0; size = 2.2 + Math.random() * 2.6;
        life = 22 + Math.random() * 18; tStart = 0.00; tEnd = 0.45;
      } else if (rType < 0.78) {
        type = 1; size = 2.0 + Math.random() * 2.8;
        life = 30 + Math.random() * 22; tStart = 0.20; tEnd = 0.80;
      } else {
        type = 2; size = 1.6 + Math.random() * 2.2;
        life = 36 + Math.random() * 24; tStart = 0.55; tEnd = 1.00;
      }

      this.cells.push({
        x: sx, y: sy, prevX: sx, prevY: sy,
        vx: Math.cos(angle) * speed * (type === 0 ? 1.15 : 1.0),
        vy: Math.sin(angle) * speed * (type === 0 ? 1.15 : 1.0) - (type === 0 ? 1.8 : 0),
        life, maxLife: life, size, tStart, tEnd, type,
      });
    }
  }

  private lerpCellColor(t: number): number {
    const stops = COLOR_STOPS;
    const c = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      if (c <= stops[i + 1].t) {
        const f = (c - stops[i].t) / (stops[i + 1].t - stops[i].t);
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
  private draw(camX: number, camY: number) {
    this.gfx.clear();
    this.glowGfx.clear();
    this.flashGfx.clear();

    const ix = this.impactX - camX;
    const iy = this.impactY - camY;

    // 광자 (BUILDUP/CRITICAL — 돔 뒤에서 흡인)
    if (this.phase === PHASE_BUILDUP || this.phase === PHASE_CRITICAL) {
      this.drawPhotons(ix, iy);
    }

    // 운석 (BUILDUP — IMPACT 운석은 mini 충격파만)
    for (const m of this.meteors) {
      const mtargetX = ix + m.targetOX;
      const mtargetY = iy + m.targetOY;
      if (m.phase === 0) {
        this.drawMeteorTrail(m, mtargetX, mtargetY);
        this.drawMeteorBody(m, mtargetX, mtargetY);
      } else {
        this.drawMiniShockwave(m, mtargetX, mtargetY);
      }
    }

    // 구체 (BUILDUP/CRITICAL)
    if (this.phase === PHASE_BUILDUP || this.phase === PHASE_CRITICAL) {
      this.drawSphere(ix, iy);
    }

    // DETONATION
    if (this.phase === PHASE_DETONATION) {
      this.drawDetonation(ix, iy);
    }

    // LINGER
    if (this.phase === PHASE_LINGER) {
      const t = this.phaseTimer / PH_LINGER;
      const k = 1 - t;
      this.glowGfx.beginFill(COL_STONE_700, 0.12 * k);
      this.glowGfx.drawCircle(ix, iy, 130 + t * 50);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(COL_ORANGE_500, 0.18 * k * k);
      this.glowGfx.drawCircle(ix, iy, 60 * k);
      this.glowGfx.endFill();
    }

    // 비산 운석 (DETONATION 이후 사방으로)
    this.drawEjecta(camX, camY);

    // 폭발 셀
    this.drawCells(camX, camY);

    // 화면 flash 제거 — 단색 폭발 코어가 충분히 강렬
  }

  // ── 광자 입자 (사방 → 중심 흡인) ──
  private drawPhotons(ix: number, iy: number) {
    for (const p of this.photons) {
      const lt = p.life / p.maxLife;
      // life 후반(중심 가까울수록) 더 밝게 — 모이는 임팩트 강조
      const alpha = lt < 0.15 ? lt / 0.15 : 1;
      if (alpha < 0.05) continue;
      const px = ix + p.ox;
      const py = iy + p.oy;
      const ppx = ix + p.prevOX;
      const ppy = iy + p.prevOY;

      // 두꺼운 단색 트레일 (선명하게)
      this.gfx.lineStyle(p.size * 1.4, p.color, alpha);
      this.gfx.moveTo(ppx, ppy);
      this.gfx.lineTo(px, py);
      this.gfx.lineStyle(0);
      // 코어 (단색, 더 큼)
      this.gfx.beginFill(p.color, alpha);
      this.gfx.drawCircle(px, py, p.size);
      this.gfx.endFill();
      // 이중 코어 (밝은 안쪽)
      this.gfx.beginFill(COL_FLARE, alpha);
      this.gfx.drawCircle(px, py, p.size * 0.45);
      this.gfx.endFill();
    }
  }

  // ── 구체 (sphere) — 단단한 단색 fill, 반투명 배경 글로우 X ──
  private drawSphere(ix: number, iy: number) {
    const energyT = this.energy / MAX_ENERGY;
    const critT = this.phase === PHASE_CRITICAL ? this.phaseTimer / PH_CRITICAL : 0;
    // 구체가 보이기 시작하는 임계 (운석 5발 이후)
    if (this.energy < 1 && critT === 0) return;

    // 호흡 펄스 (자연스러운 ±4%)
    const breath = 1 + Math.sin(this.time * 0.18) * 0.04 + critT * 0.1;
    const r = (SPHERE_R_BASE + this.energy * SPHERE_R_PER + critT * 30) * breath;

    // 흔들림 (energy 비례)
    const shakeAmp = 0.4 + energyT * 2.0 + critT * 6;
    const shakeFreq = 0.35 + energyT * 0.6 + critT * 1.2;
    const sx = ix + Math.sin(this.time * shakeFreq) * shakeAmp;
    const sy = iy + Math.cos(this.time * shakeFreq * 0.9) * shakeAmp * 0.7;

    // ─── 본체 그라데이션 6겹 (균일 동심원, 그림자 X) ───
    this.gfx.beginFill(COL_RED_700);
    this.gfx.drawCircle(sx, sy, r);
    this.gfx.endFill();
    this.gfx.beginFill(COL_RED_500);
    this.gfx.drawCircle(sx, sy, r * 0.85);
    this.gfx.endFill();
    this.gfx.beginFill(COL_ORANGE_500);
    this.gfx.drawCircle(sx, sy, r * 0.70);
    this.gfx.endFill();
    this.gfx.beginFill(COL_AMBER_400);
    this.gfx.drawCircle(sx, sy, r * 0.55);
    this.gfx.endFill();
    this.gfx.beginFill(COL_YELLOW_200);
    this.gfx.drawCircle(sx, sy, r * 0.40);
    this.gfx.endFill();
    this.gfx.beginFill(COL_FLARE);
    this.gfx.drawCircle(sx, sy, r * 0.22);
    this.gfx.endFill();

    // ─── 외곽선 rim light ───
    this.gfx.lineStyle(2.2, COL_AMBER_300);
    this.gfx.drawCircle(sx, sy, r);
    this.gfx.lineStyle(1.2, COL_YELLOW_200);
    this.gfx.drawCircle(sx, sy, r * 0.99);
    this.gfx.lineStyle(0);

  }

  // ── 운석 trail (EarthDarkEffect 패턴 + 강화 색) ──
  private drawMeteorTrail(m: Meteor, mtargetX: number, mtargetY: number) {
    const fallT = m.timer / METEOR_FALL_DURATION;
    const ease = fallT * fallT;
    const fx = m.startOX * (1 - ease);
    const fy = m.startOY * (1 - ease);
    const curX = mtargetX + fx;
    const curY = mtargetY + fy;

    let startX = mtargetX + m.startOX;
    let startY = mtargetY + m.startOY;
    const maxTrailLen = 105;
    const dx = curX - startX;
    const dy = curY - startY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > maxTrailLen) {
      const ratio = maxTrailLen / len;
      startX = curX - dx * ratio;
      startY = curY - dy * ratio;
    }
    if (len < 4) return;

    const tone = METEOR_TONES[m.toneIdx];
    const segments = 7;
    for (let i = 0; i < segments; i++) {
      const t1 = i / segments;
      const t2 = (i + 1) / segments;
      const x1 = startX + (curX - startX) * t1;
      const y1 = startY + (curY - startY) * t1;
      const x2 = startX + (curX - startX) * t2;
      const y2 = startY + (curY - startY) * t2;
      const alpha = ((i + 1) / segments) * 0.92;

      // ADD 외곽 불꽃
      this.glowGfx.lineStyle(6, tone.inner, alpha * 0.55);
      this.glowGfx.moveTo(x1, y1); this.glowGfx.lineTo(x2, y2);
      this.glowGfx.lineStyle(3.5, tone.rim, alpha * 0.65);
      this.glowGfx.moveTo(x1, y1); this.glowGfx.lineTo(x2, y2);
      // 검은 연기
      this.gfx.lineStyle(3, COL_STONE_900, alpha * 0.65);
      this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
      // 갈색 코어
      this.gfx.lineStyle(1.6, tone.outer, alpha * 0.95);
      this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
      // 밝은 노랑 라인 (히트)
      this.gfx.lineStyle(0.8, tone.rim, alpha * 0.95);
      this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
    }
    this.gfx.lineStyle(0);
    this.glowGfx.lineStyle(0);
  }

  // ── 운석 본체 (EarthDarkEffect 6각형 + 강화 색 + rim glow) ──
  private drawMeteorBody(m: Meteor, mtargetX: number, mtargetY: number) {
    const fallT = m.timer / METEOR_FALL_DURATION;
    const ease = fallT * fallT;
    const fx = m.startOX * (1 - ease);
    const fy = m.startOY * (1 - ease);
    const x = mtargetX + fx;
    const y = mtargetY + fy;
    const sz = m.size * (0.6 + ease * 0.5);

    const tone = METEOR_TONES[m.toneIdx];
    const motionAngle = Math.atan2(-m.startOY, -m.startOX);
    const cosA = Math.cos(motionAngle);
    const sinA = Math.sin(motionAngle);

    // 타이트한 코어 글로우 (작게 — 배경 글로우 X)
    this.glowGfx.beginFill(tone.rim, 0.55);
    this.glowGfx.drawCircle(x, y, sz * 1.2);
    this.glowGfx.endFill();

    // 외곽 6각형 (X 1.6배 길쭉)
    const outerPts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const noise = m.hexNoise[i];
      const rx = Math.cos(a) * sz * (METEOR_X_STRETCH + noise);
      const ry = Math.sin(a) * sz * (0.85 + noise * 0.5);
      const wx = rx * cosA - ry * sinA;
      const wy = rx * sinA + ry * cosA;
      outerPts.push(x + wx, y + wy);
    }
    this.gfx.beginFill(tone.outer, 0.95);
    this.gfx.drawPolygon(outerPts);
    this.gfx.endFill();

    // 중간 6각형
    const midPts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const noise = m.hexNoise[i];
      const rx = Math.cos(a) * sz * (1.05 + noise);
      const ry = Math.sin(a) * sz * (0.55 + noise * 0.5);
      const wx = rx * cosA - ry * sinA;
      const wy = rx * sinA + ry * cosA;
      midPts.push(x + wx, y + wy);
    }
    this.gfx.beginFill(tone.inner, 0.95);
    this.gfx.drawPolygon(midPts);
    this.gfx.endFill();

    // 코어 검 + rim 빛
    this.gfx.beginFill(COL_STONE_950, 0.95);
    this.gfx.drawCircle(x, y, sz * 0.40);
    this.gfx.endFill();
    this.gfx.beginFill(tone.rim, 0.92);
    this.gfx.drawCircle(x + sz * 0.15, y - sz * 0.10, sz * 0.16);
    this.gfx.endFill();
  }

  // ── 착탄 mini 충격파 ──
  private drawMiniShockwave(m: Meteor, mtargetX: number, mtargetY: number) {
    const p = m.shockProgress;
    if (p >= 1) return;
    const r = (0.4 + p * 0.6) * MINI_SHOCK_R;
    const fade = (1 - p) * (1 - p);

    this.gfx.lineStyle(5 * (1 - p * 0.3), COL_RED_600, fade * 0.65);
    this.gfx.drawCircle(mtargetX, mtargetY, r);
    this.gfx.lineStyle(3.5 * (1 - p * 0.25), COL_ORANGE_500, fade * 0.78);
    this.gfx.drawCircle(mtargetX, mtargetY, r);
    this.gfx.lineStyle(2 * (1 - p * 0.2), COL_AMBER_300, fade * 0.85);
    this.gfx.drawCircle(mtargetX, mtargetY, r);
    this.gfx.lineStyle(1, COL_YELLOW_200, fade * 0.7);
    this.gfx.drawCircle(mtargetX, mtargetY, r);
    this.gfx.lineStyle(0);
  }

  // ── DETONATION (강화) ──
  private drawDetonation(ix: number, iy: number) {
    const t = this.phaseTimer / PH_DETONATION;
    const fade = 1 - t;
    const fadeSq = fade * fade;
    const r = this.blastRadius;

    // 빛 코어 플래시 (초반 40%) — 단색 fill, 사이즈만 줄여서 단단하게
    if (t < 0.40) {
      const fk = 1 - (t / 0.40);
      const coreR = 50 + (1 - fk) * 60;
      // 외곽 → 코어 단색 그라데이션 (작은 사이즈로 임팩트만)
      this.gfx.beginFill(COL_RED_700);
      this.gfx.drawCircle(ix, iy, coreR * 1.5 * fk);
      this.gfx.endFill();
      this.gfx.beginFill(COL_ORANGE_500);
      this.gfx.drawCircle(ix, iy, coreR * 1.15 * fk);
      this.gfx.endFill();
      this.gfx.beginFill(COL_AMBER_400);
      this.gfx.drawCircle(ix, iy, coreR * 0.85 * fk);
      this.gfx.endFill();
      this.gfx.beginFill(COL_YELLOW_200);
      this.gfx.drawCircle(ix, iy, coreR * 0.55 * fk);
      this.gfx.endFill();
      this.gfx.beginFill(COL_FLARE);
      this.gfx.drawCircle(ix, iy, coreR * 0.32 * fk);
      this.gfx.endFill();
    }

    // 6겹 wavy ring (GLSL과 동기화, 두께 강화)
    this.drawWavyRing(ix, iy, r * 1.00, COL_RED_700, fadeSq * 0.85, 7.0, 1.0);
    this.drawWavyRing(ix, iy, r * 0.88, COL_RED_600, fadeSq * 0.90, 5.5, 1.2);
    this.drawWavyRing(ix, iy, r * 0.76, COL_ORANGE_600, fadeSq * 0.90, 4.5, 0.9);
    this.drawWavyRing(ix, iy, r * 0.64, COL_ORANGE_500, fadeSq * 0.88, 3.8, 1.4);
    this.drawWavyRing(ix, iy, r * 0.52, COL_AMBER_500, fadeSq * 0.78, 2.8, 1.1);
    this.drawWavyRing(ix, iy, r * 0.38, COL_AMBER_300, fadeSq * 0.68, 1.8, 1.6);
    // 잔화 — 단색 코어
    if (t > 0.2) {
      const lt = 1 - t;
      this.gfx.beginFill(COL_ORANGE_500);
      this.gfx.drawCircle(ix, iy, 50 * lt);
      this.gfx.endFill();
      this.gfx.beginFill(COL_AMBER_400);
      this.gfx.drawCircle(ix, iy, 30 * lt);
      this.gfx.endFill();
      this.gfx.beginFill(COL_YELLOW_200);
      this.gfx.drawCircle(ix, iy, 16 * lt);
      this.gfx.endFill();
    }
  }

  // ── 비산 운석 (모인 운석이 반대로 사방 튀어나감) ──
  private drawEjecta(camX: number, camY: number) {
    for (const e of this.ejecta) {
      const lt = e.life / e.maxLife;
      const alpha = lt < 0.1 ? lt / 0.1 : 1 - (lt - 0.1) / 0.9;
      if (alpha < 0.04) continue;
      const x = e.x - camX;
      const y = e.y - camY;
      const tone = METEOR_TONES[e.toneIdx];
      const sz = e.size * (1 - lt * 0.3);
      const cosA = Math.cos(e.rotation);
      const sinA = Math.sin(e.rotation);

      // 짧은 trail (현재 → prev, 8개 세그먼트로 빠진 길이)
      const dx = e.x - e.prevX;
      const dy = e.y - e.prevY;
      const speedMag = Math.sqrt(dx * dx + dy * dy);
      const trailLen = Math.min(85, speedMag * 6);
      if (trailLen > 4) {
        const tx0 = x - cosA * trailLen;
        const ty0 = y - sinA * trailLen;
        const segs = 6;
        for (let i = 0; i < segs; i++) {
          const t1 = i / segs;
          const t2 = (i + 1) / segs;
          const x1 = tx0 + (x - tx0) * t1;
          const y1 = ty0 + (y - ty0) * t1;
          const x2 = tx0 + (x - tx0) * t2;
          const y2 = ty0 + (y - ty0) * t2;
          const segA = ((i + 1) / segs) * alpha;
          // ADD 불꽃
          this.glowGfx.lineStyle(5, tone.inner, segA * 0.55);
          this.glowGfx.moveTo(x1, y1); this.glowGfx.lineTo(x2, y2);
          this.glowGfx.lineStyle(2.5, tone.rim, segA * 0.7);
          this.glowGfx.moveTo(x1, y1); this.glowGfx.lineTo(x2, y2);
          // 검은 연기
          this.gfx.lineStyle(2.4, COL_STONE_900, segA * 0.6);
          this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
          // 갈색 코어
          this.gfx.lineStyle(1.2, tone.outer, segA * 0.95);
          this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
          // 노랑 라인
          this.gfx.lineStyle(0.6, tone.rim, segA * 0.9);
          this.gfx.moveTo(x1, y1); this.gfx.lineTo(x2, y2);
        }
        this.gfx.lineStyle(0);
        this.glowGfx.lineStyle(0);
      }

      // 타이트한 코어 글로우 (작게)
      this.glowGfx.beginFill(tone.rim, alpha * 0.55);
      this.glowGfx.drawCircle(x, y, sz * 1.2);
      this.glowGfx.endFill();

      // 외곽 6각형 (X 1.6배 길쭉, rotation 정렬)
      const outerPts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const noise = e.hexNoise[i];
        const rx = Math.cos(a) * sz * (METEOR_X_STRETCH + noise);
        const ry = Math.sin(a) * sz * (0.85 + noise * 0.5);
        const wx = rx * cosA - ry * sinA;
        const wy = rx * sinA + ry * cosA;
        outerPts.push(x + wx, y + wy);
      }
      this.gfx.beginFill(tone.outer, 0.95 * alpha);
      this.gfx.drawPolygon(outerPts);
      this.gfx.endFill();

      // 중간 6각형
      const midPts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        const noise = e.hexNoise[i];
        const rx = Math.cos(a) * sz * (1.05 + noise);
        const ry = Math.sin(a) * sz * (0.55 + noise * 0.5);
        const wx = rx * cosA - ry * sinA;
        const wy = rx * sinA + ry * cosA;
        midPts.push(x + wx, y + wy);
      }
      this.gfx.beginFill(tone.inner, 0.95 * alpha);
      this.gfx.drawPolygon(midPts);
      this.gfx.endFill();

      // 코어
      this.gfx.beginFill(COL_STONE_950, 0.95 * alpha);
      this.gfx.drawCircle(x, y, sz * 0.40);
      this.gfx.endFill();
      this.gfx.beginFill(tone.rim, 0.92 * alpha);
      this.gfx.drawCircle(x + sz * 0.15, y - sz * 0.10, sz * 0.16);
      this.gfx.endFill();
    }
  }

  // ── 폭발 셀 ──
  private drawCells(camX: number, camY: number) {
    for (const c of this.cells) {
      const lifeFrac = c.life / c.maxLife;
      const t = c.tStart + (1 - lifeFrac) * (c.tEnd - c.tStart);
      const color = this.lerpCellColor(t);
      const alpha = lifeFrac * 0.92;
      const sz = c.size * (0.6 + lifeFrac * 0.4);
      const px = c.x - camX;
      const py = c.y - camY;
      const ppx = c.prevX - camX;
      const ppy = c.prevY - camY;

      if (c.type === 0) {
        this.glowGfx.beginFill(color, alpha * 0.25);
        this.glowGfx.drawCircle(px, py, sz * 1.5);
        this.glowGfx.endFill();
      }
      this.gfx.lineStyle(sz * 0.55, color, alpha * 0.50);
      this.gfx.moveTo(ppx, ppy);
      this.gfx.lineTo(px, py);
      this.gfx.lineStyle(0);
      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(px, py, sz);
      this.gfx.endFill();
    }
  }

  // ── Wavy Ring ──
  private drawWavyRing(cx: number, cy: number, r: number, color: number, alpha: number, thickness: number, freqMul: number) {
    if (alpha < 0.02 || r < 2) return;
    const steps = 72;
    this.gfx.lineStyle(thickness, color, alpha);
    let first = true;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const wave = Math.sin(a * 5 * freqMul + this.time * 0.22 + cx * 0.01) * 4.5
                 + Math.sin(a * 9 * freqMul + this.time * 0.14 + cy * 0.01) * 2.5;
      const rr = r + wave;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (first) { this.gfx.moveTo(x, y); first = false; }
      else this.gfx.lineTo(x, y);
    }
    this.gfx.lineStyle(0);
  }

  stop() {
    this.active = false;
    this.meteors = [];
    this.cells = [];
    this.photons = [];
    this.ejecta = [];
    this._impacts = [];
    this.phase = PHASE_BUILDUP;
    this.phaseTimer = 0;
    this.energy = 0;
    this.spawnedCount = 0;
    this.spawnTimer = 0;
    this.detonationFired = false;
    this.blastRadius = 0;
    this.blastStrength = 0;
    this.flashAlpha = 0;
    this.gfx.clear();
    this.glowGfx.clear();
    this.flashGfx.clear();
    this.flashAlpha = 0;
    this.detachFilter();
  }

  destroy() {
    this.stop();
    if (this.filter) {
      this.filter.destroy();
      this.filter = null;
    }
    this.container.destroy({ children: true });
  }
}
