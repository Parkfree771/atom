import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles, spawnExplosionParticles } from '../particles';

/**
 * 흙 액티브 스킬 — 대지진 (Seismic Rift)
 *
 * 컨셉: 쿵... 쿵... 쿵... 지면을 3번 찍으며 방사 균열을 넓게 펼치고,
 *       균열이 완성된 뒤 5초간 용암이 차오른 상태로 지속 데미지를 주다가,
 *       마지막에 균열 전체가 입자 폭발로 터지면서 추가 데미지.
 *
 * 주인공은 "균열 그 자체" — 캐릭터 주변의 원형 링·광선·기둥 같은 요란한 그래픽은 없음.
 * 모든 폭발 연출은 입자(particles) 기반.
 *
 * 차별점:
 *   - 대해일 : 수평 횡단 · 밀어냄
 *   - 지옥염 : 격자 카펫 · 연쇄 폭발
 *   - 대지진 : 방사 균열 · 지속 용암 존 · 균열 자체의 폭발
 *
 * 좌표계 (개발서 규칙 4 준수):
 *   - Graphics : overlayLayer 내부 worldWrap 컨테이너 (worldWrap.x/y = -cameraX/Y)
 *                → 내부는 월드좌표로 자유롭게 그림
 *   - GLSL     : groundLayer (screen-space), uCenter 매 프레임 스크린좌표 주입
 *   - uTexSize : filter.apply 오버라이드로 실제 input 크기 주입 (하드코딩 금지)
 */

const EARTHQUAKE_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  'uniform float uTime;',
  'uniform float uTremor;',    // 0..1 지면 상시 진동 진폭
  'uniform float uPulse;',     // 0..1 쿵! 순간 추가 진동/지면 적열 (감쇠형)
  'uniform vec2 uCenter;',     // 플레이어 스크린좌표 (lava tint 중심)
  'uniform float uZoneR;',     // 지속 용암 존 반경 (sustain 동안 활성)
  'uniform float uZoneStr;',   // 지속 용암 존 강도 0..1',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  vec2 distorted = pix;',
  '',
  '  float tremor = uTremor + uPulse * 0.55;',
  '',
  '  // 지면 진동 (저주파 + 고주파 중첩)',
  '  distorted.y += sin(pix.x * 0.028 + uTime * 12.0) * tremor * 3.6;',
  '  distorted.y += sin(pix.x * 0.09  - uTime * 17.0) * tremor * 1.4;',
  '  distorted.x += sin(pix.y * 0.022 + uTime * 9.0)  * tremor * 1.6;',
  '  distorted.x += cos(pix.y * 0.075 - uTime * 21.0) * tremor * 0.9;',
  '',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 지면 흙빛 믹스',
  '  vec3 earthTint = vec3(0.78, 0.62, 0.44);',
  '  color.rgb = mix(color.rgb, color.rgb * earthTint, tremor * 0.30);',
  '',
  '  // 지속 용암 존 — 중앙 반경 이내에서 은은한 적열 + 그림자',
  '  float dist = length(pix - uCenter);',
  '  if (uZoneStr > 0.001 && uZoneR > 1.0) {',
  '    float inside = 1.0 - smoothstep(uZoneR - 80.0, uZoneR, dist);',
  '    float pulsate = 0.55 + 0.45 * sin(uTime * 2.6 + dist * 0.012);',
  '    color.rgb += vec3(0.32, 0.11, 0.02) * inside * uZoneStr * pulsate * 0.22;',
  '    color.rgb = mix(color.rgb, color.rgb * vec3(0.62, 0.48, 0.34), inside * uZoneStr * 0.18);',
  '  }',
  '',
  '  // 쿵 순간 플래시 없음 — tremor 에만 반영 (uPulse 는 지면 진동 강화용)',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// ── 팔레트 ──
const COL_BROWN9 = 0x451a03;
const COL_BROWN7 = 0x78350f;
const COL_AMBER8 = 0x92400e;
const COL_AMBER5 = 0xf59e0b;
const COL_AMBER3 = 0xfcd34d;
const COL_STONE4 = 0x78716c;
const COL_ORANGE = 0xf97316;
const COL_ORANGE_HI = 0xfdba74;
const COL_RED    = 0xb91c1c;
const COL_LAVA_HI = 0xfef3c7;
const COL_DUST   = 0xd6b896;
const COL_DUST_DK= 0x9c7c5a;

// ── 페이즈 구성 (쿵... 쿵... 쿵... 유지(5s)... 폭발) ──
const PHASE_CHARGE  = 18;    // 0.30s  워밍업
const PHASE_BOOM1   = 8;     // 0.13s  1차 쿵
const PHASE_WAIT1   = 24;    // 0.40s  쉼
const PHASE_BOOM2   = 8;     // 0.13s  2차 쿵
const PHASE_WAIT2   = 28;    // 0.47s  쉼
const PHASE_BOOM3   = 10;    // 0.17s  3차 쿵 (균열 완전 성장)
const PHASE_WAIT3   = 14;    // 0.23s  숨고르기
const PHASE_SUSTAIN = 300;   // 5.00s  균열 지속 (tick damage)
const PHASE_FINAL   = 68;    // 1.13s  균열 따라 파바바바박 파동 폭발
const PHASE_FADE    = 24;    // 0.40s  잔진 페이드
const PHASE_TOTAL   =
  PHASE_CHARGE + PHASE_BOOM1 + PHASE_WAIT1 + PHASE_BOOM2 + PHASE_WAIT2 +
  PHASE_BOOM3 + PHASE_WAIT3 + PHASE_SUSTAIN + PHASE_FINAL + PHASE_FADE; // 474

const T_BOOM1_START   = PHASE_CHARGE;
const T_WAIT1_START   = T_BOOM1_START + PHASE_BOOM1;
const T_BOOM2_START   = T_WAIT1_START + PHASE_WAIT1;
const T_WAIT2_START   = T_BOOM2_START + PHASE_BOOM2;
const T_BOOM3_START   = T_WAIT2_START + PHASE_WAIT2;
const T_WAIT3_START   = T_BOOM3_START + PHASE_BOOM3;
const T_SUSTAIN_START = T_WAIT3_START + PHASE_WAIT3;
const T_FINAL_START   = T_SUSTAIN_START + PHASE_SUSTAIN;
const T_FADE_START    = T_FINAL_START + PHASE_FINAL;

// ── 균열 설정 (넓게) ──
const CRACK_COUNT = 12;
const SUB_BRANCH_COUNT = 5;
const CRACK_LEN_BASE = 560;
const CRACK_LEN_RAND = 180;           // 실 길이 560~740

// ── 판정 반경 ──
const SUSTAIN_POINT_RADIUS = 50;      // 라인 쿵 — 균열 포인트 주변
const FINAL_POINT_RADIUS   = 64;      // 피날레 — 균열 포인트 주변
const SUSTAIN_POINTS_PER_CRACK = 6;   // 균열당 판정 포인트 수 (파티클도 여기서 분출)
// SUSTAIN 동안 "쿵쿵쿵" 라인 폭발 주기
const RUMBLE_INTERVAL = 50;           // 0.83s 마다 쿵 (총 6번 = 300f)
const RUMBLE_PICK_COUNT = 10;         // 한 쿵당 폭발 포인트 수 (후보 48개 중 10개)

// ── 각 쿵 스펙 (점증) ──
interface BoomSpec {
  dmgReg: number;
  dmgBoss: number;
  stun: number;
  stunBoss: number;
  shakeFrames: number;
  pulseStr: number;
  particleCount: number;
  grownReach: number;
}
const BOOM1: BoomSpec = { dmgReg: 110, dmgBoss: 70,  stun: 16, stunBoss: 6,  shakeFrames: 10, pulseStr: 0.42, particleCount: 14, grownReach: 0.40 };
const BOOM2: BoomSpec = { dmgReg: 160, dmgBoss: 100, stun: 22, stunBoss: 10, shakeFrames: 16, pulseStr: 0.58, particleCount: 22, grownReach: 0.75 };
const BOOM3: BoomSpec = { dmgReg: 220, dmgBoss: 140, stun: 32, stunBoss: 12, shakeFrames: 22, pulseStr: 0.72, particleCount: 34, grownReach: 1.00 };
// SUSTAIN "쿵쿵쿵" — 매 RUMBLE_INTERVAL 마다 발동
const RUMBLE_DMG_REG   = 72;
const RUMBLE_DMG_BOSS  = 46;
const RUMBLE_STUN      = 10;
const RUMBLE_STUN_BOSS = 4;
const RUMBLE_SHAKE     = 9;
const RUMBLE_PULSE     = 0.38;
// 피날레 폭발 (one-shot damage, 파동형 시각)
const FINAL_DMG_REG    = 420;
const FINAL_DMG_BOSS   = 270;
const FINAL_STUN       = 56;
const FINAL_STUN_BOSS  = 20;
const FINAL_SHAKE      = 36;
const FINAL_PULSE      = 0.70;   // 과한 전화면 플래시 방지

interface CrackSegment {
  x: number; y: number;  // center 기준 오프셋
  w: number;             // 두께 배율 (끝으로 갈수록 얇아짐)
}

interface SubBranch {
  startIdx: number;
  segments: CrackSegment[];
  triggerAt: number;
  grownT: number;
}

interface SustainPoint {
  x: number; y: number;      // center 기준
  frac: number;              // 부모 균열 상 진행률 (0..1)
}

interface Crack {
  angle: number;
  length: number;
  segments: CrackSegment[];
  subs: SubBranch[];
  grownT: number;
  shimmer: Array<{ x: number; y: number; r: number; phase: number }>;
  debris: Array<{ x: number; y: number; r: number; tint: number }>;
  sustainPoints: SustainPoint[];
}

// 피날레 폭발 — 3단계 Ultimate 패턴 (wavy shockwave ring + crater, NORMAL stroke)
// 기존 "filled glow disc" 대신 EarthUltimate drawShockwave + drawCrater 스타일
type DiscKind = 'mega' | 'big' | 'medium' | 'small';
interface BurstDisc {
  wx: number; wy: number;
  birthFrame: number;      // 생성 시점 rt.frame
  maxR: number;
  maxLife: number;
  kind: DiscKind;
  seed: number;            // sin 위상
  hasCrater: boolean;      // tip(big/medium) 만 크레이터
}

interface EarthquakeRuntime {
  frame: number;
  centerWX: number;
  centerWY: number;
  cracks: Crack[];
  active: boolean;
  // GLSL
  tremor: number;
  pulse: number;
  zoneR: number;
  zoneStr: number;
  // 트리거 플래그
  boomFired: [boolean, boolean, boolean];
  finalFired: boolean;
  // 데미지 중복 방지
  damagedBoom: [Set<number>, Set<number>, Set<number>];
  damagedFinal: Set<number>;
  // SUSTAIN 라인 쿵 시스템
  rumbleTimer: number;
  rumbleIdx: number;
  // FINAL 파동 진행
  finalWavePrev: number;
  burstDiscs: BurstDisc[];
}

// ── 지그재그 세그먼트 생성 ──
// 두께 곡선: 중앙(t=0)은 w=1.0 (두꺼움), 끝단(t=1)은 w=0.12 (얇음). pow 커브로 중앙부 넓게 유지.
function buildZigzag(angle: number, length: number): CrackSegment[] {
  const segs: CrackSegment[] = [];
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const px = -ny;
  const py = nx;
  let d = 0;
  segs.push({ x: 0, y: 0, w: 1 });
  while (d < length) {
    const step = 14 + Math.random() * 8;
    d += step;
    if (d > length) d = length;
    const t = d / length;
    const taperAmp = 1 - t * 0.85;
    const lateral = (Math.random() - 0.5) * 18 * taperAmp;
    const x = nx * d + px * lateral;
    const y = ny * d + py * lateral;
    // 중앙 두께감 유지, 끝단으로 급격히 얇아짐 (pow curve)
    const w = Math.max(0.12, 1 - Math.pow(t, 1.35) * 0.88);
    segs.push({ x, y, w });
  }
  return segs;
}

function buildSubBranch(parent: Crack): SubBranch {
  const startIdx = 2 + Math.floor(Math.random() * Math.max(1, parent.segments.length - 4));
  const sideSign = Math.random() < 0.5 ? -1 : 1;
  const angleOffset = sideSign * ((25 + Math.random() * 40) * Math.PI / 180);
  const subAngle = parent.angle + angleOffset;
  // 길이 다양화 — 짧은 잔가지부터 긴 분기까지 (40~220px)
  const subLen = 40 + Math.random() * 180;
  const anchor = parent.segments[startIdx];

  const segs: CrackSegment[] = [];
  const nx = Math.cos(subAngle);
  const ny = Math.sin(subAngle);
  const tx = -ny;
  const ty = nx;
  let d = 0;
  segs.push({ x: anchor.x, y: anchor.y, w: anchor.w * 0.75 });
  while (d < subLen) {
    const step = 10 + Math.random() * 5;
    d += step;
    if (d > subLen) d = subLen;
    const t = d / subLen;
    const lateral = (Math.random() - 0.5) * 10 * (1 - t * 0.6);
    segs.push({
      x: anchor.x + nx * d + tx * lateral,
      y: anchor.y + ny * d + ty * lateral,
      w: anchor.w * 0.75 * (1 - t * 0.9),
    });
  }

  return {
    startIdx,
    segments: segs,
    triggerAt: (startIdx / Math.max(1, parent.segments.length)) * 0.9 + 0.05,
    grownT: 0,
  };
}

// 균열 위 균등 분포 판정 포인트 생성 (부모 균열만, 곁가지 제외)
function buildSustainPoints(segments: CrackSegment[]): SustainPoint[] {
  const pts: SustainPoint[] = [];
  const last = segments.length - 1;
  if (last <= 1) return pts;
  // 0.15, 0.30, 0.45, 0.60, 0.75, 0.90 지점
  for (let k = 0; k < SUSTAIN_POINTS_PER_CRACK; k++) {
    const frac = 0.15 + (0.90 - 0.15) * (k / (SUSTAIN_POINTS_PER_CRACK - 1));
    const idx = Math.min(last, Math.max(1, Math.round(last * frac)));
    const s = segments[idx];
    pts.push({ x: s.x, y: s.y, frac });
  }
  return pts;
}

export class EarthquakeSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  private worldWrap: PIXI.Container;
  private crackDarkGfx: PIXI.Graphics;
  private crackGlowGfx: PIXI.Graphics;
  private crackCoreGfx: PIXI.Graphics;
  private shimmerGfx: PIXI.Graphics;
  private debrisGfx: PIXI.Graphics;
  private burstDiscGfx: PIXI.Graphics;  // 피날레 폭발 glow disc (ADD)
  private flashGfx: PIXI.Graphics;      // 쿵 순간 + 피날레 중앙 플래시 (ADD)

  private filter: PIXI.Filter | null = null;
  private runtime: EarthquakeRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    // Z-order: glow(add) → dark → core(add) → shimmer(add) → debris → flash(add)
    this.crackGlowGfx = new PIXI.Graphics();
    this.crackGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.crackGlowGfx);

    this.crackDarkGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.crackDarkGfx);

    this.crackCoreGfx = new PIXI.Graphics();
    this.crackCoreGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.crackCoreGfx);

    this.shimmerGfx = new PIXI.Graphics();
    this.shimmerGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.shimmerGfx);

    this.debrisGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.debrisGfx);

    // NORMAL 블렌드 — 3단계 Ultimate shockwave 스타일 (ADD flash 제거)
    this.burstDiscGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.burstDiscGfx);

    this.flashGfx = new PIXI.Graphics();
    this.flashGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.flashGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, EARTHQUAKE_FRAG, {
      uTime: 0,
      uTremor: 0,
      uPulse: 0,
      uCenter: [CANVAS_W / 2, CANVAS_H / 2],
      uZoneR: 0,
      uZoneStr: 0,
      uTexSize: [CANVAS_W, CANVAS_H],
    });
    this.filter.padding = 0;
    const f = this.filter;
    // 개발서 규칙 4: uTexSize 는 실제 input 크기 주입
    f.apply = function (fm: any, input: any, output: any, clearMode: any) {
      if (input && input.width > 0) {
        f.uniforms.uTexSize = [input.width, input.height];
      }
      fm.applyFilter(f, input, output, clearMode);
    };
  }

  private attachFilter() {
    if (!this.filter) return;
    this.groundLayer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);
    const existing = this.groundLayer.filters || [];
    if (!existing.includes(this.filter)) {
      this.groundLayer.filters = [...existing, this.filter];
    }
  }

  private detachFilter() {
    if (!this.filter || !this.groundLayer.filters) return;
    this.groundLayer.filters = this.groundLayer.filters.filter((f) => f !== this.filter);
  }

  start(playerWX: number, playerWY: number) {
    if (this.runtime && this.runtime.active) return;
    this.ensureFilter();
    this.attachFilter();

    const cracks: Crack[] = [];
    for (let i = 0; i < CRACK_COUNT; i++) {
      const angle = (i / CRACK_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.14;
      const length = CRACK_LEN_BASE + Math.random() * CRACK_LEN_RAND;
      const segments = buildZigzag(angle, length);

      const parent: Crack = {
        angle,
        length,
        segments,
        subs: [],
        grownT: 0,
        shimmer: [],
        debris: [],
        sustainPoints: buildSustainPoints(segments),
      };
      for (let s = 0; s < SUB_BRANCH_COUNT; s++) {
        parent.subs.push(buildSubBranch(parent));
      }

      // heat shimmer
      const shimmerCount = 8 + Math.floor(length / 60);
      for (let s = 0; s < shimmerCount; s++) {
        const idx = 1 + Math.floor(Math.random() * (segments.length - 1));
        const sref = segments[idx];
        parent.shimmer.push({
          x: sref.x + (Math.random() - 0.5) * 22,
          y: sref.y + (Math.random() - 0.5) * 22,
          r: 1.8 + Math.random() * 2.6,
          phase: Math.random() * Math.PI * 2,
        });
      }

      // 돌조각 파편
      const debrisCount = 6 + Math.floor(length / 70);
      for (let s = 0; s < debrisCount; s++) {
        const idx = 1 + Math.floor(Math.random() * (segments.length - 1));
        const sref = segments[idx];
        const sideSign = Math.random() < 0.5 ? -1 : 1;
        const nx = -Math.sin(angle);
        const ny = Math.cos(angle);
        const dist = 6 + Math.random() * 14;
        const tint = Math.random() < 0.5 ? COL_BROWN7 : COL_STONE4;
        parent.debris.push({
          x: sref.x + nx * sideSign * dist + (Math.random() - 0.5) * 4,
          y: sref.y + ny * sideSign * dist + (Math.random() - 0.5) * 4,
          r: 1.4 + Math.random() * 2.2,
          tint,
        });
      }

      cracks.push(parent);
    }

    this.runtime = {
      frame: 0,
      centerWX: playerWX,
      centerWY: playerWY,
      cracks,
      active: true,
      tremor: 0,
      pulse: 0,
      zoneR: 0,
      zoneStr: 0,
      boomFired: [false, false, false],
      finalFired: false,
      damagedBoom: [new Set<number>(), new Set<number>(), new Set<number>()],
      damagedFinal: new Set<number>(),
      rumbleTimer: 0,
      rumbleIdx: 0,
      finalWavePrev: 0,
      burstDiscs: [],
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
    onShake: (frames: number) => void,
  ) {
    const rt = this.runtime;
    if (!rt || !rt.active) return;
    void canvasW; void canvasH;

    this.time += dt;
    rt.frame += dt;

    // overlayLayer 안에서 월드좌표 그리기 (개발서 규칙 4)
    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    const f = rt.frame;

    // ── 1) 페이즈 판별 ──
    const inCharge  = f < T_BOOM1_START;
    const inBoom1   = f >= T_BOOM1_START   && f < T_WAIT1_START;
    const inWait1   = f >= T_WAIT1_START   && f < T_BOOM2_START;
    const inBoom2   = f >= T_BOOM2_START   && f < T_WAIT2_START;
    const inWait2   = f >= T_WAIT2_START   && f < T_BOOM3_START;
    const inBoom3   = f >= T_BOOM3_START   && f < T_WAIT3_START;
    const inWait3   = f >= T_WAIT3_START   && f < T_SUSTAIN_START;
    const inSustain = f >= T_SUSTAIN_START && f < T_FINAL_START;
    const inFinal   = f >= T_FINAL_START   && f < T_FADE_START;
    const inFade    = f >= T_FADE_START;

    // ── 2) tremor 스케줄 ──
    if (inCharge) {
      rt.tremor = 0.22 * (f / PHASE_CHARGE);
      if ((f | 0) % 3 === 0) {
        spawnHitParticles(particles,
          rt.centerWX + (Math.random() - 0.5) * 60,
          rt.centerWY + (Math.random() - 0.5) * 60,
          COL_DUST);
      }
    } else if (inBoom1) {
      const k = (f - T_BOOM1_START) / PHASE_BOOM1;
      rt.tremor = 0.30 + 0.22 * Math.sin(k * Math.PI);
    } else if (inWait1) {
      const k = (f - T_WAIT1_START) / PHASE_WAIT1;
      rt.tremor = 0.32 - (0.32 - 0.22) * easeOutCubic(Math.min(1, k * 1.4));
    } else if (inBoom2) {
      const k = (f - T_BOOM2_START) / PHASE_BOOM2;
      rt.tremor = 0.42 + 0.28 * Math.sin(k * Math.PI);
    } else if (inWait2) {
      const k = (f - T_WAIT2_START) / PHASE_WAIT2;
      rt.tremor = 0.42 - (0.42 - 0.26) * easeOutCubic(Math.min(1, k * 1.4));
    } else if (inBoom3) {
      const k = (f - T_BOOM3_START) / PHASE_BOOM3;
      rt.tremor = 0.55 + 0.32 * Math.sin(k * Math.PI);
    } else if (inWait3) {
      const k = (f - T_WAIT3_START) / PHASE_WAIT3;
      rt.tremor = 0.50 - (0.50 - 0.38) * k;
    } else if (inSustain) {
      // 유지 구간 — 미세하게 박동 (sin), 말미로 갈수록 불길함 증가
      const k = (f - T_SUSTAIN_START) / PHASE_SUSTAIN;
      const base = 0.30 + 0.04 * Math.sin(this.time * 0.14);
      rt.tremor = base + k * 0.18;  // 0.30 → 0.48 로 서서히 증가 (피날레 예고)
    } else if (inFinal) {
      const k = (f - T_FINAL_START) / PHASE_FINAL;
      // 폭발 순간 최고점 후 급감
      rt.tremor = 1.05 * (1 - easeOutQuad(k)) + 0.12;
    } else if (inFade) {
      const k = 1 - (f - T_FADE_START) / PHASE_FADE;
      rt.tremor = 0.12 * Math.max(0, k);
    }

    // ── 3) 균열 자람 ──
    let targetGrown = 0;
    if (inCharge) {
      targetGrown = 0.08 * (f / PHASE_CHARGE);
    } else if (inBoom1) {
      const k = (f - T_BOOM1_START) / PHASE_BOOM1;
      targetGrown = 0.08 + (0.40 - 0.08) * easeOutCubic(k);
    } else if (inWait1) {
      targetGrown = 0.40;
    } else if (inBoom2) {
      const k = (f - T_BOOM2_START) / PHASE_BOOM2;
      targetGrown = 0.40 + (0.75 - 0.40) * easeOutCubic(k);
    } else if (inWait2) {
      targetGrown = 0.75;
    } else if (inBoom3) {
      const k = (f - T_BOOM3_START) / PHASE_BOOM3;
      targetGrown = 0.75 + (1.00 - 0.75) * easeOutCubic(k);
    } else {
      targetGrown = 1;
    }
    for (const c of rt.cracks) {
      c.grownT = targetGrown;
      for (const sb of c.subs) {
        if (targetGrown >= sb.triggerAt) {
          const local = Math.min(1, (targetGrown - sb.triggerAt) / 0.18);
          sb.grownT = easeOutCubic(local);
        }
      }
    }

    // ── 4) BOOM/FINAL 트리거 ──
    if (inBoom1 && !rt.boomFired[0]) {
      rt.boomFired[0] = true;
      this.fireBoom(rt, BOOM1, 0, enemies, particles, onKill, onShake);
    } else if (inBoom2 && !rt.boomFired[1]) {
      rt.boomFired[1] = true;
      this.fireBoom(rt, BOOM2, 1, enemies, particles, onKill, onShake);
    } else if (inBoom3 && !rt.boomFired[2]) {
      rt.boomFired[2] = true;
      this.fireBoom(rt, BOOM3, 2, enemies, particles, onKill, onShake);
    } else if (inFinal && !rt.finalFired) {
      rt.finalFired = true;
      this.fireFinal(rt, enemies, particles, onKill, onShake);
    }

    // ── 5) pulse 자연 감쇠 ──
    rt.pulse = Math.max(0, rt.pulse - 0.055 * dt);

    // ── 5-b) BurstDisc life 감소 + 죽은 것 제거 ──
    if (rt.burstDiscs.length > 0) {
      rt.burstDiscs = rt.burstDiscs.filter((d) => rt.frame - d.birthFrame < d.maxLife);
    }

    // ── 6) SUSTAIN: 지속 존 + 라인 쿵 / FINAL: 파동 폭발 ──
    if (inSustain) {
      const k = (f - T_SUSTAIN_START) / PHASE_SUSTAIN;
      const zoneFade = Math.min(1, k * 6) * Math.min(1, (1 - k) * 8 + 0.4);
      rt.zoneR = (CRACK_LEN_BASE + CRACK_LEN_RAND * 0.5) * 0.95;
      rt.zoneStr = 0.75 * zoneFade;

      // 자잘한 용암 튐 (빈도 낮춤 — 라인 쿵 시각과 중복 방지)
      if ((f | 0) % 5 === 0) {
        this.emitSustainParticles(rt, particles);
      }

      // 라인 쿵! — RUMBLE_INTERVAL 마다 발동
      rt.rumbleTimer -= dt;
      if (rt.rumbleTimer <= 0) {
        rt.rumbleTimer += RUMBLE_INTERVAL;
        rt.rumbleIdx++;
        this.fireRumble(rt, enemies, particles, onKill, onShake);
      }
    } else if (inFinal) {
      const k = (f - T_FINAL_START) / PHASE_FINAL;
      rt.zoneR = (CRACK_LEN_BASE + CRACK_LEN_RAND * 0.5) * 0.95;
      rt.zoneStr = 0.75 * (1 - k);

      // 파동 진행 — linear 로 중앙→tip 일정 속도 파바바바박
      const maxLen = CRACK_LEN_BASE + CRACK_LEN_RAND;
      const waveR = k * maxLen * 1.08;
      this.emitFinalWaveParticles(rt, particles, rt.finalWavePrev, waveR);
      rt.finalWavePrev = waveR;

      // FINAL 지속 셰이크 — 파동 진행 중 지면 계속 흔들림
      if ((f | 0) % 4 === 0) {
        onShake(6);
      }
    } else if (inFade) {
      const k = 1 - (f - T_FADE_START) / PHASE_FADE;
      rt.zoneStr = 0.15 * Math.max(0, k);
    } else {
      rt.zoneStr = 0;
      rt.zoneR = 0;
    }

    // ── 7) uniform 주입 ──
    if (this.filter) {
      const screenCx = rt.centerWX - cameraX;
      const screenCy = rt.centerWY - cameraY;
      this.filter.uniforms.uTime = this.time * 0.016;
      this.filter.uniforms.uTremor = rt.tremor;
      this.filter.uniforms.uPulse = rt.pulse;
      this.filter.uniforms.uCenter = [screenCx, screenCy];
      this.filter.uniforms.uZoneR = rt.zoneR;
      this.filter.uniforms.uZoneStr = rt.zoneStr;
    }

    // ── 8) 종료 ──
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    this.render(rt);
  }

  /** 쿵! — 중앙 플래시 + 균열 grown 범위 내 적 데미지 + 파티클 */
  private fireBoom(
    rt: EarthquakeRuntime,
    spec: BoomSpec,
    idx: number,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
    onShake: (frames: number) => void,
  ) {
    // 데미지 판정 — 균열 포인트 중 현재 grown 에 도달한 지점 주변
    const damaged = rt.damagedBoom[idx];
    const r2 = SUSTAIN_POINT_RADIUS * SUSTAIN_POINT_RADIUS;
    for (const c of rt.cracks) {
      for (const pt of c.sustainPoints) {
        if (pt.frac > spec.grownReach) continue;
        const pwx = rt.centerWX + pt.x;
        const pwy = rt.centerWY + pt.y;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          if (damaged.has(i)) continue;
          const dx = e.x - pwx;
          const dy = e.y - pwy;
          if (dx * dx + dy * dy > r2) continue;
          damaged.add(i);
          const isB = isBossType(e.type);
          e.hp -= isB ? spec.dmgBoss : spec.dmgReg;
          e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? spec.stunBoss : spec.stun);
          spawnHitParticles(particles, e.x, e.y, COL_AMBER5);
          spawnHitParticles(particles, e.x, e.y, COL_ORANGE);
          spawnHitParticles(particles, e.x, e.y, COL_DUST);
          if (e.hp <= 0) onKill(i);
        }
      }
    }

    // 중앙 먼지 + 용암 폭발 파티클
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_DUST, Math.floor(spec.particleCount * 0.50));
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_AMBER5, Math.floor(spec.particleCount * 0.30));
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_ORANGE, Math.floor(spec.particleCount * 0.25));
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_BROWN7, Math.floor(spec.particleCount * 0.20));

    // 새로 자란 균열 tip 에서도 파티클 분출 (grownReach 에 해당하는 끝점 주변)
    for (const c of rt.cracks) {
      const tipIdx = Math.max(1, Math.floor(c.segments.length * spec.grownReach) - 1);
      const tip = c.segments[tipIdx];
      spawnExplosionParticles(particles,
        rt.centerWX + tip.x, rt.centerWY + tip.y,
        COL_AMBER5, 4);
      spawnExplosionParticles(particles,
        rt.centerWX + tip.x, rt.centerWY + tip.y,
        COL_DUST, 5);
      if (idx === 2) {
        spawnExplosionParticles(particles,
          rt.centerWX + tip.x, rt.centerWY + tip.y,
          COL_ORANGE, 4);
      }
    }

    rt.pulse = Math.max(rt.pulse, spec.pulseStr);
    onShake(spec.shakeFrames);
  }

  /** 라인 쿵! — SUSTAIN 동안 주기적으로 균열 라인 랜덤 지점에서 폭발 */
  private fireRumble(
    rt: EarthquakeRuntime,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
    onShake: (frames: number) => void,
  ) {
    // 모든 sustain 포인트 후보 수집 (cracks × SUSTAIN_POINTS_PER_CRACK = 48)
    const candidates: Array<{ wx: number; wy: number }> = [];
    for (const c of rt.cracks) {
      for (const pt of c.sustainPoints) {
        candidates.push({ wx: rt.centerWX + pt.x, wy: rt.centerWY + pt.y });
      }
    }
    // Fisher-Yates 부분 셔플 → 앞에서 PICK_COUNT 개
    const pick = Math.min(RUMBLE_PICK_COUNT, candidates.length);
    for (let i = 0; i < pick; i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i));
      const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
    }

    // 각 선택 포인트에서 폭발 + 반경 내 적 피해 (적 별 1회)
    const r2 = SUSTAIN_POINT_RADIUS * SUSTAIN_POINT_RADIUS;
    const hit = new Set<number>();
    for (let k = 0; k < pick; k++) {
      const p = candidates[k];
      // 폭발 파티클
      spawnExplosionParticles(particles, p.wx, p.wy, COL_ORANGE, 8);
      spawnExplosionParticles(particles, p.wx, p.wy, COL_AMBER5, 6);
      spawnExplosionParticles(particles, p.wx, p.wy, COL_LAVA_HI, 4);
      if (Math.random() < 0.55) {
        spawnExplosionParticles(particles, p.wx, p.wy, COL_DUST, 5);
      }
      if (Math.random() < 0.35) {
        spawnExplosionParticles(particles, p.wx, p.wy, COL_RED, 3);
      }
      // 피해
      for (let i = 0; i < enemies.length; i++) {
        if (hit.has(i)) continue;
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - p.wx;
        const dy = e.y - p.wy;
        if (dx * dx + dy * dy > r2) continue;
        hit.add(i);
        const isB = isBossType(e.type);
        e.hp -= isB ? RUMBLE_DMG_BOSS : RUMBLE_DMG_REG;
        e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? RUMBLE_STUN_BOSS : RUMBLE_STUN);
        spawnHitParticles(particles, e.x, e.y, COL_ORANGE);
        spawnHitParticles(particles, e.x, e.y, COL_AMBER5);
        if (e.hp <= 0) onKill(i);
      }
    }

    rt.pulse = Math.max(rt.pulse, RUMBLE_PULSE);
    onShake(RUMBLE_SHAKE);
  }

  /** FINAL 동안 파동 반경 (prev→curr) 사이 세그먼트에서 폭발 (disc + 파티클).
   *  tip(마지막 세그) 도달 시 big disc, sub-branch anchor 도달 시 sub-tip 에 medium disc. */
  private emitFinalWaveParticles(
    rt: EarthquakeRuntime,
    particles: ParticleState[],
    prevR: number,
    currR: number,
  ) {
    if (currR <= prevR) return;
    for (const c of rt.cracks) {
      const lastIdx = c.segments.length - 1;
      for (let i = 0; i < c.segments.length; i++) {
        const s = c.segments[i];
        const r = Math.hypot(s.x, s.y);
        if (r <= prevR || r > currR) continue;
        const wx = rt.centerWX + s.x;
        const wy = rt.centerWY + s.y;

        // 파동이 지나가는 순간 — 파티클 분출 (균열 팔레트, LAVA_HI 제거)
        spawnExplosionParticles(particles, wx, wy, COL_ORANGE, 5);
        spawnExplosionParticles(particles, wx, wy, COL_AMBER5, 4);
        spawnExplosionParticles(particles, wx, wy, COL_AMBER8, 3);
        if (i % 2 === 0) {
          spawnExplosionParticles(particles, wx, wy, COL_RED, 3);
          // 2간격으로 small shockwave ring
          rt.burstDiscs.push({
            wx, wy,
            birthFrame: rt.frame,
            maxR: 52, maxLife: 24,
            kind: 'small',
            seed: Math.random() * 100,
            hasCrater: false,
          });
        }
        if (i % 3 === 0) spawnExplosionParticles(particles, wx, wy, COL_DUST, 4);
        if (i % 4 === 0) spawnExplosionParticles(particles, wx, wy, COL_BROWN7, 3);

        // tip 도달 — BIG shockwave + 크레이터
        if (i === lastIdx) {
          rt.burstDiscs.push({
            wx, wy,
            birthFrame: rt.frame,
            maxR: 150, maxLife: 36,
            kind: 'big',
            seed: Math.random() * 100,
            hasCrater: true,
          });
          spawnExplosionParticles(particles, wx, wy, COL_ORANGE, 12);
          spawnExplosionParticles(particles, wx, wy, COL_AMBER5, 10);
          spawnExplosionParticles(particles, wx, wy, COL_RED, 8);
          spawnExplosionParticles(particles, wx, wy, COL_DUST, 9);
          spawnExplosionParticles(particles, wx, wy, COL_BROWN7, 6);
          spawnExplosionParticles(particles, wx, wy, COL_STONE4, 5);
        }
      }
      // 곁가지 anchor 도달
      for (const sb of c.subs) {
        const anchor = sb.segments[0];
        const anchorR = Math.hypot(anchor.x, anchor.y);
        if (anchorR <= prevR || anchorR > currR) continue;
        for (let i = 1; i < sb.segments.length; i += 2) {
          const s = sb.segments[i];
          const wx = rt.centerWX + s.x;
          const wy = rt.centerWY + s.y;
          spawnExplosionParticles(particles, wx, wy, COL_ORANGE, 4);
          spawnExplosionParticles(particles, wx, wy, COL_AMBER5, 3);
          if (i % 2 === 0) spawnExplosionParticles(particles, wx, wy, COL_RED, 2);
        }
        // sub-tip MEDIUM shockwave + 작은 크레이터
        const st = sb.segments[sb.segments.length - 1];
        rt.burstDiscs.push({
          wx: rt.centerWX + st.x, wy: rt.centerWY + st.y,
          birthFrame: rt.frame,
          maxR: 90, maxLife: 28,
          kind: 'medium',
          seed: Math.random() * 100,
          hasCrater: true,
        });
      }
    }
  }

  /** 균열 지속 중 용암이 튀는 자잘한 파티클 */
  private emitSustainParticles(
    rt: EarthquakeRuntime,
    particles: ParticleState[],
  ) {
    // 매 호출마다 sustain 포인트 중 일부만 샘플링해서 파티클 분출
    for (const c of rt.cracks) {
      if (Math.random() < 0.45) continue;
      const pt = c.sustainPoints[Math.floor(Math.random() * c.sustainPoints.length)];
      const wx = rt.centerWX + pt.x;
      const wy = rt.centerWY + pt.y;
      const col = Math.random() < 0.5 ? COL_ORANGE : COL_AMBER5;
      spawnHitParticles(particles, wx, wy, col);
      if (Math.random() < 0.3) {
        spawnHitParticles(particles, wx, wy, COL_LAVA_HI);
      }
    }
  }

  /** 피날레 — 균열 전체가 입자로 터지며 범위 내 적 일제 타격 */
  private fireFinal(
    rt: EarthquakeRuntime,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
    onShake: (frames: number) => void,
  ) {
    // 데미지 판정 — sustain 포인트 주변 FINAL 반경
    const r2 = FINAL_POINT_RADIUS * FINAL_POINT_RADIUS;
    for (const c of rt.cracks) {
      for (const pt of c.sustainPoints) {
        const pwx = rt.centerWX + pt.x;
        const pwy = rt.centerWY + pt.y;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          if (rt.damagedFinal.has(i)) continue;
          const dx = e.x - pwx;
          const dy = e.y - pwy;
          if (dx * dx + dy * dy > r2) continue;
          rt.damagedFinal.add(i);
          const isB = isBossType(e.type);
          e.hp -= isB ? FINAL_DMG_BOSS : FINAL_DMG_REG;
          e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? FINAL_STUN_BOSS : FINAL_STUN);
          spawnHitParticles(particles, e.x, e.y, COL_LAVA_HI);
          spawnHitParticles(particles, e.x, e.y, COL_ORANGE);
          spawnHitParticles(particles, e.x, e.y, COL_RED);
          if (e.hp <= 0) onKill(i);
        }
      }
    }

    // 파동 파티클 + tip/sub/small disc 스폰은 emitFinalWaveParticles 가
    // 파동 반경 도달 순서대로 처리 → 중앙에서 균열 따라 파바바바박.
    // fireFinal 은 중앙 mega disc + 초기 파티클 + 데미지만.

    // 중앙 MEGA wavy shockwave + 크레이터 (피날레 시작 순간)
    rt.burstDiscs.push({
      wx: rt.centerWX, wy: rt.centerWY,
      birthFrame: rt.frame,
      maxR: 260, maxLife: 56,
      kind: 'mega',
      seed: Math.random() * 100,
      hasCrater: true,
    });
    // 추가 mega 층 — 더 크고 늦게 발생하는 외곽 wavy ring
    rt.burstDiscs.push({
      wx: rt.centerWX, wy: rt.centerWY,
      birthFrame: rt.frame + 6,
      maxR: 380, maxLife: 48,
      kind: 'mega',
      seed: Math.random() * 100,
      hasCrater: false,
    });
    rt.burstDiscs.push({
      wx: rt.centerWX, wy: rt.centerWY,
      birthFrame: rt.frame + 14,
      maxR: 520, maxLife: 42,
      kind: 'mega',
      seed: Math.random() * 100,
      hasCrater: false,
    });

    // 중앙 초기 폭발 파티클 — 6색 혼합
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_ORANGE, 30);
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_AMBER5, 24);
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_AMBER8, 20);
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_RED, 18);
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_DUST, 22);
    spawnExplosionParticles(particles, rt.centerWX, rt.centerWY, COL_BROWN7, 16);

    rt.pulse = Math.max(rt.pulse, FINAL_PULSE);
    onShake(FINAL_SHAKE);
  }

  private clearGfx() {
    this.crackDarkGfx.clear();
    this.crackGlowGfx.clear();
    this.crackCoreGfx.clear();
    this.shimmerGfx.clear();
    this.debrisGfx.clear();
    this.burstDiscGfx.clear();
    this.flashGfx.clear();
  }

  private render(rt: EarthquakeRuntime) {
    this.clearGfx();

    const cx = rt.centerWX;
    const cy = rt.centerWY;
    const t = this.time;
    const f = rt.frame;

    // FINAL 동안 균열은 서서히 사라짐 (터지며 흩어지는 느낌)
    const inFinal = f >= T_FINAL_START && f < T_FADE_START;
    const inFade  = f >= T_FADE_START;
    const finalK = inFinal ? (f - T_FINAL_START) / PHASE_FINAL : 0;
    const fadeK  = inFade ? 1 - (f - T_FADE_START) / PHASE_FADE : 1;
    const crackAlpha = inFinal ? (1 - easeOutQuad(finalK)) : (inFade ? fadeK : 1);

    // ── 균열선 ──
    for (const c of rt.cracks) {
      const grown = c.grownT;
      if (grown <= 0.02 || crackAlpha <= 0.02) continue;

      const maxIdx = Math.max(2, Math.floor(c.segments.length * grown));
      const pulseK = 0.7 + 0.3 * Math.sin(t * 0.22 + c.angle * 2);
      // 두꺼움/깊이감은 drawCrackStroke 내부에서 세그먼트 w 기반(거리 비례)으로 자동 처리됨.
      // 별도 중앙-only 인덱스 구분 없이, 동일 로직을 균열 전체에 적용.

      // (1) wide glow (ADD)
      this.drawCrackStroke(this.crackGlowGfx, c.segments, maxIdx, cx, cy, 14, COL_ORANGE, 0.24 * pulseK * crackAlpha);
      this.drawCrackStroke(this.crackGlowGfx, c.segments, maxIdx, cx, cy, 8, COL_ORANGE_HI, 0.32 * pulseK * crackAlpha);
      // 용암의 열기 (깊은 red glow) — 균열 전체
      this.drawCrackStroke(this.crackGlowGfx, c.segments, maxIdx, cx, cy, 18, COL_RED, 0.16 * pulseK * crackAlpha);

      // (2) 깊은 그림자 — 갈라진 땅의 "바닥 안 보임" 느낌 — 균열 전체
      this.drawCrackStroke(this.crackDarkGfx, c.segments, maxIdx, cx, cy, 8, COL_BROWN9, 0.96 * crackAlpha);
      this.drawCrackStroke(this.crackDarkGfx, c.segments, maxIdx, cx, cy, 5.5, 0x1c0a00, 1.0 * crackAlpha);

      // (3) 일반 dark outline — 질감용 얇은 레이어
      this.drawCrackStroke(this.crackDarkGfx, c.segments, maxIdx, cx, cy, 3.2, COL_BROWN7, 0.85 * crackAlpha);

      // (4) lava core (ADD) — 4겹 (red 굵게 → amber → lava-hi)
      this.drawCrackStroke(this.crackCoreGfx, c.segments, maxIdx, cx, cy, 5.0, COL_RED, 0.90 * pulseK * crackAlpha);
      this.drawCrackStroke(this.crackCoreGfx, c.segments, maxIdx, cx, cy, 3.2, COL_RED, 0.85 * pulseK * crackAlpha);
      this.drawCrackStroke(this.crackCoreGfx, c.segments, maxIdx, cx, cy, 1.6, COL_AMBER3, 0.95 * pulseK * crackAlpha);
      this.drawCrackStroke(this.crackCoreGfx, c.segments, maxIdx, cx, cy, 0.8, COL_LAVA_HI, 0.95 * pulseK * crackAlpha);

      // sub-branches
      for (const sb of c.subs) {
        if (sb.grownT <= 0.02) continue;
        const subMax = Math.max(2, Math.floor(sb.segments.length * sb.grownT));
        this.drawCrackStroke(this.crackGlowGfx, sb.segments, subMax, cx, cy, 8, COL_ORANGE, 0.20 * pulseK * crackAlpha);
        this.drawCrackStroke(this.crackDarkGfx, sb.segments, subMax, cx, cy, 2.6, COL_BROWN9, 0.9 * crackAlpha);
        this.drawCrackStroke(this.crackCoreGfx, sb.segments, subMax, cx, cy, 1.5, COL_RED, 0.7 * pulseK * crackAlpha);
        this.drawCrackStroke(this.crackCoreGfx, sb.segments, subMax, cx, cy, 0.6, COL_AMBER3, 0.8 * pulseK * crackAlpha);
      }

      // 돌조각 파편
      const debrisShow = Math.floor(c.debris.length * grown);
      for (let di = 0; di < debrisShow; di++) {
        const d = c.debris[di];
        this.debrisGfx.beginFill(d.tint, 0.95 * crackAlpha);
        this.debrisGfx.drawCircle(cx + d.x, cy + d.y, d.r);
        this.debrisGfx.endFill();
        this.debrisGfx.lineStyle(0.8, COL_BROWN9, 0.8 * crackAlpha);
        this.debrisGfx.drawCircle(cx + d.x, cy + d.y, d.r);
        this.debrisGfx.lineStyle(0);
      }

      // heat shimmer
      const shimmerShow = Math.floor(c.shimmer.length * grown);
      for (let si = 0; si < shimmerShow; si++) {
        const sh = c.shimmer[si];
        const a = (0.35 + 0.35 * Math.sin(t * 0.35 + sh.phase)) * crackAlpha;
        if (a <= 0) continue;
        this.shimmerGfx.beginFill(COL_ORANGE_HI, a);
        this.shimmerGfx.drawCircle(cx + sh.x, cy + sh.y, sh.r);
        this.shimmerGfx.endFill();
      }
    }

    // ── 피날레 폭발 — 3단계 Ultimate 스타일 wavy shockwave + 크레이터 ──
    // 플래시/ADD 블렌드 없음. NORMAL stroke 의 유기적 wavy 링 (다중 sin 중첩).
    for (const d of rt.burstDiscs) {
      const age = rt.frame - d.birthFrame;
      if (age < 0 || age > d.maxLife) continue;
      const progress = age / d.maxLife;           // 0 → 1
      const fade = (1 - progress) * (1 - progress); // quadratic fade (EarthUltimate 패턴)
      if (fade < 0.01) continue;
      const baseR = d.maxR * easeOutQuad(progress);

      // 크레이터 (big/medium 만) — 5겹 ellipse + 8방향 방사 균열
      if (d.hasCrater) {
        this.drawImpactCrater(d.wx, d.wy, Math.min(baseR * 0.45, d.maxR * 0.4), fade, d.seed);
      }

      // wavy shockwave ring — 사이즈별 겹 수 차등
      // mega: 4겹, big: 3겹, medium: 2겹, small: 2겹 (얇고 빠른 확장)
      const layerCount = d.kind === 'mega' ? 4 : d.kind === 'big' ? 3 : 2;
      const layerConfigs: Array<{ rMul: number; color: number; lineW: number; alphaMul: number; freqMul: number }> = [
        { rMul: 1.00, color: COL_BROWN9, lineW: 3.2, alphaMul: 0.82, freqMul: 1.0 },
        { rMul: 0.86, color: COL_BROWN7, lineW: 2.4, alphaMul: 0.90, freqMul: 1.3 },
        { rMul: 0.70, color: COL_AMBER8, lineW: 1.8, alphaMul: 0.85, freqMul: 0.8 },
        { rMul: 0.54, color: COL_ORANGE, lineW: 1.3, alphaMul: 0.70, freqMul: 1.5 },
      ];
      for (let li = 0; li < layerCount; li++) {
        const cfg = layerConfigs[li];
        this.drawWavyRing(
          d.wx, d.wy,
          baseR * cfg.rMul,
          cfg.color,
          cfg.lineW,
          fade * cfg.alphaMul,
          d.seed + li * 0.7,
          cfg.freqMul,
        );
      }
    }

    // 쿵 순간 flashGfx 사용 안 함 — pulse 는 tremor(지면 진동) 에만 영향.
  }

  /** 다중 sin 중첩 wavy ring — EarthUltimate drawShockwave 패턴 */
  private drawWavyRing(
    wx: number, wy: number,
    r: number,
    color: number,
    lineW: number,
    alpha: number,
    seed: number,
    freqMult: number,
  ) {
    if (r < 1 || alpha < 0.01) return;
    const SEGS = 44;
    const g = this.burstDiscGfx;
    const t = this.time;
    g.lineStyle(lineW, color, alpha);
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2;
      const wave =
        Math.sin(a * 5 * freqMult + t * 0.18 + seed) * 3.6 +
        Math.sin(a * 9 * freqMult + t * 0.12 + seed * 0.7) * 1.9 +
        Math.sin(a * 14 * freqMult + t * 0.14 + seed * 1.3) * 1.0;
      const rr = r + wave;
      const x = wx + Math.cos(a) * rr;
      const y = wy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.lineStyle(0);
  }

  /** 충돌 크레이터 — 5겹 ellipse + 8방향 방사 균열 (EarthUltimate drawCrater 패턴) */
  private drawImpactCrater(wx: number, wy: number, r: number, alpha: number, seed: number) {
    if (r < 2 || alpha < 0.02) return;
    const g = this.burstDiscGfx;
    const ratio = 0.96; // near-circle (top-down 느낌 살짝)

    // 1. 외곽 rim — 밝은 stone (raised dirt)
    g.lineStyle(2.2, COL_STONE4, 0.85 * alpha);
    g.drawEllipse(wx, wy, r, r * ratio);
    g.lineStyle(0);

    // 2. outer fill — brown-7
    g.beginFill(COL_BROWN7, 0.75 * alpha);
    g.drawEllipse(wx, wy, r * 0.92, r * 0.88);
    g.endFill();

    // 3. mid fill — brown-9 (깊어짐)
    g.beginFill(COL_BROWN9, 0.85 * alpha);
    g.drawEllipse(wx, wy, r * 0.74, r * 0.70);
    g.endFill();

    // 4. inner fill — 아주 어두운 갈색
    g.beginFill(0x2b0f04, 0.92 * alpha);
    g.drawEllipse(wx, wy, r * 0.50, r * 0.47);
    g.endFill();

    // 5. core — near-black
    g.beginFill(0x1c0a00, 0.95 * alpha);
    g.drawEllipse(wx, wy, r * 0.26, r * 0.24);
    g.endFill();

    // 6. 8방향 방사 균열선
    for (let i = 0; i < 8; i++) {
      const a = seed * 0.37 + (i / 8) * Math.PI * 2;
      const r1 = r * 0.88;
      const r2 = r * 1.30;
      const x1 = wx + Math.cos(a) * r1;
      const y1 = wy + Math.sin(a) * r1 * ratio;
      const x2 = wx + Math.cos(a) * r2;
      const y2 = wy + Math.sin(a) * r2 * ratio;
      g.lineStyle(1.2, COL_BROWN9, 0.72 * alpha);
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
    }
    g.lineStyle(0);
  }

  private drawCrackStroke(
    g: PIXI.Graphics,
    segs: CrackSegment[],
    maxIdx: number,
    cx: number,
    cy: number,
    baseWidth: number,
    color: number,
    alpha: number,
  ) {
    if (maxIdx < 2 || alpha <= 0) return;
    // 세그먼트별 두께: 중앙 1.45x → 끝단 0.35x (강한 taper)
    for (let i = 1; i < maxIdx; i++) {
      const s0 = segs[i - 1];
      const s1 = segs[i];
      const w = baseWidth * (0.25 + s1.w * 1.20);
      g.lineStyle(w, color, alpha);
      g.moveTo(cx + s0.x, cy + s0.y);
      g.lineTo(cx + s1.x, cy + s1.y);
    }
    g.lineStyle(0);
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.worldWrap.destroy({ children: true });
    this.runtime = null;
  }
}

// ── 이징 유틸 ──
function easeOutCubic(k: number): number {
  const t = 1 - Math.min(1, Math.max(0, k));
  return 1 - t * t * t;
}
function easeOutQuad(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return 1 - (1 - t) * (1 - t);
}
// 미사용이지만 향후 확장 여지
void COL_DUST_DK;
