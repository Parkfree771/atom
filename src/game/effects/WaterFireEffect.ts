import * as PIXI from 'pixi.js';
import { swapPop } from './utils';

/**
 * 물+불 2단계 — 스팀 폭발 (Steam Burst)
 *
 * 끓는 물이 압력에 응축되었다가 한순간에 폭발한다.
 * 자연현상 참고: BLEVE(끓는 액체 팽창 증기 폭발), 화산 phreatomagmatic 분화.
 *
 * 4페이즈 사이클:
 *   1. 응축 (CONDENSING, 50f) — 사방의 차가운 증기가 캐릭터로 빨려듦, 회전하며 가열
 *   2. 임계 (CRITICAL,    8f) — 모든 게 한 점으로 수렴, 정적, 백색 극점
 *   3. 폭발 (BURST,      30f) — 충격파 + 폭발 셀 사방 분출, 데미지 발동
 *   4. 잔류 (LINGERING,  20f) — 식어가는 증기가 흩어짐
 *
 * 좌표계:
 *   - 응축/임계는 컨테이너 = 플레이어 위치 (캐릭터 따라다님)
 *   - 폭발 시작 시 컨테이너 위치 고정 (그 자리에 머무름 → 임팩트)
 *   - 잔류 종료 → 응축 복귀 시 잠금 해제
 *
 * 디자인 원칙:
 *   - 폴리곤 X, 셀이 곧 형태
 *   - 색상 연속 보간 (10스톱)
 *   - 끝까지 강렬한 색 유지 (마지막은 진슬레이트, 흐지부지 X)
 *   - 캐릭터 뿌리 보호 (응축 셀은 거리 8 미만에서 소멸)
 */

// ───────────────────────────────────────────────────────────────
//  타입 정의
// ───────────────────────────────────────────────────────────────

const enum SteamPhase {
  CONDENSING = 0,
  CRITICAL = 1,
  BURST = 2,
  LINGERING = 3,
}

/** 응축 셀: 사방에서 중심으로 빨려드는 차가운 증기 */
interface CondenseParticle {
  x: number;
  y: number;
  /** 반경 방향 가속도 누적용 */
  radialSpeed: number;
  /** 접선 방향 (회전) 가속도 누적용. 셀마다 시계/반시계 약간 다르게 */
  tangentBias: number;
  size: number;
  /** 시드(0~1) — 색상/투명도 미세 변동용 */
  seed: number;
}

/** 폭발 셀: 사방 360도로 분출되는 증기/불꽃/백열 코어 */
interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=백열 코어, 1=증기, 2=불꽃 */
  type: 0 | 1 | 2;
  /** 회전 (드로잉용 시각 변화) */
  spin: number;
}

/** 충격파: 1차/2차 두 발 */
interface Shockwave {
  /** 0~1 (수명 30f) */
  progress: number;
  /** 시작 딜레이 (프레임) */
  delay: number;
  /** 1차=1.0, 2차=0.78 */
  scale: number;
}

// ───────────────────────────────────────────────────────────────
//  색상 보간 — 백열에서 진슬레이트까지 10스톱
// ───────────────────────────────────────────────────────────────

interface ColorStop { t: number; r: number; g: number; b: number; }

/**
 * 스팀 폭발 메인 그라데이션 (식어가는 증기)
 * t=0:   백열 (warm white)
 * t=0.1: 밝은 오렌지
 * t=0.2: 오렌지
 * t=0.35: 식어가는 황색
 * t=0.5: 슬레이트 밝음
 * t=0.7: 슬레이트 중간
 * t=0.85: 슬레이트 진함
 * t=1.0: 진슬레이트 (끝까지 강렬)
 */
const STEAM_STOPS: ColorStop[] = [
  { t: 0.00, r: 0xff, g: 0xf7, b: 0xed }, // warm white
  { t: 0.08, r: 0xfe, g: 0xd0, b: 0x8a }, // 밝은 황금
  { t: 0.18, r: 0xfb, g: 0xa4, b: 0x4a }, // 진오렌지 사이
  { t: 0.28, r: 0xfb, g: 0x92, b: 0x3c }, // orange-400
  { t: 0.42, r: 0xe2, g: 0xc4, b: 0x9a }, // 식어가는 황색
  { t: 0.55, r: 0xcb, g: 0xd5, b: 0xe1 }, // slate-300
  { t: 0.70, r: 0x94, g: 0xa3, b: 0xb8 }, // slate-400
  { t: 0.85, r: 0x64, g: 0x74, b: 0x8b }, // slate-500
  { t: 1.00, r: 0x47, g: 0x55, b: 0x69 }, // slate-600 (끝까지 진함)
];

/**
 * 응축 셀용 그라데이션 (차가운 슬레이트 → 가열 앰버)
 * t=0: 멀리 있음 (차가움)
 * t=1: 중심 근처 (뜨거움)
 */
const CONDENSE_STOPS: ColorStop[] = [
  { t: 0.00, r: 0x47, g: 0x55, b: 0x69 }, // slate-600 차가움
  { t: 0.30, r: 0x6b, g: 0x72, b: 0x80 }, // slate-500
  { t: 0.55, r: 0x9c, g: 0x84, b: 0x4a }, // 회황색 (중간)
  { t: 0.78, r: 0xd9, g: 0x77, b: 0x06 }, // amber-600
  { t: 1.00, r: 0xfb, g: 0xbf, b: 0x24 }, // amber-400 뜨거움
];

function lerpStops(stops: ColorStop[], t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tt >= a.t && tt <= b.t) {
      const u = (tt - a.t) / (b.t - a.t);
      const r = Math.round(a.r + (b.r - a.r) * u);
      const g = Math.round(a.g + (b.g - a.g) * u);
      const bl = Math.round(a.b + (b.b - a.b) * u);
      return (r << 16) | (g << 8) | bl;
    }
  }
  const last = stops[stops.length - 1];
  return (last.r << 16) | (last.g << 8) | last.b;
}

const lerpSteamColor = (t: number) => lerpStops(STEAM_STOPS, t);
const lerpCondenseColor = (t: number) => lerpStops(CONDENSE_STOPS, t);

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class WaterFireEffect {
  private container: PIXI.Container;
  /** ADD 블렌드 글로우 (충격파, 코어 글로우, 백열 셀 글로우) */
  private glowGfx: PIXI.Graphics;
  /** 일반 블렌드 (응축 셀, 증기 셀 본체) */
  private cellGfx: PIXI.Graphics;
  /** 코어/임계점 (위에 그림) */
  private coreGfx: PIXI.Graphics;

  active = false;
  /** 폭발 발동 순간 (엔진이 데미지 처리에 사용) */
  burstFiredThisFrame = false;
  burstRadius = 280;

  // 페이즈 상태
  private phase: SteamPhase = SteamPhase.CONDENSING;
  private phaseTimer = 0;
  private time = 0;

  // 페이즈 길이 (프레임)
  private readonly CONDENSE_DURATION = 50;
  private readonly CRITICAL_DURATION = 8;
  private readonly BURST_DURATION = 30;
  private readonly LINGER_DURATION = 20;

  // 응축 셀
  private condenseParticles: CondenseParticle[] = [];
  private readonly CONDENSE_MAX = 60;
  private condenseSpawnAcc = 0;

  // 폭발 셀
  private burstParticles: BurstParticle[] = [];

  // 충격파
  private shockwaves: Shockwave[] = [];

  // 위치 잠금 (폭발 단계에서 컨테이너 고정)
  private locked = false;

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    parent.addChild(this.container);

    // 글로우 (아래, ADD)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 셀 본체 (중간, NORMAL)
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    // 코어 (위, NORMAL)
    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.time = 0;
    this.phase = SteamPhase.CONDENSING;
    this.phaseTimer = 0;
    this.condenseParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.condenseSpawnAcc = 0;
    this.locked = false;
    this.burstFiredThisFrame = false;
    this.container.position.set(x, y);
    this.container.visible = true;
  }

  setPosition(x: number, y: number) {
    if (this.locked) return; // 폭발 단계에서는 잠김
    this.container.position.set(x, y);
  }

  /** 컨테이너의 현재 월드 좌표 (폭발 중심 — 엔진 데미지 판정용) */
  get centerX(): number { return this.container.position.x; }
  get centerY(): number { return this.container.position.y; }

  // ═══════════════════════════════════════════════════════════
  //  업데이트 (페이즈 상태머신)
  // ═══════════════════════════════════════════════════════════

  update(dt: number) {
    if (!this.active) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.burstFiredThisFrame = false;

    switch (this.phase) {
      case SteamPhase.CONDENSING:
        this.updateCondensing(dt);
        if (this.phaseTimer >= this.CONDENSE_DURATION) {
          this.phase = SteamPhase.CRITICAL;
          this.phaseTimer = 0;
          this.condenseParticles = []; // 모두 한 점으로 수렴 → 사라짐
        }
        break;

      case SteamPhase.CRITICAL:
        // 정적 — 업데이트 거의 없음
        if (this.phaseTimer >= this.CRITICAL_DURATION) {
          this.phase = SteamPhase.BURST;
          this.phaseTimer = 0;
          this.locked = true; // 폭발 시작 → 위치 고정
          this.burstFiredThisFrame = true; // 엔진에 알림
          this.spawnBurst();
          this.spawnShockwaves();
        }
        break;

      case SteamPhase.BURST:
        this.updateBurst(dt);
        if (this.phaseTimer >= this.BURST_DURATION) {
          this.phase = SteamPhase.LINGERING;
          this.phaseTimer = 0;
        }
        break;

      case SteamPhase.LINGERING:
        this.updateBurst(dt); // 잔류는 폭발 셀만 페이드 (새 생성 X)
        if (this.phaseTimer >= this.LINGER_DURATION) {
          this.phase = SteamPhase.CONDENSING;
          this.phaseTimer = 0;
          this.locked = false;
          this.burstParticles = [];
          this.shockwaves = [];
        }
        break;
    }

    this.draw();
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 1 — 응축
  // ───────────────────────────────────────────────────────────

  private updateCondensing(dt: number) {
    const progress = this.phaseTimer / this.CONDENSE_DURATION;

    // 셀 스폰: 진행될수록 빈번하게
    this.condenseSpawnAcc += dt * (0.7 + progress * 1.6);
    while (this.condenseSpawnAcc >= 1 && this.condenseParticles.length < this.CONDENSE_MAX) {
      this.condenseSpawnAcc -= 1;
      this.spawnCondenseParticle();
    }

    // 셀 이동: 나선형 흡입 (반경 + 접선)
    for (let i = this.condenseParticles.length - 1; i >= 0; i--) {
      const p = this.condenseParticles[i];
      const d = Math.sqrt(p.x * p.x + p.y * p.y);

      // 캐릭터 뿌리 보호: 거리 8 미만에서 소멸
      if (d < 8) {
        swapPop(this.condenseParticles, i);
        continue;
      }

      // 반경 방향 (중심으로)
      const nx = -p.x / d;
      const ny = -p.y / d;

      // 접선 방향 (시계/반시계 — tangentBias 부호로 결정)
      const tx = -ny * p.tangentBias;
      const ty = nx * p.tangentBias;

      // 가속: 가까울수록 더 빨라짐 (압력에 빨려드는 느낌)
      const closeBoost = 1 + Math.max(0, (140 - d) / 90);
      p.radialSpeed += 0.05 * closeBoost * dt;
      // 접선 속도도 가까울수록 증가 → 회전이 가속됨
      const tanSpeed = 0.4 + (140 - d) / 90;

      p.x += (nx * p.radialSpeed + tx * tanSpeed) * dt;
      p.y += (ny * p.radialSpeed + ty * tanSpeed) * dt;
    }
  }

  private spawnCondenseParticle() {
    const angle = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 60;
    // tangentBias: 절반은 시계 / 절반은 반시계, 약간의 강도 변동
    const sign = Math.random() < 0.5 ? -1 : 1;
    const bias = sign * (0.6 + Math.random() * 0.5);
    this.condenseParticles.push({
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      radialSpeed: 0.6 + Math.random() * 0.4,
      tangentBias: bias,
      size: 1.5 + Math.random() * 1.5,
      seed: Math.random(),
    });
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 3 — 폭발 셀 / 충격파 생성
  // ───────────────────────────────────────────────────────────

  private spawnBurst() {
    const total = 130;
    for (let i = 0; i < total; i++) {
      // 균등 분포 + 약간의 지터 (완전 균일하면 부자연스러움)
      const angle = (i / total) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const speed = 5 + Math.random() * 7;

      // 타입 분포: 10% 백열 코어, 70% 증기, 20% 불꽃
      const r = Math.random();
      let type: 0 | 1 | 2;
      let size: number;
      let maxLife: number;
      if (r < 0.10) {
        type = 0; // 백열 코어 셀
        size = 3 + Math.random() * 3;
        maxLife = 25 + Math.random() * 12;
      } else if (r < 0.80) {
        type = 1; // 증기 셀
        size = 2 + Math.random() * 3;
        maxLife = 35 + Math.random() * 15;
      } else {
        type = 2; // 불꽃 셀
        size = 1 + Math.random() * 2;
        maxLife = 20 + Math.random() * 12;
      }

      // 중심에서 약간 떨어진 곳에서 시작 (캐릭터 뿌리 보호)
      const startDist = 6 + Math.random() * 6;

      this.burstParticles.push({
        x: Math.cos(angle) * startDist,
        y: Math.sin(angle) * startDist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife,
        size,
        type,
        spin: Math.random() * Math.PI * 2,
      });
    }
  }

  private spawnShockwaves() {
    this.shockwaves = [
      { progress: 0, delay: 0, scale: 1.0 },   // 1차 (즉발, 큰)
      { progress: 0, delay: 5, scale: 0.78 },  // 2차 (5f 후, 작음)
    ];
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 3/4 — 폭발 셀 + 충격파 업데이트
  // ───────────────────────────────────────────────────────────

  private updateBurst(dt: number) {
    // 폭발 셀 이동 (드래그 감속)
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.burstParticles, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // 드래그: 매 프레임 약간씩 감속 (증기는 공기저항 큼)
      const drag = p.type === 2 ? 0.93 : 0.95;
      p.vx *= drag;
      p.vy *= drag;
    }

    // 충격파 진행
    for (const sw of this.shockwaves) {
      if (sw.delay > 0) {
        sw.delay -= dt;
        continue;
      }
      sw.progress += dt / 30;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  렌더링
  // ═══════════════════════════════════════════════════════════

  private draw() {
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();

    switch (this.phase) {
      case SteamPhase.CONDENSING:
        this.drawCondensing();
        break;
      case SteamPhase.CRITICAL:
        this.drawCritical();
        break;
      case SteamPhase.BURST:
        this.drawBurst();
        this.drawShockwaves();
        break;
      case SteamPhase.LINGERING:
        this.drawBurst();
        // 충격파는 잔류 단계엔 거의 사라져 있음
        this.drawShockwaves();
        break;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  응축 드로우
  // ───────────────────────────────────────────────────────────

  private drawCondensing() {
    const progress = this.phaseTimer / this.CONDENSE_DURATION;

    // 1) 응축 셀 — 거리 기반 색상 (멀=차가움 / 가까움=가열)
    this.cellGfx.lineStyle(0);
    for (const p of this.condenseParticles) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y);
      // 거리 → 온도 (140=차가움, 8=가열)
      const tempT = 1 - Math.min(1, Math.max(0, (d - 8) / 132));
      const color = lerpCondenseColor(tempT);
      // 셀 본체
      const alpha = 0.55 + p.seed * 0.25;
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, p.size);
      this.cellGfx.endFill();

      // 가열된 셀(중심 근처)에는 글로우 추가
      if (tempT > 0.55) {
        const glowAlpha = (tempT - 0.55) / 0.45 * 0.35;
        this.glowGfx.beginFill(color, glowAlpha);
        this.glowGfx.drawCircle(p.x, p.y, p.size * 2.4);
        this.glowGfx.endFill();
      }
    }

    // 2) 압력 코어 — 진행률 60%부터 등장
    if (progress > 0.6) {
      const coreT = (progress - 0.6) / 0.4;
      // 막바지(85%+) 펄스 진동
      const pulse = progress > 0.85
        ? 0.92 + Math.sin(this.time * 0.55) * 0.08
        : 1.0;
      const baseR = (4 + coreT * 8) * pulse;

      // 외부 cream 글로우 (ADD)
      this.glowGfx.beginFill(0xfef3c7, 0.32 * coreT);
      this.glowGfx.drawCircle(0, 0, baseR * 2.4);
      this.glowGfx.endFill();

      // 오렌지 코어 글로우 (ADD)
      this.glowGfx.beginFill(0xfb923c, 0.55 * coreT);
      this.glowGfx.drawCircle(0, 0, baseR * 1.5);
      this.glowGfx.endFill();

      // 백열 중심 (위에)
      this.coreGfx.beginFill(0xffffff, 0.85 * coreT * coreT);
      this.coreGfx.drawCircle(0, 0, baseR * 0.45);
      this.coreGfx.endFill();
    }
  }

  // ───────────────────────────────────────────────────────────
  //  임계 드로우
  // ───────────────────────────────────────────────────────────

  private drawCritical() {
    const tFrac = this.phaseTimer / this.CRITICAL_DURATION;
    // 마지막 25%에서 살짝 수축 (폭발 직전 흡입)
    const shrink = tFrac < 0.75
      ? 1.0
      : 1.0 - (tFrac - 0.75) / 0.25 * 0.35;
    const baseR = 14 * shrink;

    // 가장 바깥: 오렌지 헤일로 (ADD)
    this.glowGfx.beginFill(0xfb923c, 0.45);
    this.glowGfx.drawCircle(0, 0, baseR * 3.4);
    this.glowGfx.endFill();

    // 중간: 크림 글로우 (ADD)
    this.glowGfx.beginFill(0xfef3c7, 0.65);
    this.glowGfx.drawCircle(0, 0, baseR * 2.0);
    this.glowGfx.endFill();

    // 백열 코어 (ADD)
    this.glowGfx.beginFill(0xfff7ed, 0.85);
    this.glowGfx.drawCircle(0, 0, baseR * 1.15);
    this.glowGfx.endFill();

    // 순백 중심 (위)
    this.coreGfx.beginFill(0xffffff, 0.95);
    this.coreGfx.drawCircle(0, 0, baseR * 0.55);
    this.coreGfx.endFill();
  }

  // ───────────────────────────────────────────────────────────
  //  폭발/잔류 드로우 — 셀
  // ───────────────────────────────────────────────────────────

  private drawBurst() {
    this.cellGfx.lineStyle(0);

    for (const p of this.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      // 셀 사이즈는 살짝 커지다가 줄어듦 (팽창 후 흩어짐)
      const sizePhase = lifeFrac < 0.25
        ? 1 + lifeFrac * 1.0       // 0~25%: 1.0 → 1.25
        : 1.25 - (lifeFrac - 0.25) * 0.5; // 25~100%: 1.25 → 0.875
      const r = p.size * sizePhase;

      let color: number;
      let alpha: number;
      let glowColor: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        // ── 백열 코어 셀: 백→오렌지→슬레이트, 가장 밝음
        color = lerpSteamColor(lifeFrac * 0.85);
        alpha = (1 - lifeFrac * 0.55) * 0.95;
        glowColor = lerpSteamColor(Math.max(0, lifeFrac * 0.5 - 0.05));
        glowAlpha = (1 - lifeFrac) * 0.55;
        glowMul = 2.8;
      } else if (p.type === 1) {
        // ── 증기 셀: 슬레이트 위주 (메인 부피)
        // 시작은 살짝 따뜻한 색, 빠르게 슬레이트로
        color = lerpSteamColor(0.35 + lifeFrac * 0.55);
        alpha = (1 - lifeFrac * 0.35) * 0.62;
        glowColor = color;
        glowAlpha = (1 - lifeFrac) * 0.18;
        glowMul = 2.0;
      } else {
        // ── 불꽃 셀: 오렌지 위주, 빨리 식음
        color = lerpSteamColor(0.05 + lifeFrac * 0.7);
        alpha = (1 - lifeFrac * 0.7) * 0.88;
        glowColor = lerpSteamColor(0.08 + lifeFrac * 0.4);
        glowAlpha = (1 - lifeFrac) * 0.45;
        glowMul = 2.4;
      }

      // 글로우 (ADD)
      this.glowGfx.beginFill(glowColor, glowAlpha);
      this.glowGfx.drawCircle(p.x, p.y, r * glowMul);
      this.glowGfx.endFill();

      // 본체
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, r);
      this.cellGfx.endFill();

      // 백열 코어 셀은 한 번 더 작은 흰 점 추가 (반짝)
      if (p.type === 0 && lifeFrac < 0.4) {
        const sparkA = (1 - lifeFrac / 0.4) * 0.7;
        this.coreGfx.beginFill(0xffffff, sparkA);
        this.coreGfx.drawCircle(p.x, p.y, r * 0.4);
        this.coreGfx.endFill();
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  폭발 드로우 — 충격파
  // ───────────────────────────────────────────────────────────

  private drawShockwaves() {
    for (const sw of this.shockwaves) {
      if (sw.delay > 0) continue;
      if (sw.progress >= 1) continue;

      // 가속/감속 곡선: 첫 5/30=0.17 진행률에서 70% 반경 도달
      const p = sw.progress;
      const radiusFrac = p < 0.17
        ? (p / 0.17) * 0.7
        : 0.7 + ((p - 0.17) / 0.83) * 0.3;
      const r = radiusFrac * this.burstRadius * sw.scale;

      // 알파: 빠르게 페이드 (ease-out)
      const fade = (1 - p) * (1 - p);

      // 1) 가장 바깥 — 큰 슬레이트 글로우 (ADD)
      this.glowGfx.lineStyle(28 * (1 - p * 0.4), 0x94a3b8, fade * 0.30);
      this.glowGfx.drawCircle(0, 0, r);

      // 2) 중간 — 밝은 슬레이트 (ADD)
      this.glowGfx.lineStyle(16 * (1 - p * 0.3), 0xcbd5e1, fade * 0.55);
      this.glowGfx.drawCircle(0, 0, r);

      // 3) 코어 — 따뜻한 백 (ADD)
      this.glowGfx.lineStyle(7 * (1 - p * 0.2), 0xfff7ed, fade * 0.75);
      this.glowGfx.drawCircle(0, 0, r);

      // 4) 심선 — 순백 (ADD), 1차 충격파만 (2차는 얇게)
      const coreLine = sw.scale > 0.9 ? 3 : 1.6;
      this.glowGfx.lineStyle(coreLine, 0xffffff, fade * 0.85);
      this.glowGfx.drawCircle(0, 0, r);
    }
    this.glowGfx.lineStyle(0);
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.condenseParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.locked = false;
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();
  }

  destroy() {
    this.stop();
    this.container.destroy({ children: true });
  }
}
