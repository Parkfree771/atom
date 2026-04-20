import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles, spawnExplosionParticles } from '../particles';

/**
 * 암흑 액티브 스킬 — 심연 (Abyss)
 *
 * 컨셉 (사용자 지정):
 *   - 모든 공격 · 몬스터 일시 정지
 *   - 배경이 검게 덮임
 *   - ~2초 후, 한 점(특이점)으로 스크린 내 모든 몬스터 + 검정 배경이 수렴
 *   - GLSL 중력 렌즈로 시공간 왜곡 표현
 *   - "전체" = 보이는 화면 전체 (안 보이는 월드는 영향 X)
 *
 * 타 스킬과의 차별점:
 *   - 대해일/지옥염/대지진/뇌전폭풍/심판광 : 모두 "타격" 중심
 *   - 심연 : 시간 정지 + 공간 수렴 + 흡수 (damage 보다 "세상을 삼킴" 연출)
 *
 * 좌표계:
 *   - GLSL 중력 렌즈 → worldContainer (적/이펙트까지 시각 왜곡) — BigBang 패턴
 *   - 다크 오버레이 + blob 파티클 → overlayLayer (screen-space)
 *   - singularity core → overlayLayer (screen-space)
 */

// ── GLSL 중력 렌즈 ──
const ABYSS_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',      // 특이점 screen px',
  'uniform float uStrength;',   // 0..1 렌즈 강도',
  'uniform float uRadius;',     // 영향권 (px)',
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  vec2 delta = pix - uCenter;',
  '  float dist = length(delta);',
  '',
  '  if (dist > uRadius * 1.25 || uStrength < 0.001) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  float t = clamp(dist / uRadius, 0.0, 1.0);',
  '  float falloff = exp(-t * t * 1.8);',
  '',
  '  // 구심 수렴 pull (항상 음의 방향 — singularity 향함)',
  '  float pull = uStrength * falloff * 180.0;',
  '',
  '  // 회전 소용돌이 (회전각 시간에 따라 증가, 거리에 따라 빠르게)',
  '  vec2 perp = vec2(-dir.y, dir.x);',
  '  float swirl = (sin(dist * 0.03 - uTime * 3.5) + 1.2) * uStrength * 18.0 * falloff;',
  '',
  '  vec2 distorted = pix - dir * pull + perp * swirl;',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 중심에 가까울수록 어두워짐 + 보라색 fringe',
  '  float centerDark = exp(-(t * t) * 5.5) * uStrength;',
  '  color.rgb = mix(color.rgb, color.rgb * 0.12, centerDark * 0.85);',
  '  color.rgb += vec3(0.18, 0.04, 0.32) * centerDark * 0.6;',
  '',
  '  // 사건 지평선 (horizon ring)',
  '  float horizon = exp(-pow(dist - uRadius * 0.18, 2.0) / (22.0 * 22.0)) * uStrength;',
  '  color.rgb += vec3(0.45, 0.10, 0.70) * horizon * 0.55;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 팔레트
const COL_VOID      = 0x020010; // 심연 본체
const COL_VIO9      = 0x3b0764; // purple-950 (rim outer)
const COL_VIO8      = 0x581c87; // purple-900
const COL_VIO7      = 0x7e22ce; // purple-700 (rim mid)
const COL_VIO5      = 0xa855f7; // purple-500 (rim inner bright)
const COL_VIO3      = 0xd8b4fe; // purple-300 (core flash)
const COL_WHITE_HI  = 0xe9d5ff; // purple-200 (peak flash)
const COL_DARK_BLOB = 0x0a0617; // 빨려드는 dark blob

// ── 페이즈 ──
const PHASE_DARKEN   = 24;   // 0.40s
const PHASE_HOLD     = 96;   // 1.60s
const PHASE_PULL     = 36;   // 0.60s
const PHASE_COLLAPSE = 12;   // 0.20s
const PHASE_RESTORE  = 18;   // 0.30s
const PHASE_TOTAL    = PHASE_DARKEN + PHASE_HOLD + PHASE_PULL + PHASE_COLLAPSE + PHASE_RESTORE; // 186

// 판정
const DMG_REG  = 9999;    // 일반 적: 소멸
const DMG_BOSS = 360;     // 보스: 강력 + 스턴
const PULL_ABSORB_DIST = 18;  // singularity 도달 판정 반경 (스크린)

interface TrackedEnemy {
  idx: number;
  // 시작 시 world 좌표 lock
  lockWX: number;
  lockWY: number;
  // pull 시점에 각자 초기 스크린 좌표 저장 (월드좌표가 아닌 screen 기준 수렴)
  pullSX: number;
  pullSY: number;
  absorbed: boolean;
}

interface AbyssRuntime {
  frame: number;
  tracked: TrackedEnemy[];

  // 스크린 좌표 기준 singularity (고정)
  centerSX: number;
  centerSY: number;

  // 카메라 (start 시 저장 — 월드→스크린 추적용)
  startCamX: number;
  startCamY: number;

  canvasW: number;
  canvasH: number;

  // 상태값
  darkAlpha: number;         // 0..1 base 다크 오버레이
  singularityR: number;      // 특이점 반경 (px)
  singularityBright: number; // 중심 밝기 0..1
  lensStrength: number;      // uStrength
  lensRadius: number;        // uRadius

  active: boolean;
  pullStartCaptured: boolean;
  collapsed: boolean;
}

export class AbyssSkill {
  private overlayLayer: PIXI.Container;
  private worldContainer: PIXI.Container;

  // 오버레이 Graphics
  private darkGfx: PIXI.Graphics;           // 기본 full-screen dark
  private horizonGfx: PIXI.Graphics;        // 사건 지평선 ring
  private coreGfx: PIXI.Graphics;           // 특이점 코어 (ADD 아님 — void core)
  private coreGlowGfx: PIXI.Graphics;       // 특이점 외곽 보라 글로우 (ADD)
  private flashGfx: PIXI.Graphics;          // collapse flash

  private filter: PIXI.Filter | null = null;
  private runtime: AbyssRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.worldContainer = worldContainer;

    // 렌더 순서: dark(세상을 덮음) → horizon → glow → core → flash
    // (가짜 dark blob 제거 — 실제 적 스프라이트가 스파이럴)
    this.darkGfx = new PIXI.Graphics();
    this.overlayLayer.addChild(this.darkGfx);

    this.horizonGfx = new PIXI.Graphics();
    this.horizonGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.overlayLayer.addChild(this.horizonGfx);

    this.coreGlowGfx = new PIXI.Graphics();
    this.coreGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.overlayLayer.addChild(this.coreGlowGfx);

    this.coreGfx = new PIXI.Graphics();
    this.overlayLayer.addChild(this.coreGfx);

    this.flashGfx = new PIXI.Graphics();
    this.flashGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.overlayLayer.addChild(this.flashGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, ABYSS_FRAG, {
      uCenter: [CANVAS_W / 2, CANVAS_H / 2],
      uStrength: 0,
      uRadius: Math.hypot(CANVAS_W / 2, CANVAS_H / 2),
      uTime: 0,
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
    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);
    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  private detachFilter() {
    if (!this.filter || !this.worldContainer.filters) return;
    this.worldContainer.filters = this.worldContainer.filters.filter((f) => f !== this.filter);
  }

  start(
    enemies: EnemyState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
  ) {
    if (this.runtime && this.runtime.active) return;
    this.ensureFilter();
    this.attachFilter();

    // 스크린 내 살아있는 적만 추적
    const tracked: TrackedEnemy[] = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const sx = e.x - cameraX;
      const sy = e.y - cameraY;
      if (sx < -30 || sx > canvasW + 30) continue;
      if (sy < -30 || sy > canvasH + 30) continue;
      tracked.push({
        idx: i,
        lockWX: e.x,
        lockWY: e.y,
        pullSX: 0,
        pullSY: 0,
        absorbed: false,
      });
    }

    const centerSX = canvasW / 2;
    const centerSY = canvasH / 2;

    this.runtime = {
      frame: 0,
      tracked,
      centerSX,
      centerSY,
      startCamX: cameraX,
      startCamY: cameraY,
      canvasW,
      canvasH,
      darkAlpha: 0,
      singularityR: 0,
      singularityBright: 0,
      lensStrength: 0,
      lensRadius: Math.hypot(canvasW / 2, canvasH / 2) * 1.15,
      active: true,
      pullStartCaptured: false,
      collapsed: false,
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
  ) {
    const rt = this.runtime;
    if (!rt || !rt.active) return;

    this.time += dt;
    rt.frame += dt;

    const f = rt.frame;
    const inDarken   = f < PHASE_DARKEN;
    const inHold     = f >= PHASE_DARKEN && f < PHASE_DARKEN + PHASE_HOLD;
    const inPull     = f >= PHASE_DARKEN + PHASE_HOLD && f < PHASE_DARKEN + PHASE_HOLD + PHASE_PULL;
    const inCollapse = f >= PHASE_DARKEN + PHASE_HOLD + PHASE_PULL && f < PHASE_DARKEN + PHASE_HOLD + PHASE_PULL + PHASE_COLLAPSE;
    const inRestore  = f >= PHASE_DARKEN + PHASE_HOLD + PHASE_PULL + PHASE_COLLAPSE;

    const fPull    = Math.max(0, f - (PHASE_DARKEN + PHASE_HOLD));
    const fCollapse= Math.max(0, f - (PHASE_DARKEN + PHASE_HOLD + PHASE_PULL));
    const fRestore = Math.max(0, f - (PHASE_DARKEN + PHASE_HOLD + PHASE_PULL + PHASE_COLLAPSE));

    // ── DARKEN/HOLD/PULL 동안 추적된 적 정지 (stunFrames 매 프레임 리셋) ──
    if (inDarken || inHold || inPull) {
      for (const t of rt.tracked) {
        const e = enemies[t.idx];
        if (!e || !e.active) continue;
        e.stunFrames = Math.max(e.stunFrames ?? 0, 2);
      }
    }

    // ── PULL 시작 순간 — 적 스크린 좌표 스냅샷 (실제 적이 스파이럴; 가짜 blob 제거됨) ──
    if (inPull && !rt.pullStartCaptured) {
      rt.pullStartCaptured = true;
      for (const t of rt.tracked) {
        const e = enemies[t.idx];
        if (!e || !e.active) continue;
        t.pullSX = e.x - cameraX;
        t.pullSY = e.y - cameraY;
      }
    }

    // ── PULL 페이즈 — 실제 적 스프라이트가 스파이럴로 수렴 ──
    if (inPull) {
      const k = fPull / PHASE_PULL;
      const eased = k * k; // ease-in (느리게 → 빠르게)

      for (const t of rt.tracked) {
        if (t.absorbed) continue;
        const e = enemies[t.idx];
        if (!e || !e.active) continue;
        if (isBossType(e.type)) continue; // 보스 면역

        const fromSX = t.pullSX;
        const fromSY = t.pullSY;
        const toSX = rt.centerSX;
        const toSY = rt.centerSY;
        const dx0 = fromSX - toSX;
        const dy0 = fromSY - toSY;
        const baseA = Math.atan2(dy0, dx0);
        const baseR = Math.hypot(dx0, dy0);
        const curR = baseR * (1 - eased);
        const curA = baseA + eased * Math.PI * 1.3;
        const curSX = toSX + Math.cos(curA) * curR;
        const curSY = toSY + Math.sin(curA) * curR;

        e.x = cameraX + curSX;
        e.y = cameraY + curSY;

        // 찢겨나가는 입자 — 적이 스파이럴 중 몸에서 어둠 파편이 튀는 느낌
        // 중심에 가까워질수록 빈도 증가
        const trailChance = 0.35 + eased * 0.55;
        if (Math.random() < trailChance) {
          const color = Math.random() < 0.5 ? COL_VIO7 : COL_VIO9;
          spawnHitParticles(particles, e.x, e.y, color);
        }
        if (eased > 0.5 && Math.random() < 0.4) {
          spawnHitParticles(particles, e.x, e.y, COL_DARK_BLOB);
        }

        // singularity 도달 체크
        if (curR < PULL_ABSORB_DIST) {
          t.absorbed = true;
          const isB = isBossType(e.type);
          e.hp -= isB ? DMG_BOSS : DMG_REG;
          e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? 90 : 2);
          spawnHitParticles(particles, e.x, e.y, COL_VIO5);
          spawnHitParticles(particles, e.x, e.y, COL_VIO3);
          spawnExplosionParticles(particles, e.x, e.y, COL_VIO7, isB ? 18 : 12);
          spawnExplosionParticles(particles, e.x, e.y, COL_VIO9, 8);
          if (e.hp <= 0) onKill(t.idx);
        }
      }
    }

    // ── uniform 스케쥴 ──
    if (inDarken) {
      const k = f / PHASE_DARKEN;
      rt.darkAlpha = 0.88 * k;
      rt.singularityR = 3 * k;
      rt.singularityBright = 0.4 * k;
      rt.lensStrength = 0;
    } else if (inHold) {
      rt.darkAlpha = 0.88;
      const k = (f - PHASE_DARKEN) / PHASE_HOLD;
      rt.singularityR = 3 + 5 * k;
      rt.singularityBright = 0.4 + 0.2 * Math.sin(this.time * 0.12) * 0.5 + 0.15;
      rt.lensStrength = 0;
    } else if (inPull) {
      const k = fPull / PHASE_PULL;
      // base dark alpha 감소 (적 스파이럴이 시각 전달)
      rt.darkAlpha = 0.88 * (1 - k * 0.85);
      rt.singularityR = 8 + 12 * k;
      rt.singularityBright = 0.6 + 0.35 * k;
      rt.lensStrength = Math.min(1, k * 1.3);
    } else if (inCollapse) {
      const k = fCollapse / PHASE_COLLAPSE;
      // 수축 → 폭발 피크
      if (k < 0.5) {
        rt.singularityR = 20 + k * 60;
        rt.singularityBright = 0.95 + k * 0.05;
      } else {
        rt.singularityR = 50 * (1 - (k - 0.5) / 0.5);
        rt.singularityBright = Math.max(0, 1 - (k - 0.5) / 0.5);
      }
      rt.lensStrength = Math.max(0, 1 - k * 1.2);
      rt.darkAlpha = 0;
    } else if (inRestore) {
      rt.singularityR = 0;
      rt.singularityBright = 0;
      rt.lensStrength = 0;
      rt.darkAlpha = 0;
      // collapse 순간에만 collapsed=true 설정 (restore 에서도 flash 표시)
    }

    // collapse 진입 순간: 폭발 플래시 트리거
    if (inCollapse && !rt.collapsed) {
      rt.collapsed = true;
      // 남은 적 모두 추가 피해 (혹시 살아남은 일반)
      for (const t of rt.tracked) {
        if (t.absorbed) continue;
        const e = enemies[t.idx];
        if (!e || !e.active) continue;
        const isB = isBossType(e.type);
        e.hp -= isB ? DMG_BOSS : DMG_REG;
        if (e.hp <= 0) onKill(t.idx);
      }
      // (가짜 blob 제거됨 — 실제 적만 이 시점에서 collapse 처리)
    }

    // uniform 주입 (lens center 는 스크린 좌표 고정)
    if (this.filter) {
      this.filter.uniforms.uCenter = [rt.centerSX, rt.centerSY];
      this.filter.uniforms.uStrength = rt.lensStrength;
      this.filter.uniforms.uRadius = rt.lensRadius;
      this.filter.uniforms.uTime = this.time * 0.016;
    }

    // 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    this.render(rt);
    void canvasW; void canvasH; void fRestore;
  }

  private clearGfx() {
    this.darkGfx.clear();
    this.horizonGfx.clear();
    this.coreGfx.clear();
    this.coreGlowGfx.clear();
    this.flashGfx.clear();
  }

  private render(rt: AbyssRuntime) {
    this.clearGfx();

    // ── base dark overlay ──
    if (rt.darkAlpha > 0.01) {
      this.darkGfx.beginFill(COL_VOID, rt.darkAlpha);
      this.darkGfx.drawRect(0, 0, rt.canvasW, rt.canvasH);
      this.darkGfx.endFill();
    }

    // (가짜 dark blob 렌더 제거됨 — 실제 적 스프라이트가 수렴 연출)

    // ── singularity core ──
    if (rt.singularityR > 0.2) {
      const cx = rt.centerSX;
      const cy = rt.centerSY;
      const R = rt.singularityR;

      // 바깥 보라 halo (ADD)
      this.coreGlowGfx.beginFill(COL_VIO5, 0.25 * rt.singularityBright);
      this.coreGlowGfx.drawCircle(cx, cy, R * 4.2);
      this.coreGlowGfx.endFill();
      this.coreGlowGfx.beginFill(COL_VIO7, 0.4 * rt.singularityBright);
      this.coreGlowGfx.drawCircle(cx, cy, R * 2.6);
      this.coreGlowGfx.endFill();
      this.coreGlowGfx.beginFill(COL_VIO3, 0.55 * rt.singularityBright);
      this.coreGlowGfx.drawCircle(cx, cy, R * 1.6);
      this.coreGlowGfx.endFill();

      // 사건 지평선 링 (pull/collapse 때 뚜렷)
      const horizonStr = Math.min(1, rt.lensStrength * 1.3 + (rt.collapsed ? 0.4 : 0));
      if (horizonStr > 0.05) {
        this.horizonGfx.lineStyle(2.2, COL_VIO5, 0.85 * horizonStr);
        this.horizonGfx.drawCircle(cx, cy, R * 2.2);
        this.horizonGfx.lineStyle(1.4, COL_VIO3, 0.7 * horizonStr);
        this.horizonGfx.drawCircle(cx, cy, R * 3.0);
        this.horizonGfx.lineStyle(0);
      }

      // void core (not ADD — 실제 어둠)
      this.coreGfx.beginFill(COL_VOID, 0.98);
      this.coreGfx.drawCircle(cx, cy, R);
      this.coreGfx.endFill();

      // 중심 하이라이트 점 (아주 작게)
      if (rt.singularityBright > 0.5) {
        this.coreGfx.beginFill(COL_VIO3, rt.singularityBright * 0.9);
        this.coreGfx.drawCircle(cx, cy, Math.max(1, R * 0.2));
        this.coreGfx.endFill();
      }
    }

    // collapse flash 제거됨 (전화면 white flash + radial purple flash 전부 삭제)
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.darkGfx.destroy();
    this.horizonGfx.destroy();
    this.coreGfx.destroy();
    this.coreGlowGfx.destroy();
    this.flashGfx.destroy();
    this.runtime = null;
  }
}

// 언사용 상수 경고 방지
void COL_VIO8;
