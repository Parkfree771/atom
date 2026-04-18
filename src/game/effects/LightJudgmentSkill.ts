import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles, spawnExplosionParticles } from '../particles';

/**
 * 빛 액티브 스킬 — 심판광 (Final Judgment)
 *
 * 컨셉: 화면 전체가 서서히 밝아지며, 살아있는 적 각각의 머리 위에 빛의 십자가 마커가
 *       순차 생성된다. 차징이 끝나는 순간 모든 적에게 동시에 수직 광선이 강림하고,
 *       화면은 색상 반전(홀리 모드) 후 서서히 복귀한다.
 *
 * 타 스킬과의 차별점:
 *   - 뇌전폭풍 : 시간차 무작위 난타 + chain 전이
 *   - 심판광   : 동시 전체 타격 (일제 판정, chain 없음, 마커→집행 의식감)
 *
 * 좌표계:
 *   - 마커: 월드 좌표 (적 추적) — worldWrap 내부
 *   - 빔:   Verdict 시점 고정 좌표 (적 죽어도 유지) — worldWrap
 *   - GLSL: groundLayer — uBrightness + uInvert
 */

const JUDGMENT_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  'uniform float uBrightness;',   // 0..1 밝기',
  'uniform float uInvert;',        // 0..1 색상 반전',
  'uniform float uRadiate;',       // 0..1 상단 방사',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec4 color = texture2D(uSampler, vTextureCoord);',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '',
  '  // 상단에서 쏟아지는 빛 — y 작을수록 강함',
  '  float top = 1.0 - smoothstep(0.0, uTexSize.y * 0.85, pix.y);',
  '  vec3 radCol = vec3(1.0, 0.97, 0.82);',
  '  color.rgb = mix(color.rgb, color.rgb + radCol, top * uRadiate * 0.35);',
  '',
  '  // 전체 밝기',
  '  vec3 warm = vec3(1.0, 0.96, 0.78);',
  '  color.rgb = mix(color.rgb, color.rgb + warm * 0.55, uBrightness);',
  '  color.rgb = clamp(color.rgb, 0.0, 1.0);',
  '',
  '  // 색상 반전 (홀리 모드)',
  '  color.rgb = mix(color.rgb, vec3(1.0) - color.rgb, uInvert);',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 팔레트 (holy light)
const COL_WHITE     = 0xffffff;
const COL_AMBER1    = 0xfef3c7; // amber-100
const COL_AMBER2    = 0xfde68a; // amber-200
const COL_YEL3      = 0xfde047; // yellow-300
const COL_YEL4      = 0xfacc15; // yellow-400
const COL_AMBER4    = 0xfbbf24; // amber-400
const COL_ORANGE3   = 0xfdba74; // orange-300 (halo)
const COL_AMBER7    = 0xb45309; // amber-700 (룬 dark stroke)

// ── 페이즈 ──
const PHASE_GATHER  = 30;   // 0.50s
const PHASE_MARK    = 36;   // 0.60s
const PHASE_VERDICT = 18;   // 0.30s
const PHASE_INVERT  = 36;   // 0.60s
const PHASE_FADE    = 18;   // 0.30s
const PHASE_TOTAL   = PHASE_GATHER + PHASE_MARK + PHASE_VERDICT + PHASE_INVERT + PHASE_FADE; // 138

// 판정
const DMG_REG  = 500;        // 일반 적 사실상 즉사
const DMG_BOSS = 260;
const BOSS_STUN = 120;       // 2초 스턴
const BEAM_CORE_W = 8;
const BEAM_GLOW_W = 26;
const BEAM_HALO_W = 64;

interface Marker {
  enemyIdx: number;
  spawnFrame: number;   // Mark 페이즈 기준 프레임
  lockedWX: number;     // 최초 적 위치 (적이 움직이면 추적하지만 fallback 용)
  lockedWY: number;
  alive: boolean;
}

interface Beam {
  wx: number;           // 빔의 월드 x (Verdict 시 고정)
  wy: number;           // 적 중심 월드 y (화면상 빔 파괴 표시용)
  start: number;        // Verdict 시작 프레임 기준 (0)
}

interface JudgmentRuntime {
  frame: number;
  markers: Marker[];
  beams: Beam[];
  active: boolean;

  brightness: number;   // uBrightness
  invert: number;       // uInvert
  radiate: number;      // uRadiate

  verdictFired: boolean;
}

export class LightJudgmentSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  private worldWrap: PIXI.Container;
  private markerGfx: PIXI.Graphics;
  private markerGlowGfx: PIXI.Graphics;
  private beamCoreGfx: PIXI.Graphics;
  private beamGlowGfx: PIXI.Graphics;
  private beamHaloGfx: PIXI.Graphics;
  private beamBaseGfx: PIXI.Graphics;   // 지면 타격 링

  private screenGfx: PIXI.Graphics;     // 화면 전체 오버레이 (스크린 좌표)

  private filter: PIXI.Filter | null = null;
  private runtime: JudgmentRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.worldWrap = new PIXI.Container();
    this.overlayLayer.addChild(this.worldWrap);

    // 빔은 아래 레이어 (halo→glow→core)
    this.beamHaloGfx = new PIXI.Graphics();
    this.beamHaloGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.beamHaloGfx);

    this.beamGlowGfx = new PIXI.Graphics();
    this.beamGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.beamGlowGfx);

    this.beamBaseGfx = new PIXI.Graphics();
    this.beamBaseGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.beamBaseGfx);

    this.beamCoreGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.beamCoreGfx);

    this.markerGlowGfx = new PIXI.Graphics();
    this.markerGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.worldWrap.addChild(this.markerGlowGfx);

    this.markerGfx = new PIXI.Graphics();
    this.worldWrap.addChild(this.markerGfx);

    this.screenGfx = new PIXI.Graphics();
    this.screenGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.overlayLayer.addChild(this.screenGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, JUDGMENT_FRAG, {
      uBrightness: 0,
      uInvert: 0,
      uRadiate: 0,
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

  start(enemies: EnemyState[], cameraX: number, cameraY: number, canvasW: number, canvasH: number) {
    if (this.runtime && this.runtime.active) return;
    this.ensureFilter();
    this.attachFilter();

    // 스크린 내 살아있는 적만 대상
    const candidates: number[] = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const sx = e.x - cameraX;
      const sy = e.y - cameraY;
      if (sx < -30 || sx > canvasW + 30) continue;
      if (sy < -30 || sy > canvasH + 30) continue;
      candidates.push(i);
    }

    // 마커 생성 — 순차 스폰 간격은 MARK 페이즈 내 균등 분배
    const markers: Marker[] = [];
    const n = candidates.length;
    if (n > 0) {
      for (let k = 0; k < n; k++) {
        const idx = candidates[k];
        const e = enemies[idx];
        const spawnFrame = Math.floor((k / n) * (PHASE_MARK - 4));
        markers.push({
          enemyIdx: idx,
          spawnFrame,
          lockedWX: e.x,
          lockedWY: e.y,
          alive: true,
        });
      }
    }

    this.runtime = {
      frame: 0,
      markers,
      beams: [],
      active: true,
      brightness: 0,
      invert: 0,
      radiate: 0,
      verdictFired: false,
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

    this.worldWrap.x = -cameraX;
    this.worldWrap.y = -cameraY;

    const f = rt.frame;
    const inGather  = f < PHASE_GATHER;
    const inMark    = f >= PHASE_GATHER && f < PHASE_GATHER + PHASE_MARK;
    const inVerdict = f >= PHASE_GATHER + PHASE_MARK && f < PHASE_GATHER + PHASE_MARK + PHASE_VERDICT;
    const inInvert  = f >= PHASE_GATHER + PHASE_MARK + PHASE_VERDICT && f < PHASE_GATHER + PHASE_MARK + PHASE_VERDICT + PHASE_INVERT;
    const inFade    = f >= PHASE_GATHER + PHASE_MARK + PHASE_VERDICT + PHASE_INVERT;

    const fVerdict = Math.max(0, f - (PHASE_GATHER + PHASE_MARK));
    const fInvert  = Math.max(0, f - (PHASE_GATHER + PHASE_MARK + PHASE_VERDICT));
    const fFade    = Math.max(0, f - (PHASE_GATHER + PHASE_MARK + PHASE_VERDICT + PHASE_INVERT));

    // uniform schedule
    if (inGather) {
      rt.radiate = f / PHASE_GATHER;
      rt.brightness = 0.35 * (f / PHASE_GATHER);
    } else if (inMark) {
      rt.radiate = 1;
      const k = (f - PHASE_GATHER) / PHASE_MARK;
      rt.brightness = 0.35 + 0.35 * k;
    } else if (inVerdict) {
      rt.radiate = 1;
      rt.brightness = 0.70 + 0.25 * Math.min(1, fVerdict / 6);  // 0.70 → 0.95
    } else if (inInvert) {
      rt.brightness = Math.max(0, 0.95 - 0.85 * (fInvert / PHASE_INVERT));
      rt.invert = fInvert < PHASE_INVERT * 0.6
        ? (fInvert / (PHASE_INVERT * 0.6))
        : Math.max(0, 1 - (fInvert - PHASE_INVERT * 0.6) / (PHASE_INVERT * 0.4));
      rt.radiate = Math.max(0, 1 - fInvert / PHASE_INVERT);
    } else if (inFade) {
      const k = 1 - fFade / PHASE_FADE;
      rt.brightness = 0.1 * Math.max(0, k);
      rt.invert = 0;
      rt.radiate = 0;
    }

    // Mark 페이즈 — 마커 활성 여부만 갱신 (렌더 단계에서 spawn 판정)
    // 적이 죽으면 marker.alive = false, but beam 은 여전히 생성

    // Verdict 시작 순간 — 한 번만 실행
    if (inVerdict && !rt.verdictFired) {
      rt.verdictFired = true;
      // 모든 마커 위치에 빔 생성 + 대미지 적용
      for (const m of rt.markers) {
        // marker의 현재 추적 위치 (적이 살아있으면 그 좌표, 죽었으면 lock)
        const e = enemies[m.enemyIdx];
        let wx: number, wy: number;
        if (e && e.active) {
          wx = e.x;
          wy = e.y;
        } else {
          wx = m.lockedWX;
          wy = m.lockedWY;
        }
        rt.beams.push({ wx, wy, start: fVerdict });

        // 대미지 (그 시점 범위 내 적)
        this.dealBeamDamage(wx, enemies, particles, onKill);

        // 폭발 파티클
        spawnExplosionParticles(particles, wx, wy, COL_AMBER2, 12);
        spawnExplosionParticles(particles, wx, wy, COL_YEL3, 6);
      }
    }

    // uniform 주입
    if (this.filter) {
      this.filter.uniforms.uBrightness = rt.brightness;
      this.filter.uniforms.uInvert = rt.invert;
      this.filter.uniforms.uRadiate = rt.radiate;
    }

    // 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    this.render(rt, enemies, cameraX, cameraY, canvasW, canvasH, fVerdict, inInvert);
  }

  /** 수직 빔 x=wx 전체 세로 통과 — 해당 세로 라인 ±BEAM_GLOW_W 에 있는 적 타격 */
  private dealBeamDamage(
    wx: number,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
  ) {
    const halfW = BEAM_GLOW_W * 1.4;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = Math.abs(e.x - wx);
      if (dx > halfW) continue;
      const isB = isBossType(e.type);
      e.hp -= isB ? DMG_BOSS : DMG_REG;
      e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? BOSS_STUN : 40);
      spawnHitParticles(particles, e.x, e.y, COL_AMBER2);
      spawnHitParticles(particles, e.x, e.y, COL_YEL4);
      if (e.hp <= 0) onKill(i);
    }
  }

  private clearGfx() {
    this.markerGfx.clear();
    this.markerGlowGfx.clear();
    this.beamCoreGfx.clear();
    this.beamGlowGfx.clear();
    this.beamHaloGfx.clear();
    this.beamBaseGfx.clear();
    this.screenGfx.clear();
  }

  private render(
    rt: JudgmentRuntime,
    enemies: EnemyState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
    fVerdict: number,
    inInvert: boolean,
  ) {
    this.clearGfx();
    void canvasW;

    const f = rt.frame;
    const inMark = f >= PHASE_GATHER && f < PHASE_GATHER + PHASE_MARK;
    const fMark = f - PHASE_GATHER;

    // ── 마커 (빛의 십자가) ──
    if (inMark || (f >= PHASE_GATHER + PHASE_MARK && fVerdict < 3)) {
      for (const m of rt.markers) {
        // marker 활성 여부 — spawnFrame 이 경과했으면 표시
        if (inMark && fMark < m.spawnFrame) continue;

        // 위치: 적 추적 (살아있으면 적 따라, 아니면 locked)
        const e = enemies[m.enemyIdx];
        let wx: number, wy: number;
        if (e && e.active) {
          wx = e.x;
          wy = e.y;
        } else {
          wx = m.lockedWX;
          wy = m.lockedWY;
        }

        // 적 위 32px 십자가
        const mx = wx;
        const my = wy - 32;
        const age = inMark ? (fMark - m.spawnFrame) : PHASE_MARK;
        const spawnK = Math.min(1, age / 8); // 등장 애니
        const pulse = 0.75 + 0.25 * Math.sin(this.time * 0.3 + m.enemyIdx * 0.7);

        // 광배 (ADD)
        this.markerGlowGfx.beginFill(COL_YEL3, 0.32 * spawnK * pulse);
        this.markerGlowGfx.drawCircle(mx, my, 18);
        this.markerGlowGfx.endFill();
        this.markerGlowGfx.beginFill(COL_AMBER2, 0.22 * spawnK);
        this.markerGlowGfx.drawCircle(mx, my, 28);
        this.markerGlowGfx.endFill();

        // 십자 모양 — 수직 + 수평 바
        const barLong = 14 * spawnK;
        const barShort = 14 * spawnK;
        const barW = 3.2;
        this.markerGfx.beginFill(COL_YEL3, 0.95 * spawnK);
        this.markerGfx.drawRect(mx - barW / 2, my - barLong, barW, barLong * 2);
        this.markerGfx.drawRect(mx - barShort, my - barW / 2, barShort * 2, barW);
        this.markerGfx.endFill();
        // 코어 흰
        this.markerGfx.beginFill(COL_WHITE, 0.92 * spawnK);
        this.markerGfx.drawRect(mx - 1, my - barLong + 2, 2, barLong * 2 - 4);
        this.markerGfx.drawRect(mx - barShort + 2, my - 1, (barShort - 2) * 2, 2);
        this.markerGfx.endFill();

        // 외곽 링 (회전 암시 위해 약간 점선처럼 두 호)
        this.markerGfx.lineStyle(1.6 * spawnK, COL_AMBER7, 0.8 * spawnK);
        const rotA = this.time * 0.08 + m.enemyIdx * 0.3;
        this.markerGfx.arc(mx, my, 12, rotA, rotA + Math.PI * 0.75);
        this.markerGfx.arc(mx, my, 12, rotA + Math.PI, rotA + Math.PI * 1.75);
        this.markerGfx.lineStyle(0);
      }
    }

    // ── 빔 ──
    for (const b of rt.beams) {
      const age = f - (PHASE_GATHER + PHASE_MARK) - b.start;
      if (age < 0) continue;
      const beamLife = PHASE_VERDICT + 10; // 광선 수명 (인버트 초반까지 끊기지 않음)
      if (age > beamLife) continue;
      const k = 1 - age / beamLife;
      const peakK = Math.max(0, 1 - age / 4);      // 처음 4f 강렬
      const ks = Math.max(0, 1 - age / 10);        // 지속 강도

      // 화면 전체 수직 커버 — 월드좌표 빔이므로 y 범위는 카메라 기준 화면 전체 커버
      const topWY = cameraY - 40;
      const botWY = cameraY + canvasH + 40;
      const bx = b.wx;

      // halo (매우 넓은 amber)
      this.beamHaloGfx.beginFill(COL_ORANGE3, 0.22 * ks);
      this.beamHaloGfx.drawRect(bx - BEAM_HALO_W / 2, topWY, BEAM_HALO_W, botWY - topWY);
      this.beamHaloGfx.endFill();

      // glow (yellow)
      this.beamGlowGfx.beginFill(COL_YEL3, 0.48 * ks);
      this.beamGlowGfx.drawRect(bx - BEAM_GLOW_W / 2, topWY, BEAM_GLOW_W, botWY - topWY);
      this.beamGlowGfx.endFill();
      this.beamGlowGfx.beginFill(COL_AMBER2, 0.62 * peakK);
      this.beamGlowGfx.drawRect(bx - BEAM_GLOW_W / 4, topWY, BEAM_GLOW_W / 2, botWY - topWY);
      this.beamGlowGfx.endFill();

      // core (white)
      this.beamCoreGfx.beginFill(COL_WHITE, 0.95 * ks);
      this.beamCoreGfx.drawRect(bx - BEAM_CORE_W / 2, topWY, BEAM_CORE_W, botWY - topWY);
      this.beamCoreGfx.endFill();

      // 타격 지면 링 — 적 y 주변 원형
      const groundY = b.wy + 2;
      this.beamBaseGfx.beginFill(COL_AMBER2, 0.55 * ks);
      this.beamBaseGfx.drawEllipse(bx, groundY, BEAM_HALO_W * 0.8, 10 + age * 0.8);
      this.beamBaseGfx.endFill();
      this.beamBaseGfx.beginFill(COL_YEL3, 0.75 * peakK);
      this.beamBaseGfx.drawEllipse(bx, groundY, BEAM_GLOW_W * 0.6, 6 + age * 0.4);
      this.beamBaseGfx.endFill();
    }

    // ── 화면 오버레이 ──
    // Verdict 직후 순간 강한 white flash
    if (fVerdict >= 0 && fVerdict < 8 && rt.verdictFired) {
      const p = 1 - fVerdict / 8;
      this.screenGfx.beginFill(COL_AMBER1, 0.35 * p);
      this.screenGfx.drawRect(0, 0, canvasW, canvasH);
      this.screenGfx.endFill();
    }
    // Inversion 시작 시 white brief
    if (inInvert) {
      const fI = rt.frame - (PHASE_GATHER + PHASE_MARK + PHASE_VERDICT);
      if (fI < 4) {
        const p = 1 - fI / 4;
        this.screenGfx.beginFill(COL_WHITE, 0.28 * p);
        this.screenGfx.drawRect(0, 0, canvasW, canvasH);
        this.screenGfx.endFill();
      }
    }
    // Gather 페이즈 상단 hint
    if (f < PHASE_GATHER + PHASE_MARK) {
      const gk = Math.min(1, f / PHASE_GATHER);
      this.screenGfx.beginFill(COL_AMBER1, 0.12 * gk);
      this.screenGfx.drawRect(0, 0, canvasW, canvasH * 0.35);
      this.screenGfx.endFill();
    }

    void cameraX;
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.worldWrap.destroy({ children: true });
    this.screenGfx.destroy();
    this.runtime = null;
  }
}

// 언사용 상수 경고 방지
void COL_AMBER4;
