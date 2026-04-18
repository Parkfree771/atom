import * as PIXI from 'pixi.js';
import { CANVAS_W, CANVAS_H } from '../types';
import { swapPop } from './utils';

/**
 * 전기+암흑 2단계 — 자기장 폭풍 (Magnetic Storm)
 *
 * 컨셉: 캐릭터 주변에 이극성 자기장이 형성되어 영역 내 모든 적이 자기력선에
 *        잡혀 캐릭터 쪽으로 천천히 끌려오면서(자기 견인) 지속 감전 데미지를 받는다.
 *        일정 주기마다 자기 재연결(magnetic reconnection)이 일어나며, 모든 자기력선이
 *        한순간 끊어지고 그동안 모인 적들의 위치마다 폭발적 에너지가 방출된다.
 *        함정(견인) → 한방(다중 폭발)의 콤보.
 *
 * 4페이즈 사이클 (총 150프레임 ≈ 2.5초):
 *   1. 충전 (CHARGING,    100f) — 자기력선 + 사이클로트론, 견인 + DoT
 *   2. 재연결 (RECONNECTION, 5f) — 자기력선 강하게 깜빡 → 끊어짐 (정적), 폭발 좌표 잠금
 *   3. 폭발 (BURST,         30f) — 잠긴 적 위치마다 시안/마젠타 셀 분출 + 충격파, 광역 데미지
 *   4. 재형성 (REFORMING,   15f) — 폭발 셀 페이드 → 자동 stop()
 *
 * 좌표계 (메일스트롬/항성붕괴와 완전 동일, 개발서 규칙 4):
 *   - GLSL Filter → worldContainer (스크린 공간 후처리)
 *   - Graphics → overlayLayer (stage 직속, 스크린 좌표)
 *   - update(dt, cameraX, cameraY) 매 프레임 카메라 받음 → screenX/Y 계산
 *   - apply 오버라이드로 uTexSize에 실제 렌더 텍스처 크기 주입
 *
 * 위치 거동:
 *   - 충전 동안 캐릭터 위치 추적 (장판형)
 *   - 재연결 시점에 위치 잠금 + 폭발 좌표 캡처 (엔진이 setBurstPositions로 전달)
 *   - 사이클 끝(재형성 종료)에 자동 stop() → 다음 프레임 새 캐릭터 위치 새 사이클
 */

// ───────────────────────────────────────────────────────────────
//  GLSL 셰이더 — 양극성 자기장 왜곡 (회전 X — 메일스트롬과 차별)
// ───────────────────────────────────────────────────────────────

const MAGNETIC_FRAG = [
  'varying vec2 vTextureCoord;',
  'uniform sampler2D uSampler;',
  '',
  'uniform vec2 uCenter;',
  'uniform float uRadius;',
  'uniform float uStrength;', // 0~1, 페이즈에 따라 변화
  'uniform float uTime;',
  'uniform vec2 uTexSize;',
  '',
  'void main(void) {',
  '  vec2 pixCoord = vTextureCoord * uTexSize;',
  '  vec2 delta = pixCoord - uCenter;',
  '  float dist = length(delta);',
  '',
  '  if (uStrength <= 0.001 || dist > uRadius * 0.95) {',
  '    gl_FragColor = texture2D(uSampler, vTextureCoord);',
  '    return;',
  '  }',
  '',
  '  float r = uRadius * 0.95;',
  '  float t = clamp(dist / r, 0.0, 1.0);',
  '',
  '  // 양극성 렌즈 (회전 X — 정적, 항성붕괴와 비슷한 강도)',
  '  float warp = pow(max(t, 0.02), 0.45 + uStrength * 0.40);',
  '  vec2 dir = normalize(delta + vec2(0.0001));',
  '  vec2 warpedCoord = uCenter + dir * r * warp;',
  '  vec2 warpedUV = warpedCoord / uTexSize;',
  '  vec4 color = texture2D(uSampler, warpedUV);',
  '',
  '  // 안쪽 어두움 (영역 전체 어두워짐 — 외곽까지 darkness 적용해서 흰 원 방지)',
  '  // smoothstep range를 0~0.92로 늘려서 영역 가장자리만 부드럽게 페이드 아웃',
  '  float darkness = smoothstep(0.0, 0.92, t);',
  '  color.rgb *= mix(1.0, darkness, uStrength * 0.85);',
  '',
  '  // 양극 색 분할: 위(시안) ↔ 아래(마젠타)',
  '  float angle = atan(delta.y, delta.x);',
  '  float polarity = sin(angle); // -1(아래/마젠타) ~ 1(위/시안)',
  '  vec3 cyanCol = vec3(0.02, 0.71, 0.83);    // #06b6d4',
  '  vec3 magentaCol = vec3(0.85, 0.27, 0.94); // #d946ef',
  '  vec3 polarColor = mix(magentaCol, cyanCol, polarity * 0.5 + 0.5);',
  '',
  '  // 양극 fringe (가장자리 펄스 링) — 어두운 배경 위에 빛남',
  '  float ringDist = (t - 0.85) * 7.0;',
  '  float ring = exp(-(ringDist * ringDist));',
  '  float ringPulse = 0.7 + sin(uTime * 1.8) * 0.30;',
  '  color.rgb += polarColor * ring * 0.78 * ringPulse * uStrength;',
  '',
  '  // 안쪽 양극 글로우 (별의 표면 잔열 패턴 차용, 양극 색) — 더 강하게',
  '  float innerGlow = exp(-pow((t - 0.30) * 4.0, 2.0));',
  '  color.rgb += polarColor * innerGlow * 0.50 * uStrength;',
  '',
  '  // 중심 void (자기장 코어 — 검정에 가깝게, base 제거)',
  '  float voidMask = smoothstep(0.0, 0.22, t);',
  '  color.rgb *= mix(1.0, voidMask, uStrength * 0.90);',
  '',
  '  // ★ 가장자리 페이드: 모든 효과를 background로 lerp',
  '  // t < 0.65: 효과 100% / t > 0.92: 효과 0% → 가장 바깥 흰끼 사라짐',
  '  float effectStrength = 1.0 - smoothstep(0.65, 0.92, t);',
  '  vec4 bgColor = texture2D(uSampler, vTextureCoord);',
  '  gl_FragColor = mix(bgColor, color, effectStrength);',
  '}',
].join('\n');

// ───────────────────────────────────────────────────────────────
//  타입 정의
// ───────────────────────────────────────────────────────────────

const enum MagneticPhase {
  CHARGING = 0,
  RECONNECTION = 1,
  BURST = 2,
  REFORMING = 3,
}

/** 자기력선 타겟 — engine이 매 프레임 캐릭터 기준 로컬 좌표 전달 */
interface MagneticTarget {
  lx: number;
  ly: number;
  /** 휘어짐 방향 결정용 결정론적 시드 (적 인덱스 기반 ±1) */
  curveDir: number;
}

/** 사이클로트론 입자 — 적 주변을 회전 (자기장에 갇힌 하전입자) */
interface CyclotronParticle {
  /** 어느 적 인덱스(타겟 배열 인덱스) */
  targetIdx: number;
  angle: number;
  radius: number;
  /** 0=시안, 1=마젠타 */
  type: 0 | 1;
}

/** 폭발 셀 — 적 위치마다 다중 인스턴스 사방 분출 */
interface BurstParticle {
  /** 폭발 중심 좌표 (로컬, 컨테이너 = screen 기준) */
  cx: number;
  cy: number;
  /** 중심 기준 위치 */
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0=시안, 1=마젠타, 2=백열 */
  type: 0 | 1 | 2;
}

/** 충격파 — 폭발 중심마다 1발 */
interface Shockwave {
  cx: number;
  cy: number;
  progress: number;
}

// ───────────────────────────────────────────────────────────────
//  메인 클래스
// ───────────────────────────────────────────────────────────────

export class ElectricDarkEffect {
  private container: PIXI.Container;
  private worldContainer: PIXI.Container;
  /** ADD 블렌드 (글로우, 자기력선 외곽, 폭발 셀 글로우, 충격파) */
  private glowGfx: PIXI.Graphics;
  /** NORMAL 블렌드 (폭발 셀 본체, 사이클로트론 본체) */
  private cellGfx: PIXI.Graphics;
  /** NORMAL 블렌드 (자기력선 코어/심선, 백열 코어) */
  private coreGfx: PIXI.Graphics;
  /** GLSL 양극성 셰이더 */
  private filter: PIXI.Filter | null = null;

  active = false;
  /** 재연결 폭발 발동 순간 (엔진이 광역 데미지 처리에 사용) */
  burstFiredThisFrame = false;
  /** 잠긴 폭발 위치들 (월드 좌표) — engine이 데미지/넉백 처리 시 사용 */
  lockedBurstPositions: Array<{ x: number; y: number }> = [];

  readonly fieldRadius = 180;
  readonly burstRadiusEach = 80;

  // 월드/스크린 좌표
  private posX = 0;
  private posY = 0;
  private screenX = 0;
  private screenY = 0;

  // 페이즈 상태
  private phase: MagneticPhase = MagneticPhase.CHARGING;
  private phaseTimer = 0;
  private time = 0;

  // 페이즈 길이 (프레임)
  private readonly CHARGING_DURATION = 100;
  private readonly RECONNECTION_DURATION = 5;
  private readonly BURST_DURATION = 30;
  private readonly REFORMING_DURATION = 15;

  /** 자기력선 타겟 (engine이 매 프레임 갱신, 충전 페이즈 동안만 의미) */
  private magneticTargets: MagneticTarget[] = [];

  /** 사이클로트론 입자 — 활성 타겟 인덱스 기준 */
  private cyclotronParticles: CyclotronParticle[] = [];

  /** 폭발 셀 */
  private burstParticles: BurstParticle[] = [];

  /** 충격파 — 폭발 중심마다 */
  private shockwaves: Shockwave[] = [];

  /** 위치 잠금 (재연결 시점부터 폭발/재형성 끝까지) */
  private locked = false;

  // GLSL uStrength
  private uStrength = 0;

  // ── 색상 (양극성 — 백색 안 씀, 명확한 채도 유지) ──
  // 원칙: BRIGHT가 거의 흰색이면 안 됨 → 300번대까지가 한계
  private readonly COL_CYAN_MAIN     = 0x06b6d4; // cyan-500 (메인)
  private readonly COL_CYAN_GLOW     = 0x22d3ee; // cyan-400 (글로우 중)
  private readonly COL_CYAN_LIGHT    = 0x67e8f9; // cyan-300 (라이트)
  private readonly COL_CYAN_BRIGHT   = 0x67e8f9; // 가장 밝아도 cyan-300 (백색 방지)
  private readonly COL_MAGENTA_MAIN  = 0xd946ef; // fuchsia-500 (메인)
  private readonly COL_MAGENTA_GLOW  = 0xe879f9; // fuchsia-400 (글로우 중)
  private readonly COL_MAGENTA_LIGHT = 0xf0abfc; // fuchsia-300 (라이트)
  private readonly COL_MAGENTA_BRIGHT = 0xf0abfc; // 가장 밝아도 fuchsia-300 (백색 방지)
  private readonly COL_VIOLET        = 0xa78bfa; // violet-400 (양극 융합 톤, 더 진하게)

  constructor(screenLayer: PIXI.Container, worldContainer: PIXI.Container) {
    this.worldContainer = worldContainer;
    this.container = new PIXI.Container();
    screenLayer.addChild(this.container);

    // 글로우 (가장 아래, ADD)
    this.glowGfx = new PIXI.Graphics();
    this.glowGfx.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.glowGfx);

    // 셀 본체 (중간, NORMAL)
    this.cellGfx = new PIXI.Graphics();
    this.container.addChild(this.cellGfx);

    // 코어/심선 (위, NORMAL)
    this.coreGfx = new PIXI.Graphics();
    this.container.addChild(this.coreGfx);
  }

  start(x: number, y: number) {
    this.active = true;
    this.posX = x;
    this.posY = y;
    this.time = 0;
    this.phase = MagneticPhase.CHARGING;
    this.phaseTimer = 0;
    this.magneticTargets = [];
    this.cyclotronParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.lockedBurstPositions = [];
    this.locked = false;
    this.burstFiredThisFrame = false;
    this.uStrength = 0.2;
    this.container.visible = true;

    if (!this.filter) {
      this.filter = new PIXI.Filter(undefined, MAGNETIC_FRAG, {
        uCenter: [0, 0],
        uRadius: this.fieldRadius,
        uStrength: 0.2,
        uTime: 0,
        uTexSize: [CANVAS_W, CANVAS_H],
      });
      this.filter.padding = 0;

      // ★ apply 오버라이드 (개발서 규칙 4)
      const f = this.filter;
      f.apply = function (filterManager: any, input: any, output: any, clearMode: any) {
        if (input && input.width > 0) {
          f.uniforms.uTexSize = [input.width, input.height];
        }
        filterManager.applyFilter(f, input, output, clearMode);
      };
    }
    this.filter.uniforms.uRadius = this.fieldRadius;
    this.filter.uniforms.uStrength = 0.2;

    this.worldContainer.filterArea = new PIXI.Rectangle(0, 0, CANVAS_W, CANVAS_H);

    const existing = this.worldContainer.filters || [];
    if (!existing.includes(this.filter)) {
      this.worldContainer.filters = [...existing, this.filter];
    }
  }

  setPosition(x: number, y: number) {
    if (this.locked) return; // 재연결 후 잠금
    this.posX = x;
    this.posY = y;
  }

  /** engine이 매 프레임 호출 — 충전 페이즈 동안만 의미. 캐릭터 기준 로컬 좌표. */
  setMagneticTargets(targets: MagneticTarget[]) {
    if (this.phase === MagneticPhase.CHARGING) {
      this.magneticTargets = targets;
    }
  }

  /** 폭발 중심 좌표 (월드) */
  get centerX(): number { return this.posX; }
  get centerY(): number { return this.posY; }

  /** 충전 페이즈인지 (engine이 견인/DoT 처리에 사용) */
  get chargingActive(): boolean {
    return this.phase === MagneticPhase.CHARGING;
  }

  // ═══════════════════════════════════════════════════════════
  //  업데이트 (페이즈 상태머신)
  // ═══════════════════════════════════════════════════════════

  update(dt: number, cameraX: number, cameraY: number) {
    if (!this.active || !this.filter) return;
    this.time += dt;
    this.phaseTimer += dt;
    this.burstFiredThisFrame = false;

    // ★ 스크린 좌표 — 컨테이너 위치 + 셰이더 uCenter 모두 이 값
    this.screenX = this.posX - cameraX;
    this.screenY = this.posY - cameraY;
    this.container.position.set(this.screenX, this.screenY);

    this.filter.uniforms.uCenter = [this.screenX, this.screenY];
    this.filter.uniforms.uTime = this.time * 0.016;

    switch (this.phase) {
      case MagneticPhase.CHARGING:
        this.updateCharging(dt);
        if (this.phaseTimer >= this.CHARGING_DURATION) {
          this.phase = MagneticPhase.RECONNECTION;
          this.phaseTimer = 0;
        }
        break;

      case MagneticPhase.RECONNECTION:
        // 정적 — 자기력선만 강하게 빛남
        if (this.phaseTimer >= this.RECONNECTION_DURATION) {
          this.phase = MagneticPhase.BURST;
          this.phaseTimer = 0;
          // 폭발 좌표 잠금: magneticTargets의 각 적 위치를 월드 좌표로 캡처
          this.lockBurstPositions();
          // 자기력선/사이클로트론 입자 모두 소멸 (폭발에 휩쓸림)
          this.magneticTargets = [];
          this.cyclotronParticles = [];
          // 위치 잠금 (폭발이 그 자리에 머무름)
          this.locked = true;
          // 폭발 시각 발동
          this.spawnBurstAndShockwaves();
          // 엔진에 폭발 알림
          this.burstFiredThisFrame = true;
        }
        break;

      case MagneticPhase.BURST:
        this.updateBurstParticles(dt);
        if (this.phaseTimer >= this.BURST_DURATION) {
          this.phase = MagneticPhase.REFORMING;
          this.phaseTimer = 0;
        }
        break;

      case MagneticPhase.REFORMING:
        this.updateBurstParticles(dt); // 폭발 셀만 페이드
        if (this.phaseTimer >= this.REFORMING_DURATION) {
          // 사이클 종료: 자동 stop. engine이 다음 프레임 새 위치로 다시 start.
          this.stop();
          return;
        }
        break;
    }

    // uStrength 페이즈별
    this.updateUStrength();
    this.filter.uniforms.uStrength = this.uStrength;

    this.draw();
  }

  /** 페이즈에 따라 uStrength 변화 */
  private updateUStrength() {
    switch (this.phase) {
      case MagneticPhase.CHARGING: {
        // 0.2 → 1.0 (충전이 강해짐)
        const t = this.phaseTimer / this.CHARGING_DURATION;
        this.uStrength = 0.2 + t * 0.8;
        break;
      }
      case MagneticPhase.RECONNECTION:
        this.uStrength = 1.0;
        break;
      case MagneticPhase.BURST: {
        // 1.0 → 0 (자기장이 폭발과 함께 소멸)
        const t = this.phaseTimer / this.BURST_DURATION;
        this.uStrength = 1.0 - t;
        break;
      }
      case MagneticPhase.REFORMING:
        this.uStrength = 0;
        break;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 1 — 충전 (사이클로트론 입자 회전)
  // ───────────────────────────────────────────────────────────

  private updateCharging(dt: number) {
    // 사이클로트론 입자: 활성 타겟마다 2개 (시안 + 마젠타). 매 프레임 갱신.
    // (적 인덱스가 매 프레임 바뀔 수 있어 매 프레임 재구성)
    const desired = this.magneticTargets.length * 2;

    // 부족하면 추가
    while (this.cyclotronParticles.length < desired) {
      const idx = Math.floor(this.cyclotronParticles.length / 2);
      const isCyan = (this.cyclotronParticles.length % 2) === 0;
      this.cyclotronParticles.push({
        targetIdx: idx,
        angle: Math.random() * Math.PI * 2,
        radius: 9 + Math.random() * 5,
        type: isCyan ? 0 : 1,
      });
    }
    // 넘치면 제거
    if (this.cyclotronParticles.length > desired) {
      this.cyclotronParticles.length = desired;
    }

    // 매 프레임 회전 (안쪽 빠름 흉내 — 단, 적 단위라 단순화)
    for (const p of this.cyclotronParticles) {
      p.angle += 0.15 * dt;
    }
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 2 → 3 전환: 폭발 좌표 잠금 + 셀/충격파 생성
  // ───────────────────────────────────────────────────────────

  /** 재연결 시점에 활성 타겟 위치를 월드 좌표로 캡처 (폴 재사용 방어 — 좌표 고정) */
  private lockBurstPositions() {
    this.lockedBurstPositions = this.magneticTargets.map((t) => ({
      x: this.posX + t.lx,
      y: this.posY + t.ly,
    }));
  }

  private spawnBurstAndShockwaves() {
    // 각 폭발 위치마다 셀 + 충격파
    // 컨테이너 = screen 좌표(잠긴 posX/Y - cameraX/Y), 셀은 컨테이너 로컬 좌표
    // 폭발 위치를 컨테이너 기준 로컬로 변환
    const cellsPerBurst = 25;

    for (const burst of this.lockedBurstPositions) {
      // 컨테이너 기준 로컬 좌표 (잠긴 posX/Y가 컨테이너 위치)
      const cx = burst.x - this.posX;
      const cy = burst.y - this.posY;

      // 충격파 1발
      this.shockwaves.push({ cx, cy, progress: 0 });

      // 셀 사방 분출
      for (let i = 0; i < cellsPerBurst; i++) {
        const angle = (i / cellsPerBurst) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
        const speed = 4 + Math.random() * 5;

        const r = Math.random();
        let type: 0 | 1 | 2;
        let size: number;
        let maxLife: number;
        if (r < 0.30) {
          type = 2; // 백열 코어
          size = 1.0 + Math.random() * 1.5;
          maxLife = 18 + Math.random() * 10;
        } else if (r < 0.65) {
          type = 0; // 시안
          size = 1.5 + Math.random() * 1.5;
          maxLife = 22 + Math.random() * 14;
        } else {
          type = 1; // 마젠타
          size = 1.5 + Math.random() * 1.5;
          maxLife = 22 + Math.random() * 14;
        }

        const startDist = 4 + Math.random() * 4;
        this.burstParticles.push({
          cx,
          cy,
          x: cx + Math.cos(angle) * startDist,
          y: cy + Math.sin(angle) * startDist,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife,
          size,
          type,
        });
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  //  Phase 3/4 — 폭발 셀 + 충격파 업데이트
  // ───────────────────────────────────────────────────────────

  private updateBurstParticles(dt: number) {
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        swapPop(this.burstParticles, i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = 0.93;
      p.vx *= drag;
      p.vy *= drag;
    }

    for (const sw of this.shockwaves) {
      sw.progress += dt / 25;
    }
    // 끝난 충격파 정리
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      if (this.shockwaves[i].progress >= 1.0) {
        swapPop(this.shockwaves, i);
      }
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
      case MagneticPhase.CHARGING:
        this.drawCenterCore();
        this.drawMagneticFieldLines(false);
        this.drawCyclotron();
        break;
      case MagneticPhase.RECONNECTION:
        this.drawCenterCore();
        this.drawMagneticFieldLines(true); // 강하게
        this.drawCyclotron();
        break;
      case MagneticPhase.BURST:
        this.drawBurst();
        this.drawShockwaves();
        break;
      case MagneticPhase.REFORMING:
        this.drawBurst();
        // 충격파는 사이즈에 따라 자연히 사라짐
        this.drawShockwaves();
        break;
    }
  }

  // ── 중심 코어 (양극 글로우 + 양극 라이트 코어) ──
  private drawCenterCore() {
    const pulse = 0.85 + Math.sin(this.time * 0.10) * 0.15;

    // 시안 글로우 (위) — 더 진하게
    this.glowGfx.beginFill(this.COL_CYAN_MAIN, 0.42 * pulse);
    this.glowGfx.drawCircle(0, -3, 14);
    this.glowGfx.endFill();

    // 마젠타 글로우 (아래)
    this.glowGfx.beginFill(this.COL_MAGENTA_MAIN, 0.42 * pulse);
    this.glowGfx.drawCircle(0, 3, 14);
    this.glowGfx.endFill();

    // 양극 라이트 코어 (시안 위 + 마젠타 아래 작은 원)
    this.coreGfx.beginFill(this.COL_CYAN_BRIGHT, 0.85 * pulse);
    this.coreGfx.drawCircle(0, -1.5, 2.2);
    this.coreGfx.endFill();

    this.coreGfx.beginFill(this.COL_MAGENTA_BRIGHT, 0.85 * pulse);
    this.coreGfx.drawCircle(0, 1.5, 2.2);
    this.coreGfx.endFill();

    // 양극 융합 보라 한 점 (자기장의 N/S 만남 지점)
    this.coreGfx.beginFill(this.COL_VIOLET, 0.92 * pulse);
    this.coreGfx.drawCircle(0, 0, 1.4);
    this.coreGfx.endFill();
  }

  // ── 자기력선 호 (캐릭터 → 적, 곡선) ──
  private drawMagneticFieldLines(reconnecting: boolean) {
    if (this.magneticTargets.length === 0) return;

    // 충전 진행률 (호흡 빈도에 영향)
    const chargeProgress = this.phase === MagneticPhase.CHARGING
      ? this.phaseTimer / this.CHARGING_DURATION
      : 1.0;

    // sin 호흡 — 충전 후반부일수록 빨라짐
    const breatheRate = 0.10 + chargeProgress * 0.15;
    const breatheBase = reconnecting ? 1.0 : 0.55 + chargeProgress * 0.20;
    const breatheAmp = reconnecting ? 0.0 : 0.25;
    const breathe = breatheBase + Math.sin(this.time * breatheRate) * breatheAmp;

    // 두께 배율 (재연결 순간 1.5x)
    const thickMul = reconnecting ? 1.5 : 1.0;
    const alphaMul = reconnecting ? 1.0 : 1.0;

    for (const target of this.magneticTargets) {
      const dx = target.lx;
      const dy = target.ly;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) continue;

      // 곡선 segments — perpendicular sin 변위
      const segs = 8;
      // 휘어짐 진폭: 거리 비례 (가까울수록 작은 휘어짐)
      const curveAmp = Math.min(dist * 0.18, 35) * target.curveDir;
      const perpX = -dy / dist;
      const perpY = dx / dist;

      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        // 직선 보간 + 수직 sin 변위 (양 끝 0, 중앙 최대 — sin(t*π))
        const sinBow = Math.sin(t * Math.PI);
        const offset = curveAmp * sinBow;
        pts.push({
          x: dx * t + perpX * offset,
          y: dy * t + perpY * offset,
        });
      }

      // 4패스 라인
      // 1. 외곽 글로우 시안 (ADD)
      this.glowGfx.lineStyle(5.0 * thickMul, this.COL_CYAN_MAIN, 0.35 * breathe * alphaMul);
      this.glowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.glowGfx.lineTo(pts[i].x, pts[i].y);

      // 2. 글로우 마젠타 (ADD)
      this.glowGfx.lineStyle(3.0 * thickMul, this.COL_MAGENTA_MAIN, 0.45 * breathe * alphaMul);
      this.glowGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.glowGfx.lineTo(pts[i].x, pts[i].y);

      // 3. 코어 시안 라이트 (NORMAL)
      this.coreGfx.lineStyle(1.4 * thickMul, this.COL_CYAN_BRIGHT, 0.82 * breathe * alphaMul);
      this.coreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.coreGfx.lineTo(pts[i].x, pts[i].y);

      // 4. 심선 — target.curveDir에 따라 시안/마젠타 교차 (양극 표현)
      const sinewColor = target.curveDir > 0 ? this.COL_CYAN_BRIGHT : this.COL_MAGENTA_BRIGHT;
      this.coreGfx.lineStyle(0.5 * thickMul, sinewColor, 0.95 * breathe * alphaMul);
      this.coreGfx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.coreGfx.lineTo(pts[i].x, pts[i].y);

      // 적 위치에 양극 코어 (시안 + 마젠타 작은 두 점, 가운데 보라 융합)
      this.coreGfx.lineStyle(0);
      this.coreGfx.beginFill(this.COL_CYAN_BRIGHT, 0.85 * breathe);
      this.coreGfx.drawCircle(dx - 1.0, dy - 1.0, 1.6 * thickMul);
      this.coreGfx.endFill();
      this.coreGfx.beginFill(this.COL_MAGENTA_BRIGHT, 0.85 * breathe);
      this.coreGfx.drawCircle(dx + 1.0, dy + 1.0, 1.6 * thickMul);
      this.coreGfx.endFill();
      this.coreGfx.beginFill(this.COL_VIOLET, 0.92 * breathe);
      this.coreGfx.drawCircle(dx, dy, 1.2 * thickMul);
      this.coreGfx.endFill();

      // 적 위치 양극 글로우
      this.glowGfx.beginFill(this.COL_CYAN_GLOW, 0.50 * breathe);
      this.glowGfx.drawCircle(dx, dy, 5.5 * thickMul);
      this.glowGfx.endFill();
      this.glowGfx.beginFill(this.COL_MAGENTA_GLOW, 0.40 * breathe);
      this.glowGfx.drawCircle(dx, dy, 4.0 * thickMul);
      this.glowGfx.endFill();
    }
    this.glowGfx.lineStyle(0);
    this.coreGfx.lineStyle(0);
  }

  // ── 사이클로트론 입자 (적 주변 회전) ──
  private drawCyclotron() {
    if (this.cyclotronParticles.length === 0 || this.magneticTargets.length === 0) return;

    for (const p of this.cyclotronParticles) {
      const target = this.magneticTargets[p.targetIdx];
      if (!target) continue;

      const ex = target.lx + Math.cos(p.angle) * p.radius;
      const ey = target.ly + Math.sin(p.angle) * p.radius;

      const color = p.type === 0 ? this.COL_CYAN_MAIN : this.COL_MAGENTA_MAIN;
      const glowColor = p.type === 0 ? this.COL_CYAN_GLOW : this.COL_MAGENTA_GLOW;

      // 글로우
      this.glowGfx.beginFill(glowColor, 0.55);
      this.glowGfx.drawCircle(ex, ey, 2.5);
      this.glowGfx.endFill();

      // 본체
      this.cellGfx.beginFill(color, 0.85);
      this.cellGfx.drawCircle(ex, ey, 1.2);
      this.cellGfx.endFill();
    }
  }

  // ── 폭발 셀 ──
  private drawBurst() {
    this.cellGfx.lineStyle(0);

    for (const p of this.burstParticles) {
      const lifeFrac = p.life / p.maxLife;
      // 사이즈 펄스: 빨리 커졌다가 천천히 줄어듦
      const sizePhase = lifeFrac < 0.20
        ? 1 + lifeFrac * 1.3
        : 1.26 - (lifeFrac - 0.20) * 0.5;
      const r = p.size * sizePhase;

      let color: number;
      let glowColor: number;
      let alpha: number;
      let glowAlpha: number;
      let glowMul: number;

      if (p.type === 0) {
        // 시안
        color = this.COL_CYAN_MAIN;
        glowColor = this.COL_CYAN_GLOW;
        alpha = (1 - lifeFrac * 0.35) * 0.92;
        glowAlpha = (1 - lifeFrac) * 0.55;
        glowMul = 2.6;
      } else if (p.type === 1) {
        // 마젠타
        color = this.COL_MAGENTA_MAIN;
        glowColor = this.COL_MAGENTA_GLOW;
        alpha = (1 - lifeFrac * 0.35) * 0.92;
        glowAlpha = (1 - lifeFrac) * 0.55;
        glowMul = 2.6;
      } else {
        // ★ 임팩트 코어 — 백색 대신 양극 라이트 (vx 부호로 시안/마젠타 결정)
        const isCyanSide = p.vx > 0;
        color = isCyanSide ? this.COL_CYAN_BRIGHT : this.COL_MAGENTA_BRIGHT;
        glowColor = isCyanSide ? this.COL_CYAN_LIGHT : this.COL_MAGENTA_LIGHT;
        alpha = (1 - lifeFrac * 0.50) * 0.96;
        glowAlpha = (1 - lifeFrac) * 0.70;
        glowMul = 3.2;
      }

      // 글로우
      this.glowGfx.beginFill(glowColor, glowAlpha);
      this.glowGfx.drawCircle(p.x, p.y, r * glowMul);
      this.glowGfx.endFill();

      // 본체
      this.cellGfx.beginFill(color, alpha);
      this.cellGfx.drawCircle(p.x, p.y, r);
      this.cellGfx.endFill();

      // 임팩트 코어는 보라 융합 점 추가 (양극 합쳐진 강조)
      if (p.type === 2 && lifeFrac < 0.4) {
        const sparkA = (1 - lifeFrac / 0.4) * 0.90;
        this.coreGfx.beginFill(this.COL_VIOLET, sparkA);
        this.coreGfx.drawCircle(p.x, p.y, r * 0.45);
        this.coreGfx.endFill();
      }
    }
  }

  // ── 충격파 ──
  private drawShockwaves() {
    for (const sw of this.shockwaves) {
      if (sw.progress >= 1) continue;

      const p = sw.progress;
      // 빠르게 팽창 (15%까지 60%, 이후 천천히 100%)
      const radiusFrac = p < 0.15
        ? (p / 0.15) * 0.60
        : 0.60 + ((p - 0.15) / 0.85) * 0.40;
      const r = radiusFrac * this.burstRadiusEach;

      const fade = (1 - p) * (1 - p);

      // 4겹 양극 (백색 X — 시안/마젠타 + 라이트 톤)
      this.glowGfx.lineStyle(14 * (1 - p * 0.35), this.COL_CYAN_MAIN, fade * 0.50);
      this.glowGfx.drawCircle(sw.cx, sw.cy, r);

      this.glowGfx.lineStyle(9 * (1 - p * 0.30), this.COL_MAGENTA_MAIN, fade * 0.60);
      this.glowGfx.drawCircle(sw.cx, sw.cy, r);

      this.glowGfx.lineStyle(5 * (1 - p * 0.25), this.COL_CYAN_BRIGHT, fade * 0.78);
      this.glowGfx.drawCircle(sw.cx, sw.cy, r);

      this.glowGfx.lineStyle(1.6, this.COL_MAGENTA_BRIGHT, fade * 0.92);
      this.glowGfx.drawCircle(sw.cx, sw.cy, r);
    }
    this.glowGfx.lineStyle(0);
  }

  // ═══════════════════════════════════════════════════════════
  //  정리
  // ═══════════════════════════════════════════════════════════

  stop() {
    this.active = false;
    this.container.visible = false;
    this.magneticTargets = [];
    this.cyclotronParticles = [];
    this.burstParticles = [];
    this.shockwaves = [];
    this.lockedBurstPositions = [];
    this.locked = false;
    this.uStrength = 0;
    this.glowGfx.clear();
    this.cellGfx.clear();
    this.coreGfx.clear();

    if (this.filter && this.worldContainer.filters) {
      this.worldContainer.filters = this.worldContainer.filters.filter((f) => f !== this.filter);
      if (this.worldContainer.filters.length === 0) {
        this.worldContainer.filters = null;
        this.worldContainer.filterArea = null as any;
      }
    }
  }

  destroy() {
    this.stop();
    if (this.filter) {
      this.filter.destroy();
      this.filter = null;
    }
    this.container.destroy({ children: true });
  }
}
