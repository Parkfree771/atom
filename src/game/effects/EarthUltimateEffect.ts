import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 흙 × 3 (AAA) — 운석우 (Meteor Storm)
 *
 * 슬롯 3칸이 모두 흙일 때만 발동. 1단계 모래지옥 장판과 별개의 고유 클래스.
 *
 * 거동 — 다중 중간 사이즈 운석 burst:
 *   - 사이클: 30f BURSTING (5발 6f 간격 spawn) → 80f REST → 반복
 *   - 모든 운석 동일 각도 (135° = 우상→좌하 사선, 일관성)
 *   - 각 운석: 사선 35f 낙하 → 착탄 → wavy ring 일렁거림
 *
 * 운석 본체 — stone.webp 텍스처 pre-process (폴리곤 X):
 *   - 원본 stone.webp는 outline only (검은 선 + 투명 배경)
 *   - 첫 update() 시 렌더러로 BlurFilter + ColorMatrixFilter 적용해서 RenderTexture로 베이킹
 *   - 결과: filled gray stone 텍스처 (안이 채워진 회색 돌)
 *   - sprite는 이 베이크된 텍스처를 직접 사용 (필터 X)
 *
 * 사이클 페이즈:
 *   1. FALLING (35f)  — 사선 낙하
 *   2. EMBEDDED (18f) — 땅에 꽂힌 채 정지 (착탄 임팩트 + dust burst + 짧은 정지)
 *   3. SHOCKWAVE (35f) — 폭발 + wavy ring + 광역 데미지/스턴/넉백
 *
 * 사용자 피드백 (3차):
 *   1. **사이즈 중간** — 첫 거대 40px (너무 큼) → 7px (너무 작음, "쥐같다") → **12~14px (중간)**
 *   2. **각도 일관성** — 전 운석 동일 135° (개체별 변동 X)
 *   3. **stone.webp 사용** — public/game/stone.webp 스프라이트로 운석 시각
 *   4. **회색 컬러** — stone tones, 똥색 X
 *
 * 흰끼 방지:
 *   - 폴리곤 fill 회색 only (3겹 stone gradient)
 *   - 스프라이트 검은 outline (자연스러움, 흰끼 0)
 *   - 화염 trail amber 톤만 (NORMAL only, R 안전)
 *   - 가열 hint ADD 작게 (운석 앞쪽만)
 *   - 폭발 셀 NORMAL only
 *
 * 검증된 컴포넌트:
 *   - 다중 인스턴스 풀 + popImpacts → FireUltimateEffect 패턴
 *   - 사이클 머신 (BURSTING / RESTING) → 자체 2-state
 *   - 폴리곤 절차 생성 + elongation + motion-rotation 변환
 *   - PIXI.Sprite + PIXI.Texture.from (lazy 로딩)
 *   - Wavy ring (다중 sin 중첩) → WaterEffect 1단계 패턴
 *   - 폭발 셀 NORMAL only → EarthDarkEffect 패턴
 *   - 스턴 시스템 → EnemyState.stunFrames
 */

// ── 색 팔레트 (모두 중성 회색 — 화염 amber 사용 X) ──
const COL_STONE_950 = 0x0c0a09;
const COL_STONE_900 = 0x1c1917;
const COL_STONE_800 = 0x292524;
const COL_STONE_700 = 0x44403c;
const COL_STONE_600 = 0x57534e;
const COL_STONE_500 = 0x78716c;
const COL_STONE_400 = 0xa8a29e;

// ── 스펙 ──
const METEORS_PER_BURST = 5;
const SPAWN_INTERVAL = 6;            // burst 내 운석 간 spawn 간격
const REST_DURATION = 80;            // burst 종료 후 다음 burst까지
const METEOR_FALL_FRAMES = 35;       // 각 운석 낙하 시간
const METEOR_EMBEDDED_FRAMES = 18;   // 충돌 후 땅에 꽂힌 채 정지 (~0.3s)
const SHOCKWAVE_FRAMES = 35;         // 충격파 페이드 시간
const FALL_DISTANCE = 220;
const SHOCKWAVE_MAX_R = 180;       // 폭발 충격파 최대 반경 (강화)
const SPAWN_MIN_DIST = 40;
const SPAWN_MAX_DIST = 150;
/** 모든 운석 동일 각도 (사용자 강조 — 일관성). 135° = 우상→좌하 사선 */
const FIXED_MOTION_ANGLE = (3 * Math.PI) / 4;

// ── stone.webp 스프라이트 설정 ──
const STONE_TEXTURE_URL = '/game/stone.webp';
/** 스프라이트 short axis 스케일 (가로 — 원본 stone은 세로 길쭉) */
const SPRITE_SCALE_X = 0.075;
/** 스프라이트 long axis 스케일 (세로 — 원본 stone의 long axis) */
const SPRITE_SCALE_Y = 0.105;
/** 스프라이트 회전 — 원본 stone의 long axis (세로/local +y)를 motion 방향 (135°)에 정렬.
 *  PIXI clockwise rotation: 45° 회전 → local +y (down) → 135° (down-left) */
const SPRITE_ROTATION = Math.PI / 4;

// ── 폭발 강화 ──
/** Ground crater 반경 (top-down ellipse, 운석 사이즈보다 큼) */
const CRATER_RX = 32;
const CRATER_RY = 24;
/** Crater radial crack lines (impact 균열) */
const CRATER_CRACK_COUNT = 6;

// ── 타입 ──
interface Meteor {
  // 위치 (월드)
  startWX: number; startWY: number;
  targetWX: number; targetWY: number;
  worldX: number; worldY: number;

  /** 0 = FALLING, 1 = EMBEDDED (땅에 꽂힘), 2 = SHOCKWAVE_FADE */
  phase: 0 | 1 | 2;
  /** 페이즈 내 진행 시간 (페이즈 전환 시 0으로 리셋) */
  phaseTimer: number;

  // 착탄 좌표 (잠금)
  impactWX: number;
  impactWY: number;

  // stone.webp 스프라이트 (lazy — texture 미로딩 시 null)
  sprite: PIXI.Sprite | null;
}

interface BurstCell {
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  isDust: boolean;
  toneIdx: number;
}

const STATE_BURSTING = 0;
const STATE_RESTING = 1;

export class EarthUltimateEffect {
  private container: PIXI.Container;
  /** NORMAL — trails, 폴리곤 body, 균열, 충격파 wavy ring, 폭발 셀 */
  private gfx: PIXI.Graphics;
  /** ADD — 가열 hint (운석 앞쪽 작은 글로우만) */
  private glowGfx: PIXI.Graphics;
  /** Sprite 컨테이너 — 운석마다 PIXI.Sprite child 추가/제거 */
  private spriteContainer: PIXI.Container;
  /** stone.webp 원본 텍스처 (lazy 로딩) */
  private stoneTexture: PIXI.Texture | null = null;
  /** Pre-process된 filled gray RenderTexture (렌더러 + 텍스처 둘 다 준비되면 1번만 생성) */
  private filledTexture: PIXI.RenderTexture | null = null;
  /** Pre-process 완료 플래그 */
  private texturePreprocessed = false;
  /** PIXI 렌더러 (텍스처 pre-process용) */
  private renderer: PIXI.Renderer | null;

  // 잔해/먼지 톤 (모두 회색 stone, amber X)
  private readonly STONE_TONES = [
    COL_STONE_900,
    COL_STONE_800,
    COL_STONE_700,
    COL_STONE_600,
  ];
  private readonly DUST_TONES = [
    COL_STONE_600,
    COL_STONE_500,
    COL_STONE_400,
  ];

  active = false;

  // 캐릭터 현재 위치 (운석 spawn target 중심)
  private posX = 0;
  private posY = 0;

  private time = 0;

  // 사이클 상태머신
  private state = STATE_BURSTING;
  private spawnedThisBurst = 0;
  private spawnTimer = 0;
  private restTimer = 0;

  // 운석 인스턴스
  private meteors: Meteor[] = [];

  // 폭발 셀 (월드 좌표)
  private cells: BurstCell[] = [];

  // 이번 프레임 착탄 좌표 — engine이 popImpacts로 가져감
  private pendingImpacts: Array<{ x: number; y: number }> = [];

  constructor(parent: PIXI.Container, renderer: PIXI.Renderer | null = null) {
    this.renderer = renderer;
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 레이어 순서: gfx (back) → spriteContainer (운석 sprite) → glowGfx (ADD, top)
    this.gfx = new PIXI.Graphics();
    this.container.addChild(this.gfx);

    this.spriteContainer = new PIXI.Container();
    this.container.addChild(this.spriteContainer);

    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);
  }

  // ═══════════════════════════════════════════════════════════
  //  텍스처 pre-process — stone.webp outline → filled gray
  // ═══════════════════════════════════════════════════════════

  /**
   * BlurFilter로 outline을 펼쳐서 안을 채우고, 2-pass ColorMatrixFilter로 회색 톤 정렬.
   * PIXI는 premultiplied alpha라서 RGB는 항상 (gray * A)에 비례해야 display가 gray로 나옴.
   * 단순히 RGB=0.5로 설정하면 alpha 낮은 곳이 흰색으로 보이는 버그.
   *
   * 2-pass 체인:
   *   1. amplifyAlpha — A *= 8 (RGB 그대로)
   *   2. fillGray     — R=G=B = 0.5 * A (alpha 비례, display = R/A = 0.5 항상)
   */
  private preprocessTexture() {
    if (this.texturePreprocessed) return;
    if (!this.renderer || !this.stoneTexture) return;
    if (!this.stoneTexture.baseTexture.valid) return; // 아직 로딩 안 됨

    const W = this.stoneTexture.width;
    const H = this.stoneTexture.height;
    const rt = PIXI.RenderTexture.create({ width: W, height: H });

    // Temp sprite (원본 텍스처)
    const tempSprite = new PIXI.Sprite(this.stoneTexture);
    tempSprite.x = 0;
    tempSprite.y = 0;

    // 1. BlurFilter — outline을 펼쳐서 inside 영역까지 alpha 채움
    const blur = new PIXI.BlurFilter(20);
    blur.quality = 6;

    // 2. amplifyAlpha — A를 8배 증폭 (clamp to 1)
    const amplifyAlpha = new PIXI.ColorMatrixFilter();
    amplifyAlpha.matrix = [
      1, 0, 0, 0, 0,   // R unchanged
      0, 1, 0, 0, 0,   // G unchanged
      0, 0, 1, 0, 0,   // B unchanged
      0, 0, 0, 8, 0,   // A *= 8
    ];

    // 3. fillGray — R=G=B = 0.5 * A (premultiplied alpha 정합)
    //    Display = R / A = 0.5 → 항상 medium gray
    const fillGray = new PIXI.ColorMatrixFilter();
    fillGray.matrix = [
      0, 0, 0, 0.5, 0,   // R = 0.5 * A_in
      0, 0, 0, 0.5, 0,   // G = 0.5 * A_in
      0, 0, 0, 0.5, 0,   // B = 0.5 * A_in
      0, 0, 0, 1, 0,     // A unchanged
    ];

    tempSprite.filters = [blur, amplifyAlpha, fillGray];
    tempSprite.filterArea = new PIXI.Rectangle(0, 0, W, H);

    // 렌더 (PIXI v7 API)
    this.renderer.render(tempSprite, { renderTexture: rt });

    this.filledTexture = rt;
    this.texturePreprocessed = true;

    // Cleanup
    tempSprite.destroy();

    // 기존 sprite 텍스처 swap
    for (const m of this.meteors) {
      if (m.sprite && this.filledTexture) {
        m.sprite.texture = this.filledTexture;
      }
    }
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.time = 0;
    this.state = STATE_BURSTING;
    this.spawnedThisBurst = 0;
    this.spawnTimer = 0;
    this.restTimer = 0;
    this.meteors = [];
    this.cells = [];
    this.pendingImpacts = [];

    // stone.webp 텍스처 lazy 로딩 (PIXI.Texture.from은 즉시 반환, 비동기 로드)
    if (!this.stoneTexture) {
      this.stoneTexture = PIXI.Texture.from(STONE_TEXTURE_URL);
    }
  }

  setPosition(x: number, y: number) {
    this.posX = x;
    this.posY = y;
  }

  /** 이번 프레임에 착탄한 운석 좌표 */
  popImpacts(): Array<{ x: number; y: number }> {
    const arr = this.pendingImpacts;
    this.pendingImpacts = [];
    return arr;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트 (사이클 머신 + 다중 인스턴스)
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;

    // 텍스처 lazy preprocess (1번만)
    if (!this.texturePreprocessed) {
      this.preprocessTexture();
    }

    // ── 사이클 상태머신 ──
    if (this.state === STATE_BURSTING) {
      this.spawnTimer += dt;
      while (this.spawnTimer >= SPAWN_INTERVAL && this.spawnedThisBurst < METEORS_PER_BURST) {
        this.spawnTimer -= SPAWN_INTERVAL;
        this.spawnMeteor();
        this.spawnedThisBurst++;
      }
      if (this.spawnedThisBurst >= METEORS_PER_BURST) {
        this.state = STATE_RESTING;
        this.restTimer = 0;
      }
    } else {
      this.restTimer += dt;
      if (this.restTimer >= REST_DURATION) {
        this.state = STATE_BURSTING;
        this.spawnedThisBurst = 0;
        this.spawnTimer = 0;
      }
    }

    // ── 운석 업데이트 ──
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.phaseTimer += dt;

      if (m.phase === 0) {
        // FALLING — 사선 낙하
        const t = Math.min(1, m.phaseTimer / METEOR_FALL_FRAMES);
        const ease = t * t; // 가속
        m.worldX = m.startWX + (m.targetWX - m.startWX) * ease;
        m.worldY = m.startWY + (m.targetWY - m.startWY) * ease;

        if (m.sprite) {
          m.sprite.x = m.worldX;
          m.sprite.y = m.worldY;
        }

        if (m.phaseTimer >= METEOR_FALL_FRAMES) {
          // 착탄 → 땅에 꽂힘 (정지) + 임팩트 dust
          m.phase = 1;
          m.phaseTimer = 0;
          m.worldX = m.targetWX;
          m.worldY = m.targetWY;
          if (m.sprite) {
            m.sprite.x = m.worldX;
            m.sprite.y = m.worldY;
          }
          // 착탄 임팩트 dust burst (작음, 폭발 X)
          this.spawnLandingDust(m.targetWX, m.targetWY);
        }
      } else if (m.phase === 1) {
        // EMBEDDED — 땅에 꽂힌 채 정지. 착탄 임팩트 후 squash → 원상 복귀.
        if (m.sprite) {
          // 페이즈 진행 따라 squash → normal lerp
          // 0%: 1.20 wide × 0.85 tall (압축 — 충격에 짓눌림)
          // 100%: 1.00 × 1.00 (원래 사이즈)
          const t = Math.min(1, m.phaseTimer / METEOR_EMBEDDED_FRAMES);
          const squashX = 1.20 - 0.20 * t;
          const squashY = 0.85 + 0.15 * t;
          m.sprite.scale.set(SPRITE_SCALE_X * squashX, SPRITE_SCALE_Y * squashY);
        }
        if (m.phaseTimer >= METEOR_EMBEDDED_FRAMES) {
          // 폭발 → SHOCKWAVE 페이즈
          m.phase = 2;
          m.phaseTimer = 0;
          m.impactWX = m.targetWX;
          m.impactWY = m.targetWY;
          this.spawnImpactCells(m.impactWX, m.impactWY);
          this.pendingImpacts.push({ x: m.impactWX, y: m.impactWY });
          // 스프라이트 제거 (운석 산산조각)
          this.destroyMeteorSprite(m);
        }
      } else {
        // SHOCKWAVE 페이드
        if (m.phaseTimer >= SHOCKWAVE_FRAMES) {
          swapPop(this.meteors, i);
        }
      }
    }

    // ── 폭발 셀 update ──
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.prevX = c.x;
      c.prevY = c.y;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vx *= 0.93;
      c.vy *= 0.93;
      c.life -= dt;
      if (c.life <= 0) swapPop(this.cells, i);
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  운석 spawn (시드 결정 + sprite 생성)
  // ═══════════════════════════════════════════════════════════

  private spawnMeteor() {
    // 캐릭터 주변 random target
    const angle = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN_DIST + Math.random() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
    const targetWX = this.posX + Math.cos(angle) * dist;
    const targetWY = this.posY + Math.sin(angle) * dist;

    // 일관 motion direction (135°)
    const dirX = Math.cos(FIXED_MOTION_ANGLE);
    const dirY = Math.sin(FIXED_MOTION_ANGLE);
    const startWX = targetWX - dirX * FALL_DISTANCE;
    const startWY = targetWY - dirY * FALL_DISTANCE;

    // 운석 sprite 생성 — filled gray 텍스처 우선 (없으면 원본 fallback, 후에 swap됨)
    let sprite: PIXI.Sprite | null = null;
    const tex = this.filledTexture || this.stoneTexture;
    if (tex) {
      sprite = new PIXI.Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.scale.set(SPRITE_SCALE_X, SPRITE_SCALE_Y);
      sprite.rotation = SPRITE_ROTATION;
      sprite.x = startWX;
      sprite.y = startWY;
      this.spriteContainer.addChild(sprite);
    }

    this.meteors.push({
      startWX, startWY,
      targetWX, targetWY,
      worldX: startWX,
      worldY: startWY,
      phase: 0,
      phaseTimer: 0,
      impactWX: 0,
      impactWY: 0,
      sprite,
    });
  }

  private destroyMeteorSprite(m: Meteor) {
    if (m.sprite) {
      if (m.sprite.parent) {
        m.sprite.parent.removeChild(m.sprite);
      }
      m.sprite.destroy();
      m.sprite = null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  착탄 임팩트 dust (땅에 박히는 순간 — 폭발은 아님)
  // ═══════════════════════════════════════════════════════════

  private spawnLandingDust(wx: number, wy: number) {
    // 작은 dust 10개 — 사방으로 살짝 튐 (위쪽 가중치)
    const N = 10;
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 1.5 + Math.random() * 2.0;
      const life = 14 + Math.random() * 10;
      this.cells.push({
        x: wx, y: wy,
        prevX: wx, prevY: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.8, // 위쪽 살짝 솟음
        life, maxLife: life,
        size: 0.8 + Math.random() * 1.0,
        isDust: true,
        toneIdx: Math.floor(Math.random() * this.DUST_TONES.length),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  폭발 셀 spawn (EMBEDDED 후 큰 폭발)
  // ═══════════════════════════════════════════════════════════

  private spawnImpactCells(wx: number, wy: number) {
    // 돌 잔해 35개 (이전 18 → 35, 강화)
    const STONES = 35;
    for (let i = 0; i < STONES; i++) {
      const angle = (i / STONES) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 5 + Math.random() * 7;       // 4~9 → 5~12 (멀리 튐)
      const life = 30 + Math.random() * 22;       // 25~43 → 30~52 (오래)
      this.cells.push({
        x: wx, y: wy,
        prevX: wx, prevY: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size: 1.8 + Math.random() * 2.2,          // 1.5~3.2 → 1.8~4.0 (큼)
        isDust: false,
        toneIdx: Math.floor(Math.random() * this.STONE_TONES.length),
      });
    }
    // 먼지 25개 (이전 12 → 25, 강화)
    const DUST = 25;
    for (let i = 0; i < DUST; i++) {
      const angle = (i / DUST) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const speed = 3 + Math.random() * 4.5;
      const life = 22 + Math.random() * 18;
      this.cells.push({
        x: wx, y: wy,
        prevX: wx, prevY: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life, maxLife: life,
        size: 1.2 + Math.random() * 1.6,
        isDust: true,
        toneIdx: Math.floor(Math.random() * this.DUST_TONES.length),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  드로우
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.gfx.clear();
    this.glowGfx.clear();

    for (const m of this.meteors) {
      // EMBEDDED + SHOCKWAVE 모두에서 ground crater 그림 (땅에 박힌 자국)
      if (m.phase >= 1) {
        this.drawCrater(m);
      }
      // SHOCKWAVE — 폭발 충격파
      if (m.phase === 2) {
        this.drawShockwave(m);
      }
      // FALLING/EMBEDDED 동안 sprite는 spriteContainer에서 자동 렌더
    }

    this.drawBurstCells();
  }

  // ── Ground crater (운석이 박힌 자국 — 움푹 파인 입체감) ──
  // 5겹 ellipse + radial crack lines + 운석 정중앙 정렬 (offset X)
  private drawCrater(m: Meteor) {
    const cx = m.targetWX;
    const cy = m.targetWY;

    // SHOCKWAVE 페이즈에서 점점 흐려짐
    let alpha = 1;
    if (m.phase === 2) {
      const t = m.phaseTimer / SHOCKWAVE_FRAMES;
      alpha = 1 - t * 0.7; // 완전히 사라지진 않음 (잔상)
    }
    if (alpha < 0.05) return;

    // 1. 외곽 rim — 살짝 밝은 stone (raised dirt 느낌, 입체감)
    this.gfx.lineStyle(2.5, COL_STONE_500, 0.85 * alpha);
    this.gfx.drawEllipse(cx, cy, CRATER_RX, CRATER_RY);
    this.gfx.lineStyle(0);

    // 2. 외곽 fill (depression 시작)
    this.gfx.beginFill(COL_STONE_700, 0.75 * alpha);
    this.gfx.drawEllipse(cx, cy, CRATER_RX * 0.95, CRATER_RY * 0.92);
    this.gfx.endFill();

    // 3. 중간 fill (더 어두움 — 깊어짐)
    this.gfx.beginFill(COL_STONE_800, 0.85 * alpha);
    this.gfx.drawEllipse(cx, cy, CRATER_RX * 0.75, CRATER_RY * 0.72);
    this.gfx.endFill();

    // 4. 안쪽 fill (가장 깊은 부분)
    this.gfx.beginFill(COL_STONE_900, 0.92 * alpha);
    this.gfx.drawEllipse(cx, cy, CRATER_RX * 0.50, CRATER_RY * 0.48);
    this.gfx.endFill();

    // 5. 코어 (구덩이 가장 깊은 곳, 검정에 가까움)
    this.gfx.beginFill(COL_STONE_950, 0.95 * alpha);
    this.gfx.drawEllipse(cx, cy, CRATER_RX * 0.25, CRATER_RY * 0.24);
    this.gfx.endFill();

    // 6. Radial crack lines — impact force로 갈라진 균열 (방사형)
    // 시드 결정 (운석 위치 기반)으로 매 프레임 동일 패턴
    const seedAngle = (m.targetWX * 0.013 + m.targetWY * 0.017) % (Math.PI * 2);
    for (let i = 0; i < CRATER_CRACK_COUNT; i++) {
      const a = seedAngle + (i / CRATER_CRACK_COUNT) * Math.PI * 2;
      const r1 = CRATER_RX * 0.85;
      const r2 = CRATER_RX * 1.25;
      // top-down ellipse: y 축 squish
      const ratio = CRATER_RY / CRATER_RX;
      const x1 = cx + Math.cos(a) * r1;
      const y1 = cy + Math.sin(a) * r1 * ratio;
      const x2 = cx + Math.cos(a) * r2;
      const y2 = cy + Math.sin(a) * r2 * ratio;
      this.gfx.lineStyle(1.3, COL_STONE_900, 0.75 * alpha);
      this.gfx.moveTo(x1, y1);
      this.gfx.lineTo(x2, y2);
    }
    this.gfx.lineStyle(0);
  }

  // ── 충격파 wavy ring (4겹, NORMAL only, 강화) ──
  private drawShockwave(m: Meteor) {
    const t = m.phaseTimer / SHOCKWAVE_FRAMES;
    const fade = (1 - t) * (1 - t);
    if (fade < 0.01) return;

    const cx = m.impactWX;
    const cy = m.impactWY;
    const baseR = SHOCKWAVE_MAX_R * t;

    // Wavy ring 헬퍼 (다중 sin 주파수 중첩)
    const drawWavyRing = (r: number, color: number, alpha: number, lineW: number, freqMult: number) => {
      if (r < 1) return;
      const SEGS = 40;
      this.gfx.lineStyle(lineW, color, alpha);
      for (let i = 0; i <= SEGS; i++) {
        const a = (i / SEGS) * Math.PI * 2;
        const wave = Math.sin(a * 5 * freqMult + this.time * 0.18 + m.targetWX * 0.01) * 3.2
                   + Math.sin(a * 9 * freqMult + this.time * 0.12 + m.targetWY * 0.01) * 1.8;
        const rr = r + wave;
        const wx = cx + Math.cos(a) * rr;
        const wy = cy + Math.sin(a) * rr;
        if (i === 0) this.gfx.moveTo(wx, wy);
        else this.gfx.lineTo(wx, wy);
      }
      this.gfx.lineStyle(0);
    };

    // 4겹 wavy ring (3 → 4 강화) — 모두 회색
    drawWavyRing(baseR * 1.00, COL_STONE_800, fade * 0.78, 3.5, 1.0);
    drawWavyRing(baseR * 0.88, COL_STONE_700, fade * 0.85, 2.6, 1.2);
    drawWavyRing(baseR * 0.74, COL_STONE_600, fade * 0.85, 1.9, 0.8);
    drawWavyRing(baseR * 0.58, COL_STONE_500, fade * 0.70, 1.3, 1.4);
  }

  // ── 폭발 셀 (NORMAL only) ──
  private drawBurstCells() {
    for (const c of this.cells) {
      const lifeFrac = c.life / c.maxLife;
      const alpha = lifeFrac * 0.92;
      const sz = c.size * (0.6 + lifeFrac * 0.4);

      const color = c.isDust
        ? this.DUST_TONES[c.toneIdx % this.DUST_TONES.length]
        : this.STONE_TONES[c.toneIdx % this.STONE_TONES.length];

      this.gfx.lineStyle(sz * 0.55, color, alpha * 0.45);
      this.gfx.moveTo(c.prevX, c.prevY);
      this.gfx.lineTo(c.x, c.y);
      this.gfx.lineStyle(0);

      this.gfx.beginFill(color, alpha);
      this.gfx.drawCircle(c.x, c.y, sz);
      this.gfx.endFill();
    }
  }

  stop() {
    this.active = false;
    // 모든 sprite 정리
    for (const m of this.meteors) {
      this.destroyMeteorSprite(m);
    }
    this.meteors = [];
    this.cells = [];
    this.pendingImpacts = [];
    this.spawnedThisBurst = 0;
    this.spawnTimer = 0;
    this.restTimer = 0;
    this.gfx.clear();
    this.glowGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
