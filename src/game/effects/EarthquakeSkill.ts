import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles, spawnExplosionParticles } from '../particles';

/**
 * 흙 액티브 스킬 — 대지진 (Seismic Rupture)
 *
 * 컨셉: 플레이어 중심으로 방사 균열(8방향) 지면을 찢으며 뻗어나가고,
 *       균열선 위 세 지점에서 거대 바위 기둥이 솟아오름.
 *       GLSL은 지면 수직 진동 + radial shockwave 링 왜곡.
 *
 * 타 스킬과의 차별점:
 *   - 대해일 : 수평 횡단 · 밀어냄
 *   - 지옥염 : 격자 카펫 · 연쇄 폭발
 *   - 대지진 : 중심 방사 균열 · 바위 솟구침 · 지면 자체가 이펙트
 *
 * 좌표계:
 *   - 월드 좌표 이펙트 (start 시점 플레이어 위치 고정, 카메라 이동 따라감)
 *   - worldWrap 컨테이너 → overlayLayer (내부는 월드좌표 그대로 씀)
 *   - GLSL 은 groundLayer (screen-space, uCenter 매 프레임 갱신)
 */

const EARTHQUAKE_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  'uniform float uTime;',
  'uniform float uTremor;',    // 0..1 지면 수직 진동 진폭
  'uniform vec2 uCenter;',     // 충격파 중심 (screen space, px)
  'uniform float uWaveR;',     // 충격파 현재 반지름 (px)
  'uniform float uWaveStr;',   // 충격파 강도 0..1',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  vec2 distorted = pix;',
  '',
  '  // 지면 수직/수평 진동 (낮은 주파수 트레멀러)',
  '  distorted.y += sin(pix.x * 0.028 + uTime * 12.0) * uTremor * 3.6;',
  '  distorted.y += sin(pix.x * 0.09  - uTime * 17.0) * uTremor * 1.4;',
  '  distorted.x += sin(pix.y * 0.022 + uTime * 9.0)  * uTremor * 1.6;',
  '',
  '  // Radial shockwave ring',
  '  vec2 d = pix - uCenter;',
  '  float dist = length(d);',
  '  float band = exp(-pow(dist - uWaveR, 2.0) / (42.0 * 42.0));',
  '  float s = band * uWaveStr;',
  '  if (dist > 1.0) {',
  '    distorted += (d / dist) * s * 16.0;',
  '  }',
  '',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 지면 어두운 흙빛 믹스',
  '  vec3 earthTint = vec3(0.78, 0.62, 0.44);',
  '  color.rgb = mix(color.rgb, color.rgb * earthTint, uTremor * 0.30);',
  '',
  '  // 충격파 ring 위 crack 그림자',
  '  color.rgb = mix(color.rgb, color.rgb * vec3(0.48, 0.36, 0.26), s * 0.65);',
  '  // 충격파 ring 안쪽(dist<waveR)은 용암 crack 적열 약간',
  '  float inside = smoothstep(uWaveR, uWaveR - 48.0, dist) * uWaveStr;',
  '  color.rgb += vec3(0.35, 0.11, 0.02) * inside * 0.18;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 팔레트 (earth tones)
const COL_BROWN9 = 0x451a03; // amber-950 (아주 어두운 갈)
const COL_BROWN7 = 0x78350f; // amber-900
const COL_AMBER8 = 0x92400e; // amber-800
const COL_AMBER5 = 0xf59e0b; // amber-500
const COL_STONE4 = 0x78716c; // stone-500
const COL_ORANGE = 0xf97316; // orange-500 (crack glow)
const COL_RED    = 0xb91c1c; // red-700 (deep crack lava)
const COL_DUST   = 0xd6b896; // dust

// ── 페이즈 ──
const PHASE_TREMOR   = 24;   // 0.40s
const PHASE_RUPTURE  = 60;   // 1.00s
const PHASE_AFTER    = 36;   // 0.60s
const PHASE_FADE     = 18;   // 0.30s
const PHASE_TOTAL    = PHASE_TREMOR + PHASE_RUPTURE + PHASE_AFTER + PHASE_FADE; // 138

// 균열 설정
const CRACK_COUNT = 8;
const CRACK_GROW_FRAMES = 30;   // rupture 단계 중 균열이 자라는 프레임
const CRACK_LEN_BASE = 400;
const CRACK_LEN_RAND = 80;

// 바위 기둥 설정
const PILLAR_POS_FRACTIONS = [0.45, 0.70, 0.95];
const PILLAR_LIFE = 50;          // rise 9 + hover 24 + fall 17
const PILLAR_RISE = 9;
const PILLAR_HOVER = 24;
const PILLAR_DMG_REG  = 260;
const PILLAR_DMG_BOSS = 170;
const PILLAR_R = 58;

interface CrackSegment {
  x: number; y: number;  // 끝점 오프셋 (center 기준)
}

interface Crack {
  angle: number;
  length: number;
  segments: CrackSegment[];   // zigzag 포인트 (center기준 상대좌표)
  grownT: number;             // 0..1 (자라난 비율)
}

interface Pillar {
  wx: number; wy: number;     // 월드 좌표
  spawnFrame: number;         // 생성 프레임 (rupture 기준)
  t: number;                   // 현재 life (0..PILLAR_LIFE)
  active: boolean;
  damaged: Set<number>;
  height: number;              // 최대 높이
  width: number;
  skewSeed: number;            // 기울기/모양 시드
}

interface EarthquakeRuntime {
  frame: number;
  centerWX: number;            // 플레이어 월드 좌표 고정
  centerWY: number;
  cracks: Crack[];
  pillars: Pillar[];
  pillarsSpawned: boolean[];   // crack×pos 조합이 이미 스폰됐는지
  active: boolean;
  tremor: number;              // uTremor
  waveR: number;
  waveStr: number;
  secondaryWaveR: number;      // aftershock 링
  secondaryStr: number;
  damagedShockwave: Set<number>; // 초기 shockwave 1회 대미지 중복 방지
}

// 지그재그 세그먼트 생성
function buildZigzag(angle: number, length: number): CrackSegment[] {
  const segs: CrackSegment[] = [];
  const step = 18 + Math.random() * 6;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const px = -ny;
  const py = nx;
  let d = 0;
  let lateral = 0;
  segs.push({ x: 0, y: 0 });
  while (d < length) {
    d += step;
    if (d > length) d = length;
    lateral = (Math.random() - 0.5) * 14;
    const x = nx * d + px * lateral;
    const y = ny * d + py * lateral;
    segs.push({ x, y });
  }
  return segs;
}

export class EarthquakeSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  private worldWrap: PIXI.Container;
  private crackGfx: PIXI.Graphics;      // 균열선
  private crackGlowGfx: PIXI.Graphics;  // crack 하단 용암 글로우 (ADD)
  private pillarGfx: PIXI.Graphics;     // 바위 기둥 본체
  private pillarShadowGfx: PIXI.Graphics; // 바위 그림자
  private dustGfx: PIXI.Graphics;       // 먼지 링
  private ringGfx: PIXI.Graphics;       // shockwave 시각 링

  private filter: PIXI.Filter | null = null;
  private runtime: EarthquakeRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    this.crackGlowGfx = new PIXI.Graphics();
    this.crackGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.crackGlowGfx);

    this.crackGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.crackGfx);

    this.ringGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.ringGfx);

    this.pillarShadowGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.pillarShadowGfx);

    this.pillarGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.pillarGfx);

    this.dustGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.dustGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, EARTHQUAKE_FRAG, {
      uTime: 0,
      uTremor: 0,
      uCenter: [CANVAS_W / 2, CANVAS_H / 2],
      uWaveR: 0,
      uWaveStr: 0,
      uTexSize: [CANVAS_W, CANVAS_H],
    });
    this.filter.padding = 0;
    const f = this.filter;
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

  /** 시작: 플레이어 월드 좌표 기준 방사 균열 생성 */
  start(playerWX: number, playerWY: number) {
    if (this.runtime && this.runtime.active) return;
    this.ensureFilter();
    this.attachFilter();

    const cracks: Crack[] = [];
    for (let i = 0; i < CRACK_COUNT; i++) {
      const angle = (i / CRACK_COUNT) * Math.PI * 2 + Math.random() * 0.08;
      const length = CRACK_LEN_BASE + Math.random() * CRACK_LEN_RAND;
      cracks.push({
        angle,
        length,
        segments: buildZigzag(angle, length),
        grownT: 0,
      });
    }

    this.runtime = {
      frame: 0,
      centerWX: playerWX,
      centerWY: playerWY,
      cracks,
      pillars: [],
      pillarsSpawned: new Array(CRACK_COUNT * PILLAR_POS_FRACTIONS.length).fill(false),
      active: true,
      tremor: 0,
      waveR: 0,
      waveStr: 0,
      secondaryWaveR: 0,
      secondaryStr: 0,
      damagedShockwave: new Set<number>(),
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

    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    const f = rt.frame;
    const inTremor  = f < PHASE_TREMOR;
    const inRupture = f >= PHASE_TREMOR && f < PHASE_TREMOR + PHASE_RUPTURE;
    const inAfter   = f >= PHASE_TREMOR + PHASE_RUPTURE && f < PHASE_TREMOR + PHASE_RUPTURE + PHASE_AFTER;
    const inFade    = f >= PHASE_TREMOR + PHASE_RUPTURE + PHASE_AFTER;
    const fRupture  = Math.max(0, f - PHASE_TREMOR);

    // 1) Tremor — 점점 증가하는 지면 진동 + 초기 shake
    if (inTremor) {
      rt.tremor = 0.25 * (f / PHASE_TREMOR);
      if (f === 1 || f === 6 || f === 14) onShake(5);
      // dust spawn at player feet
      if ((f | 0) % 3 === 0) {
        spawnHitParticles(particles, rt.centerWX + (Math.random() - 0.5) * 50, rt.centerWY + (Math.random() - 0.5) * 50, COL_DUST);
      }
    } else if (inRupture) {
      // tremor 유지 + rupture 진행에 따라 점증
      rt.tremor = 0.25 + 0.55 * Math.min(1, fRupture / 30);
    } else if (inAfter) {
      const k = 1 - (f - (PHASE_TREMOR + PHASE_RUPTURE)) / PHASE_AFTER;
      rt.tremor = 0.45 * k + 0.08;
    } else if (inFade) {
      const k = 1 - (f - (PHASE_TREMOR + PHASE_RUPTURE + PHASE_AFTER)) / PHASE_FADE;
      rt.tremor = 0.08 * Math.max(0, k);
    }

    // 2) Rupture — 균열 자람 + 1차 shockwave + 바위 기둥 스폰
    if (inRupture) {
      const growT = Math.min(1, fRupture / CRACK_GROW_FRAMES);
      for (const c of rt.cracks) c.grownT = growT;

      // 1차 shockwave — 균열과 같이 확장 (max ~480)
      const maxR = 480;
      rt.waveR = maxR * growT;
      rt.waveStr = growT > 0.9 ? (1 - (growT - 0.9) / 0.1) * 0.85 : 0.85;

      // Rupture 시작 첫 프레임 큰 shake
      if (fRupture < 2) onShake(14);

      // Shockwave 첫 스캔 — 1회 대미지 (90px 이내 적)
      if (growT < 0.4) {
        const REG = 90;
        const boss = 60;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          if (rt.damagedShockwave.has(i)) continue;
          const dx = e.x - rt.centerWX;
          const dy = e.y - rt.centerWY;
          const dist = Math.hypot(dx, dy);
          if (dist > rt.waveR + 20) continue;
          rt.damagedShockwave.add(i);
          const isB = isBossType(e.type);
          e.hp -= isB ? boss : REG;
          e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? 12 : 24);
          spawnHitParticles(particles, e.x, e.y, COL_AMBER5);
          spawnHitParticles(particles, e.x, e.y, COL_DUST);
          if (e.hp <= 0) onKill(i);
        }
      }

      // 바위 기둥 — 각 crack × PILLAR_POS 조합, crack.grownT 가 해당 위치 넘으면 스폰
      for (let ci = 0; ci < rt.cracks.length; ci++) {
        const c = rt.cracks[ci];
        for (let pi = 0; pi < PILLAR_POS_FRACTIONS.length; pi++) {
          const key = ci * PILLAR_POS_FRACTIONS.length + pi;
          if (rt.pillarsSpawned[key]) continue;
          const frac = PILLAR_POS_FRACTIONS[pi];
          if (c.grownT < frac) continue;
          rt.pillarsSpawned[key] = true;
          const wx = rt.centerWX + Math.cos(c.angle) * c.length * frac;
          const wy = rt.centerWY + Math.sin(c.angle) * c.length * frac;
          rt.pillars.push({
            wx, wy,
            spawnFrame: fRupture,
            t: 0,
            active: true,
            damaged: new Set<number>(),
            height: 60 + Math.random() * 22,
            width: 42 + Math.random() * 14,
            skewSeed: Math.random() * 10,
          });
          spawnExplosionParticles(particles, wx, wy, COL_DUST, 12);
          spawnExplosionParticles(particles, wx, wy, COL_AMBER8, 6);
          onShake(6);
        }
      }
    }

    // 3) Aftershock — 2차 링 + 감쇠
    if (inAfter) {
      const k = (f - (PHASE_TREMOR + PHASE_RUPTURE)) / PHASE_AFTER;
      rt.waveR = 480 + 220 * k;
      rt.waveStr = Math.max(0, (1 - k) * 0.35);
      // 2차 (aftershock) 링
      rt.secondaryWaveR = 200 * k;
      rt.secondaryStr = (1 - k) * 0.35;
    } else if (inFade) {
      const k = 1 - (f - (PHASE_TREMOR + PHASE_RUPTURE + PHASE_AFTER)) / PHASE_FADE;
      rt.waveStr = 0.15 * Math.max(0, k);
    }

    // 4) 바위 기둥 업데이트 + 판정
    for (const p of rt.pillars) {
      if (!p.active) continue;
      p.t += dt;
      if (p.t >= PILLAR_LIFE) { p.active = false; continue; }

      // rise 페이즈 시작 지점에서 범위 내 대미지
      if (p.t >= PILLAR_RISE - 1 && p.t < PILLAR_RISE + 2) {
        const r2 = PILLAR_R * PILLAR_R;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          if (p.damaged.has(i)) continue;
          const dx = e.x - p.wx;
          const dy = e.y - p.wy;
          if (dx * dx + dy * dy > r2) continue;
          p.damaged.add(i);
          const isB = isBossType(e.type);
          e.hp -= isB ? PILLAR_DMG_BOSS : PILLAR_DMG_REG;
          e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? 10 : 36);
          spawnHitParticles(particles, e.x, e.y, COL_BROWN7);
          spawnHitParticles(particles, e.x, e.y, COL_AMBER5);
          if (e.hp <= 0) onKill(i);
        }
      }
    }

    // 5) uniform 주입 — uCenter 를 플레이어 월드좌표의 screen 으로 변환
    if (this.filter) {
      const screenCx = rt.centerWX - cameraX;
      const screenCy = rt.centerWY - cameraY;
      this.filter.uniforms.uTime = this.time * 0.016;
      this.filter.uniforms.uTremor = rt.tremor;
      this.filter.uniforms.uCenter = [screenCx, screenCy];
      this.filter.uniforms.uWaveR = rt.waveR;
      this.filter.uniforms.uWaveStr = rt.waveStr;
    }

    // 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    // 6) 렌더
    this.render(rt);
  }

  private clearGfx() {
    this.crackGfx.clear();
    this.crackGlowGfx.clear();
    this.pillarGfx.clear();
    this.pillarShadowGfx.clear();
    this.dustGfx.clear();
    this.ringGfx.clear();
  }

  private render(rt: EarthquakeRuntime) {
    this.clearGfx();

    const cx = rt.centerWX;
    const cy = rt.centerWY;

    // ── 균열선 ──
    for (const c of rt.cracks) {
      const grown = c.grownT;
      if (grown <= 0) continue;

      // 자란 부분만 그림
      const maxIdx = Math.max(1, Math.floor(c.segments.length * grown));
      // glow (밝은 빨강/오렌지) - 넓게
      this.crackGlowGfx.lineStyle(10, COL_ORANGE, 0.32);
      this.crackGlowGfx.moveTo(cx + c.segments[0].x, cy + c.segments[0].y);
      for (let i = 1; i < maxIdx; i++) {
        const s = c.segments[i];
        this.crackGlowGfx.lineTo(cx + s.x, cy + s.y);
      }
      this.crackGlowGfx.lineStyle(0);

      // lava 코어 (red-700)
      this.crackGlowGfx.lineStyle(4, COL_RED, 0.85);
      this.crackGlowGfx.moveTo(cx + c.segments[0].x, cy + c.segments[0].y);
      for (let i = 1; i < maxIdx; i++) {
        const s = c.segments[i];
        this.crackGlowGfx.lineTo(cx + s.x, cy + s.y);
      }
      this.crackGlowGfx.lineStyle(0);

      // 어두운 윤곽 (brown-900)
      this.crackGfx.lineStyle(2, COL_BROWN9, 0.95);
      this.crackGfx.moveTo(cx + c.segments[0].x, cy + c.segments[0].y);
      for (let i = 1; i < maxIdx; i++) {
        const s = c.segments[i];
        this.crackGfx.lineTo(cx + s.x, cy + s.y);
      }
      this.crackGfx.lineStyle(0);
    }

    // ── shockwave 링 (월드좌표 렌더) ──
    if (rt.waveStr > 0.05 && rt.waveR > 4) {
      this.ringGfx.lineStyle(6, COL_AMBER8, 0.5 * rt.waveStr);
      this.ringGfx.drawCircle(cx, cy, rt.waveR);
      this.ringGfx.lineStyle(2, COL_ORANGE, 0.85 * rt.waveStr);
      this.ringGfx.drawCircle(cx, cy, rt.waveR);
      this.ringGfx.lineStyle(0);
    }
    if (rt.secondaryStr > 0.05 && rt.secondaryWaveR > 4) {
      this.ringGfx.lineStyle(2, COL_STONE4, 0.4 * rt.secondaryStr);
      this.ringGfx.drawCircle(cx, cy, rt.secondaryWaveR);
      this.ringGfx.lineStyle(0);
    }

    // ── 바위 기둥 ──
    for (const p of rt.pillars) {
      if (!p.active) continue;
      // 진행률: 0→1 rise, 1 hover, 1→0 fall
      let riseK = 0;
      if (p.t < PILLAR_RISE) riseK = p.t / PILLAR_RISE;
      else if (p.t < PILLAR_RISE + PILLAR_HOVER) riseK = 1;
      else riseK = Math.max(0, 1 - (p.t - PILLAR_RISE - PILLAR_HOVER) / (PILLAR_LIFE - PILLAR_RISE - PILLAR_HOVER));

      const h = p.height * riseK;
      const w = p.width;
      const sx = p.wx;
      const sy = p.wy;
      const topY = sy - h;

      // shadow
      this.pillarShadowGfx.beginFill(0x1c1209, 0.38 * (0.5 + riseK * 0.5));
      this.pillarShadowGfx.drawEllipse(sx, sy + 4, w * 0.78, 9);
      this.pillarShadowGfx.endFill();

      // 기둥 본체 (jagged polygon)
      // 좌우 비대칭 사다리꼴 + 톱니
      const jag = 4 + (p.skewSeed % 3);
      const pts: number[] = [];
      // 밑변 (왼쪽→오른쪽)
      pts.push(sx - w / 2, sy + 6);
      pts.push(sx + w / 2, sy + 6);
      // 오른쪽 상단 톱니
      const topW = w * (0.72 + (p.skewSeed * 0.07) % 0.2);
      pts.push(sx + topW / 2 + jag * 0.4, topY + 8);
      pts.push(sx + topW / 2 - 2, topY + 2);
      pts.push(sx + topW / 4, topY - jag * 0.4);
      pts.push(sx, topY);
      pts.push(sx - topW / 4, topY - jag * 0.25);
      pts.push(sx - topW / 2 + 2, topY + 2);
      pts.push(sx - topW / 2 - jag * 0.3, topY + 8);

      // 메인 컬러 — 어두운 brown
      this.pillarGfx.beginFill(COL_BROWN7, 0.98);
      this.pillarGfx.drawPolygon(pts);
      this.pillarGfx.endFill();
      // 밝은 면 하이라이트 (왼쪽)
      const lightPts = [
        sx - w / 2 + 3, sy + 6,
        sx - w * 0.08, sy + 6,
        sx - w * 0.08, topY + 3,
        sx - topW / 2 + 1, topY + 3,
      ];
      this.pillarGfx.beginFill(COL_AMBER8, 0.72);
      this.pillarGfx.drawPolygon(lightPts);
      this.pillarGfx.endFill();
      // 균열 라인
      this.pillarGfx.lineStyle(1, COL_BROWN9, 0.8);
      this.pillarGfx.moveTo(sx + 2, sy + 4);
      this.pillarGfx.lineTo(sx + 5, topY + 14);
      this.pillarGfx.moveTo(sx - 4, sy + 4);
      this.pillarGfx.lineTo(sx - 7, topY + 10);
      this.pillarGfx.lineStyle(0);

      // 윤곽
      this.pillarGfx.lineStyle(1.2, COL_BROWN9, 0.95);
      this.pillarGfx.drawPolygon(pts);
      this.pillarGfx.lineStyle(0);

      // rise 중 밑에서 흙 분출 파티클 위치에 작은 먼지 띠
      if (p.t < PILLAR_RISE + 2) {
        this.dustGfx.beginFill(COL_DUST, 0.55 * (1 - riseK * 0.5));
        this.dustGfx.drawEllipse(sx, sy + 6, w * 0.9, 5);
        this.dustGfx.endFill();
      }
    }
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
