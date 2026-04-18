import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙+전기+암흑 3단계 — 자철 다이나모 (Magnetite Dynamo)
 *
 * 플레이어 머리 위에 떠있는 암흑 자기 쌍극자 코어. 검은 철가루(흙)가 자기력선(field line)을
 * 따라 흐르고, 반경 내 모든 적이 "자화(magnetized)"된다. 사이클이 진행되며 SUSTAIN
 * DoT, RECONNECT 페이즈에서 코어→자화 적 전원에게 검은 번개가 동시 방전.
 *
 * 페이즈 (총 240f / 4초):
 *   CHARGE   60f — 코어 회전↑, 자화 마커 페이드인 (초기 타격)
 *   SUSTAIN 120f — DoT 유지, 철가루/마커 회전, 자기력선 확정
 *   RECONNECT 40f — 자화 적 전원에 검은 번개 동시 방전 + 쇼크웨이브
 *   RESET    20f — 페이드아웃, 다음 사이클로
 *
 * 좌표계: 컨테이너 = 캐릭터 위치, 로컬 좌표.
 *
 * 풀 재사용 방어: engine이 매 프레임 영역 내 적 좌표(인덱스 X)만 전달. 인덱스 추적 무관.
 */

export const EED_PHASE_CHARGE = 0;
export const EED_PHASE_SUSTAIN = 1;
export const EED_PHASE_RECONNECT = 2;
export const EED_PHASE_RESET = 3;

const CHARGE_FRAMES = 60;
const SUSTAIN_FRAMES = 120;
const RECONNECT_FRAMES = 40;
const RESET_FRAMES = 20;

// ──────────────────────────────────────────────────────────────
//  GLSL Mesh — 쌍극자 자기장 procedural 베이스 (철가루 카펫 + 와류 + 극 글로우)
// ──────────────────────────────────────────────────────────────

const DIPOLE_VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aUvs;
uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
varying vec2 vUvs;
void main() {
  vUvs = aUvs;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}
`;

/**
 * 쌍극자 자기장 fragment shader.
 *
 * 매 fragment에서 위치 p (코어 기준 [-1, 1])의 dipole field B(p)를 분석적으로 계산:
 *   B_r = 2 cos(θ_rel)            (radial)
 *   B_θ = sin(θ_rel)              (tangential)
 *   θ_rel = atan(p.y, p.x) - α    (α = 코어 회전축)
 *
 * 시각 출력:
 *   1. 어두운 베이스 (인디고)
 *   2. 와류 회전 (코어 회전 따라 perpendicular plane)
 *   3. dipole field LINE 패턴 — L = r / sin²(θ_rel) 등고선 (8겹)
 *   4. 철가루 카펫 — 각 셀에 작은 stripe가 field 방향으로 정렬 (anisotropic noise)
 *   5. N/S 극 hot spot (코어 회전 따라 두 극 백열)
 *   6. RECONNECT 폭발 모드 (uReconnectShock):
 *      - 모든 색 brighten
 *      - radial 방향으로 노이즈 displace (철가루 폭사)
 *      - 와류 violently rotating
 */
const DIPOLE_FRAG = `
precision mediump float;
varying vec2 vUvs;
uniform float uTime;
uniform float uPolarAngle;     // 코어 회전 (rad)
uniform float uPhaseAlpha;     // 0~1 전체 가시성
uniform float uReconnectShock; // 0~1 폭발 spike (RECONNECT 때 1→0 감쇠)
uniform float uPolarFlip;      // 0~1 N/S 반전 플래시 강도

const float PI = 3.14159265359;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void main(void) {
  vec2 p = (vUvs - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.02) discard;

  float theta = atan(p.y, p.x);
  // 폭발 시 반경 displace (철가루가 바깥으로 폭사)
  float rEffective = r - uReconnectShock * 0.20 * smoothstep(0.0, 0.7, r);

  // 코어 회전축 — RECONNECT 폭발 첫 6f 동안 N/S 반전 (uPolarFlip)
  float dipoleAngle = uPolarAngle + uPolarFlip * PI;
  float thetaRel = theta - dipoleAngle;
  float cT = cos(thetaRel);
  float sT = sin(thetaRel);
  float sinSq = sT * sT;

  // ── 1. 베이스 (ADD blend — bgGfx 어두운 보라 위에 features만 더함) ──
  vec3 col = vec3(0.0);
  // 와류 / 빙글빙글 도는 요소 일체 제거 — 자기력선 + 철가루만 남김

  // ── 3. 8자모양 dipole field LINE 등고선 제거 — 적 연결 자기력선(fieldGfx)이 담당 ──

  // ── 4. 철가루 카펫 — 격자에 anisotropic stripe (field 방향 정렬) ──
  // 격자 셀
  float density = 38.0;
  vec2 cell = floor(p * density);
  float cellHash = hash(cell);
  // 셀 중심 점
  vec2 cellCenter = (cell + vec2(0.5)) / density;
  vec2 cellOff = p - cellCenter;
  // 셀에 jitter
  cellOff += (vec2(hash(cell + 1.3), hash(cell + 7.7)) - 0.5) * 0.5 / density;
  // field 방향 (Cartesian): B_x, B_y
  // 셀 위치 기준 dipole field 계산
  vec2 cp = cellCenter;
  float cTheta = atan(cp.y, cp.x);
  float cThetaRel = cTheta - dipoleAngle;
  float cCT = cos(cThetaRel);
  float cST = sin(cThetaRel);
  // (r̂, θ̂) → Cartesian
  // r̂ = (cos cTheta, sin cTheta), θ̂ = (-sin cTheta, cos cTheta)
  // B = 2cT·r̂ + sT·θ̂
  vec2 bDir = 2.0 * cCT * vec2(cos(cTheta), sin(cTheta))
            + cST * vec2(-sin(cTheta), cos(cTheta));
  bDir = normalize(bDir + vec2(0.0001));
  // perpendicular (filing 폭 방향)
  vec2 bPerp = vec2(-bDir.y, bDir.x);
  // 셀 내 좌표를 field 정렬 frame으로 회전
  float fAlong = dot(cellOff, bDir);
  float fPerp = dot(cellOff, bPerp);
  // 짧은 stripe: |fPerp| 작고 |fAlong| 약간 더 큼
  float perpHalf = 0.006;
  float alongHalf = 0.012;
  float sx = smoothstep(alongHalf, alongHalf * 0.5, abs(fAlong));
  float sy = smoothstep(perpHalf, perpHalf * 0.3, abs(fPerp));
  float filing = sx * sy;
  // 셀마다 강도 변동 + 외곽 약간만 sparser (전체적으로 빽빽)
  float filingDensity = step(0.20, cellHash); // 80% 셀에 (이전 70%)
  float filingStrength = filing * filingDensity * exp(-rEffective * 0.6);
  // 폭발 시 brighten + scatter
  filingStrength *= (1.0 + uReconnectShock * 1.5);
  // 색 (밝은 호박/노랑 — 어두운 인디고 배경 대비 매우 강함)
  vec3 filingCol = mix(vec3(0.99, 0.75, 0.15), vec3(1.00, 0.88, 0.30), cellHash);
  col += filingCol * filingStrength * 1.50;

  // ── 5. N/S 극 hot spot 제거 — 자기력선 + 철가루만 남김 ──

  // ── 6. RECONNECT 폭발 추가 brighten ──
  if (uReconnectShock > 0.001) {
    float coreFlash = exp(-r * r * 8.0) * uReconnectShock;
    col += vec3(0.65, 0.50, 0.95) * coreFlash * 0.80;
    // radial shock band
    float ringR = uReconnectShock * 0.95;
    float ringW = 0.10;
    float onRing = exp(-pow((r - ringR) / ringW, 2.0));
    col += vec3(0.55, 0.42, 0.90) * onRing * uReconnectShock * 0.65;
  }

  // ── 7. N/S 반전 플래시 (코어 폭발) ──
  if (uPolarFlip > 0.001) {
    float flipFlash = exp(-r * r * 5.0) * uPolarFlip;
    col += vec3(0.80, 0.72, 0.98) * flipFlash * 0.95;
  }

  // 색 saturate clamp (washout 방지)
  col = min(col, vec3(0.95));

  // 외곽 vignette
  float vignette = 1.0 - smoothstep(0.92, 1.02, r);

  // ADD blend 출력: col * alpha (premultiplied), alpha=1
  float a = vignette * uPhaseAlpha;
  gl_FragColor = vec4(col * a, a);
}
`;

// ── 색상 (흰색 금지, 메인 컬러 라이트 톤) ──
// 암흑 (코어 본체)
const COL_DARK_ABYSS = 0x1e1b4b; // indigo-950
const COL_DARK_MID   = 0x312e81; // indigo-900
const COL_DARK_VIO   = 0x4c1d95; // violet-900
// 보라 (자기/전기 방전)
const COL_VIO_700 = 0x6d28d9;
const COL_VIO_600 = 0x7c3aed;
const COL_VIO_500 = 0x8b5cf6;
const COL_VIO_400 = 0xa78bfa;
const COL_VIO_300 = 0xc4b5fd; // 흰색 대체
// 흙 (철가루)
const COL_IRON_DARK = 0x44260a;
const COL_IRON      = 0xa16207;
const COL_IRON_HOT  = 0xd4a53c;

interface IronDust {
  /** target index */
  ti: number;
  /** progress along bezier (0=core → 1=target) */
  t: number;
  speed: number;
  size: number;
  /** -1 / +1 — 어느 쪽 dipole loop인지 */
  side: number;
}

interface ReconnectArc {
  tx: number; ty: number;
  life: number;
  maxLife: number;
  seed: number;
}

interface Shockwave {
  life: number;
  maxLife: number;
  maxR: number;
  /** 시작 지연 (staggered shockwave용) */
  delay: number;
  /** 두께 배수 */
  thicknessScale: number;
}

interface VerticalBolt {
  /** 타겟 ground 좌표 (로컬) */
  tx: number; ty: number;
  life: number;
  maxLife: number;
  seed: number;
}

interface GroundCrack {
  /** 0,0 → (tx, ty) 방향 균열 */
  tx: number; ty: number;
  life: number;
  maxLife: number;
  seed: number;
}

export class EarthElectricDarkEffect {
  private container: PIXI.Container;
  /** 어두운 베이스 자기장 흔적 (NORMAL) */
  private bgGfx: PIXI.Graphics;
  /** 자기력선 (ADD) */
  private fieldGfx: PIXI.Graphics;
  /** 철가루 (ADD) */
  private dustGfx: PIXI.Graphics;
  /** 자화 마커 (ADD) */
  private markerGfx: PIXI.Graphics;
  /** 쌍극자 코어 본체 (NORMAL — 가장 위에서 묵직) */
  private coreGfx: PIXI.Graphics;
  /** 코어 글로우 (ADD) */
  private coreGlowGfx: PIXI.Graphics;
  /** RECONNECT 아크/쇼크웨이브 글로우 (ADD) */
  private arcGlowGfx: PIXI.Graphics;
  /** RECONNECT 아크 코어 (NORMAL) */
  private arcCoreGfx: PIXI.Graphics;
  /** 그라운드 크랙 (NORMAL — 어두운 균열) */
  private crackGfx: PIXI.Graphics;
  /** 수직 검은 번개 기둥 글로우 (ADD) */
  private vboltGlowGfx: PIXI.Graphics;
  /** 수직 검은 번개 기둥 코어 (NORMAL) */
  private vboltCoreGfx: PIXI.Graphics;

  // GLSL Mesh
  private mesh: PIXI.Mesh | null = null;
  private shader: PIXI.Shader | null = null;
  private uReconnectShock = 0;
  private uPolarFlip = 0;
  private polarAngle = 0;

  active = false;
  radius = 0;
  private time = 0;
  private phase = EED_PHASE_CHARGE;
  private phaseTime = 0;

  // engine이 매 프레임 갱신 — 영역 내 적의 캐릭터 기준 로컬 좌표
  private targets: Array<{ lx: number; ly: number }> = [];
  // RECONNECT 진입 시 스냅샷 (아크 발사 대상 고정)
  private reconnectTargets: Array<{ lx: number; ly: number }> = [];

  // 한번-발화 이벤트 (engine이 update 후 같은 프레임에 읽음)
  reconnectFiredThisFrame = false;
  chargeStartedThisFrame = false;

  // 시각 파티클
  private dust: IronDust[] = [];
  private arcs: ReconnectArc[] = [];
  private shocks: Shockwave[] = [];
  private vbolts: VerticalBolt[] = [];
  private cracks: GroundCrack[] = [];
  private dustTimer = 0;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 가장 아래 — 어두운 외곽 호흡 링만 최소 유지 (mesh가 베이스 통째 담당)
    this.bgGfx = new PIXI.Graphics();
    this.container.addChild(this.bgGfx);

    // ── GLSL Mesh — start()에서 instantiate ──
    // (mesh는 bgGfx 위, fieldGfx 아래 — addChild는 start()에서)

    // 그라운드 크랙 (NORMAL — 어두운 균열, mesh 위)
    this.crackGfx = new PIXI.Graphics();
    this.container.addChild(this.crackGfx);

    this.fieldGfx = new PIXI.Graphics();
    this.fieldGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.fieldGfx);

    this.dustGfx = new PIXI.Graphics();
    this.dustGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.dustGfx);

    this.markerGfx = new PIXI.Graphics();
    this.markerGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.markerGfx);

    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);

    this.coreGlowGfx = new PIXI.Graphics();
    this.coreGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.coreGlowGfx);

    // 수직 번개 기둥 (코어 위 — 가장 두드러져야)
    this.vboltGlowGfx = new PIXI.Graphics();
    this.vboltGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.vboltGlowGfx);

    this.vboltCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.vboltCoreGfx);

    this.arcGlowGfx = new PIXI.Graphics();
    this.arcGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.arcGlowGfx);

    this.arcCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.arcCoreGfx);
  }

  private ensureMesh() {
    if (this.mesh) return;
    // quad 반경: dipole loop 외곽까지 잘림 X — 반경 1.05× 정도
    const R = Math.ceil(this.radius * 1.05);
    const geometry = new PIXI.Geometry()
      .addAttribute('aVertexPosition', [-R, -R,  R, -R,  R,  R,  -R,  R], 2)
      .addAttribute('aUvs', [0, 0,  1, 0,  1, 1,  0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);
    this.shader = PIXI.Shader.from(DIPOLE_VERT, DIPOLE_FRAG, {
      uTime: 0,
      uPolarAngle: 0,
      uPhaseAlpha: 0,
      uReconnectShock: 0,
      uPolarFlip: 0,
    });
    this.mesh = new PIXI.Mesh(geometry, this.shader as PIXI.MeshMaterial);
    this.mesh.position.set(0, 0); // 컨테이너가 player 위치
    // ADD blend — 바닥 위에 자기장 features만 더함 (어둡게 덮지 X)
    this.mesh.blendMode = PIXI.BLEND_MODES.ADD;
    // bgGfx 바로 위, crackGfx 아래에 삽입
    this.container.addChildAt(this.mesh, 1);
  }

  /** 컨테이너 노출 — EffectManager에서 layer 변경 시 re-parent 위해 */
  getContainer(): PIXI.Container {
    return this.container;
  }

  start(x: number, y: number, radius: number) {
    this.active = true;
    this.radius = radius;
    this.time = 0;
    this.phase = EED_PHASE_CHARGE;
    this.phaseTime = 0;
    this.targets = [];
    this.reconnectTargets = [];
    this.dust = [];
    this.arcs = [];
    this.shocks = [];
    this.vbolts = [];
    this.cracks = [];
    this.dustTimer = 0;
    this.chargeStartedThisFrame = true;
    this.reconnectFiredThisFrame = false;
    this.uReconnectShock = 0;
    this.uPolarFlip = 0;
    this.polarAngle = 0;
    this.container.position.set(x, y);
    this.container.visible = true;
    this.ensureMesh();
    if (this.mesh) this.mesh.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  setTargets(targets: Array<{ lx: number; ly: number }>) {
    this.targets = targets;
  }

  isCharge(): boolean { return this.phase === EED_PHASE_CHARGE; }
  isSustain(): boolean { return this.phase === EED_PHASE_SUSTAIN; }
  isReconnect(): boolean { return this.phase === EED_PHASE_RECONNECT; }
  currentPhase(): number { return this.phase; }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTime += dt;

    // 이벤트 플래그 — 이번 update에서 새로 발화한 게 아니면 false
    this.reconnectFiredThisFrame = false;
    if (!this.chargeStartedThisFrame) {
      // start() 직후엔 이 한 프레임 동안 true 유지
    } else {
      // 다음 프레임에는 자동으로 false (아래 페이즈 전이에서 다시 true 가능)
      this.chargeStartedThisFrame = false;
    }

    // ── 페이즈 전이 ──
    if (this.phase === EED_PHASE_CHARGE && this.phaseTime >= CHARGE_FRAMES) {
      this.phase = EED_PHASE_SUSTAIN;
      this.phaseTime = 0;
    } else if (this.phase === EED_PHASE_SUSTAIN && this.phaseTime >= SUSTAIN_FRAMES) {
      this.phase = EED_PHASE_RECONNECT;
      this.phaseTime = 0;
      this.reconnectFiredThisFrame = true;
      // 자화 적 스냅샷 → 수직 번개 + 그라운드 크랙 spawn (횡 아크 X)
      this.reconnectTargets = this.targets.slice();
      for (const t of this.reconnectTargets) {
        this.vbolts.push({
          tx: t.lx, ty: t.ly,
          life: 0, maxLife: 26,
          seed: Math.random() * 1000,
        });
        this.cracks.push({
          tx: t.lx, ty: t.ly,
          life: 0, maxLife: 36,
          seed: Math.random() * 1000,
        });
      }
      // 3겹 staggered 쇼크웨이브
      this.shocks.push({ life: 0, maxLife: RECONNECT_FRAMES,         maxR: this.radius * 1.10, delay: 0,  thicknessScale: 1.0 });
      this.shocks.push({ life: 0, maxLife: RECONNECT_FRAMES + 6,     maxR: this.radius * 0.85, delay: 8,  thicknessScale: 0.7 });
      this.shocks.push({ life: 0, maxLife: RECONNECT_FRAMES + 12,    maxR: this.radius * 1.30, delay: 16, thicknessScale: 1.4 });
      // 셰이더 폭발 모드 + 극성 반전 플래시 spike
      this.uReconnectShock = 1.0;
      this.uPolarFlip = 1.0;
    } else if (this.phase === EED_PHASE_RECONNECT && this.phaseTime >= RECONNECT_FRAMES) {
      this.phase = EED_PHASE_RESET;
      this.phaseTime = 0;
    } else if (this.phase === EED_PHASE_RESET && this.phaseTime >= RESET_FRAMES) {
      this.phase = EED_PHASE_CHARGE;
      this.phaseTime = 0;
      this.chargeStartedThisFrame = true;
    }

    // 철가루 spawn (CHARGE/SUSTAIN 동안)
    if (this.phase === EED_PHASE_CHARGE || this.phase === EED_PHASE_SUSTAIN) {
      this.dustTimer += dt;
      if (this.dustTimer >= 1.5 && this.targets.length > 0 && this.dust.length < 240) {
        this.dustTimer = 0;
        for (let ti = 0; ti < this.targets.length; ti++) {
          for (let k = 0; k < 2; k++) {
            this.dust.push({
              ti,
              t: 0,
              speed: 0.012 + Math.random() * 0.011,
              size: 1.0 + Math.random() * 1.4,
              side: Math.random() < 0.5 ? -1 : 1,
            });
          }
        }
      }
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.t += d.speed * dt;
      if (d.ti >= this.targets.length || d.t >= 1) swapPop(this.dust, i);
    }

    for (let i = this.arcs.length - 1; i >= 0; i--) {
      this.arcs[i].life += dt;
      if (this.arcs[i].life >= this.arcs[i].maxLife) swapPop(this.arcs, i);
    }
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      this.shocks[i].life += dt;
      if (this.shocks[i].life >= this.shocks[i].maxLife) swapPop(this.shocks, i);
    }
    for (let i = this.vbolts.length - 1; i >= 0; i--) {
      this.vbolts[i].life += dt;
      if (this.vbolts[i].life >= this.vbolts[i].maxLife) swapPop(this.vbolts, i);
    }
    for (let i = this.cracks.length - 1; i >= 0; i--) {
      this.cracks[i].life += dt;
      if (this.cracks[i].life >= this.cracks[i].maxLife) swapPop(this.cracks, i);
    }

    // ── 셰이더 uniforms 갱신 ──
    // 코어 회전 — drawCore와 동기화 (같은 rotSpeed 산식)
    let rotSpeed = 0.05;
    if (this.phase === EED_PHASE_CHARGE) {
      const t = this.phaseTime / CHARGE_FRAMES;
      rotSpeed = 0.05 + t * 0.12;
    } else if (this.phase === EED_PHASE_SUSTAIN) {
      rotSpeed = 0.16;
    } else if (this.phase === EED_PHASE_RECONNECT) {
      const t = this.phaseTime / RECONNECT_FRAMES;
      rotSpeed = 0.32 - t * 0.27;
    }
    this.polarAngle += rotSpeed * dt;

    // RECONNECT shock decay (1→0 over RECONNECT_FRAMES)
    if (this.phase === EED_PHASE_RECONNECT) {
      this.uReconnectShock = 1 - this.phaseTime / RECONNECT_FRAMES;
    } else {
      this.uReconnectShock *= Math.max(0, 1 - 0.08 * dt);
      if (this.uReconnectShock < 0.001) this.uReconnectShock = 0;
    }
    // 극성 반전 플래시 — RECONNECT 첫 6f만 1, 이후 빠르게 0
    if (this.phase === EED_PHASE_RECONNECT && this.phaseTime < 6) {
      this.uPolarFlip = 1 - this.phaseTime / 6;
    } else {
      this.uPolarFlip = 0;
    }

    if (this.shader) {
      // 항상 alpha=1 (반투명 X), RESET만 fade-out
      let phaseAlpha = 1;
      if (this.phase === EED_PHASE_RESET) phaseAlpha = 1 - this.phaseTime / RESET_FRAMES;
      this.shader.uniforms.uTime = this.time * 0.016;
      this.shader.uniforms.uPolarAngle = this.polarAngle;
      this.shader.uniforms.uPhaseAlpha = phaseAlpha;
      this.shader.uniforms.uReconnectShock = this.uReconnectShock;
      this.shader.uniforms.uPolarFlip = this.uPolarFlip;
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.bgGfx.clear();
    this.crackGfx.clear();
    this.fieldGfx.clear();
    this.dustGfx.clear();
    this.markerGfx.clear();
    this.coreGfx.clear();
    this.coreGlowGfx.clear();
    this.vboltGlowGfx.clear();
    this.vboltCoreGfx.clear();
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();

    // 페이즈별 전체 alpha (반투명 X — RESET만 fade-out)
    let mainAlpha = 1;
    if (this.phase === EED_PHASE_RESET) {
      mainAlpha = 1 - this.phaseTime / RESET_FRAMES;
    }

    this.drawGround(mainAlpha);
    this.drawCracks();
    this.drawFieldLines(mainAlpha);  // 적과 연결된 자기력선 (중앙→적 호) — 살림
    this.drawDust(mainAlpha);        // 그 호 따라 흐르는 철가루 입자 — 살림
    this.drawMarkers(mainAlpha);
    this.drawCore(mainAlpha);
    this.drawShocks();
    this.drawVerticalBolts();
  }

  // ── 1. 배경 = 단색 어두운 보라 (통일, alpha=1) + 외곽 윤곽 링 ──
  private drawGround(_a: number) {
    const R = this.radius;
    // 단색 어두운 violet disk (캐릭터 위 layer라서 캐릭터 가림)
    this.bgGfx.beginFill(COL_DARK_VIO, 1.0); // 0x4c1d95 violet-900
    this.bgGfx.drawCircle(0, 0, R);
    this.bgGfx.endFill();
    // 외곽 호흡 링 2겹 (라이트 보라 윤곽)
    const breathe = 1 + Math.sin(this.time * 0.04) * 0.018;
    this.bgGfx.lineStyle(3.5, COL_VIO_400, 1.0);
    this.bgGfx.drawCircle(0, 0, R * breathe);
    this.bgGfx.lineStyle(1.8, COL_VIO_300, 1.0);
    this.bgGfx.drawCircle(0, 0, R * 0.92 * breathe);
    this.bgGfx.lineStyle(0);
  }

  // ── 2. 자기력선 (코어 ↔ 각 타겟, 양쪽 dipole arc) ──
  private drawFieldLines(a: number) {
    if (a < 0.02 || this.targets.length === 0) return;

    // 항상 alpha=1 (반투명 X)
    let lineAlpha = 1.0;
    if (this.phase === EED_PHASE_RESET) {
      lineAlpha = 1 - this.phaseTime / RESET_FRAMES;
    }

    for (const tgt of this.targets) {
      const dx = tgt.lx;
      const dy = tgt.ly;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;
      this.drawDipoleArc(dx, dy, dist, +1, lineAlpha);
      this.drawDipoleArc(dx, dy, dist, -1, lineAlpha);
    }
  }

  /** 코어(0,0) → (dx,dy) 사이 양쪽으로 부푼 호 (3패스: 외글로우/중글로우/심선) */
  private drawDipoleArc(dx: number, dy: number, dist: number, side: number, alpha: number) {
    const px = -dy / dist;
    const py = dx / dist;
    const bulge = Math.min(dist * 0.45, 95);
    const cx = dx * 0.5 + px * bulge * side;
    const cy = dy * 0.5 + py * bulge * side;

    // 두꺼운 외글로우 (보라)
    this.fieldGfx.lineStyle(5.0, COL_VIO_500, alpha);
    this.fieldGfx.moveTo(0, 0);
    this.fieldGfx.quadraticCurveTo(cx, cy, dx, dy);
    // 중심 라이트 보라 (밝게 — 어두운 배경 대비)
    this.fieldGfx.lineStyle(2.5, COL_VIO_300, alpha);
    this.fieldGfx.moveTo(0, 0);
    this.fieldGfx.quadraticCurveTo(cx, cy, dx, dy);
    this.fieldGfx.lineStyle(0);
  }

  // ── 3. 철가루 (자기력선 quadratic bezier 따라 흐름) ──
  private drawDust(a: number) {
    if (a < 0.02) return;
    for (const d of this.dust) {
      if (d.ti >= this.targets.length) continue;
      const tgt = this.targets[d.ti];
      const dx = tgt.lx;
      const dy = tgt.ly;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;
      const px = -dy / dist;
      const py = dx / dist;
      const bulge = Math.min(dist * 0.45, 95);
      const cxq = dx * 0.5 + px * bulge * d.side;
      const cyq = dy * 0.5 + py * bulge * d.side;

      // B(t) = (1-t)²·(0,0) + 2(1-t)t·C + t²·P1
      const tt = d.t;
      const omt = 1 - tt;
      const x = 2 * omt * tt * cxq + tt * tt * dx;
      const y = 2 * omt * tt * cyq + tt * tt * dy;

      const fade = tt < 0.10 ? tt / 0.10 : tt > 0.85 ? (1 - tt) / 0.15 : 1;
      const alpha = fade * a;

      // 밝은 호박 (yellow-300) — 보라 배경 대비 강함
      this.dustGfx.beginFill(0xfde047, alpha);
      this.dustGfx.drawCircle(x, y, d.size * 1.5);
      this.dustGfx.endFill();
      this.dustGfx.beginFill(0xfbbf24, alpha);
      this.dustGfx.drawCircle(x, y, d.size * 2.8);
      this.dustGfx.endFill();
    }
  }

  // ── 4. 자화 마커 (적 주변 회전 입자 + 점선 링) ──
  private drawMarkers(a: number) {
    if (a < 0.02 || this.targets.length === 0) return;
    const baseR = 14;
    const rot = this.time * 0.10;

    let mAlpha = 1.00;
    if (this.phase === EED_PHASE_CHARGE) {
      mAlpha = (this.phaseTime / CHARGE_FRAMES) * 1.00;
    } else if (this.phase === EED_PHASE_RECONNECT) {
      mAlpha = 1.00 * (1 - this.phaseTime / RECONNECT_FRAMES);
    } else if (this.phase === EED_PHASE_RESET) {
      mAlpha = 0.55 * (1 - this.phaseTime / RESET_FRAMES);
    }
    mAlpha *= a;

    for (const tgt of this.targets) {
      const x = tgt.lx;
      const y = tgt.ly;
      // 회전 입자 3개 (크고 진하게)
      for (let arc = 0; arc < 3; arc++) {
        const off = rot + arc * (Math.PI * 2 / 3);
        const rx = x + Math.cos(off) * baseR;
        const ry = y + Math.sin(off) * baseR;
        this.markerGfx.beginFill(COL_VIO_300, mAlpha);
        this.markerGfx.drawCircle(rx, ry, 2.8);
        this.markerGfx.endFill();
        this.markerGfx.beginFill(COL_VIO_500, mAlpha * 0.65);
        this.markerGfx.drawCircle(rx, ry, 5.5);
        this.markerGfx.endFill();
      }
      // 윤곽 링 (선명)
      this.markerGfx.lineStyle(1.8, COL_VIO_400, mAlpha * 0.95);
      this.markerGfx.drawCircle(x, y, baseR);
      this.markerGfx.lineStyle(1.2, COL_VIO_300, mAlpha * 0.55);
      this.markerGfx.drawCircle(x, y, baseR * 0.65);
      this.markerGfx.lineStyle(0);
    }
  }

  // ── 5. 쌍극자 코어 (회전 N/S 두 구체 + 어두운 본체) ──
  private drawCore(a: number) {
    if (a < 0.02) return;

    // 페이즈별 코어 크기 (회전은 polarAngle을 그대로 씀 — 셰이더와 동기화)
    let coreScale = 1.0;
    if (this.phase === EED_PHASE_CHARGE) {
      const t = this.phaseTime / CHARGE_FRAMES;
      coreScale = 0.85 + t * 0.20;
    } else if (this.phase === EED_PHASE_SUSTAIN) {
      coreScale = 1.05 + Math.sin(this.time * 0.08) * 0.04;
    } else if (this.phase === EED_PHASE_RECONNECT) {
      const t = this.phaseTime / RECONNECT_FRAMES;
      coreScale = 1.10 + (1 - t) * 0.30;
    } else {
      coreScale = 0.85;
    }

    // 극성 반전 플래시: N과 S 위치를 swap (uPolarFlip 1→0 동안)
    const angle = this.polarAngle + this.uPolarFlip * Math.PI;
    const sep = 12 * coreScale;
    const nx = Math.cos(angle) * sep;
    const ny = Math.sin(angle) * sep;
    const sx = -nx;
    const sy = -ny;

    // 코어 본체 (보라 톤 진하게)
    this.coreGfx.beginFill(COL_VIO_700, 0.95 * a);
    this.coreGfx.drawCircle(0, 0, 24 * coreScale);
    this.coreGfx.endFill();
    this.coreGfx.beginFill(COL_VIO_600, 1.00 * a);
    this.coreGfx.drawCircle(0, 0, 17 * coreScale);
    this.coreGfx.endFill();

    // N극 (밝은 보라)
    this.coreGfx.beginFill(COL_VIO_500, 1.00 * a);
    this.coreGfx.drawCircle(nx, ny, 10 * coreScale);
    this.coreGfx.endFill();
    this.coreGfx.beginFill(COL_VIO_300, 1.00 * a);
    this.coreGfx.drawCircle(nx, ny, 5.5 * coreScale);
    this.coreGfx.endFill();
    // S극 (진보라)
    this.coreGfx.beginFill(COL_VIO_700, 1.00 * a);
    this.coreGfx.drawCircle(sx, sy, 10 * coreScale);
    this.coreGfx.endFill();
    this.coreGfx.beginFill(COL_VIO_400, 0.95 * a);
    this.coreGfx.drawCircle(sx, sy, 5.5 * coreScale);
    this.coreGfx.endFill();

    // ADD 글로우 (작고 약하게 — 셰이더 hot spot과 중첩 시 washout 방지)
    this.coreGlowGfx.beginFill(COL_VIO_500, 0.18 * a);
    this.coreGlowGfx.drawCircle(0, 0, 30 * coreScale);
    this.coreGlowGfx.endFill();
    this.coreGlowGfx.beginFill(COL_VIO_400, 0.10 * a);
    this.coreGlowGfx.drawCircle(0, 0, 46 * coreScale);
    this.coreGlowGfx.endFill();
    // 양 극 하이라이트
    this.coreGlowGfx.beginFill(COL_VIO_300, 0.55 * a);
    this.coreGlowGfx.drawCircle(nx, ny, 4 * coreScale);
    this.coreGlowGfx.endFill();
    this.coreGlowGfx.beginFill(COL_VIO_300, 0.55 * a);
    this.coreGlowGfx.drawCircle(sx, sy, 4 * coreScale);
    this.coreGlowGfx.endFill();

    // RECONNECT 폭발 플래시
    if (this.phase === EED_PHASE_RECONNECT) {
      const t = this.phaseTime / RECONNECT_FRAMES;
      const flash = (1 - t) * (1 - t);
      this.coreGlowGfx.beginFill(COL_VIO_400, flash * 0.55);
      this.coreGlowGfx.drawCircle(0, 0, 80);
      this.coreGlowGfx.endFill();
      this.coreGlowGfx.beginFill(COL_VIO_300, flash * 0.35);
      this.coreGlowGfx.drawCircle(0, 0, 130);
      this.coreGlowGfx.endFill();
    }
    // N/S 반전 플래시 — 코어 자체가 폭발 (큰 라이트 보라 폭발)
    if (this.uPolarFlip > 0.001) {
      this.coreGlowGfx.beginFill(COL_VIO_300, this.uPolarFlip * 0.85);
      this.coreGlowGfx.drawCircle(0, 0, 60 * coreScale);
      this.coreGlowGfx.endFill();
      this.coreGlowGfx.beginFill(COL_VIO_400, this.uPolarFlip * 0.55);
      this.coreGlowGfx.drawCircle(0, 0, 110 * coreScale);
      this.coreGlowGfx.endFill();
      // 양 극에서 순간 방전 스파크
      this.coreGlowGfx.beginFill(COL_VIO_300, this.uPolarFlip * 0.9);
      this.coreGlowGfx.drawCircle(nx, ny, 8 * coreScale);
      this.coreGlowGfx.drawCircle(sx, sy, 8 * coreScale);
      this.coreGlowGfx.endFill();
    }
  }

  // ── 6. RECONNECT 3겹 staggered 쇼크웨이브 ──
  private drawShocks() {
    for (const s of this.shocks) {
      // delay 안 끝나면 skip
      if (s.life < s.delay) continue;
      const eff = s.life - s.delay;
      const effMax = s.maxLife - s.delay;
      if (effMax <= 0) continue;
      const t = eff / effMax;
      if (t > 1) continue;
      const r = s.maxR * (0.10 + t * 0.95);
      const alpha = (1 - t) * (1 - t);
      const thick = s.thicknessScale;
      this.arcGlowGfx.lineStyle(6 * thick, COL_VIO_500, alpha * 0.50);
      this.arcGlowGfx.drawCircle(0, 0, r);
      this.arcGlowGfx.lineStyle(2.5 * thick, COL_VIO_300, alpha * 0.70);
      this.arcGlowGfx.drawCircle(0, 0, r * 0.97);
      // 안쪽 어두운 공허 (실제 충격파 효과)
      this.arcGlowGfx.lineStyle(1.2 * thick, COL_DARK_VIO, alpha * 0.50);
      this.arcGlowGfx.drawCircle(0, 0, r * 1.03);
      this.arcGlowGfx.lineStyle(0);
    }
  }

  // ── 7-2. RECONNECT 그라운드 크랙 (코어→자화 적 어두운 균열) ──
  private drawCracks() {
    for (const c of this.cracks) {
      const t = c.life / c.maxLife;
      // 0~0.25: 빠르게 길어짐, 0.25~1: 페이드아웃
      const grow = Math.min(1, t / 0.25);
      const alpha = t < 0.25 ? grow : (1 - (t - 0.25) / 0.75);
      if (alpha < 0.03) continue;

      const dx = c.tx;
      const dy = c.ty;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;
      const perpX = -dy / dist;
      const perpY = dx / dist;
      const segs = 9;
      const jit = Math.min(dist * 0.06, 14);

      // 균열 path (zigzag)
      const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }];
      const reach = grow; // 0~1
      for (let i = 1; i < segs; i++) {
        const f = (i / segs) * reach;
        const j = Math.sin(c.seed + i * 2.7) * jit;
        pts.push({ x: dx * f + perpX * j, y: dy * f + perpY * j });
      }

      // 외곽 (진보라 — 검정 X, 다른 ADD 요소를 가리지 X)
      this.crackGfx.lineStyle(4, COL_VIO_700, alpha * 0.85);
      this.crackGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.crackGfx.lineTo(pts[i].x, pts[i].y);
      // 안쪽 보라 발광 (균열 속에서 새어나오는 자기 에너지)
      this.crackGfx.lineStyle(1.2, COL_VIO_300, alpha * 0.95);
      this.crackGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.crackGfx.lineTo(pts[i].x, pts[i].y);
      this.crackGfx.lineStyle(0);
    }
  }

  // ── 7-3. RECONNECT 수직 검은 번개 기둥 (자화 적 위치마다 하늘에서 낙뢰) ──
  private drawVerticalBolts() {
    for (const v of this.vbolts) {
      const t = v.life / v.maxLife;
      // 0~0.10: 빠른 strike-in, 0.10~1: 페이드아웃
      const alpha = t < 0.10 ? t / 0.10 : (1 - t) * (1 - t);
      if (alpha < 0.02) continue;

      const tx = v.tx;
      const ty = v.ty;
      // 하늘 = 타겟 위 350px (반경보다 크게 — 화면 밖에서 떨어지는 느낌)
      const skyY = ty - 350;
      const segs = 9;
      const jit = 18;

      const pts: { x: number; y: number }[] = [{ x: tx, y: skyY }];
      for (let i = 1; i < segs; i++) {
        const f = i / segs;
        const yj = skyY + (ty - skyY) * f;
        const xj = tx + Math.sin(v.seed + v.life * 13 + i * 2.1) * jit;
        pts.push({ x: xj, y: yj });
      }
      pts.push({ x: tx, y: ty });

      // 외글로우 (보라 짙음)
      this.vboltGlowGfx.lineStyle(9, COL_VIO_700, alpha * 0.55);
      this.vboltGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.vboltGlowGfx.lineTo(pts[i].x, pts[i].y);
      // 중글로우
      this.vboltGlowGfx.lineStyle(5, COL_VIO_500, alpha * 0.70);
      this.vboltGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.vboltGlowGfx.lineTo(pts[i].x, pts[i].y);
      // 코어 (라이트 보라)
      this.vboltCoreGfx.lineStyle(2.2, COL_VIO_300, alpha * 0.92);
      this.vboltCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.vboltCoreGfx.lineTo(pts[i].x, pts[i].y);

      // 착탄점 폭발 (큰 보라 폭점)
      this.vboltGlowGfx.lineStyle(0);
      this.vboltGlowGfx.beginFill(COL_VIO_400, alpha * 0.75);
      this.vboltGlowGfx.drawCircle(tx, ty, 14);
      this.vboltGlowGfx.endFill();
      this.vboltGlowGfx.beginFill(COL_VIO_300, alpha * 0.55);
      this.vboltGlowGfx.drawCircle(tx, ty, 22);
      this.vboltGlowGfx.endFill();
      this.vboltGlowGfx.beginFill(COL_DARK_VIO, alpha * 0.40);
      this.vboltGlowGfx.drawCircle(tx, ty, 32);
      this.vboltGlowGfx.endFill();
    }
    this.vboltGlowGfx.lineStyle(0);
    this.vboltCoreGfx.lineStyle(0);
  }

  // ── 7. RECONNECT 검은 번개 아크 (코어→타겟, 4패스 지그재그) ──
  private drawArcs() {
    for (const arc of this.arcs) {
      const t = arc.life / arc.maxLife;
      // 빠른 fade-in (0→0.15) 후 quadratic fade-out
      const alpha = t < 0.15 ? t / 0.15 : (1 - t) * (1 - t);
      if (alpha < 0.02) continue;

      const dx = arc.tx;
      const dy = arc.ty;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;
      const perpX = -dy / dist;
      const perpY = dx / dist;
      const segs = 7;
      const jit = Math.min(dist * 0.12, 30);

      const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }];
      for (let i = 1; i < segs; i++) {
        const f = i / segs;
        const j = Math.sin(arc.seed + arc.life * 11 + i * 1.7) * jit;
        pts.push({ x: dx * f + perpX * j, y: dy * f + perpY * j });
      }
      pts.push({ x: dx, y: dy });

      // 외글로우 (보라 짙음)
      this.arcGlowGfx.lineStyle(7, COL_VIO_700, alpha * 0.55);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);
      // 중글로우
      this.arcGlowGfx.lineStyle(4, COL_VIO_500, alpha * 0.70);
      this.arcGlowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcGlowGfx.lineTo(pts[i].x, pts[i].y);
      // 코어 (라이트 보라 — 흰색 대체)
      this.arcCoreGfx.lineStyle(1.8, COL_VIO_300, alpha * 0.92);
      this.arcCoreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.arcCoreGfx.lineTo(pts[i].x, pts[i].y);

      // 타겟 폭점
      this.arcGlowGfx.lineStyle(0);
      this.arcGlowGfx.beginFill(COL_VIO_400, alpha * 0.70);
      this.arcGlowGfx.drawCircle(dx, dy, 7);
      this.arcGlowGfx.endFill();
      this.arcGlowGfx.beginFill(COL_VIO_300, alpha * 0.50);
      this.arcGlowGfx.drawCircle(dx, dy, 12);
      this.arcGlowGfx.endFill();
    }
    this.arcGlowGfx.lineStyle(0);
    this.arcCoreGfx.lineStyle(0);
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.targets = [];
    this.reconnectTargets = [];
    this.dust = [];
    this.arcs = [];
    this.shocks = [];
    this.vbolts = [];
    this.cracks = [];
    this.uReconnectShock = 0;
    this.uPolarFlip = 0;
    this.bgGfx.clear();
    this.crackGfx.clear();
    this.fieldGfx.clear();
    this.dustGfx.clear();
    this.markerGfx.clear();
    this.coreGfx.clear();
    this.coreGlowGfx.clear();
    this.vboltGlowGfx.clear();
    this.vboltCoreGfx.clear();
    this.arcGlowGfx.clear();
    this.arcCoreGfx.clear();
    if (this.mesh) this.mesh.visible = false;
  }

  destroy() {
    this.stop();
    if (this.mesh) {
      this.mesh.destroy();
      this.mesh = null;
      this.shader = null;
    }
    this.container.destroy({ children: true });
  }
}
