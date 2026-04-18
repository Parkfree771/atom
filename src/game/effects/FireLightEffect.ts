import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 불+빛 2단계 — 헬파이어 빔 (Hellfire Beam)
 *
 * 컨셉: 빛 1단계의 차징→발사 사이클 패턴을 그대로 차용하되,
 *        - 차징의 광점(빛/금) → 화염 셀(진한 빨강/어두운 빨강)
 *        - 발사의 5겹 빔(백/금) → 두꺼운 진한 빨강 빔 (백색 X)
 *        지옥불처럼 묵직하고 진한 광선.
 *
 * 검증된 컴포넌트 조합:
 *   - 차징/발사 사이클, impactBulge, 충격파 → LightEffect 패턴 100%
 *   - 화염 셀 톤 → FireEffect.lerpFlameColor 적색 영역 차용
 *
 * 다른 빛 조합과의 차별:
 *   - 빛 1단계: 백/금 빔
 *   - 빛+전기 (프리즘 방전): 금빛 체인 (빔 X)
 *   - 물+빛 (프리즘 차징 빔): 무지개 7색 빔
 *   - 불+빛 (헬파이어): 진한 빨강만, 백색 없음, 더 두꺼움
 *
 * 좌표계: 빛 1단계와 동일 — 컨테이너 = 캐릭터, 빔은 각도로 직접 그림
 */

// ── 빔 타격 화염 셀 (적 위치에서 작은 폭발) ──
interface HitFlameCell {
  /** 월드 좌표 (컨테이너가 캐릭터 따라가니까 매 프레임 변환 필요) */
  worldX: number;
  worldY: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
}

// ── 차징 화염 셀 ──
interface ChargeFlameCell {
  x: number;
  y: number;
  /** 직전 프레임 위치 (트레일용) */
  prevX: number;
  prevY: number;
  speed: number;
  size: number;
  /** 색 분류 (id % 4 === 0 → 오렌지/앰버 액센트, 나머지 → 진한 빨강) */
  id: number;
  /** 흔들림 위상 */
  wobblePhase: number;
  /** 흔들림 주파수 */
  wobbleSpeed: number;
  /** 흔들림 진폭 */
  wobbleAmp: number;
  /** 위쪽 표류 강도 (화염 솟구침) */
  upDrift: number;
}

const enum FireLightPhase {
  CHARGING = 0,
  FIRING = 1,
}

export class FireLightEffect {
  private container: PIXI.Container;
  /** ADD 글로우 (외곽 글로우만 — ADD라 빨강 어두운색 거의 안 보임) */
  private glowGfx: PIXI.Graphics;
  /** NORMAL 셀 코어 (셀 본체 빨강 색 정확히 보이게) */
  private cellGfx: PIXI.Graphics;
  /** 빔 본체 (NORMAL, 5겹 라인) */
  private beamGfx: PIXI.Graphics;

  active = false;
  private beamRange = 2000;
  private time = 0;
  private currentAngle = 0;

  // 페이즈
  private phase: FireLightPhase = FireLightPhase.CHARGING;
  private phaseTimer = 0;
  private readonly CHARGE_DURATION = 90;
  private readonly FIRE_DURATION = 50;

  // 엔진이 읽는 공개 상태
  beamFiredThisFrame = false;
  beamDirection = 0;

  // 차징 화염 셀
  private chargeCells: ChargeFlameCell[] = [];
  private cellIdCounter = 0;

  // 빔 타격 화염 (적 위치 폭발)
  private hitFlames: HitFlameCell[] = [];

  // ── 색 팔레트 (빔과 동일한 빨강만, amber/orange 없음) ──
  private readonly COL_DARKEST = 0x4a0e0e; // 거의 검정 빨강 (빔 외곽)
  private readonly COL_RED_900 = 0x7f1d1d; // red-900 (빔 외곽)
  private readonly COL_RED_800 = 0x991b1b; // red-800
  private readonly COL_RED_700 = 0xb91c1c; // red-700 (빔 중간)
  private readonly COL_RED_600 = 0xdc2626; // red-600 (빔 내부)
  private readonly COL_RED_500 = 0xef4444; // red-500
  private readonly COL_RED_400 = 0xf87171; // red-400 (빔 심선)
  private readonly COL_RED_300 = 0xfca5a5; // red-300
  private readonly COL_RED_200 = 0xfecaca; // red-200 (입자 머리 — 가장 밝음)

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (ADD, 가장 아래)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 셀 본체 (NORMAL — 빨강 색 정확히 표현, 글로우 위)
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    // 빔 (NORMAL, 가장 위)
    this.beamGfx = new PIXI.Graphics();
    this.container.addChild(this.beamGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.phase = FireLightPhase.CHARGING;
    this.phaseTimer = 0;
    this.chargeCells = [];
    this.hitFlames = [];
    this.beamFiredThisFrame = false;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    this.container.position.set(x, y);
  }

  /** 빔 타격 시 적 위치에 작은 화염 폭발 (engine이 호출) */
  spawnHitFlame(worldX: number, worldY: number) {
    const count = 10;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed = 0.8 + Math.random() * 1.5;
      this.hitFlames.push({
        worldX,
        worldY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.4, // 살짝 위쪽
        size: 1.5 + Math.random() * 1.5,
        life: 0,
        maxLife: 16 + Math.random() * 10,
      });
    }
  }

  setDirection(angle: number) {
    let diff = angle - this.currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.currentAngle += diff * 0.08;
  }

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.beamFiredThisFrame = false;
    this.phaseTimer += dt;

    if (this.phase === FireLightPhase.CHARGING) {
      this.updateCharging(dt);
      if (this.phaseTimer >= this.CHARGE_DURATION) {
        this.phase = FireLightPhase.FIRING;
        this.phaseTimer = 0;
        this.beamFiredThisFrame = true;
        this.beamDirection = this.currentAngle;
        this.chargeCells = [];
      }
    } else {
      if (this.phaseTimer >= this.FIRE_DURATION) {
        this.phase = FireLightPhase.CHARGING;
        this.phaseTimer = 0;
      }
    }

    // 타격 화염 셀 업데이트 (페이즈 무관)
    for (let i = this.hitFlames.length - 1; i >= 0; i--) {
      const f = this.hitFlames[i];
      f.life += dt;
      if (f.life >= f.maxLife) {
        swapPop(this.hitFlames, i);
        continue;
      }
      f.worldX += f.vx * dt;
      f.worldY += f.vy * dt;
      f.vy -= 0.04 * dt; // 위쪽 가속 (불꽃 솟구침)
      f.vx *= 0.95;
      f.vy *= 0.95;
    }

    this.draw();
  }

  // ═══════════════════════════════════════════════════════════
  //  차징 — 화염 셀이 사방→중심
  // ═══════════════════════════════════════════════════════════

  private updateCharging(dt: number) {
    const progress = this.phaseTimer / this.CHARGE_DURATION;

    // 셀 생성 (진행될수록 빈번)
    const spawnRate = 3 + progress * 5;
    if (Math.floor(this.time) % Math.max(1, Math.floor(3 - spawnRate)) === 0
        && this.chargeCells.length < 50) {
      const count = 2 + Math.floor(progress * 3);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 55 + Math.random() * 75;
        const sx = Math.cos(angle) * dist;
        const sy = Math.sin(angle) * dist;
        this.chargeCells.push({
          x: sx,
          y: sy,
          prevX: sx,
          prevY: sy,
          speed: 0.7 + Math.random() * 0.5 + progress * 1.6,
          size: 1.4 + Math.random() * 2.0,
          id: this.cellIdCounter++,
          wobblePhase: Math.random() * Math.PI * 2,
          wobbleSpeed: 0.20 + Math.random() * 0.15,
          wobbleAmp: 2.0 + Math.random() * 1.8,
          upDrift: 0.25 + Math.random() * 0.30, // 위쪽 솟구침 강화
        });
      }
    }

    // 셀 이동 (중심 흡입 + 사인파 흔들림 + 위쪽 표류 + 트레일)
    for (let i = this.chargeCells.length - 1; i >= 0; i--) {
      const c = this.chargeCells[i];
      const d = Math.sqrt(c.x * c.x + c.y * c.y);
      if (d < 5) {
        swapPop(this.chargeCells, i);
        continue;
      }

      // 트레일용 직전 위치 저장
      c.prevX = c.x;
      c.prevY = c.y;

      // 중심 방향 단위 벡터
      const nx = -c.x / d;
      const ny = -c.y / d;

      // 수직 방향 (사인파 흔들림용 — 진행 방향에 직각)
      const px = -ny;
      const py = nx;

      // 흔들림 진폭 (시간 따라 위상 진행)
      c.wobblePhase += c.wobbleSpeed * dt;
      const wobble = Math.sin(c.wobblePhase) * c.wobbleAmp;

      // 이동: 중심 흡입 + 흔들림(수직) + 위쪽 표류(-y)
      c.x += (nx * c.speed + px * wobble * 0.15) * dt;
      c.y += (ny * c.speed + py * wobble * 0.15 - c.upDrift) * dt;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.beamGfx.clear();

    if (this.phase === FireLightPhase.CHARGING) {
      this.drawCharging();
    } else {
      this.drawBeam();
    }

    // 타격 화염 (페이즈 무관)
    this.drawHitFlames();
  }

  private drawCharging() {
    const cells = this.chargeCells;

    // 화염 혀 (셀별) — 중심 덩어리 같은 배경 원 없음, 입자만
    for (const c of cells) {
      const d = Math.sqrt(c.x * c.x + c.y * c.y);
      const closeFactor = 1 - Math.min(1, d / 130);

      // 셀 색 — 멀리도 보이게 RED_700부터 시작 (DARKEST는 너무 어두워서 묻힘)
      // 가까이는 매우 밝은 빨강 (RED_300, RED_200)까지
      const headColor = closeFactor < 0.20 ? this.COL_RED_700
                      : closeFactor < 0.40 ? this.COL_RED_600
                      : closeFactor < 0.60 ? this.COL_RED_500
                      : closeFactor < 0.78 ? this.COL_RED_400
                      : closeFactor < 0.92 ? this.COL_RED_300
                      : this.COL_RED_200;
      // 글로우는 한 단계 어둡게
      const glowColor = closeFactor < 0.30 ? this.COL_RED_900
                      : closeFactor < 0.55 ? this.COL_RED_700
                      : closeFactor < 0.80 ? this.COL_RED_600
                      : this.COL_RED_500;

      // 강한 깜빡임
      const flickerWob = 0.75 + Math.sin(c.wobblePhase * 1.9) * 0.25;
      // 알파 강화 (가까이 거의 1.0)
      const alpha = (0.70 + closeFactor * 0.30) * flickerWob;

      // 셀 운동 방향 (중심 + 위쪽 표류 보정)
      const nx = -c.x / d;
      const ny = -c.y / d - c.upDrift * 0.5;
      const mag = Math.sqrt(nx * nx + ny * ny) || 1;
      const dirX = nx / mag;
      const dirY = ny / mag;

      // 꼬리 (셀 운동 반대)
      const tailLen = c.size * 5.5;
      const tailX = c.x - dirX * tailLen;
      const tailY = c.y - dirY * tailLen;

      // 화염 혀: 머리 → 꼬리 6점
      const segments = 6;
      for (let i = 0; i < segments; i++) {
        const t = i / segments;
        const px = c.x + (tailX - c.x) * t;
        const py = c.y + (tailY - c.y) * t;
        const sz = c.size * (1 - t * 0.85);
        const segA = alpha * (1 - t * 0.55);

        // 글로우 (ADD — 외곽 빛 효과)
        this.glowGfx.beginFill(glowColor, segA * 0.35);
        this.glowGfx.drawCircle(px, py, sz * 2.4);
        this.glowGfx.endFill();

        // 코어 (NORMAL — 빨강 색 정확히 보이게)
        this.cellGfx.beginFill(headColor, segA);
        this.cellGfx.drawCircle(px, py, sz);
        this.cellGfx.endFill();
      }

      // 머리 강조 — 가장 밝은 빨강 (red-200) — NORMAL 블렌드
      this.cellGfx.beginFill(this.COL_RED_200, alpha * 0.95);
      this.cellGfx.drawCircle(c.x, c.y, c.size * 0.60);
      this.cellGfx.endFill();
    }
  }

  private drawHitFlames() {
    if (this.hitFlames.length === 0) return;
    const cx = this.container.position.x;
    const cy = this.container.position.y;

    for (const f of this.hitFlames) {
      // 월드 → 컨테이너 로컬 변환
      const lx = f.worldX - cx;
      const ly = f.worldY - cy;
      const lifeFrac = f.life / f.maxLife;
      const alpha = (1 - lifeFrac * 0.8) * 0.90;
      const sz = f.size * (1 - lifeFrac * 0.5);

      // 색: 시작=밝은 빨강 → 끝=어두운 빨강 (빔 색과 통일)
      const color = lifeFrac < 0.25 ? this.COL_RED_300
                  : lifeFrac < 0.50 ? this.COL_RED_500
                  : lifeFrac < 0.75 ? this.COL_RED_600
                  : this.COL_RED_700;
      const glowCol = lifeFrac < 0.40 ? this.COL_RED_600
                    : this.COL_RED_800;

      // 글로우 (ADD)
      this.glowGfx.beginFill(glowCol, alpha * 0.40);
      this.glowGfx.drawCircle(lx, ly, sz * 2.5);
      this.glowGfx.endFill();

      // 코어 (NORMAL — 빨강 정확히 보이게)
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(lx, ly, sz);
      this.cellGfx.endFill();
    }
  }

  private drawBeam() {
    const fadeProg = this.phaseTimer / this.FIRE_DURATION;
    const alpha = 1 - fadeProg * 0.85;
    const fade = 1 - fadeProg * 0.4;
    const angle = this.beamDirection;
    const R = this.beamRange;

    // 발사 직후 두께 팽창 → 수축 (처음 5프레임 130% → 정상)
    const impactBulge = this.phaseTimer < 5
      ? 1 + (1 - this.phaseTimer / 5) * 0.30
      : 1;

    const endX = Math.cos(angle) * R;
    const endY = Math.sin(angle) * R;
    const bulge = fade * impactBulge;

    // ── 빔 5겹 (1단계 빛과 비슷한 두께, 색은 모두 적색, alpha 강화) ──

    // 1) 최외곽 — 검정빨강
    this.beamGfx.lineStyle(65 * bulge, this.COL_DARKEST, alpha * 0.22);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 2) 외곽 — red-900
    this.beamGfx.lineStyle(42 * bulge, this.COL_RED_900, alpha * 0.40);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 3) 중간 — red-700
    this.beamGfx.lineStyle(25 * bulge, this.COL_RED_700, alpha * 0.60);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 4) 내부 코어 — red-600
    this.beamGfx.lineStyle(13 * bulge, this.COL_RED_600, alpha * 0.82);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);

    // 5) 심선 — red-400 (빔 가시성)
    this.beamGfx.lineStyle(6 * bulge, this.COL_RED_400, alpha * 0.95);
    this.beamGfx.moveTo(0, 0);
    this.beamGfx.lineTo(endX, endY);
    this.beamGfx.lineStyle(0);

    // ── 발사 임팩트 (적색 충격파) ──
    if (fadeProg < 0.25) {
      const flashAlpha = (0.25 - fadeProg) / 0.25;

      // 강렬한 진한 빨강 코어
      this.glowGfx.beginFill(this.COL_RED_500, 0.55 * flashAlpha);
      this.glowGfx.drawCircle(0, 0, 26);
      this.glowGfx.endFill();

      // 중간 빨강 글로우
      this.glowGfx.beginFill(this.COL_RED_700, 0.50 * flashAlpha);
      this.glowGfx.drawCircle(0, 0, 38);
      this.glowGfx.endFill();

      // 어두운 빨강 충격파 링
      this.glowGfx.lineStyle(3.5 * flashAlpha, this.COL_RED_800, 0.55 * flashAlpha);
      this.glowGfx.drawCircle(0, 0, 42 + (1 - flashAlpha) * 30);
      this.glowGfx.lineStyle(0);
    }
  }

  stop() {
    this.active = false;
    this.container.visible = false;
    this.chargeCells = [];
    this.hitFlames = [];
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.beamGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
