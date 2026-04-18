import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles } from '../particles';

/**
 * 전기 액티브 스킬 — 뇌전폭풍 (Thunder Storm)
 *
 * 컨셉: 화면 상단에 먹구름이 몰려오고, 무작위 위치에 강력한 번개가 연달아 떨어진다.
 *       각 번개는 주변 적 3마리에게 체인 라이트닝으로 전이한다.
 *       대해일(횡단·push), 지옥염(grid·연쇄폭발), 대지진(방사·지면왜곡) 과 다르게
 *       "하늘→땅" 수직 난타 + 체인 전이 + 화면 플래시가 포인트.
 *
 * 좌표계:
 *   - 구름·번개는 스크린 좌표 (overlayLayer)
 *   - 적 판정은 번개 발생 시점의 적 월드좌표
 *   - GLSL(groundLayer): 상단 어둠 + 번개 strike 시 전화면 flash
 */

const THUNDER_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  'uniform float uTime;',
  'uniform float uFlashStr;',   // 0..1 번개 번쩍 (감쇠)
  'uniform float uCloudStr;',   // 0..1 상단 어둠',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  vec4 color = texture2D(uSampler, vTextureCoord);',
  '',
  '  // 상단 먹구름 어둠 — y<160 에서 강, 점진 감쇠',
  '  float top = 1.0 - smoothstep(0.0, 160.0, pix.y);',
  '  float darken = top * uCloudStr;',
  '  vec3 shade = vec3(0.26, 0.22, 0.34);',
  '  color.rgb = mix(color.rgb, color.rgb * shade, darken * 0.85);',
  '',
  '  // 번개 flash — 전체 화면 violet-tinted brighten',
  '  if (uFlashStr > 0.001) {',
  '    vec3 flashCol = vec3(0.92, 0.86, 1.0);',
  '    color.rgb = mix(color.rgb, color.rgb + flashCol, uFlashStr * 0.45);',
  '  }',
  '',
  '  // 잔잔한 구름 그림자 모션 (번개 직후 한동안 살짝 어른거림)',
  '  float sway = sin(pix.x * 0.015 + uTime * 0.6) * 2.0 * uCloudStr;',
  '  color.rgb = mix(color.rgb, color.rgb * vec3(0.94, 0.92, 0.98), uCloudStr * 0.12 + sway * 0.01);',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 팔레트
const COL_SLATE9  = 0x0f172a; // slate-900 (먹구름 심부)
const COL_SLATE7  = 0x334155; // slate-700
const COL_SLATE5  = 0x64748b; // slate-500
const COL_VIO9    = 0x4c1d95; // violet-900
const COL_VIO7    = 0x6d28d9; // violet-700
const COL_VIO5    = 0x8b5cf6; // violet-500
const COL_VIO3    = 0xc4b5fd; // violet-300 (번개 코어)
const COL_VIO_HI  = 0xe0d8ff; // violet-100 (strike peak)
const COL_IND5    = 0x6366f1; // indigo-500

// ── 페이즈 ──
const PHASE_CLOUD  = 24;    // 0.40s
const PHASE_STRIKE = 120;   // 2.00s
const PHASE_DISS   = 30;    // 0.50s
const PHASE_TOTAL  = PHASE_CLOUD + PHASE_STRIKE + PHASE_DISS; // 174

// 번개 설정
const BOLT_COUNT_MIN = 24;
const BOLT_COUNT_MAX = 30;
const BOLT_LIFE = 10;           // 번개 전체 수명 frames
const BOLT_PEAK = 3;            // strike peak frames (밝고 굵게)
const CLOUD_Y = 70;             // 구름 중심 y (screen)
const BOLT_DMG_REG  = 220;
const BOLT_DMG_BOSS = 140;
const CHAIN_RADIUS  = 110;
const CHAIN_MAX     = 3;
const CHAIN_DMG_FACTOR = 0.7;

interface Bolt {
  // 스크린 좌표
  sx1: number; sy1: number;    // from (cloud)
  sx2: number; sy2: number;    // to (strike ground)
  segments: Array<{ x: number; y: number }>;  // jagged path (screen)
  life: number;                 // 남은 life
  peak: number;                 // peak 남은 frames
  isChain: boolean;             // 체인 번개(보조) 여부
  width: number;                // 기본 stroke
}

interface CloudBlob {
  x: number;            // 화면 중심 x
  y: number;            // 상단 y 기준 변위
  r: number;            // 반경
  sway: number;         // 수평 흔들림 phase
  darkness: number;     // 색 강도 0..1
}

interface ThunderRuntime {
  frame: number;
  boltsToFire: number;         // 앞으로 발사할 번개 수
  nextBoltFrame: number;       // 다음 발사 프레임 (strike 페이즈 내)
  bolts: Bolt[];
  clouds: CloudBlob[];
  cloudStr: number;
  flashStr: number;            // 0..1 감쇠형
  active: boolean;
}

function buildBoltPath(sx1: number, sy1: number, sx2: number, sy2: number): Array<{ x: number; y: number }> {
  const segs: Array<{ x: number; y: number }> = [];
  const dx = sx2 - sx1;
  const dy = sy2 - sy1;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(6, Math.floor(len / 22));
  const nx = dx / len;
  const ny = dy / len;
  const px = -ny;
  const py = nx;
  segs.push({ x: sx1, y: sy1 });
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const baseX = sx1 + dx * t;
    const baseY = sy1 + dy * t;
    // 양 끝은 고정, 중간으로 갈수록 lateral 크게
    const taper = Math.sin(t * Math.PI); // 0→1→0
    const lateral = (Math.random() - 0.5) * 28 * taper;
    segs.push({ x: baseX + px * lateral, y: baseY + py * lateral });
  }
  segs.push({ x: sx2, y: sy2 });
  return segs;
}

export class ThunderStormSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  private container: PIXI.Container;
  private cloudGfx: PIXI.Graphics;       // 먹구름 본체
  private cloudGlowGfx: PIXI.Graphics;   // 구름 바닥부 violet 광
  private boltGlowGfx: PIXI.Graphics;    // 번개 외곽 글로우 (ADD)
  private boltCoreGfx: PIXI.Graphics;    // 번개 코어
  private strikeGfx: PIXI.Graphics;      // 지면 타격 글로우 (ADD)
  private flashGfx: PIXI.Graphics;       // 번개 순간 전 화면 플래시 (ADD)

  private filter: PIXI.Filter | null = null;
  private runtime: ThunderRuntime | null = null;
  private time = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.container = new PIXI.Container();
    this.overlayLayer.addChild(this.container);

    this.cloudGfx = new PIXI.Graphics();
    this.container.addChild(this.cloudGfx);

    this.cloudGlowGfx = new PIXI.Graphics();
    this.cloudGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.cloudGlowGfx);

    this.strikeGfx = new PIXI.Graphics();
    this.strikeGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.strikeGfx);

    this.boltGlowGfx = new PIXI.Graphics();
    this.boltGlowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.boltGlowGfx);

    this.boltCoreGfx = new PIXI.Graphics();
    this.container.addChild(this.boltCoreGfx);

    this.flashGfx = new PIXI.Graphics();
    this.flashGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.flashGfx);
  }

  isActive(): boolean {
    return this.runtime !== null && this.runtime.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, THUNDER_FRAG, {
      uTime: 0,
      uFlashStr: 0,
      uCloudStr: 0,
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

  start(canvasW: number, canvasH: number) {
    if (this.runtime && this.runtime.active) return;
    void canvasW; void canvasH;
    this.ensureFilter();
    this.attachFilter();

    // 구름 블롭 6개 - 상단을 덮도록 배치
    const clouds: CloudBlob[] = [];
    const blobCount = 7;
    for (let i = 0; i < blobCount; i++) {
      clouds.push({
        x: (CANVAS_W / blobCount) * i + CANVAS_W / (blobCount * 2) + (Math.random() - 0.5) * 40,
        y: CLOUD_Y + (Math.random() - 0.5) * 24,
        r: 70 + Math.random() * 36,
        sway: Math.random() * Math.PI * 2,
        darkness: 0.7 + Math.random() * 0.3,
      });
    }

    const boltCount = BOLT_COUNT_MIN + Math.floor(Math.random() * (BOLT_COUNT_MAX - BOLT_COUNT_MIN + 1));

    this.runtime = {
      frame: 0,
      boltsToFire: boltCount,
      nextBoltFrame: 0,
      bolts: [],
      clouds,
      cloudStr: 0,
      flashStr: 0,
      active: true,
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
    const inCloud  = f < PHASE_CLOUD;
    const inStrike = f >= PHASE_CLOUD && f < PHASE_CLOUD + PHASE_STRIKE;
    const inDiss   = f >= PHASE_CLOUD + PHASE_STRIKE;

    // 1) Cloud str 진행
    if (inCloud) {
      rt.cloudStr = f / PHASE_CLOUD;
    } else if (inStrike) {
      rt.cloudStr = 1;
    } else if (inDiss) {
      const k = (f - (PHASE_CLOUD + PHASE_STRIKE)) / PHASE_DISS;
      rt.cloudStr = Math.max(0, 1 - k);
    }

    // 2) 구름 sway 갱신
    for (const c of rt.clouds) {
      c.sway += 0.02 * dt;
    }

    // 3) Strike 페이즈 — 번개 발사
    if (inStrike) {
      const fStrike = f - PHASE_CLOUD;
      while (rt.boltsToFire > 0 && fStrike >= rt.nextBoltFrame) {
        // 타겟 선정 — 살아있는 일반 적 우선, 없으면 보스, 없으면 screen random
        const targetWorld = this.pickTarget(enemies, cameraX, cameraY, canvasW, canvasH);

        const primary = this.fireBolt(targetWorld.wx, targetWorld.wy, cameraX, cameraY, false);
        this.dealBoltDamage(primary, enemies, particles, onKill, targetWorld.wx, targetWorld.wy, cameraX, cameraY, false);

        // 체인 번개들
        this.spawnChains(primary, enemies, particles, cameraX, cameraY, onKill, targetWorld.hitIdx);

        // flash
        rt.flashStr = Math.min(1, rt.flashStr + 0.85);

        rt.boltsToFire--;
        // 다음 bolt 간격: 3~8 frames (평균 ~5) — 총 STRIKE 페이즈에 골고루
        const gap = 3 + Math.floor(Math.random() * 5);
        rt.nextBoltFrame = fStrike + gap;
      }
    }

    // 4) bolt life 감소 + 제거
    for (const b of rt.bolts) {
      b.life -= dt;
      if (b.peak > 0) b.peak -= dt;
    }
    rt.bolts = rt.bolts.filter((b) => b.life > 0);

    // 5) flash 자연 감쇠
    rt.flashStr = Math.max(0, rt.flashStr - 0.12 * dt);

    // 6) uniform 주입
    if (this.filter) {
      this.filter.uniforms.uTime = this.time * 0.016;
      this.filter.uniforms.uFlashStr = rt.flashStr;
      this.filter.uniforms.uCloudStr = rt.cloudStr;
    }

    // 종료
    if (rt.frame >= PHASE_TOTAL) {
      rt.active = false;
      this.detachFilter();
      this.clearGfx();
      return;
    }

    this.render(rt);
  }

  /** 적 하나를 타겟으로 선정 (스크린 내 적만). 없으면 랜덤 좌표. */
  private pickTarget(
    enemies: EnemyState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
  ): { wx: number; wy: number; hitIdx: number } {
    // 스크린 내 살아있는 적 수집
    const candidates: number[] = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const sx = e.x - cameraX;
      const sy = e.y - cameraY;
      if (sx < -20 || sx > canvasW + 20) continue;
      if (sy < -20 || sy > canvasH + 20) continue;
      candidates.push(i);
    }
    if (candidates.length > 0) {
      const idx = candidates[Math.floor(Math.random() * candidates.length)];
      const e = enemies[idx];
      return { wx: e.x, wy: e.y, hitIdx: idx };
    }
    // 없으면 화면 내 랜덤
    const rx = Math.random() * canvasW;
    const ry = 150 + Math.random() * (canvasH - 180);
    return { wx: cameraX + rx, wy: cameraY + ry, hitIdx: -1 };
  }

  /** 번개 하나 생성 — world target 받아 screen bolt 생성 */
  private fireBolt(
    targetWX: number,
    targetWY: number,
    cameraX: number,
    cameraY: number,
    isChain: boolean,
  ): Bolt {
    const targetSX = targetWX - cameraX;
    const targetSY = targetWY - cameraY;
    const sourceSX = targetSX + (Math.random() - 0.5) * 60;
    const sourceSY = CLOUD_Y + 18 + (Math.random() - 0.5) * 10;

    const segments = buildBoltPath(sourceSX, sourceSY, targetSX, targetSY);
    const bolt: Bolt = {
      sx1: sourceSX, sy1: sourceSY,
      sx2: targetSX, sy2: targetSY,
      segments,
      life: BOLT_LIFE,
      peak: BOLT_PEAK,
      isChain,
      width: isChain ? 1.6 : 2.6,
    };
    this.runtime!.bolts.push(bolt);
    return bolt;
  }

  /** 번개 타격점에 대한 범위 판정 */
  private dealBoltDamage(
    bolt: Bolt,
    enemies: EnemyState[],
    particles: ParticleState[],
    onKill: (idx: number) => void,
    targetWX: number,
    targetWY: number,
    cameraX: number,
    cameraY: number,
    isChain: boolean,
  ) {
    void bolt; void cameraX; void cameraY;
    // 타격점 주변 반경 내 모든 적 타격 (primary 의 경우 radius 48, chain 의 경우 30)
    const r = isChain ? 34 : 52;
    const r2 = r * r;
    const factor = isChain ? CHAIN_DMG_FACTOR : 1;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = e.x - targetWX;
      const dy = e.y - targetWY;
      if (dx * dx + dy * dy > r2) continue;
      const isB = isBossType(e.type);
      const dmg = (isB ? BOLT_DMG_BOSS : BOLT_DMG_REG) * factor;
      e.hp -= dmg;
      e.stunFrames = Math.max(e.stunFrames ?? 0, isB ? 5 : 12);
      spawnHitParticles(particles, e.x, e.y, COL_VIO3);
      spawnHitParticles(particles, e.x, e.y, COL_VIO5);
      if (e.hp <= 0) onKill(i);
    }
  }

  /** primary bolt 로부터 chain 번개 전이 */
  private spawnChains(
    primary: Bolt,
    enemies: EnemyState[],
    particles: ParticleState[],
    cameraX: number,
    cameraY: number,
    onKill: (idx: number) => void,
    primaryTargetIdx: number,
  ) {
    void primary;
    const centerWX = primary.sx2 + cameraX;
    const centerWY = primary.sy2 + cameraY;

    // 반경 내 미피격 후보
    const r2 = CHAIN_RADIUS * CHAIN_RADIUS;
    const candidates: Array<{ idx: number; d2: number; wx: number; wy: number }> = [];
    for (let i = 0; i < enemies.length; i++) {
      if (i === primaryTargetIdx) continue;
      const e = enemies[i];
      if (!e.active) continue;
      const dx = e.x - centerWX;
      const dy = e.y - centerWY;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      candidates.push({ idx: i, d2, wx: e.x, wy: e.y });
    }
    candidates.sort((a, b) => a.d2 - b.d2);

    const pickCount = Math.min(CHAIN_MAX, candidates.length);
    for (let k = 0; k < pickCount; k++) {
      const cand = candidates[k];
      // 체인 번개는 구름이 아니라 primary 타격점에서 시작
      const bolt: Bolt = {
        sx1: primary.sx2,
        sy1: primary.sy2,
        sx2: cand.wx - cameraX,
        sy2: cand.wy - cameraY,
        segments: buildBoltPath(primary.sx2, primary.sy2, cand.wx - cameraX, cand.wy - cameraY),
        life: BOLT_LIFE - 2,
        peak: BOLT_PEAK - 1,
        isChain: true,
        width: 1.6,
      };
      this.runtime!.bolts.push(bolt);
      this.dealBoltDamage(bolt, enemies, particles, onKill, cand.wx, cand.wy, cameraX, cameraY, true);
    }
  }

  private clearGfx() {
    this.cloudGfx.clear();
    this.cloudGlowGfx.clear();
    this.boltGlowGfx.clear();
    this.boltCoreGfx.clear();
    this.strikeGfx.clear();
    this.flashGfx.clear();
  }

  private render(rt: ThunderRuntime) {
    this.clearGfx();

    // ── 먹구름 ──
    const cs = rt.cloudStr;
    if (cs > 0.02) {
      // 뒤쪽 큰 블롭 (어두운 slate-900)
      for (const c of rt.clouds) {
        const cx = c.x + Math.sin(c.sway) * 4;
        const cy = c.y + Math.cos(c.sway * 0.8) * 2;
        this.cloudGfx.beginFill(COL_SLATE9, 0.78 * cs * c.darkness);
        this.cloudGfx.drawCircle(cx, cy, c.r);
        this.cloudGfx.endFill();
      }
      // 중간 tier (slate-700)
      for (const c of rt.clouds) {
        const cx = c.x + Math.sin(c.sway + 0.6) * 3;
        const cy = c.y - c.r * 0.15 + Math.cos(c.sway * 1.2) * 2;
        this.cloudGfx.beginFill(COL_SLATE7, 0.72 * cs);
        this.cloudGfx.drawCircle(cx, cy, c.r * 0.78);
        this.cloudGfx.endFill();
      }
      // 밝은 hint (slate-500) — 구름 윗부분
      for (const c of rt.clouds) {
        const cx = c.x + Math.sin(c.sway + 1.4) * 2;
        const cy = c.y - c.r * 0.35;
        this.cloudGfx.beginFill(COL_SLATE5, 0.45 * cs);
        this.cloudGfx.drawCircle(cx, cy, c.r * 0.52);
        this.cloudGfx.endFill();
      }
      // 구름 바닥 violet glow (지면 향함)
      for (const c of rt.clouds) {
        this.cloudGlowGfx.beginFill(COL_VIO7, 0.18 * cs);
        this.cloudGlowGfx.drawCircle(c.x, c.y + c.r * 0.55, c.r * 1.1);
        this.cloudGlowGfx.endFill();
      }
    }

    // ── 번개 ──
    for (const b of rt.bolts) {
      const lifeK = Math.max(0, b.life / BOLT_LIFE);
      const peakK = Math.max(0, b.peak / BOLT_PEAK);
      const coreAlpha = 0.55 + peakK * 0.45;
      const glowAlpha = 0.30 + peakK * 0.35;
      const width = b.width * (0.8 + peakK * 0.6) * (0.6 + lifeK * 0.4);

      // 외곽 글로우 (ADD, violet-500 wide)
      this.boltGlowGfx.lineStyle(width * 4.5, COL_VIO7, glowAlpha * lifeK * 0.45);
      this.strokePath(this.boltGlowGfx, b.segments);
      this.boltGlowGfx.lineStyle(width * 2.6, COL_VIO5, glowAlpha * lifeK * 0.7);
      this.strokePath(this.boltGlowGfx, b.segments);
      this.boltGlowGfx.lineStyle(0);

      // 코어 (밝은 violet)
      this.boltCoreGfx.lineStyle(width, COL_VIO_HI, coreAlpha * lifeK);
      this.strokePath(this.boltCoreGfx, b.segments);
      this.boltCoreGfx.lineStyle(width * 0.45, COL_VIO3, (coreAlpha + 0.1) * lifeK);
      this.strokePath(this.boltCoreGfx, b.segments);
      this.boltCoreGfx.lineStyle(0);

      // 지면 타격 글로우
      if (b.peak > 0 && !b.isChain) {
        this.strikeGfx.beginFill(COL_VIO_HI, 0.55 * peakK);
        this.strikeGfx.drawCircle(b.sx2, b.sy2, 12 + (1 - peakK) * 14);
        this.strikeGfx.endFill();
        this.strikeGfx.beginFill(COL_VIO5, 0.35 * peakK);
        this.strikeGfx.drawCircle(b.sx2, b.sy2, 28 + (1 - peakK) * 18);
        this.strikeGfx.endFill();
        this.strikeGfx.beginFill(COL_IND5, 0.22 * peakK);
        this.strikeGfx.drawCircle(b.sx2, b.sy2, 48 + (1 - peakK) * 18);
        this.strikeGfx.endFill();
      } else if (b.peak > 0 && b.isChain) {
        this.strikeGfx.beginFill(COL_VIO3, 0.4 * peakK);
        this.strikeGfx.drawCircle(b.sx2, b.sy2, 10);
        this.strikeGfx.endFill();
      }
    }

    // ── 번개 flash (전체 화면 ADD) ──
    if (rt.flashStr > 0.02) {
      this.flashGfx.beginFill(COL_VIO_HI, rt.flashStr * 0.16);
      this.flashGfx.drawRect(0, 0, CANVAS_W, CANVAS_H);
      this.flashGfx.endFill();
    }
  }

  private strokePath(g: PIXI.Graphics, segs: Array<{ x: number; y: number }>) {
    if (segs.length < 2) return;
    g.moveTo(segs[0].x, segs[0].y);
    for (let i = 1; i < segs.length; i++) g.lineTo(segs[i].x, segs[i].y);
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.container.destroy({ children: true });
    this.runtime = null;
  }
}

// 언사용 상수 경고 방지
void COL_VIO9;
