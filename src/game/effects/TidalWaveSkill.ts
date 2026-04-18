import * as PIXI from 'pixi.js';
import { EnemyState, ParticleState, CANVAS_W, CANVAS_H } from '../types';
import { isBossType } from '../types';
import { spawnHitParticles } from '../particles';

/**
 * 물 액티브 스킬 — 대해일 (Tidal Wave)
 *
 * 오른쪽 화면 밖에서 시작 → 왼쪽 방향으로 거대한 파도가 스크린을 횡단.
 * 파도에 닿은 일반 적은 파도와 함께 왼쪽으로 쓸려나감 (pin + 스턴 + drag).
 * 보스는 쓸려가지 않고 데미지만 받음 (버팀).
 *
 * 좌표계 (개발서 규칙 4/7):
 *   - 파도 자체는 스크린 공간 이펙트 (카메라 무관)
 *   - GLSL Filter → groundLayer (캐릭터/몬스터 안 가려짐, 규칙 7)
 *   - Graphics → overlayLayer (스크린 좌표, 규칙 4)
 *   - apply 오버라이드로 uTexSize 매 프레임 주입 (규칙 4)
 *
 * 시각 디자인 (규칙 6):
 *   - 폴리곤 골격 대신 셀/물보라 분포로 파도 형태 구성
 *   - 연속 색 보간 (blue-900 → sky-500, 흰색 X)
 *   - 캐릭터(atom)는 playerLayer → GLSL 영향 밖
 */

// ── GLSL 파도 디스토션 셰이더 ──
// 파도 전면 근처 수직 밴드를 압축 + 수직 사인파 일렁임. blue 톤 강화.
const TIDAL_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform float uFrontX;',
  'uniform float uWidth;',
  'uniform float uTime;',
  'uniform float uStrength;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pix = vTextureCoord * uTexSize;',
  '  float dx = pix.x - uFrontX;',
  '',
  '  // 영향권 밖 통과',
  '  if (dx < -60.0 || dx > uWidth + 260.0) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  // 밴드 내 강도 (앞에서 뒤로 부드럽게)',
  '  float band = smoothstep(-60.0, 8.0, dx) * smoothstep(uWidth + 260.0, uWidth + 40.0, dx);',
  '  float s = band * uStrength;',
  '',
  '  // 수직 사인파 일렁임',
  '  float sineY = sin(pix.y * 0.045 + uTime * 2.2) * 14.0 * s',
  '              + sin(pix.y * 0.105 - uTime * 1.4) * 6.0 * s;',
  '  // 수평 압축 (파도가 앞쪽으로 밀어내는 느낌)',
  '  float compressX = -s * 28.0;',
  '',
  '  vec2 distorted = pix + vec2(compressX + sineY * 0.25, sineY);',
  '  vec4 color = texture2D(uSampler, distorted / uTexSize);',
  '',
  '  // 푸른 톤 강화',
  '  color.rgb = mix(color.rgb, color.rgb + vec3(0.06, 0.18, 0.36), s * 0.8);',
  '',
  '  // 앞선 코어 라인 (진한 blue 하이라이트)',
  '  float frontCore = exp(-(dx * dx) / (28.0 * 28.0));',
  '  color.rgb += vec3(0.18, 0.48, 0.92) * frontCore * uStrength * 0.55;',
  '  // 전면 바로 앞 가장자리 (sky-400 글린트)',
  '  float edge = exp(-((dx + 4.0) * (dx + 4.0)) / (6.0 * 6.0));',
  '  color.rgb += vec3(0.22, 0.74, 0.97) * edge * uStrength * 0.45;',
  '',
  '  gl_FragColor = color;',
  '}',
].join('\n');

// 색 팔레트 (흰 X)
const COL_DEEP  = 0x1e3a8a; // blue-900
const COL_MAIN  = 0x2563eb; // blue-600
const COL_LIGHT = 0x3b82f6; // blue-500
const COL_CYAN  = 0x60a5fa; // blue-400
const COL_SKY   = 0x38bdf8; // sky-400
const COL_FOAM  = 0x0ea5e9; // sky-500 (최고 밝기 지점, 흰 방지)

// 셀 색 보간 스톱
const COLOR_STOPS: Array<[number, number, number, number]> = [
  [0.00,  14, 165, 233], // sky-500
  [0.20,  56, 189, 248], // sky-400
  [0.40,  96, 165, 250], // blue-400
  [0.60,  59, 130, 246], // blue-500
  [0.80,  37,  99, 235], // blue-600
  [1.00,  30,  58, 138], // blue-900
];

function lerpCellColor(t: number): number {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t1, r1, g1, b1] = COLOR_STOPS[i];
    if (t <= t1) {
      const [t0, r0, g0, b0] = COLOR_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      const r = Math.round(r0 + (r1 - r0) * k);
      const g = Math.round(g0 + (g1 - g0) * k);
      const b = Math.round(b0 + (b1 - b0) * k);
      return (r << 16) | (g << 8) | b;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  return (last[1] << 16) | (last[2] << 8) | last[3];
}

interface WaveCell {
  x: number; y: number;     // screen coords
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  colorT: number;           // 0..1 색 보간 위치
  active: boolean;
}

interface Wave {
  frontScreenX: number;    // 스크린 X (왼쪽 이동)
  speed: number;           // px/frame (음수)
  width: number;           // 본체 두께
  height: number;          // 커버 높이 (세로 전체)
  life: number;
  strength: number;        // 0..1 (페이드 인/아웃)
  active: boolean;
  damagedIds: Set<number>;
}

const CELL_POOL_SIZE = 160;

export class TidalWaveSkill {
  private overlayLayer: PIXI.Container;
  private groundLayer: PIXI.Container;

  private container: PIXI.Container;
  private bodyGfx: PIXI.Graphics;
  private frothGfx: PIXI.Graphics;
  private glowGfx: PIXI.Graphics;

  private filter: PIXI.Filter | null = null;

  private wave: Wave | null = null;
  private time = 0;

  private cells: WaveCell[] = [];
  private spawnAcc = 0;

  constructor(overlayLayer: PIXI.Container, groundLayer: PIXI.Container) {
    this.overlayLayer = overlayLayer;
    this.groundLayer = groundLayer;

    this.container = new PIXI.Container();
    this.overlayLayer.addChild(this.container);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    this.bodyGfx = new PIXI.Graphics();
    this.container.addChild(this.bodyGfx);

    this.frothGfx = new PIXI.Graphics();
    this.frothGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.frothGfx);

    // 셀 풀 초기화
    for (let i = 0; i < CELL_POOL_SIZE; i++) {
      this.cells.push({
        x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 0, size: 0, colorT: 0, active: false,
      });
    }
  }

  isActive(): boolean {
    return this.wave !== null && this.wave.active;
  }

  private ensureFilter() {
    if (this.filter) return;
    this.filter = new PIXI.Filter(undefined, TIDAL_FRAG, {
      uFrontX: 0,
      uWidth: 110,
      uTime: 0,
      uStrength: 0,
      uTexSize: [CANVAS_W, CANVAS_H],
    });
    this.filter.padding = 0;
    // ★ apply 오버라이드 — 매 프레임 uTexSize 주입 (개발서 규칙 4)
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
    // groundLayer 에만 filter 적용 (규칙 7) — 캐릭터/몬스터 안 가려짐
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

  /**
   * 파도 발사. 오른쪽 화면 밖에서 시작.
   */
  start(cameraX: number, cameraY: number, canvasW: number, canvasH: number) {
    // 이미 진행 중이면 무시
    if (this.wave && this.wave.active) return;
    // cameraX/Y 는 현재 스크린 좌표 산출에 사용 (wave 자체는 screen space)
    void cameraX; void cameraY; void canvasH;

    this.ensureFilter();
    this.attachFilter();

    this.wave = {
      frontScreenX: canvasW + 120,
      speed: -9,
      width: 120,
      height: CANVAS_H,
      life: 0,
      strength: 0,
      active: true,
      damagedIds: new Set<number>(),
    };
    this.time = 0;
    this.spawnAcc = 0;
    // 셀 클리어
    for (const c of this.cells) c.active = false;
  }

  /**
   * 매 프레임 업데이트.
   */
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
    const w = this.wave;
    if (!w || !w.active) return;

    this.time += dt;
    w.life += dt;
    w.frontScreenX += w.speed * dt;

    // 페이드 인/아웃 — 진입 8f fade-in, 화면 나가기 시 fade-out
    let str = 1;
    if (w.life < 10) str = w.life / 10;
    if (w.frontScreenX < -40) {
      const k = Math.max(0, 1 - (-40 - w.frontScreenX) / 240);
      str = Math.min(str, k);
    }
    w.strength = str;

    // 종료 조건 — 파도가 충분히 화면 밖 + 페이드아웃 완료
    if (w.strength <= 0.01 && w.frontScreenX < -260) {
      w.active = false;
      this.clearGfx();
      this.detachFilter();
      // 남은 셀도 클리어
      for (const c of this.cells) c.active = false;
      return;
    }

    // ── 적 처리 — 일반 적은 쓸려나가고, 보스는 데미지만 (버팀) ──
    this.processEnemies(enemies, particles, cameraX, cameraY, canvasW, canvasH, onKill);

    // ── 셀 업데이트 + 스폰 ──
    this.updateCells(dt);
    this.spawnFrontCells(dt);

    // ── 셰이더 uniform 갱신 ──
    if (this.filter) {
      this.filter.uniforms.uFrontX = w.frontScreenX;
      this.filter.uniforms.uWidth = w.width;
      this.filter.uniforms.uTime = this.time * 0.016;
      this.filter.uniforms.uStrength = w.strength;
    }

    // ── 렌더 ──
    this.render(canvasW, canvasH);
  }

  private processEnemies(
    enemies: EnemyState[],
    particles: ParticleState[],
    cameraX: number,
    cameraY: number,
    canvasW: number,
    canvasH: number,
    onKill: (idx: number) => void,
  ) {
    const w = this.wave!;
    const yTopS = -200;
    const yBotS = canvasH + 200;

    const DAMAGE_REG = 260;       // 일반 적 최초 진입 데미지
    const DAMAGE_BOSS = 180;      // 보스 최초 접촉 데미지 (한 번만)
    const WAVE_ABS = Math.abs(w.speed);
    const CATCH_UP = WAVE_ABS + 7; // 뒤에 남은 적 급속 견인
    const BAND_BACK = w.width + 280;
    const BAND_FRONT = 52;
    const PIN_OFFSET = 3;

    // 월드 좌표 변환: screenX → worldX = screenX + cameraX
    const pinWorldX = w.frontScreenX - PIN_OFFSET + cameraX;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;

      // 스크린 좌표로 변환
      const eSX = e.x - cameraX;
      const eSY = e.y - cameraY;
      if (eSY < yTopS || eSY > yBotS) continue;
      if (eSX < w.frontScreenX - BAND_FRONT) continue;
      if (eSX > w.frontScreenX + BAND_BACK) continue;

      const boss = isBossType(e.type);

      // 최초 진입 1회 데미지 + 히트 파티클
      if (!w.damagedIds.has(i)) {
        e.hp -= boss ? DAMAGE_BOSS : DAMAGE_REG;
        w.damagedIds.add(i);
        spawnHitParticles(particles, e.x, e.y, COL_FOAM);
        spawnHitParticles(particles, e.x, e.y, COL_MAIN);
        if (e.hp <= 0) { onKill(i); continue; }
      }

      if (boss) {
        // 보스: 버팀 — 밀림/스턴 X. 파도가 그대로 통과.
        // 히트 위치에 추가 물보라만 찍어서 "부딪힌 느낌"을 남김.
        if ((this.time | 0) % 4 === 0) {
          spawnHitParticles(particles, e.x, e.y, COL_CYAN);
        }
        continue;
      }

      // 일반 적: 파도와 같이 왼쪽으로 끝까지 쓸려감
      e.stunFrames = Math.max(e.stunFrames ?? 0, 8);
      if (e.x > pinWorldX) {
        e.x = Math.max(pinWorldX, e.x - CATCH_UP);
      } else {
        // 이미 파도 전면 앞 → 파도 속도로 동행
        e.x += w.speed;
      }
    }

    void canvasW;
  }

  private acquireCell(): WaveCell | null {
    for (const c of this.cells) {
      if (!c.active) return c;
    }
    return null;
  }

  private spawnFrontCells(dt: number) {
    const w = this.wave!;
    if (w.strength < 0.1) return;
    // 파도 전면에서 매 프레임 여러 개 스폰 (세로 랜덤)
    this.spawnAcc += dt * (6 + w.strength * 6); // 초당 약 ~500
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      const c = this.acquireCell();
      if (!c) break;
      const yRand = Math.random() * w.height;
      // 전면 근처 살짝 랜덤
      c.x = w.frontScreenX + (Math.random() * 10 - 14);
      c.y = yRand;
      // 속도: 전반적으로 왼쪽 + 약간 수직 확산
      c.vx = w.speed * (0.55 + Math.random() * 0.5);
      c.vy = (Math.random() - 0.5) * 3.2;
      c.maxLife = 26 + Math.random() * 20;
      c.life = c.maxLife;
      c.size = 2.2 + Math.random() * 3.8;
      // 처음은 밝게(sky-500), 끝은 blue-800 쪽
      c.colorT = Math.random() * 0.25;
      c.active = true;
    }

    // 꼬리 쪽 (파도 body 뒤) — 짧은 포말이 뿌려지듯
    if (Math.random() < 0.85) {
      const c = this.acquireCell();
      if (c) {
        c.x = w.frontScreenX + w.width * 0.4 + Math.random() * (w.width * 0.8);
        c.y = Math.random() * w.height;
        c.vx = w.speed * 0.3 + (Math.random() - 0.5) * 0.8;
        c.vy = (Math.random() - 0.5) * 1.2;
        c.maxLife = 18 + Math.random() * 16;
        c.life = c.maxLife;
        c.size = 1.6 + Math.random() * 2.6;
        c.colorT = 0.35 + Math.random() * 0.4;
        c.active = true;
      }
    }
  }

  private updateCells(dt: number) {
    for (const c of this.cells) {
      if (!c.active) continue;
      c.life -= dt;
      if (c.life <= 0) { c.active = false; continue; }
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      // 약한 중력/소멸 가속
      c.vy += 0.04 * dt;
    }
  }

  private clearGfx() {
    this.bodyGfx.clear();
    this.frothGfx.clear();
    this.glowGfx.clear();
  }

  private render(canvasW: number, canvasH: number) {
    this.clearGfx();
    const w = this.wave!;
    const str = w.strength;
    if (str <= 0.01) return;

    const frontX = w.frontScreenX;
    const bodyBackX = frontX + w.width;
    const tailBackX = bodyBackX + 180;

    const yTop = 0;
    const yBot = canvasH;
    const height = yBot - yTop;

    // ── 본체: 뒤→앞으로 진해지는 수직 그라디언트 밴드 ──
    // (폴리곤 하나가 아닌 얇은 띠 여러 개로 연속 보간 — 규칙 6)
    const bands = 14;
    for (let b = 0; b < bands; b++) {
      const t = b / (bands - 1); // 0=앞, 1=뒤
      const x = frontX + (tailBackX - frontX) * t;
      // 색: 앞쪽 sky-500, 뒤쪽 blue-900
      const col = lerpCellColor(0.05 + t * 0.85);
      const alpha = (0.78 - t * 0.55) * str;
      if (alpha <= 0) continue;
      this.bodyGfx.beginFill(col, alpha);
      this.bodyGfx.drawRect(x, yTop, (tailBackX - frontX) / bands + 2, height);
      this.bodyGfx.endFill();
    }

    // ── 전면 코어 글로우 (ADD, sky-500) ──
    this.glowGfx.beginFill(COL_FOAM, 0.32 * str);
    this.glowGfx.drawRect(frontX - 36, yTop, 72, height);
    this.glowGfx.endFill();
    this.glowGfx.beginFill(COL_SKY, 0.18 * str);
    this.glowGfx.drawRect(frontX - 90, yTop, 160, height);
    this.glowGfx.endFill();

    // ── 전면 바로 앞 얇은 하이라이트 밴드 (sky-400) ──
    this.glowGfx.beginFill(COL_SKY, 0.55 * str);
    this.glowGfx.drawRect(frontX - 4, yTop, 4, height);
    this.glowGfx.endFill();

    // ── 셀 (front spray + trail foam) ──
    for (const c of this.cells) {
      if (!c.active) continue;
      const lifeFrac = c.life / c.maxLife;
      // 시간 흐름에 따라 colorT 가 1 쪽으로 이동 (밝음 → 어두운 쪽) — 연속 보간
      const ct = Math.min(1, c.colorT + (1 - lifeFrac) * 0.35);
      const col = lerpCellColor(ct);
      const a = lifeFrac * 0.9 * str;
      const size = c.size * (0.6 + lifeFrac * 0.5);
      this.frothGfx.beginFill(col, a);
      this.frothGfx.drawCircle(c.x, c.y, size);
      this.frothGfx.endFill();
    }

    void canvasW;
  }

  destroy() {
    this.detachFilter();
    if (this.filter) {
      this.filter.destroy?.();
      this.filter = null;
    }
    this.container.destroy({ children: true });
    this.wave = null;
    this.cells.length = 0;
  }
}
