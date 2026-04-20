import * as PIXI from 'pixi.js';
import {
  GameState, ElementType, EnemyType, ALL_ELEMENTS, CANVAS_W, CANVAS_H,
  WORLD_W, WORLD_H, PLAYER_SPEED, PLAYER_WIDTH, PLAYER_HEIGHT,
  INVINCIBLE_FRAMES, WAVE_DURATION, AUTO_ATTACK_INTERVAL,
  ELEMENT_ORB_DROP_CHANCE, WeaponEffectState,
  LevelEvent, LevelEventResolution,
  isBossType, BOSS_TO_ELEMENT, SkillId,
  EnemyState, EnemyProjectileState, PlayerState,
} from './types';
import { rollStatChoices, applyStatChoice } from './levelup/upgrades';
import {
  createPlayer, createEnemyPool, createProjectilePool, createEnemyProjectilePool,
  createXPOrbPool, createElementOrbPool, updateEnemies, updateProjectiles,
  updateXPOrbs, updateElementOrbs, fireProjectile, spawnXPOrb, spawnRandomElementOrb,
  spawnEnemy,
} from './entities';
import { SpatialHash, checkProjectileEnemyCollisions, checkPlayerEnemyCollisions, checkWeaponEffectEnemyCollisions } from './collision';
import { createParticlePool, updateParticles, spawnExplosionParticles, spawnHitParticles, spawnLevelUpParticles } from './particles';
import { spawnWaveEnemies, getMaxEnemies } from './spawner';
import { getWeaponForElements, activateAllWeapons, updateWeaponEffects } from './weapons';
import {
  createGameGraphics, drawGround, drawPlayer, createPlayerSprite, drawEnemies,
  drawProjectiles, drawXPOrbs, drawElementOrbs, drawParticles, drawWeaponEffects,
  drawEnemyProjectiles, drawPlayerBars,
  createParticleRenderer, ParticleRenderState,
  updateCamera, applyCamera,
} from './renderer';
import {
  UIElements, createUI, updateUI,
  GameOverOverlay, createGameOverOverlay, showGameOver,
  DevPanel, createDevPanel,
} from './ui';
import { EffectManager } from './effects/EffectManager';
import { TidalWaveSkill } from './effects/TidalWaveSkill';
import { InfernoSkill } from './effects/InfernoSkill';
import { EarthquakeSkill } from './effects/EarthquakeSkill';
import { ThunderStormSkill } from './effects/ThunderStormSkill';
import { LightJudgmentSkill } from './effects/LightJudgmentSkill';
import { AbyssSkill } from './effects/AbyssSkill';

export class GameEngine {
  app: PIXI.Application;
  state!: GameState;
  keys: Set<string> = new Set();
  spatialHash: SpatialHash = new SpatialHash();
  destroyed = false;

  // 슬롯 변경 시에만 무효화되는 activeEffects Set 캐시 (매 프레임 재계산 회피)
  private _activeEffectsCache: Set<string> | null = null;
  private _activeEffectsDirty = true;

  // 보스 큐 — 9슬롯 완성 후 Lv 10배수마다 순서대로 등장
  private _bossQueue: EnemyType[] = ['boss_water', 'boss_fire', 'boss_earth', 'boss_electric', 'boss_light', 'boss_dark'];
  private _bossQueueIndex = 0;

  // 액티브 스킬 이펙트
  private tidalWaveSkill!: TidalWaveSkill;
  private infernoSkill!: InfernoSkill;
  private earthquakeSkill!: EarthquakeSkill;
  private thunderStormSkill!: ThunderStormSkill;
  private lightJudgmentSkill!: LightJudgmentSkill;
  private abyssSkill!: AbyssSkill;

  // Graphics references
  private worldContainer!: PIXI.Container;
  private uiContainer!: PIXI.Container;
  private groundGfx!: PIXI.Graphics;
  private playerGfx!: PIXI.Sprite;
  private enemyGfx: PIXI.Graphics[] = [];
  private projGfx: PIXI.Graphics[] = [];
  private orbGfx: PIXI.Graphics[] = [];
  private elementOrbGfx: PIXI.Graphics[] = [];
  private particleRenderer!: ParticleRenderState;
  private effectGfx: PIXI.Graphics[] = [];
  private enemyProjectileGfx!: PIXI.Graphics;
  private playerBarsGfx!: PIXI.Graphics;
  private entityLayer!: PIXI.Container;
  private effectLayer!: PIXI.Container;
  private particleLayer!: PIXI.Container;
  private playerLayer!: PIXI.Container;

  private ui!: UIElements;
  private gameOverOverlay!: GameOverOverlay;
  private isDark = false; // 항상 false — 게임은 화이트모드 고정
  private devMode: boolean;
  private devPanel!: DevPanel;
  private _waterCooldown = 0;
  private _electricTimer = 0;
  /** 1단계 전기 / 빛+전기 체인 노드: enemyIdx + 마지막 안전 좌표. enemies 풀 재사용 방어. */
  private _electricChainNodes: Array<{ enemyIdx: number; lastX: number; lastY: number }> = [];
  /** 단일 전기(s1:전기) 전용 타이머 — 콤보가 _electricTimer를 리셋해도 단일 체인은 독립 구동 */
  private _electricSingleTimer = 0;
  private _electricSingleChainNodes: Array<{ enemyIdx: number; lastX: number; lastY: number }> = [];
  private _waterElectricStrikeTimer = 0;
  private _electricUltimateActive = false;
  private _electricUltimateBurstTimer = 0;
  /** 전기 AAA 사방 체인 노드: 그룹별 [캐릭터, 적1, 적2, ...] enemyIdx + lastX/Y. 풀 재사용 방어. */
  private _electricUltimateChainGroups: Array<Array<{ enemyIdx: number; lastX: number; lastY: number }>> = [];
  private _fireUltimateActive = false;
  private _waterUltimateActive = false;
  private _lightUltimateActive = false;
  /** 빛 AAA 캐스케이드 큐 — 한 볼리 시작 시 채워지고, 매 프레임 1발씩 pop해서 발사. */
  private _lightUltimateVolleyQueue: Array<{ enemyIdx: number }> = [];
  /** 빛 AAA 다음 볼리까지 쿨다운 (큐가 비었을 때만 카운트다운) */
  private _lightUltimateVolleyCooldown = 0;
  /** 빛 AAA 발사체 boltId → 추적 enemyIdx + lastX/Y. 풀 재사용 방어. */
  private _lightUltimateBoltMap: Map<number, { enemyIdx: number; lastX: number; lastY: number }> = new Map();
  private _darkPlaced = false;
  private _darkPosX = 0;
  private _darkPosY = 0;
  /** 단일 암흑(s1:암흑) 전용 설치 상태 — 콤보의 _darkPlaced 리셋과 독립 */
  private _darkSinglePlaced = false;
  private _darkSinglePosX = 0;
  private _darkSinglePosY = 0;
  private _darkUltimatePlaced = false;
  private _darkUltimatePosX = 0;
  private _darkUltimatePosY = 0;
  private _waterDarkPlaced = false;
  private _waterDarkPosX = 0;
  private _waterDarkPosY = 0;
  /** 물+전기+암흑 (흑뢰 토네이도) — 설치형 */
  private _waterElectricDarkPlaced = false;
  private _waterElectricDarkPosX = 0;
  private _waterElectricDarkPosY = 0;
  /** 물+흙+빛 (사구아로 선인장) — 설치형 */
  private _waterEarthLightPlaced = false;
  private _waterEarthLightPosX = 0;
  private _waterEarthLightPosY = 0;
  /** 물+불 화상 DoT: 적 인덱스 → 남은 프레임 (60→0) */
  private _steamBurnTargets = new Map<number, number>();
  /** 불+암흑 화상 DoT: 적 인덱스 → 남은 프레임 (60→0) */
  private _stellarBurnTargets = new Map<number, number>();
  /** 불+전기 체인 봄버 — 다음 체인 발사까지 쿨다운 카운터 */
  private _fireElectricTimer = 0;
  /** 불+전기 체인 노드: enemyIdx + 마지막 안전 좌표. enemies 풀 재사용 방어용. */
  private _fireElectricChainNodes: Array<{ enemyIdx: number; lastX: number; lastY: number }> = [];
  /** 불+전기 폭발 예약: 생성 시점 좌표 고정 (적 추적 X). timer가 0이 되면 폭발 트리거. */
  private _fireElectricPendingExplosions: Array<{ lastX: number; lastY: number; timer: number }> = [];
  /** 크리스탈 뇌격 — 다음 파동 펄스까지 쿨다운 카운터 */
  private _crystalPulseTimer = 0;
  /** 불+전기+암흑 연쇄 폭뢰 — 다분기 체인 상태 */
  private _fedCooldown = 0;
  private _fedPending: Array<{ idx: number; x: number; y: number; timer: number }> = [];
  private _fedUsed = new Set<number>();
  /** 빛+전기+암흑 (심연 진동) — 엔진은 상태 없음, 이펙트가 사이클 관리 */

  private effectManager!: EffectManager;

  // Mobile joystick
  private joystickActive = false;
  private joystickStartX = 0;
  private joystickStartY = 0;
  private joystickDX = 0;
  private joystickDY = 0;
  private joystickContainer!: PIXI.Container;
  private joystickBg!: PIXI.Graphics;
  private joystickKnob!: PIXI.Graphics;
  private isMobile = false;

  // Player facing
  private facingX = 1;
  private facingY = 0;

  constructor(options: { devMode?: boolean } = {}) {
    this.devMode = options.devMode ?? false;
    this.app = new PIXI.Application({
      width: CANVAS_W,
      height: CANVAS_H,
      backgroundColor: 0x2A2318,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
  }

  init(container: HTMLDivElement) {
    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    // 모바일 가로모드 기준 16:9 (CANVAS_W:CANVAS_H 동기화)
    canvas.style.aspectRatio = `${CANVAS_W} / ${CANVAS_H}`;
    canvas.style.maxWidth = '960px';
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.borderRadius = '8px';
    container.appendChild(canvas);

    this.isMobile = 'ontouchstart' in window;
    // 게임은 항상 화이트모드 고정 (다크모드 무시)
    this.isDark = false;

    this.setupState();
    this.setupGraphics();
    this.setupInput();
    this.app.ticker.add(this.gameLoop);
  }

  private setupState() {
    this.state = {
      player: createPlayer(),
      enemies: createEnemyPool(800),
      projectiles: createProjectilePool(100),
      enemyProjectiles: createEnemyProjectilePool(120),
      xpOrbs: createXPOrbPool(),
      elementOrbs: createElementOrbPool(),
      particles: createParticlePool(),
      wave: 1,
      waveTimer: WAVE_DURATION,
      frameCount: 0,
      autoAttackTimer: 0,
      paused: false,
      gameOver: false,
      cameraX: 0,
      cameraY: 0,
      shakeX: 0,
      shakeY: 0,
      shakeFrames: 0,
      waveAnnounceTimer: 90,
      comboDisplayTimer: 0,
      comboDisplayCount: 0,
      weaponEffects: [],
      beamAngles: [0, 0, 0],
      levelUpTextTimer: 0,
      pendingLevelEvent: null,
    };
  }

  // ── 레벨업 이벤트 구독 (React 오버레이 전용) ──
  onLevelEvent: ((event: LevelEvent) => void) | null = null;

  private setupGraphics() {
    const { worldContainer, uiContainer, groundLayer, entityLayer, effectLayer, particleLayer, playerLayer, overlayLayer } =
      createGameGraphics(this.app.stage);
    this.worldContainer = worldContainer;
    this.uiContainer = uiContainer;
    this.entityLayer = entityLayer;
    this.effectLayer = effectLayer;
    this.particleLayer = particleLayer;
    this.playerLayer = playerLayer;

    // Ground
    this.groundGfx = new PIXI.Graphics();
    drawGround(this.groundGfx, this.isDark);
    groundLayer.addChild(this.groundGfx);

    // Player — 전용 최상위 레이어 (overlayLayer 위) — atom1~4.webp 스프라이트
    this.playerGfx = createPlayerSprite();
    playerLayer.addChild(this.playerGfx);

    // 파티클 — ParticleContainer 배치 렌더 (500 → 1 draw call)
    this.particleRenderer = createParticleRenderer(particleLayer, this.app.renderer, this.state.particles.length);

    // 스킬 이펙트 — 개발서 규칙 4/7 준수 (Graphics → overlayLayer, GLSL → groundLayer)
    this.tidalWaveSkill = new TidalWaveSkill(overlayLayer, groundLayer);
    this.infernoSkill = new InfernoSkill(overlayLayer, groundLayer);
    this.earthquakeSkill = new EarthquakeSkill(overlayLayer, groundLayer);
    this.thunderStormSkill = new ThunderStormSkill(overlayLayer, groundLayer);
    this.lightJudgmentSkill = new LightJudgmentSkill(overlayLayer, groundLayer);
    // 심연 — 중력 렌즈를 worldContainer 전체에 적용 (BigBang 패턴, 적/이펙트까지 시각 왜곡)
    this.abyssSkill = new AbyssSkill(overlayLayer, worldContainer);

    // 적 투사체 그래픽 (단일 Graphics로 모든 투사체 통합 렌더)
    this.enemyProjectileGfx = new PIXI.Graphics();
    effectLayer.addChild(this.enemyProjectileGfx);

    // Player HP/XP 바 — 플레이어 레이어(최상위)에 추가
    this.playerBarsGfx = new PIXI.Graphics();
    playerLayer.addChild(this.playerBarsGfx);

    // UI
    this.ui = createUI(uiContainer);
    this.gameOverOverlay = createGameOverOverlay(uiContainer);

    // Mobile joystick
    if (this.isMobile) {
      this.setupJoystick();
    }

    // 이펙트 매니저
    // - effectLayer: 일반 PIXI Graphics 이펙트
    // - groundLayer: GLSL Filter target (background만 filter 영향, 캐릭터/몬스터/이펙트는 위에 있어 안 가려짐)
    // - overlayLayer: 스크린 좌표 이펙트 (카메라 변환 안 받음)
    this.effectManager = new EffectManager(effectLayer, groundLayer, overlayLayer, this.app.renderer as PIXI.Renderer);

    // uiContainer 참조 저장 — P 키로 런타임 dev 모드 활성화 시 패널 생성용
    this._uiContainerRef = uiContainer;

    // Dev panel (?test=1 URL로 시작된 경우)
    if (this.devMode) {
      this.enableDevMode();
    }
  }

  private _uiContainerRef!: PIXI.Container;

  /** URL/키 어느 쪽으로든 dev 모드 활성화 (idempotent) */
  private enableDevMode() {
    this.devMode = true;
    // 1) DEV 패널 생성 (이미 있으면 스킵)
    if (!this.devPanel) {
      this.devPanel = createDevPanel(
        this._uiContainerRef,
        (element: ElementType) => this.addElementToSlot(element),
        () => this.devClearSlots(),
        () => this.devFillAll(),
        () => this.devSpawnNextBoss(),
        () => this.devKillAllBosses(),
      );
    }
    // 2) 모든 액티브 스킬 해금 (1~6 키 즉시 사용)
    const skills = this.state.player.skills;
    for (const key of Object.keys(skills) as SkillId[]) {
      skills[key].unlocked = true;
      skills[key].cooldown = 0;
    }
    // 3) 9슬롯 전부 채우기 (무기 콤보 전부 완성)
    this.devFillAll();
    console.info('[dev] test mode activated — all skills unlocked, all slots filled');
  }

  private setupJoystick() {
    this.joystickContainer = new PIXI.Container();
    this.joystickContainer.visible = false;

    this.joystickBg = new PIXI.Graphics();
    this.joystickBg.beginFill(0xFFFFFF, 0.15);
    this.joystickBg.drawCircle(0, 0, 50);
    this.joystickBg.endFill();
    this.joystickBg.lineStyle(2, 0xFFFFFF, 0.3);
    this.joystickBg.drawCircle(0, 0, 50);

    this.joystickKnob = new PIXI.Graphics();
    this.joystickKnob.beginFill(0xFFFFFF, 0.4);
    this.joystickKnob.drawCircle(0, 0, 20);
    this.joystickKnob.endFill();

    this.joystickContainer.addChild(this.joystickBg, this.joystickKnob);
    this.uiContainer.addChild(this.joystickContainer);

    const canvas = this.app.view as HTMLCanvasElement;
    canvas.addEventListener('touchstart', (e) => {
      if (this.state.paused || this.state.gameOver) return;
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const x = ((touch.clientX - rect.left) / rect.width) * CANVAS_W;
      const y = ((touch.clientY - rect.top) / rect.height) * CANVAS_H;
      // Only activate in bottom-left quadrant
      if (x < CANVAS_W * 0.5 && y > CANVAS_H * 0.4) {
        this.joystickActive = true;
        this.joystickStartX = x;
        this.joystickStartY = y;
        this.joystickContainer.visible = true;
        this.joystickContainer.x = x;
        this.joystickContainer.y = y;
        this.joystickKnob.x = 0;
        this.joystickKnob.y = 0;
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!this.joystickActive) return;
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const x = ((touch.clientX - rect.left) / rect.width) * CANVAS_W;
      const y = ((touch.clientY - rect.top) / rect.height) * CANVAS_H;
      let dx = x - this.joystickStartX;
      let dy = y - this.joystickStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 50;
      if (dist > maxDist) {
        dx = (dx / dist) * maxDist;
        dy = (dy / dist) * maxDist;
      }
      this.joystickDX = dx / maxDist;
      this.joystickDY = dy / maxDist;
      this.joystickKnob.x = dx;
      this.joystickKnob.y = dy;
      e.preventDefault();
    }, { passive: false });

    const endJoystick = () => {
      this.joystickActive = false;
      this.joystickDX = 0;
      this.joystickDY = 0;
      this.joystickContainer.visible = false;
    };
    canvas.addEventListener('touchend', endJoystick);
    canvas.addEventListener('touchcancel', endJoystick);
  }

  private setupInput() {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      this.keys.add(key);

      // 액티브 스킬 발동 (1~6)
      if (key === '1') this.tryFireSkill('water_tidal');
      else if (key === '2') this.tryFireSkill('fire_inferno');
      else if (key === '3') this.tryFireSkill('earth_quake');
      else if (key === '4') this.tryFireSkill('electric_storm');
      else if (key === '5') this.tryFireSkill('light_judgment');
      else if (key === '6') this.tryFireSkill('dark_abyss');

      // P — 테스트 모드 전체 활성화 (URL 없이도 키 하나로 dev 모드 ON)
      else if (key === 'p') this.enableDevMode();
      // DEV 전용 핫키 (dev 모드에서만)
      else if (this.devMode && key === 'n') this.devSpawnNextBoss();
      else if (this.devMode && key === 'k') this.devKillAllBosses();
      else if (this.devMode && key === 'l') this.devLevelUp();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Store for cleanup
    this._keyDown = onKeyDown;
    this._keyUp = onKeyUp;
  }

  private _keyDown!: (e: KeyboardEvent) => void;
  private _keyUp!: (e: KeyboardEvent) => void;

  private gameLoop = () => {
    if (this.destroyed) return;
    if (this.state.gameOver) return;
    if (this.state.paused) {
      this.render();
      return;
    }

    this.state.frameCount++;
    this.updatePlayer();
    this.updateWave();
    spawnWaveEnemies(this.state);
    updateEnemies(this.state.enemies, this.state.player.x, this.state.player.y);
    this.updateBossBehavior();
    this.autoAttack();
    activateAllWeapons(this.state);
    updateWeaponEffects(this.state);
    updateProjectiles(this.state.projectiles);
    this.updateEnemyProjectiles();
    // DEV: XP 오브/원소 오브 업데이트 제거
    // updateXPOrbs(this.state.xpOrbs, this.state.player);
    // this.handleElementOrbPickup();
    updateParticles(this.state.particles);
    this.handleCollisions();
    this.checkLevelUp();
    this.updateCombo();
    this.updateLevelUpText();
    this.updateSkills();
    updateCamera(this.state);
    // 카메라 업데이트 후 이펙트 갱신 (GLSL 필터와 Graphics 좌표 동기화)
    this.effectManager.updateCamera(this.state.cameraX, this.state.cameraY);
    this.effectManager.update(1);
    this.updateElementEffects();
    this.render();
  };

  // ── 액티브 스킬 시스템 ──
  private tryFireSkill(id: SkillId) {
    const slot = this.state.player.skills[id];
    if (!slot.unlocked) return;
    if (slot.cooldown > 0) return;

    if (id === 'water_tidal') {
      this.tidalWaveSkill.start(this.state.cameraX, this.state.cameraY, CANVAS_W, CANVAS_H);
      slot.cooldown = slot.maxCooldown;
    } else if (id === 'fire_inferno') {
      this.infernoSkill.start(this.state.cameraX, this.state.cameraY, CANVAS_W, CANVAS_H);
      slot.cooldown = slot.maxCooldown;
    } else if (id === 'earth_quake') {
      this.earthquakeSkill.start(this.state.player.x, this.state.player.y);
      slot.cooldown = slot.maxCooldown;
    } else if (id === 'electric_storm') {
      this.thunderStormSkill.start(this.state.cameraX, this.state.cameraY, CANVAS_W, CANVAS_H);
      slot.cooldown = slot.maxCooldown;
    } else if (id === 'light_judgment') {
      this.lightJudgmentSkill.start(
        this.state.enemies,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
      );
      slot.cooldown = slot.maxCooldown;
    } else if (id === 'dark_abyss') {
      this.abyssSkill.start(
        this.state.enemies,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
      );
      slot.cooldown = slot.maxCooldown;
    }
  }

  private updateSkills() {
    const skills = this.state.player.skills;
    for (const key in skills) {
      const s = skills[key as SkillId];
      if (s.cooldown > 0) s.cooldown--;
    }

    // 물 스킬 업데이트 + 데미지 판정
    if (this.tidalWaveSkill.isActive()) {
      this.tidalWaveSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
      );
    }

    // 불 스킬 업데이트 + 연쇄 폭발 판정
    if (this.infernoSkill.isActive()) {
      this.infernoSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
      );
    }

    // 흙 스킬 업데이트 + 균열 + 3연타 폭발 판정
    if (this.earthquakeSkill.isActive()) {
      this.earthquakeSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
        (frames) => {
          this.state.shakeFrames = Math.max(this.state.shakeFrames, frames);
        },
      );
    }

    // 전기 스킬 업데이트 + 번개/체인 판정
    if (this.thunderStormSkill.isActive()) {
      this.thunderStormSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
      );
    }

    // 빛 스킬 업데이트 + 일제 심판 판정
    if (this.lightJudgmentSkill.isActive()) {
      this.lightJudgmentSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
      );
    }

    // 암흑 스킬 업데이트 + 시간 정지 + 중력 수렴 판정
    if (this.abyssSkill.isActive()) {
      this.abyssSkill.update(
        1,
        this.state.enemies,
        this.state.particles,
        this.state.cameraX,
        this.state.cameraY,
        CANVAS_W,
        CANVAS_H,
        (idx) => this.killEnemy(idx),
      );
    }
  }

  // ── 보스 AI — 속성별 다채로운 공격 패턴 + 난이도 스케일링 ──
  private updateBossBehavior() {
    const { enemies, player } = this.state;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      if (!isBossType(e.type)) continue;

      e.bossAttackTimer = (e.bossAttackTimer ?? 120) - 1;
      if (e.bossAttackTimer > 0) continue;

      // 난이도 팩터: 보스 큐를 몇 번 돌았는지 (0=첫 사이클)
      //   - 쿨다운 감소, 대미지/발사 수 증가
      const cycle = Math.floor(Math.max(0, this._bossQueueIndex - 1) / this._bossQueue.length);
      const diff = 1 + cycle * 0.45;                         // 대미지/개수 스케일
      const cdBase = 140;                                    // 기본 쿨다운 (frames)
      const cd = Math.max(50, Math.floor(cdBase - cycle * 18));

      // 공격 패턴 랜덤 선택 (속성별 헬퍼 내부에서 처리)
      switch (e.type) {
        case 'boss_water':    this.bossAttackWater(e, player, diff); break;
        case 'boss_fire':     this.bossAttackFire(e, player, diff); break;
        case 'boss_earth':    this.bossAttackEarth(e, player, diff); break;
        case 'boss_electric': this.bossAttackElectric(e, player, diff); break;
        case 'boss_light':    this.bossAttackLight(e, player, diff); break;
        case 'boss_dark':     this.bossAttackDark(e, player, diff); break;
        default: break;
      }

      e.bossAttackTimer = cd;
    }
  }

  /** 별자리 재단 헬퍼 — (cx, cy) 기준 반경 내 가장 가까운 적 N마리 (제외 idx 지원) */
  private findClosestEnemies(
    cx: number, cy: number,
    range: number, count: number,
    exclude?: Set<number>,
  ): Array<{ idx: number; d2: number }> {
    const range2 = range * range;
    const picks: Array<{ idx: number; d2: number }> = [];
    const candidates = this.spatialHash.query(cx, cy, range * 2, range * 2, this.state.enemies.length);
    for (let ci = 0; ci < candidates.length; ci++) {
      const i = candidates[ci];
      if (exclude && exclude.has(i)) continue;
      const e = this.state.enemies[i];
      if (!e.active) continue;
      const dx = e.x - cx;
      const dy = e.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2) continue;
      picks.push({ idx: i, d2 });
    }
    picks.sort((a, b) => a.d2 - b.d2);
    return picks.slice(0, count);
  }

  /** 풀에서 비활성 투사체 획득 (없으면 null) */
  private acquireEnemyProjectile(): EnemyProjectileState | null {
    for (const pr of this.state.enemyProjectiles) {
      if (!pr.active) return pr;
    }
    return null;
  }

  /** 공통 helper — 기본값으로 투사체 초기화 후 variant 세팅 */
  private initProjectile(
    pr: EnemyProjectileState,
    x: number, y: number,
    vx: number, vy: number,
    radius: number, damage: number, life: number, color: number,
    variant?: EnemyProjectileState['variant'],
  ) {
    pr.x = x; pr.y = y;
    pr.vx = vx; pr.vy = vy;
    pr.radius = radius;
    pr.damage = damage;
    pr.life = life;
    pr.color = color;
    pr.active = true;
    pr.variant = variant;
    pr.delay = undefined;
    pr.homing = undefined;
    pr.spinAngle = undefined;
    pr.spinSpeed = undefined;
  }

  // ── 물 보스 공격 ──
  // ── Phase Resonator (물 보스) ──
  // A. Dual Ring Burst  : 2겹 파동 링 (내 CW 빠름, 외 CCW 느림) — 간섭 패턴
  // B. Sinusoidal Wavefront : 5 pulses 사인파 진행 — 수직 오실레이션
  // C. Resonance Lock : 예고 pulse node → 폭발 + 12방 radial sub-pulses
  private bossAttackWater(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);

    if (roll < 0.50) {
      // A. Dual Ring Burst — 2겹 동심 링. 내·외 각도 엇갈림 + 속도 차이.
      const countInner = 8 + Math.floor(diff);
      const countOuter = 10 + Math.floor(diff * 1.5);
      const rotA = Math.random() * Math.PI * 2;
      const rotB = rotA + Math.PI / countOuter; // 외측은 내측 사이 각으로 어긋남
      // 내측 (빠름, 작음)
      for (let k = 0; k < countInner; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const a = rotA + (k / countInner) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(a) * 4.0, Math.sin(a) * 4.0,
          8, 9 * diff, 140, 0x38bdf8, 'water_ring');
      }
      // 외측 (느림, 큼) — 간섭 무늬 생성
      for (let k = 0; k < countOuter; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const a = rotB + (k / countOuter) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(a) * 2.6, Math.sin(a) * 2.6,
          10, 10 * diff, 170, 0x0ea5e9, 'water_ring');
      }

    } else if (roll < 0.80) {
      // B. Sinusoidal Wavefront — 5 pulses가 일렬로 출발, 각자 엇갈린 위상으로 수직 오실레이션
      const n = 5 + Math.floor(diff * 0.5);
      const speed = 3.8;
      const baseVx = Math.cos(base) * speed;
      const baseVy = Math.sin(base) * speed;
      const perpX = -Math.sin(base); // 단위 수직
      const perpY =  Math.cos(base);
      // 출발 오프셋 — 5발이 횡으로 살짝 벌어져 시작
      for (let k = 0; k < n; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const offIdx = k - (n - 1) / 2; // -2..+2
        const startOff = offIdx * 16;
        const sx = e.x + perpX * startOff;
        const sy = e.y + perpY * startOff;
        this.initProjectile(pr, sx, sy, baseVx, baseVy,
          9, 11 * diff, 140, 0x0284c7, 'water_wavefront');
        pr.waveBaseVx = baseVx;
        pr.waveBaseVy = baseVy;
        pr.wavePerpX = perpX;
        pr.wavePerpY = perpY;
        pr.waveAmp = 38;                                  // 피크 변위 px
        pr.wavePhase = offIdx * 0.9;                      // 위상 엇갈림
        pr.wavePhaseSpeed = 0.14;                         // 주기 ~ 45f
      }

    } else {
      // C. Resonance Lock — 예고 pulse node → 폭발 + 12방 radial sub-pulses
      const pr = this.acquireEnemyProjectile(); if (!pr) return;
      this.initProjectile(pr, player.x, player.y, 0, 0,
        46, 22 * diff, 115, 0x1d4ed8, 'water_puddle');
      pr.delay = 90;                                  // 1.5s 예고
      // 폭발 후 radial 서브 방출
      pr.onExpireSpawnCount = 12 + Math.floor(diff);
      pr.onExpireSpawnSpeed = 3.4;
      pr.onExpireSpawnLife = 95;
      pr.onExpireSpawnRadius = 7;
      pr.onExpireSpawnDamage = 9 * diff;
      pr.onExpireSpawnColor = 0x38bdf8;
      pr.onExpireSpawnVariant = 'water_ring';
    }
  }

  // ── Plasma Fusor (불 보스) ──
  // A. Plasma Lance : 3 플라즈마 창 (빠르고 긴 streak)
  // B. Corona Whirl : 10-14 소용돌이 불꽃 파편 (나선 궤적)
  // C. Meteor Rain  : 4-6 화염 기둥 예고 + 낙하
  private bossAttackFire(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);

    if (roll < 0.40) {
      // A. Plasma Lance — 3발 플라즈마 창 부채꼴, 빠르고 강력
      const n = 3 + Math.floor(diff * 0.5);
      for (let k = -Math.floor(n / 2); k <= Math.floor(n / 2); k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = base + k * 0.15;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 6.8, Math.sin(ang) * 6.8,
          10, 13 * diff, 130, 0xf97316, 'fire_ball');
      }

    } else if (roll < 0.75) {
      // B. Corona Whirl — 10-14 불꽃 파편 나선 방사 (시계/반시계 교대)
      const count = 10 + Math.floor(diff * 2);
      const rot = Math.random() * Math.PI * 2;
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = rot + (k / count) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 3.6, Math.sin(ang) * 3.6,
          9, 9 * diff, 130, 0xdc2626, 'fire_spiral');
        pr.spinAngle = ang;
        pr.spinSpeed = (k % 2 === 0 ? 1 : -1) * 0.028; // 교대 나선
      }

    } else {
      // C. Meteor Rain — 4-6 화염 기둥 (플레이어 주변 예측 위치)
      const count = 4 + Math.floor(diff);
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const tx = player.x + (Math.random() - 0.5) * 220;
        const ty = player.y + (Math.random() - 0.5) * 220;
        this.initProjectile(pr, tx, ty, 0, 0,
          40, 20 * diff, 100, 0xea580c, 'fire_meteor');
        pr.delay = 50 + Math.floor(k * 9); // 0.83s 시간차 stagger
      }
    }
  }

  // ── Crystal Lattice (흙 보스) ──
  // A. Crystal Spear : 2-3 육각 프리즘 부채꼴 (크고 느리고 강함)
  // B. Shard Rain    : 12-16 결정 파편 방사 (삼각 splinter)
  // C. Tectonic Rift : 지연 균열 + 터질 때 8방 결정 파편 방사
  private bossAttackEarth(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);

    if (roll < 0.40) {
      // A. Crystal Spear — 육각 프리즘 2-3발 부채꼴
      const count = 2 + Math.floor(diff / 2);
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = base + (k - (count - 1) / 2) * 0.18;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 3.0, Math.sin(ang) * 3.0,
          18, 18 * diff, 170, 0xa16207, 'earth_rock');
      }

    } else if (roll < 0.75) {
      // B. Shard Rain — 12-16 삼각 splinter 방사
      const count = 12 + Math.floor(diff * 2);
      const rot = Math.random() * Math.PI * 2;
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = rot + (k / count) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 3.4, Math.sin(ang) * 3.4,
          7, 8 * diff, 120, 0xd97706, 'earth_shard');
      }

    } else {
      // C. Tectonic Rift — 지연 균열 + 터지면 8방 파편 방사
      const pr = this.acquireEnemyProjectile(); if (!pr) return;
      this.initProjectile(pr, player.x, player.y, 0, 0,
        60, 26 * diff, 110, 0xb45309, 'earth_rupture');
      pr.delay = 70;
      pr.onExpireSpawnCount = 8 + Math.floor(diff);
      pr.onExpireSpawnSpeed = 3.2;
      pr.onExpireSpawnLife = 100;
      pr.onExpireSpawnRadius = 6;
      pr.onExpireSpawnDamage = 8 * diff;
      pr.onExpireSpawnColor = 0xd97706;
      pr.onExpireSpawnVariant = 'earth_shard';
    }
  }

  // ── Tesla Nucleus (전기 보스) ──
  // A. Chain Lightning : 3-4 직선 번개 나란히 발사 (빠름)
  // B. Arc Burst        : 12-14 전기 아크 방사 (빠른 360°)
  // C. Seeker Bolt      : 추적 번개 1개 (homing, 번개 실루엣)
  private bossAttackElectric(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);

    if (roll < 0.45) {
      // A. Chain Lightning — 3-4 직선 번개 나란히
      const n = 3 + Math.floor(diff * 0.5);
      for (let k = 0; k < n; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const perpX = -Math.sin(base);
        const perpY =  Math.cos(base);
        const off = (k - (n - 1) / 2) * 30;
        this.initProjectile(pr,
          e.x + perpX * off, e.y + perpY * off,
          Math.cos(base) * 7.5, Math.sin(base) * 7.5,
          7, 11 * diff, 110, 0x7c3aed, 'electric_bolt');
      }

    } else if (roll < 0.80) {
      // B. Arc Burst — 12-14 방사 arc (빠르고 전방향)
      const count = 12 + Math.floor(diff * 2);
      const rot = Math.random() * Math.PI * 2;
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = rot + (k / count) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 4.8, Math.sin(ang) * 4.8,
          7, 9 * diff, 115, 0xa855f7, 'electric_arc');
      }

    } else {
      // C. Seeker Bolt — 추적 번개 1개 (번개 실루엣, 공 아님)
      const pr = this.acquireEnemyProjectile(); if (!pr) return;
      this.initProjectile(pr, e.x, e.y,
        Math.cos(base) * 2.2, Math.sin(base) * 2.2,
        14, 18 * diff, 240, 0x7c3aed, 'electric_orb');
      pr.homing = true;
    }
  }

  // ── 빛 보스 공격 ──
  private bossAttackLight(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);
    if (roll < 0.45) {
      // 1. 좌우로 휘두르는 레이저 (5발 수직 수렴)
      const n = 5 + Math.floor(diff);
      for (let k = 0; k < n; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const off = (k - (n - 1) / 2) * 0.06;
        const ang = base + off;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 6.8, Math.sin(ang) * 6.8,
          6, 12 * diff, 140, 0xfde047, 'light_ray');
      }
    } else if (roll < 0.80) {
      // 2. 8방향 방사 holy ray (2-tier rotation)
      const countA = 8;
      const rotA = Math.random() * Math.PI * 2;
      for (let k = 0; k < countA; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = rotA + (k / countA) * Math.PI * 2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 4.2, Math.sin(ang) * 4.2,
          10, 11 * diff, 140, 0xf59e0b, 'light_holy');
      }
      if (diff >= 1.4) {
        // 2번째 ring 반대 방향 (높은 난이도에서만)
        const rotB = rotA + Math.PI / 8;
        for (let k = 0; k < countA; k++) {
          const pr = this.acquireEnemyProjectile(); if (!pr) break;
          const ang = rotB + (k / countA) * Math.PI * 2;
          this.initProjectile(pr, e.x, e.y,
            Math.cos(ang) * 3.2, Math.sin(ang) * 3.2,
            8, 9 * diff, 140, 0xfbbf24, 'light_holy');
        }
      }
    } else {
      // 3. 심판강림 — 플레이어 현재 위치 수직 광선 (지연)
      const pr = this.acquireEnemyProjectile(); if (!pr) return;
      this.initProjectile(pr, player.x, player.y, 0, 0,
        28, 26 * diff, 90, 0xfef9c3, 'light_judgment');
      pr.delay = 45;
    }
  }

  // ── 암흑 보스 공격 ──
  private bossAttackDark(e: EnemyState, player: PlayerState, diff: number) {
    const roll = Math.random();
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const base = Math.atan2(dy, dx);
    if (roll < 0.45) {
      // 1. 촉수 4방향 (휘는 궤적)
      const n = 4 + Math.floor(diff);
      for (let k = 0; k < n; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = base + (k - (n - 1) / 2) * 0.28;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 3.8, Math.sin(ang) * 3.8,
          9, 12 * diff, 170, 0x6d28d9, 'dark_tendril');
        pr.spinAngle = ang;
        pr.spinSpeed = (k % 2 === 0 ? 1 : -1) * 0.04;
      }
    } else if (roll < 0.80) {
      // 2. 검은 구체 1~2 (느리고 크다, 고대미지)
      const count = 1 + Math.floor(diff / 2);
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = base + (k - count / 2) * 0.2;
        this.initProjectile(pr, e.x, e.y,
          Math.cos(ang) * 2.4, Math.sin(ang) * 2.4,
          20, 22 * diff, 200, 0x1e1b4b, 'dark_void');
      }
    } else {
      // 3. 포털 스폰 — 보스 주변 3곳에 포털, 잠시 후 촉수 생성
      const count = 3 + Math.floor(diff / 2);
      for (let k = 0; k < count; k++) {
        const pr = this.acquireEnemyProjectile(); if (!pr) break;
        const ang = Math.random() * Math.PI * 2;
        const r = 100 + Math.random() * 120;
        this.initProjectile(pr,
          e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r,
          0, 0,
          24, 16 * diff, 90, 0x3b0764, 'dark_portal');
        pr.delay = 45 + Math.floor(k * 12);
      }
    }
  }

  // ── 적 투사체 이동 + 플레이어 충돌 + variant 특수 거동 ──
  private updateEnemyProjectiles() {
    const { enemyProjectiles, player } = this.state;
    const HIT_R = (PLAYER_WIDTH + PLAYER_HEIGHT) / 4 + 10;
    const HIT_R2 = HIT_R * HIT_R;
    for (const pr of enemyProjectiles) {
      if (!pr.active) continue;

      // ── 지연 예고 투사체: delay 동안은 정지, delay=0 되면 폭발 판정 1회 후 소멸 ──
      if (pr.delay !== undefined && pr.delay > 0) {
        pr.delay--;
        pr.life--;  // 예고 라이프도 소진
        if (pr.life <= 0) { pr.active = false; continue; }
        continue;
      }
      if (pr.delay === 0) {
        // 폭발 순간 — 플레이어 범위 내면 피해
        pr.delay = undefined;
        if (player.invincibleFrames <= 0) {
          const ddx = player.x - pr.x;
          const ddy = player.y - pr.y;
          if (ddx * ddx + ddy * ddy < (pr.radius + HIT_R) * (pr.radius + HIT_R)) {
            player.hp -= pr.damage;
            player.invincibleFrames = INVINCIBLE_FRAMES;
          }
        }
        // 폭발 시각 지속 잠시 유지 (life로 컨트롤), 이후 자연 소멸
        pr.life = Math.min(pr.life, 20);
        continue;
      }

      // ── 추적(homing) — electric_orb ──
      if (pr.homing) {
        const dx = player.x - pr.x;
        const dy = player.y - pr.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetVx = (dx / d) * 2.6;
        const targetVy = (dy / d) * 2.6;
        pr.vx = pr.vx * 0.92 + targetVx * 0.08;
        pr.vy = pr.vy * 0.92 + targetVy * 0.08;
      }

      // ── 회전 궤적 — dark_tendril ──
      if (pr.spinAngle !== undefined && pr.spinSpeed !== undefined) {
        pr.spinAngle += pr.spinSpeed;
        const speed = Math.sqrt(pr.vx * pr.vx + pr.vy * pr.vy) || 1;
        pr.vx = Math.cos(pr.spinAngle) * speed;
        pr.vy = Math.sin(pr.spinAngle) * speed;
      }

      // ── 사인파 이동 — water_wavefront ──
      // 직진 baseV 유지 + 수직 perp 방향으로 sin 오실레이션 위치 가산
      if (pr.wavePhase !== undefined && pr.waveBaseVx !== undefined) {
        const prevPerp = Math.sin(pr.wavePhase) * (pr.waveAmp ?? 0);
        pr.wavePhase += pr.wavePhaseSpeed ?? 0;
        const curPerp  = Math.sin(pr.wavePhase) * (pr.waveAmp ?? 0);
        const dPerp = curPerp - prevPerp;
        // 직진 성분은 baseV로 강제 (vx/vy가 다른 이유로 수정되는 걸 방지)
        pr.vx = pr.waveBaseVx;
        pr.vy = pr.waveBaseVy ?? 0;
        pr.x += (pr.wavePerpX ?? 0) * dPerp;
        pr.y += (pr.wavePerpY ?? 0) * dPerp;
      }

      pr.x += pr.vx;
      pr.y += pr.vy;
      pr.life--;
      if (pr.life <= 0) {
        // 소멸 시 radial 서브-투사체 방출 (resonance lock 등)
        if (pr.onExpireSpawnCount && pr.onExpireSpawnCount > 0) {
          const n = pr.onExpireSpawnCount;
          const spd = pr.onExpireSpawnSpeed ?? 3.2;
          const life = pr.onExpireSpawnLife ?? 110;
          const rad = pr.onExpireSpawnRadius ?? 8;
          const dmg = pr.onExpireSpawnDamage ?? 10;
          const col = pr.onExpireSpawnColor ?? pr.color;
          const variant = pr.onExpireSpawnVariant;
          const rot = Math.random() * Math.PI * 2;
          for (let k = 0; k < n; k++) {
            const sub = this.acquireEnemyProjectile();
            if (!sub) break;
            const a = rot + (k / n) * Math.PI * 2;
            this.initProjectile(sub, pr.x, pr.y,
              Math.cos(a) * spd, Math.sin(a) * spd,
              rad, dmg, life, col, variant);
          }
        }
        pr.active = false;
        continue;
      }
      // 플레이어 충돌
      if (player.invincibleFrames <= 0) {
        const dx = player.x - pr.x;
        const dy = player.y - pr.y;
        if (dx * dx + dy * dy < HIT_R2) {
          player.hp -= pr.damage;
          player.invincibleFrames = INVINCIBLE_FRAMES;
          pr.active = false;
        }
      }
    }
  }

  private updatePlayer() {
    const { player } = this.state;
    let dx = 0, dy = 0;

    // Keyboard
    if (this.keys.has('w') || this.keys.has('arrowup')) dy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;

    // Mobile joystick
    if (this.joystickActive) {
      dx += this.joystickDX;
      dy += this.joystickDY;
    }

    if (dx !== 0 || dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
      player.x += dx * player.speed;
      player.y += dy * player.speed;
      this.facingX = dx;
      this.facingY = dy;
    }

    // Clamp to world
    player.x = Math.max(PLAYER_WIDTH, Math.min(WORLD_W - PLAYER_WIDTH, player.x));
    player.y = Math.max(PLAYER_HEIGHT, Math.min(WORLD_H - PLAYER_HEIGHT, player.y));

    if (player.invincibleFrames > 0) player.invincibleFrames--;
    if (player.comboTimer > 0) {
      player.comboTimer--;
      if (player.comboTimer <= 0) player.comboCount = 0;
    }
  }

  /** 매 프레임: 슬롯에 있는 원소에 따라 이펙트 활성/위치 갱신 */
  private updateElementEffects() {
    const { player } = this.state;
    const px = player.x;
    const py = player.y;

    // ── 슬롯별 이펙트 ID 계산 (슬롯 변경 시에만 재계산) ──
    if (this._activeEffectsDirty || this._activeEffectsCache === null) {
      const cache = new Set<string>();
      for (const slot of player.weaponSlots) {
        const filled: ElementType[] = [];
        for (const el of slot.elements) {
          if (el !== null) filled.push(el);
        }
        if (filled.length === 0) continue;
        const uniq = new Set(filled);
        let id: string;
        if (filled.length === 3 && uniq.size === 1) {
          id = `ult:${filled[0]}`;
        } else if (filled.length === 3 && uniq.size === 3) {
          id = `c3:${[...uniq].sort().join(',')}`;
        } else if (uniq.size === 2) {
          id = `c2:${[...uniq].sort().join(',')}`;
        } else {
          id = `s1:${[...uniq][0]}`;
        }
        cache.add(id);
      }
      this._activeEffectsCache = cache;
      this._activeEffectsDirty = false;
    }
    const activeEffects = this._activeEffectsCache;

    // ── 후방호환 플래그 (본체 로직이 has* 이름으로 참조) ──
    // 단일 원소 플래그는 "어느 슬롯이 그 원소만 담았을 때" true.
    // 해당 원소가 조합에 포함된 슬롯은 조합 ID로 분류되므로 single 플래그는 false가 됨.
    const hasWater = activeEffects.has('s1:물');
    const hasEarth = activeEffects.has('s1:흙');
    const hasFire = activeEffects.has('s1:불');
    const hasLight = activeEffects.has('s1:빛');
    const hasElectric = activeEffects.has('s1:전기');
    const hasDark = activeEffects.has('s1:암흑');

    const hasWaterUltimate = activeEffects.has('ult:물');
    const hasEarthUltimate = activeEffects.has('ult:흙');
    const hasFireUltimate = activeEffects.has('ult:불');
    const hasLightUltimate = activeEffects.has('ult:빛');
    const hasElectricUltimate = activeEffects.has('ult:전기');
    const hasDarkUltimate = activeEffects.has('ult:암흑');

    // 2원소 조합 (sort 순서: 물 < 불 < 빛 < 암흑 < 전기 < 흙)
    const hasWaterFireCombo = activeEffects.has('c2:물,불');
    const hasWaterLightCombo = activeEffects.has('c2:물,빛');
    const hasWaterDarkCombo = activeEffects.has('c2:물,암흑');
    const hasWaterElectricCombo = activeEffects.has('c2:물,전기');
    const hasWaterEarthCombo = activeEffects.has('c2:물,흙');
    const hasFireLightCombo = activeEffects.has('c2:불,빛');
    const hasFireDarkCombo = activeEffects.has('c2:불,암흑');
    const hasFireElectricCombo = activeEffects.has('c2:불,전기');
    const hasEarthFireCombo = activeEffects.has('c2:불,흙');
    const hasLightDarkCombo = activeEffects.has('c2:빛,암흑');
    const hasLightElectricCombo = activeEffects.has('c2:빛,전기');
    const hasEarthLightCombo = activeEffects.has('c2:빛,흙');
    const hasElectricDarkCombo = activeEffects.has('c2:암흑,전기');
    const hasEarthDarkCombo = activeEffects.has('c2:암흑,흙');
    const hasEarthElectricCombo = activeEffects.has('c2:전기,흙');

    // 3원소 조합
    const hasWaterFireLightCombo = activeEffects.has('c3:물,불,빛');
    const hasWaterFireDarkCombo = activeEffects.has('c3:물,불,암흑');
    const hasWaterFireElectricCombo = activeEffects.has('c3:물,불,전기');
    const hasWaterEarthFireCombo = activeEffects.has('c3:물,불,흙');
    const hasWaterLightDarkCombo = activeEffects.has('c3:물,빛,암흑');
    const hasWaterLightElectricCombo = activeEffects.has('c3:물,빛,전기');
    const hasWaterEarthLightCombo = activeEffects.has('c3:물,빛,흙');
    const hasWaterElectricDarkCombo = activeEffects.has('c3:물,암흑,전기');
    const hasWaterEarthDarkCombo = activeEffects.has('c3:물,암흑,흙');
    const hasWaterEarthElectricCombo = activeEffects.has('c3:물,전기,흙');
    const hasFireLightDarkCombo = activeEffects.has('c3:불,빛,암흑');
    const hasFireLightElectricCombo = activeEffects.has('c3:불,빛,전기');
    const hasEarthFireLightCombo = activeEffects.has('c3:불,빛,흙');
    const hasFireElectricDarkCombo = activeEffects.has('c3:불,암흑,전기');
    const hasEarthFireDarkCombo = activeEffects.has('c3:불,암흑,흙');
    const hasEarthFireElectricCombo = activeEffects.has('c3:불,전기,흙');
    const hasLightElectricDarkCombo = activeEffects.has('c3:빛,암흑,전기');
    const hasEarthLightDarkCombo = activeEffects.has('c3:빛,암흑,흙');
    const hasEarthLightElectricCombo = activeEffects.has('c3:빛,전기,흙');
    const hasEarthElectricDarkCombo = activeEffects.has('c3:암흑,전기,흙');

    const { enemies, particles } = this.state;

    if (hasWaterFireCombo) {
      // ── 물+불 조합: 스팀 폭발 ──
      // 응축→임계→폭발→잔류 사이클. 폭발 순간에 광역 데미지 + 넉백 + 화상 DoT.
      this.effectManager.startWaterFire(px, py);
      this.effectManager.updateWaterFirePosition(px, py);

      // 폭발 발동 순간: 광역 처리
      if (this.effectManager.waterFireBurstFired()) {
        const center = this.effectManager.waterFireBurstCenter();
        const burstR = this.effectManager.waterFireBurstRadius();
        const burstR2 = burstR * burstR;
        const BURST_DAMAGE = 35;
        const KNOCKBACK = 38;
        const BURN_FRAMES = 60;

        const candidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < candidates.length; ci++) {
          const i = candidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;
          // 메인 데미지
          e.hp -= BURST_DAMAGE;
          // 넉백 (충격파 방향 = 중심에서 바깥)
          const knock = KNOCKBACK * (1 - dist / burstR); // 가까울수록 강함
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          // 백열 + 슬레이트 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0xfff7ed);
          spawnHitParticles(particles, e.x, e.y, 0xfb923c);
          // 화상 DoT 등록
          this._steamBurnTargets.set(i, BURN_FRAMES);
          if (e.hp <= 0) {
            this._steamBurnTargets.delete(i);
            this.killEnemy(i);
          }
        }
      }

      // 매 프레임: 화상 DoT 진행 (15f마다 8뎀, 60f → 4틱)
      if (this._steamBurnTargets.size > 0) {
        for (const [ei, framesLeft] of this._steamBurnTargets) {
          const e = enemies[ei];
          if (!e || !e.active) {
            this._steamBurnTargets.delete(ei);
            continue;
          }
          const next = framesLeft - 1;
          const elapsed = 60 - next;
          // 15f, 30f, 45f, 60f 시점에 4틱
          if (elapsed > 0 && elapsed % 15 === 0) {
            e.hp -= 8;
            spawnHitParticles(particles, e.x, e.y, 0xfb923c);
            if (e.hp <= 0) {
              this._steamBurnTargets.delete(ei);
              this.killEnemy(ei);
              continue;
            }
          }
          if (next <= 0) {
            this._steamBurnTargets.delete(ei);
          } else {
            this._steamBurnTargets.set(ei, next);
          }
        }
      }

      // 개별 물/불/물전기/물빛 정지
      this.effectManager.stopWater();
      this.effectManager.stopFire();
      this.effectManager.stopWaterElectric();
      this.effectManager.stopWaterLight();
      this._waterElectricStrikeTimer = 0;
      // 물+암흑 정지
      if (this._waterDarkPlaced) {
        this._waterDarkPlaced = false;
        this.effectManager.stopWaterDark();
      }
    } else if (hasWaterLightCombo) {
      this.effectManager.stopWaterFire();
      this._steamBurnTargets.clear();
      // ── 물+빛 조합: 프리즘 차징 빔 ──
      // 무지개 광점이 캐릭터 앞 삼각형에 모임 → 꼭짓점에서 6겹 무지개 빔 발사
      this.effectManager.startWaterLight(px, py);
      this.effectManager.updateWaterLightPosition(px, py);

      // 가장 가까운 적 방향 자동 추적
      const SEARCH_RANGE = 1800;
      let beamAngle = Math.atan2(this.facingY, this.facingX);
      let nearestDist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - px;
        const dy = enemies[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestDist && d <= SEARCH_RANGE * SEARCH_RANGE) {
          nearestDist = d;
          beamAngle = Math.atan2(dy, dx);
        }
      }
      this.effectManager.updateWaterLightDirection(beamAngle);

      // 발사 순간: 캐릭터에서 적 방향 직선 위 적에게 데미지 (빛 1단계 패턴)
      if (this.effectManager.waterLightBeamFired()) {
        const fireAngle = this.effectManager.waterLightBeamAngle();
        const cosA = Math.cos(fireAngle);
        const sinA = Math.sin(fireAngle);
        const perpX = -sinA;
        const perpY = cosA;
        const beamRange = 1800;
        const halfWidth = 18; // 빔 본체 11px + 외곽 글로우 28px 사이

        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          const ex = e.x - px;
          const ey = e.y - py;
          const along = ex * cosA + ey * sinA;
          if (along < 0 || along > beamRange) continue;
          const perp = ex * perpX + ey * perpY;
          if (Math.abs(perp) > halfWidth) continue;
          // 빔 위 — 30뎀 (관통)
          e.hp -= 30;
          spawnHitParticles(particles, e.x, e.y, 0xef4444);
          spawnHitParticles(particles, e.x, e.y, 0xfacc15);
          spawnHitParticles(particles, e.x, e.y, 0x3b82f6);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 개별 물/빛/물전기 정지
      this.effectManager.stopWater();
      this.effectManager.stopLight();
      this.effectManager.stopWaterElectric();
      this._waterElectricStrikeTimer = 0;
      // 물+암흑 정지
      if (this._waterDarkPlaced) {
        this._waterDarkPlaced = false;
        this.effectManager.stopWaterDark();
      }
    } else if (hasWaterDarkCombo) {
      this.effectManager.stopWaterFire();
      this.effectManager.stopWaterLight();
      this.effectManager.stopWaterElectric();
      this._steamBurnTargets.clear();
      this._waterElectricStrikeTimer = 0;
      // ── 물+암흑 조합: 메일스트롬 (설치형 소용돌이) ──
      // 1단계 암흑(블랙홀)과 동일한 설치형 패턴. 한 번 펼치면 그 자리에 고정.
      // 강한 흡인 + 회전 휘말림 + 지속 데미지.
      const maelstromRadius = 180;

      if (!this._waterDarkPlaced) {
        this._waterDarkPlaced = true;
        this._waterDarkPosX = px;
        this._waterDarkPosY = py;
        this.effectManager.startWaterDark(px, py, maelstromRadius);
      }

      // 1단계 암흑이 켜져 있으면 끔 (충돌 방지)
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }

      const mhx = this._waterDarkPosX;
      const mhy = this._waterDarkPosY;
      const r2 = maelstromRadius * maelstromRadius;
      const maelstromCandidates = this.spatialHash.query(mhx, mhy, maelstromRadius * 2, maelstromRadius * 2, enemies.length);
      for (let ci = 0; ci < maelstromCandidates.length; ci++) {
        const i = maelstromCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - mhx;
        const dy = e.y - mhy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const dist = Math.sqrt(d2) || 1;
        const t = dist / maelstromRadius; // 0(중심) ~ 1(가장자리)

        // ── 흡인 (블랙홀보다 강함, 가까울수록 강함) ──
        const pullStrength = 4.2 * (1 - t);
        if (!isBossType(e.type)) {
          e.x -= (dx / dist) * pullStrength;
          e.y -= (dy / dist) * pullStrength;
        }

        // ── 와류 회전: 적이 소용돌이에 휘말림 (각도 변화) ──
        // 안쪽일수록 회전이 강함 (케플러 가속 흉내)
        const swirlStrength = 0.06 * (1 - t) * (1 - t) + 0.015;
        const cs = Math.cos(swirlStrength);
        const sn = Math.sin(swirlStrength);
        const ndx = dx * cs - dy * sn;
        const ndy = dx * sn + dy * cs;
        e.x = mhx + ndx;
        e.y = mhy + ndy;

        // ── 지속 데미지 (30프레임마다 12뎀, 1단계 암흑보다 약간 강함) ──
        if (this.state.frameCount % 30 === 0) {
          e.hp -= 12;
          spawnHitParticles(particles, e.x, e.y, 0x3b82f6);
          spawnHitParticles(particles, e.x, e.y, 0xbae6fd);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 개별 물/암흑 이펙트 중지
      this.effectManager.stopWater();
    } else if (hasWaterElectricCombo) {
      this.effectManager.stopWaterFire();
      this.effectManager.stopWaterLight();
      this._steamBurnTargets.clear();
      // 물+암흑 정지
      if (this._waterDarkPlaced) {
        this._waterDarkPlaced = false;
        this.effectManager.stopWaterDark();
      }
      // ── 물+전기 조합: 감전 파도 ──
      // 느리지만 훨씬 강력. 넉백+슬로우+감전.
      const stormRadius = 160;

      this.effectManager.startWaterElectric(px, py, stormRadius);
      this.effectManager.updateWaterElectricPosition(px, py);

      const stormCandidates = this.spatialHash.query(px, py, stormRadius * 2, stormRadius * 2, enemies.length);
      for (let ci = 0; ci < stormCandidates.length; ci++) {
        const i = stormCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < stormRadius && dist > 1) {
          // 슬로우 65%: 감전으로 강하게 둔화 — 보스 면역
          const toPlayerX = (px - e.x) / dist;
          const toPlayerY = (py - e.y) / dist;
          const slowStrength = e.speed * 0.65;
          if (!isBossType(e.type)) {
            e.x -= toPlayerX * slowStrength;
            e.y -= toPlayerY * slowStrength;
          }

          // 감전 데미지 (45프레임마다 = ~0.75초, 느리지만 강한 한방)
          if (this.state.frameCount % 45 === 0) {
            e.hp -= 18;
            // 전기 히트 파티클 (노랑 여러 개)
            spawnHitParticles(particles, e.x, e.y, 0xfde047);
            spawnHitParticles(particles, e.x + (Math.random() - 0.5) * 10, e.y + (Math.random() - 0.5) * 10, 0xeab308);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 개별 물/전기 이펙트 중지
      this.effectManager.stopWater();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
    } else {
      this.effectManager.stopWaterFire();
      this._steamBurnTargets.clear();
      this.effectManager.stopWaterElectric();
      this.effectManager.stopWaterLight();
      this._waterElectricStrikeTimer = 0;
      // 물+암흑 정지
      if (this._waterDarkPlaced) {
        this._waterDarkPlaced = false;
        this.effectManager.stopWaterDark();
      }

    } // end hasWaterElectricCombo else — 물 single은 함수 끝 독립 블록으로 이동

    // ── 물+흙 조합 vs 흙 개별 ──
    if (hasWaterEarthCombo) {
      // ── 물+흙 조합: 퀵샌드 ──
      const quicksandRadius = 170; // 흙 1단계(120)보다 확대

      this.effectManager.startWaterEarth(px, py, quicksandRadius);
      this.effectManager.updateWaterEarthPosition(px, py);

      const quicksandCandidates = this.spatialHash.query(px, py, quicksandRadius * 2, quicksandRadius * 2, enemies.length);
      for (let ci = 0; ci < quicksandCandidates.length; ci++) {
        const i = quicksandCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < quicksandRadius && dist > 1) {
          // 극강 슬로우 88%: 퀵샌드에 깊이 빠짐 — 보스 면역
          const tpx3 = (px - e.x) / dist;
          const tpy3 = (py - e.y) / dist;
          if (!isBossType(e.type)) {
            e.x -= tpx3 * e.speed * 0.88;
            e.y -= tpy3 * e.speed * 0.88;
          }

          // 지속 데미지 (30프레임마다)
          if (this.state.frameCount % 30 === 0) {
            e.hp -= 10;
            spawnHitParticles(particles, e.x, e.y, 0x8b7348);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 개별 물/흙 이펙트 중지
      this.effectManager.stopWater();
      this.effectManager.stopEarth();
    } else {
      this.effectManager.stopWaterEarth();

      // 흙 single은 함수 끝 독립 블록으로 이동
    }

    // ── 물+흙+전기 3단계: 감전 퀵샌드 (Phase 3 첫 조합) ──
    if (hasWaterEarthElectricCombo) {
      const cqRadius = 170; // 퀵샌드와 동일 반경
      this.effectManager.startWaterEarthElectric(px, py, cqRadius);
      this.effectManager.updateWaterEarthElectricPosition(px, py);

      // 영역 내 모든 적: 강한 슬로우(퀵샌드 65%) + 강한 DoT(20뎀/24f)
      const teslaTargets3: Array<{ lx: number; ly: number }> = [];
      const r2 = cqRadius * cqRadius;
      const cqCandidates = this.spatialHash.query(px, py, cqRadius * 2, cqRadius * 2, enemies.length);
      for (let ci = 0; ci < cqCandidates.length; ci++) {
        const i = cqCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const dist = Math.sqrt(d2) || 1;

        // 강한 슬로우 88% (퀵샌드와 동일) — 보스 면역
        const tpx = (px - e.x) / dist;
        const tpy = (py - e.y) / dist;
        if (!isBossType(e.type)) {
          e.x -= tpx * e.speed * 0.88;
          e.y -= tpy * e.speed * 0.88;
        }

        // 전기 DoT (24f마다 20뎀)
        if (this.state.frameCount % 24 === 0) {
          e.hp -= 20;
          spawnHitParticles(particles, e.x, e.y, 0xfde047);
          spawnHitParticles(particles, e.x, e.y, 0xeab308);
          spawnHitParticles(particles, e.x, e.y, 0x8b7348);
          if (e.hp <= 0) {
            this.killEnemy(i);
            continue;
          }
        }

        // 모든 적에 테슬라 아크
        teslaTargets3.push({ lx: dx, ly: dy });
      }
      this.effectManager.updateWaterEarthElectricTeslaTargets(teslaTargets3);

      // 1단계 물/흙/전기 + 다른 2단계 조합 정지
      // ※ 다른 슬롯에서 같은 2원소 조합이 활성 중이면 끄지 않음
      this.effectManager.stopWater();
      this.effectManager.stopEarth();
      this.effectManager.stopElectric();
      if (!hasWaterEarthCombo) this.effectManager.stopWaterEarth();
      if (!hasWaterElectricCombo) this.effectManager.stopWaterElectric();
      if (!hasEarthElectricCombo) this.effectManager.stopEarthElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
    } else {
      this.effectManager.stopWaterEarthElectric();
    }

    // ── 흙+전기+암흑 3단계: 자철 다이나모 (Magnetite Dynamo) ──
    // 쌍극자 코어 + 자기력선 + 철가루. 페이즈 사이클로 CHARGE 마킹/타격, SUSTAIN DoT,
    // RECONNECT 페이즈에 자화 적 전원에 동시 검은 번개 + 쇼크웨이브.
    if (hasEarthElectricDarkCombo) {
      const dynamoRadius = 260;
      this.effectManager.startEarthElectricDark(px, py, dynamoRadius);
      this.effectManager.updateEarthElectricDarkPosition(px, py);

      // 영역 내 적 수집 (인덱스 X, 좌표만 — 풀 재사용 무관)
      const dynamoTargets: Array<{ lx: number; ly: number }> = [];
      const dynamoTargetIdx: number[] = []; // RECONNECT 데미지 배포용 (즉시 사용, 영구 저장 X)
      const r2 = dynamoRadius * dynamoRadius;
      const MAX_TARGETS = 20;
      // 거리순 정렬 위해 1차로 후보 수집
      const candidates: Array<{ idx: number; dx: number; dy: number; d2: number }> = [];
      const dynamoCandidates = this.spatialHash.query(px, py, dynamoRadius * 2, dynamoRadius * 2, enemies.length);
      for (let ci = 0; ci < dynamoCandidates.length; ci++) {
        const i = dynamoCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        candidates.push({ idx: i, dx, dy, d2 });
      }
      candidates.sort((a, b) => a.d2 - b.d2);
      const useCount = Math.min(MAX_TARGETS, candidates.length);
      for (let k = 0; k < useCount; k++) {
        const c = candidates[k];
        dynamoTargets.push({ lx: c.dx, ly: c.dy });
        dynamoTargetIdx.push(c.idx);
      }
      this.effectManager.updateEarthElectricDarkTargets(dynamoTargets);

      // CHARGE 진입 — 자화 마킹 + 초기 타격 (10뎀)
      if (this.effectManager.earthElectricDarkChargeStarted()) {
        for (const idx of dynamoTargetIdx) {
          const e = enemies[idx];
          if (!e || !e.active) continue;
          e.hp -= 10;
          spawnHitParticles(particles, e.x, e.y, 0xa78bfa);
          spawnHitParticles(particles, e.x, e.y, 0x7c3aed);
          if (e.hp <= 0) {
            this.killEnemy(idx);
          }
        }
      }

      // SUSTAIN DoT — 24f마다 자화 적 전원 15뎀
      if (this.effectManager.earthElectricDarkIsSustain() && this.state.frameCount % 24 === 0) {
        for (const idx of dynamoTargetIdx) {
          const e = enemies[idx];
          if (!e || !e.active) continue;
          e.hp -= 15;
          spawnHitParticles(particles, e.x, e.y, 0xa78bfa);
          spawnHitParticles(particles, e.x, e.y, 0xd4a53c);
          if (e.hp <= 0) {
            this.killEnemy(idx);
          }
        }
      }

      // RECONNECT 발화 — 자화 적 전원에 검은 번개 (40뎀) + 반경 내 전원 파열 (25뎀)
      if (this.effectManager.earthElectricDarkReconnectFired()) {
        // 자화 적 직격 (40뎀)
        const struck = new Set<number>();
        for (const idx of dynamoTargetIdx) {
          const e = enemies[idx];
          if (!e || !e.active) continue;
          e.hp -= 40;
          struck.add(idx);
          spawnHitParticles(particles, e.x, e.y, 0xc4b5fd);
          spawnHitParticles(particles, e.x, e.y, 0x7c3aed);
          spawnHitParticles(particles, e.x, e.y, 0x4c1d95);
          if (e.hp <= 0) {
            this.killEnemy(idx);
          }
        }
        // 반경 내 전원 파열 (25뎀, 자화 안 된 적도 포함, 자화 적은 추가 25뎀)
        const reconnectCandidates = this.spatialHash.query(px, py, dynamoRadius * 2, dynamoRadius * 2, enemies.length);
        for (let ci = 0; ci < reconnectCandidates.length; ci++) {
          const i = reconnectCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          e.hp -= 25;
          spawnHitParticles(particles, e.x, e.y, 0x8b5cf6);
          if (e.hp <= 0) {
            this.killEnemy(i);
          }
        }
      }

      // 1단계 흙/전기/암흑 + 하위 2단계 정지
      this.effectManager.stopEarth();
      this.effectManager.stopElectric();
      this.effectManager.stopDark();
      this.effectManager.stopEarthElectric();
      this.effectManager.stopElectricDark();
      this.effectManager.stopEarthDark();
      this._electricTimer = 0;
      this._electricChainNodes = [];
    } else {
      this.effectManager.stopEarthElectricDark();
    }

    // ── 흙+전기 2단계: 테슬라 늪 (1단계 흙 베이스) ──
    if (hasEarthElectricCombo) {
      const mireRadius = 150;
      this.effectManager.startEarthElectric(px, py, mireRadius);
      this.effectManager.updateEarthElectricPosition(px, py);

      // 영역 내 모든 적 — 슬로우 + DoT + 테슬라 아크
      const teslaTargets2: Array<{ lx: number; ly: number }> = [];
      const r2 = mireRadius * mireRadius;
      const mireCandidates = this.spatialHash.query(px, py, mireRadius * 2, mireRadius * 2, enemies.length);
      for (let ci = 0; ci < mireCandidates.length; ci++) {
        const i = mireCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const dist = Math.sqrt(d2) || 1;

        // 슬로우 70% — 보스 면역
        const toPlayerX = (px - e.x) / dist;
        const toPlayerY = (py - e.y) / dist;
        if (!isBossType(e.type)) {
          e.x -= toPlayerX * e.speed * 0.70;
          e.y -= toPlayerY * e.speed * 0.70;
        }

        // 전기 DoT (24f마다 14뎀, 0.4초)
        if (this.state.frameCount % 24 === 0) {
          e.hp -= 14;
          spawnHitParticles(particles, e.x, e.y, 0xfde047);
          spawnHitParticles(particles, e.x, e.y, 0xeab308);
          if (e.hp <= 0) {
            this.killEnemy(i);
            continue;
          }
        }

        // 모든 적에 테슬라 아크 (인덱스 X, 좌표만 — 풀 재사용 무관)
        teslaTargets2.push({ lx: dx, ly: dy });
      }
      this.effectManager.updateEarthElectricTeslaTargets(teslaTargets2);

      // 1단계 흙/전기 정지 (조합이 둘 다 흡수)
      this.effectManager.stopEarth();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
    } else {
      this.effectManager.stopEarthElectric();
    }

    // ── 흙+불 조합: 마그마 균열 (캐릭터 중심 동심원 3링 순차 폭발) ──
    if (hasEarthFireCombo) {
      this.effectManager.startEarthFire(px, py);
      this.effectManager.updateEarthFirePosition(px, py);

      // 폭발 발동 처리: 이번 프레임에 폭발한 링들 (도넛 영역)
      const bursts = this.effectManager.earthFireBurstFires();
      for (const b of bursts) {
        const inner = b.radius - b.ringWidth / 2;
        const outer = b.radius + b.ringWidth / 2;
        const inner2 = inner * inner;
        const outer2 = outer * outer;
        // 바깥 링일수록 데미지 약간 더 (14/18/22)
        const dmg = b.radius < 67 ? 14 : b.radius < 105 ? 18 : 22;
        const burstCandidates = this.spatialHash.query(px, py, outer * 2, outer * 2, enemies.length);
        for (let ci = 0; ci < burstCandidates.length; ci++) {
          const i = burstCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < inner2 || d2 > outer2) continue;
          const dist = Math.sqrt(d2) || 1;
          // 도넛 데미지
          e.hp -= dmg;
          // 외측 넉백 (캐릭터 중심에서 바깥으로)
          const knock = 14;
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          spawnHitParticles(particles, e.x, e.y, 0xfb923c);
          spawnHitParticles(particles, e.x, e.y, 0xfff7ed);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 풀 DoT (15f마다, 활성 도넛 풀 안의 적에게)
      if (this.state.frameCount % 15 === 0) {
        const pools = this.effectManager.earthFireActivePools();
        for (const pool of pools) {
          const inner = pool.radius - pool.ringWidth / 2;
          const outer = pool.radius + pool.ringWidth / 2;
          const inner2 = inner * inner;
          const outer2 = outer * outer;
          const poolCandidates = this.spatialHash.query(px, py, outer * 2, outer * 2, enemies.length);
          for (let ci = 0; ci < poolCandidates.length; ci++) {
            const i = poolCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - px;
            const dy = e.y - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < inner2 || d2 > outer2) continue;
            e.hp -= 6;
            spawnHitParticles(particles, e.x, e.y, 0xea580c);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 개별 흙/불 정지
      this.effectManager.stopEarth();
      this.effectManager.stopFire();
    } else {
      this.effectManager.stopEarthFire();
    }

    // ── 불+빛 조합: 헬파이어 빔 (차징→발사 사이클, 빛 1단계 패턴 + 진한 빨강) ──
    if (hasFireLightCombo) {
      this.effectManager.startFireLight(px, py);
      this.effectManager.updateFireLightPosition(px, py);

      // 가장 가까운 적 방향 자동 추적
      const SEARCH_RANGE = 2000;
      let beamAngle = Math.atan2(this.facingY, this.facingX);
      let nearestDist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - px;
        const dy = enemies[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestDist && d <= SEARCH_RANGE * SEARCH_RANGE) {
          nearestDist = d;
          beamAngle = Math.atan2(dy, dx);
        }
      }
      this.effectManager.updateFireLightDirection(beamAngle);

      // 발사 순간: 캐릭터에서 빔 방향 직선 위 적에게 데미지 (관통)
      if (this.effectManager.fireLightBeamFired()) {
        const fireAngle = this.effectManager.fireLightBeamAngle();
        const cosA = Math.cos(fireAngle);
        const sinA = Math.sin(fireAngle);
        const perpX = -sinA;
        const perpY = cosA;
        const beamRange = 2000;
        const halfWidth = 16; // 빔 두께에 맞춤 (1단계 빛 18보다 살짝 좁음)
        const HELLFIRE_DAMAGE = 30; // 1단계 빛 25보다 강함

        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          const ex = e.x - px;
          const ey = e.y - py;
          const along = ex * cosA + ey * sinA;
          if (along < 0 || along > beamRange) continue;
          const perp = ex * perpX + ey * perpY;
          if (Math.abs(perp) > halfWidth) continue;
          // 빔 위 — 30뎀 (관통)
          e.hp -= HELLFIRE_DAMAGE;
          spawnHitParticles(particles, e.x, e.y, 0xdc2626);
          spawnHitParticles(particles, e.x, e.y, 0x7f1d1d);
          // 적 위치에 작은 화염 폭발
          this.effectManager.spawnFireLightHitFlame(e.x, e.y);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 1단계 불/빛 정지 (조합이 둘 다 흡수)
      this.effectManager.stopFire();
      this.effectManager.stopLight();
    } else {
      this.effectManager.stopFireLight();
    }

    // ── 흙+빛 조합: 풀구라이트 (결정화→균열→파쇄 발사 사이클, 다발 빔 7발) ──
    if (hasEarthLightCombo) {
      this.effectManager.startEarthLight(px, py);
      this.effectManager.updateEarthLightPosition(px, py);

      // 가장 가까운 적 방향 자동 추적 (결정화 동안만, 발사 시점에 잠금)
      const SEARCH_RANGE = 1800;
      let beamAngle = Math.atan2(this.facingY, this.facingX);
      let nearestDist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - px;
        const dy = enemies[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestDist && d <= SEARCH_RANGE * SEARCH_RANGE) {
          nearestDist = d;
          beamAngle = Math.atan2(dy, dx);
        }
      }
      this.effectManager.updateEarthLightDirection(beamAngle);

      // 발사 순간: 7발 동시 데미지 (메인 1 + 분산 6)
      if (this.effectManager.earthLightBeamFired()) {
        const mainAngle = this.effectManager.earthLightBeamMainAngle();
        const spreadOffsets = this.effectManager.earthLightSpreadOffsets();
        const MAIN_RANGE = 1800;
        const SPREAD_RANGE = 1500;
        const MAIN_HALF_WIDTH = 16;
        const SPREAD_HALF_WIDTH = 11; // 분산 빔은 약간 좁음
        const MAIN_DAMAGE = 25;
        const SPREAD_DAMAGE = 12;

        // 적 1마리당 한 빔에만 데미지 (7개 빔에 모두 맞으면 OP)
        // → 가장 가까운 빔 1개에만 처리
        // 단, 메인 빔은 가장 가까운 적이 우선이라 메인이 닿으면 메인 데미지 우선
        const hitOnce = new Set<number>();

        // 메인 빔 먼저 (가장 강력)
        const mainCos = Math.cos(mainAngle);
        const mainSin = Math.sin(mainAngle);
        const mainPerpX = -mainSin;
        const mainPerpY = mainCos;

        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          const ex = e.x - px;
          const ey = e.y - py;
          const along = ex * mainCos + ey * mainSin;
          if (along < 0 || along > MAIN_RANGE) continue;
          const perp = ex * mainPerpX + ey * mainPerpY;
          if (Math.abs(perp) > MAIN_HALF_WIDTH) continue;

          e.hp -= MAIN_DAMAGE;
          spawnHitParticles(particles, e.x, e.y, 0xfde047); // 황금
          spawnHitParticles(particles, e.x, e.y, 0xfef9c3); // 크림
          hitOnce.add(i);
          if (e.hp <= 0) this.killEnemy(i);
        }

        // 분산 빔 6발 (각 ±15°/±30°/±45°)
        for (const offset of spreadOffsets) {
          const angle = mainAngle + offset;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          const perpX = -sinA;
          const perpY = cosA;

          for (let i = 0; i < enemies.length; i++) {
            if (hitOnce.has(i)) continue; // 이미 다른 빔에 맞음
            const e = enemies[i];
            if (!e.active) continue;
            const ex = e.x - px;
            const ey = e.y - py;
            const along = ex * cosA + ey * sinA;
            if (along < 0 || along > SPREAD_RANGE) continue;
            const perp = ex * perpX + ey * perpY;
            if (Math.abs(perp) > SPREAD_HALF_WIDTH) continue;

            e.hp -= SPREAD_DAMAGE;
            spawnHitParticles(particles, e.x, e.y, 0xeab308); // 황금 진
            spawnHitParticles(particles, e.x, e.y, 0xfde047); // 황금 라이트
            hitOnce.add(i);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 1단계 흙/빛 정지 (조합이 둘 다 흡수)
      this.effectManager.stopEarth();
      this.effectManager.stopLight();
    } else {
      this.effectManager.stopEarthLight();
    }

    // ── 빛+암흑 조합: 초신성 (Supernova — 두 원 충돌 → 거대 폭발 + 사방 빔 16발) ──
    if (hasLightDarkCombo) {
      this.effectManager.startLightDark(px, py);
      this.effectManager.updateLightDarkPosition(px, py);

      // SUPERNOVA 폭발 발동 순간: 광역 데미지 + 넉백 + 사방 빔 16발 데미지
      if (this.effectManager.lightDarkSupernovaFired()) {
        const center = this.effectManager.lightDarkSupernovaCenter();
        const burstR = this.effectManager.lightDarkSupernovaRadius();
        const burstR2 = burstR * burstR;
        const beamRange = this.effectManager.lightDarkBeamRange();
        const beamAngles = this.effectManager.lightDarkBeamAngles();

        const SUPERNOVA_DAMAGE = 60; // 다른 폭발 조합 중 최강
        const SUPERNOVA_KNOCKBACK = 50;
        const BEAM_DAMAGE = 15;
        const BEAM_HALF_WIDTH = 14;

        // ── 1. 광역 폭발 데미지 + 넉백 (반경 350px) ──
        // 폭발 데미지 받은 적은 hitOnce에 등록 (사방 빔 데미지 중복 방지)
        const hitOnce = new Set<number>();
        const supernovaCandidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < supernovaCandidates.length; ci++) {
          const i = supernovaCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;

          e.hp -= SUPERNOVA_DAMAGE;
          // 강한 넉백 (가까울수록 강함)
          const knock = SUPERNOVA_KNOCKBACK * (1 - dist / burstR);
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          // 백/황금/검 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0xfffef5);
          spawnHitParticles(particles, e.x, e.y, 0xfde047);
          spawnHitParticles(particles, e.x, e.y, 0x44168b);
          hitOnce.add(i);
          if (e.hp <= 0) this.killEnemy(i);
        }

        // ── 2. 사방 빔 16발 (각 직선 위 적에 데미지, 한 적당 한 빔만, 폭발 데미지와 중복 X) ──
        for (const angle of beamAngles) {
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          const perpX = -sinA;
          const perpY = cosA;

          for (let i = 0; i < enemies.length; i++) {
            if (hitOnce.has(i)) continue; // 폭발에 이미 맞음 또는 다른 빔에 이미 맞음
            const e = enemies[i];
            if (!e.active) continue;
            // 폭발 중심 기준 좌표 (잠긴 위치)
            const ex = e.x - center.x;
            const ey = e.y - center.y;
            const along = ex * cosA + ey * sinA;
            if (along < 0 || along > beamRange) continue;
            const perp = ex * perpX + ey * perpY;
            if (Math.abs(perp) > BEAM_HALF_WIDTH) continue;

            e.hp -= BEAM_DAMAGE;
            spawnHitParticles(particles, e.x, e.y, 0xfde047);
            spawnHitParticles(particles, e.x, e.y, 0xfef9c3);
            hitOnce.add(i);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 1단계 빛/암흑 정지 (조합이 둘 다 흡수)
      this.effectManager.stopLight();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
    } else {
      this.effectManager.stopLightDark();
    }

    // ── 흙+암흑 조합: 유성우 (Meteor Shower — 지속형 다중 운석 낙하) ──
    if (hasEarthDarkCombo) {
      this.effectManager.startEarthDark(px, py);
      this.effectManager.updateEarthDarkPosition(px, py);

      // 이번 프레임에 착탄한 운석들 처리
      const impacts = this.effectManager.earthDarkImpactsThisFrame();
      if (impacts.length > 0) {
        const impactR = this.effectManager.earthDarkImpactRadius();
        const impactR2 = impactR * impactR;
        const METEOR_DAMAGE = 12;
        const KNOCKBACK_MAX = 6;
        const METEOR_STUN_FRAMES = 120; // 2초 (60fps 가정)

        for (const impact of impacts) {
          // spatialHash 재활용: impact 근처 후보만 순회 (O(N)→O(후보))
          const candidates = this.spatialHash.query(impact.x, impact.y, impactR * 2, impactR * 2, enemies.length);
          for (let ci = 0; ci < candidates.length; ci++) {
            const i = candidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - impact.x;
            const dy = e.y - impact.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > impactR2) continue;
            const dist = Math.sqrt(d2) || 1;

            e.hp -= METEOR_DAMAGE;
            // 약한 넉백 (외측)
            const knock = KNOCKBACK_MAX * (1 - dist / impactR);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
            // ★ 스턴 2초 (이미 더 긴 스턴이 있으면 유지, 아니면 갱신)
            if (!e.stunFrames || e.stunFrames < METEOR_STUN_FRAMES) {
              e.stunFrames = METEOR_STUN_FRAMES;
            }
            // 어둠/모래 히트 파티클
            spawnHitParticles(particles, e.x, e.y, 0x44168b);
            spawnHitParticles(particles, e.x, e.y, 0xa16207);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 1단계 흙/암흑 정지 (조합이 둘 다 흡수)
      this.effectManager.stopEarth();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
    } else {
      this.effectManager.stopEarthDark();
    }

    // ── 불+암흑 조합: 항성 붕괴 (응축→임계→폭발→잔류 사이클) ──
    if (hasFireDarkCombo) {
      this.effectManager.startFireDark(px, py);
      this.effectManager.updateFireDarkPosition(px, py);

      // 폭발 발동 순간: 광역 처리
      if (this.effectManager.fireDarkBurstFired()) {
        const center = this.effectManager.fireDarkCenter();
        const burstR = this.effectManager.fireDarkBurstRadius();
        const burstR2 = burstR * burstR;
        const STELLAR_BURST_DAMAGE = 32;
        const STELLAR_KNOCKBACK = 36;
        const STELLAR_BURN_FRAMES = 60;

        const stellarCandidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < stellarCandidates.length; ci++) {
          const i = stellarCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;
          // 메인 데미지
          e.hp -= STELLAR_BURST_DAMAGE;
          // 넉백 (충격파 방향 = 중심에서 바깥, 가까울수록 강함)
          const knock = STELLAR_KNOCKBACK * (1 - dist / burstR);
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          // 백열 + 진주홍 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0xffffff);
          spawnHitParticles(particles, e.x, e.y, 0xfb923c);
          spawnHitParticles(particles, e.x, e.y, 0xc2410c);
          // 화상 DoT 등록
          this._stellarBurnTargets.set(i, STELLAR_BURN_FRAMES);
          if (e.hp <= 0) {
            this._stellarBurnTargets.delete(i);
            this.killEnemy(i);
          }
        }
      }

      // ── 블랙홀 페이즈: 강한 흡인 + DoT (사이클의 절반) ── spatialHash 재활용
      if (this.effectManager.fireDarkBlackholeActive()) {
        const center = this.effectManager.fireDarkCenter();
        const bhR = this.effectManager.fireDarkBlackholeRadius();
        const bhR2 = bhR * bhR;
        const bhCandidates = this.spatialHash.query(center.x, center.y, bhR * 2, bhR * 2, enemies.length);
        for (let ci = 0; ci < bhCandidates.length; ci++) {
          const i = bhCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= bhR2) continue;
          const dist = Math.sqrt(d2) || 1;
          const t = dist / bhR; // 0(중심) ~ 1(가장자리)

          // 흡인 (메일스트롬 4.2보다 약간 약함)
          const pull = 3.5 * (1 - t);
          if (!isBossType(e.type)) {
            e.x -= (dx / dist) * pull;
            e.y -= (dy / dist) * pull;
          }

          // 지속 데미지 (20프레임마다 8뎀)
          if (this.state.frameCount % 20 === 0) {
            e.hp -= 8;
            spawnHitParticles(particles, e.x, e.y, 0xea580c);
            spawnHitParticles(particles, e.x, e.y, 0x44181a);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 매 프레임: 화상 DoT 진행 (15f마다 6뎀, 60f → 4틱)
      if (this._stellarBurnTargets.size > 0) {
        for (const [ei, framesLeft] of this._stellarBurnTargets) {
          const e = enemies[ei];
          if (!e || !e.active) {
            this._stellarBurnTargets.delete(ei);
            continue;
          }
          const next = framesLeft - 1;
          const elapsed = 60 - next;
          if (elapsed > 0 && elapsed % 15 === 0) {
            e.hp -= 6;
            spawnHitParticles(particles, e.x, e.y, 0xea580c);
            if (e.hp <= 0) {
              this._stellarBurnTargets.delete(ei);
              this.killEnemy(ei);
              continue;
            }
          }
          if (next <= 0) {
            this._stellarBurnTargets.delete(ei);
          } else {
            this._stellarBurnTargets.set(ei, next);
          }
        }
      }

      // 개별 불/암흑 정지 (조합이 둘 다 흡수)
      this.effectManager.stopFire();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      // 폭발 위치 잠금 중에는 1단계 암흑 잠금도 풀어둠 (다음 사이클이 새 위치에서 시작)
    } else {
      this.effectManager.stopFireDark();
      this._stellarBurnTargets.clear();
    }

    // ── 물+빛+암흑 3단계: 개기일식 (Total Eclipse) ──
    // 5페이즈 사이클: COVERING → TOTALITY → CORONA_BURST → AFTERGLOW → COOLDOWN
    // COVERING 후반~TOTALITY 동안 적 스턴 + 조석 흡인
    // CORONA_BURST 1프레임에 120뎀 광역 + 넉백
    if (hasWaterLightDarkCombo) {
      this.effectManager.startWaterLightDark(px, py);
      this.effectManager.updateWaterLightDarkPosition(px, py);

      // ── 수렴 페이즈: 조석 흡인 + 스턴 ──
      if (this.effectManager.waterLightDarkShouldFreezeEnemies()) {
        const center = this.effectManager.waterLightDarkConvergeCenter();
        const lerpVal = this.effectManager.waterLightDarkConvergeLerp();
        const isConverging = this.effectManager.waterLightDarkIsConverging();
        const doTick = isConverging && (this.state.frameCount % 20 === 0);
        const RANGE = this.effectManager.waterLightDarkConvergeRange();
        const RANGE2 = RANGE * RANGE;

        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          e.stunFrames = 2;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > RANGE2) continue;
          // 조석 흡인 (수렴 페이즈만)
          if (isConverging) {
            if (!isBossType(e.type)) {
              e.x += (center.x - e.x) * lerpVal;
              e.y += (center.y - e.y) * lerpVal;
            }
          }
          // DoT
          if (doTick) {
            e.hp -= 5;
            spawnHitParticles(particles, e.x, e.y, 0x3b82f6);
            if (e.hp <= 0) {
              this.killEnemy(i);
            }
          }
        }
      }

      // ── CORONA_BURST 발동 1프레임: 광역 120뎀 + 넉백 ──
      if (this.effectManager.waterLightDarkBurstFired()) {
        const center = this.effectManager.waterLightDarkConvergeCenter();
        const burstR = this.effectManager.waterLightDarkBurstRadius();
        const burstR2 = burstR * burstR;
        const ECLIPSE_DAMAGE = 120;
        const ECLIPSE_KNOCKBACK = 55;

        const eclipseCandidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < eclipseCandidates.length; ci++) {
          const i = eclipseCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;

          e.hp -= ECLIPSE_DAMAGE;
          // 중심에 가까울수록 더 강한 넉백 (최소 30%)
          const knock = ECLIPSE_KNOCKBACK * (0.3 + 0.7 * (1 - dist / burstR));
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          // 금/보라/청 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0xfde047); // 금
          spawnHitParticles(particles, e.x, e.y, 0xa78bfa); // 보라
          spawnHitParticles(particles, e.x, e.y, 0x3b82f6); // 청
          if (e.hp <= 0) {
            this.killEnemy(i);
          }
        }
      }

      // 하위 이펙트 정지 — 개기일식이 물/빛/암흑 모두 흡수
      this.effectManager.stopWater();
      this.effectManager.stopLight();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopWaterLight();
      this.effectManager.stopWaterDark();
      this.effectManager.stopLightDark();
    } else {
      this.effectManager.stopWaterLightDark();
    }

    // ── 불+빛+암흑 3단계: 빅뱅 (Big Bang) — 우주 탄생 ──
    // 6페이즈 사이클: CONVERGE → SILENCE → FLASH → EXPLODE → EXPAND → LINGER
    // CONVERGE/SILENCE/FLASH 동안 모든 적 stunFrames + 특이점 lerp
    // EXPLODE 1프레임에 200뎀 광역 + 넉백
    if (hasFireLightDarkCombo) {
      this.effectManager.startFireLightDark(px, py);
      // ★ 매 프레임 특이점을 캐릭터 위치로 갱신 — 비대칭 수렴 방지 (하단/오른쪽 치우침 해결)
      this.effectManager.updateFireLightDarkPosition(px, py);

      // ── 수렴 페이즈: 모든 적 스턴 + 범위 내 적만 특이점 lerp ──
      if (this.effectManager.fireLightDarkShouldFreezeEnemies()) {
        const center = this.effectManager.fireLightDarkConvergeCenter();
        const lerp = this.effectManager.fireLightDarkConvergeLerp();
        const isConverging = this.effectManager.fireLightDarkConverging();
        const doTick = isConverging && (this.state.frameCount % 20 === 0);
        // 수렴 범위 — 화면 안 적만 수렴시켜 "화면 끝까지 딸려오는" 현상 방지
        const CONVERGE_RANGE = this.effectManager.fireLightDarkExplosionRadius();
        const CONVERGE_RANGE2 = CONVERGE_RANGE * CONVERGE_RANGE;
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          // 스턴 — 모든 적 (화면 전체 시간 정지 느낌)
          e.stunFrames = 2;
          // 범위 밖이면 lerp/DoT skip
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > CONVERGE_RANGE2) continue;
          // 특이점으로 lerp
          if (!isBossType(e.type)) {
            e.x += (center.x - e.x) * lerp;
            e.y += (center.y - e.y) * lerp;
          }
          // CONVERGE 동안 20f마다 5뎀 DoT
          if (doTick) {
            e.hp -= 5;
            spawnHitParticles(particles, e.x, e.y, 0x8b5cf6);
            if (e.hp <= 0) {
              this.killEnemy(i);
            }
          }
        }
      }

      // ── EXPLODE 발동 1프레임: 광역 200뎀 + 넉백 ──
      if (this.effectManager.fireLightDarkExplosionFired()) {
        const center = this.effectManager.fireLightDarkConvergeCenter();
        const burstR = this.effectManager.fireLightDarkExplosionRadius();
        const burstR2 = burstR * burstR;
        const BIGBANG_DAMAGE = 200;
        const BIGBANG_KNOCKBACK = 35;

        const bigbangCandidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < bigbangCandidates.length; ci++) {
          const i = bigbangCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;

          e.hp -= BIGBANG_DAMAGE;
          // 외측 넉백
          const knock = BIGBANG_KNOCKBACK * (1 - dist / burstR);
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          // 보라/금/마그마 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0x8b5cf6);
          spawnHitParticles(particles, e.x, e.y, 0xfacc15);
          spawnHitParticles(particles, e.x, e.y, 0xf97316);
          if (e.hp <= 0) {
            this.killEnemy(i);
          }
        }
      }

      // 하위 이펙트 전부 정지 — 빅뱅이 불/빛/암흑 모두 흡수
      this.effectManager.stopFire();
      this.effectManager.stopLight();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopFireLight();
      this.effectManager.stopFireDark();
      this.effectManager.stopLightDark();
    } else {
      this.effectManager.stopFireLightDark();
    }

    // ── 빛+전기+암흑 3단계: 심연 진동 (Voidpulse Cascade) ──
    // 물+빛+전기(Prism Cascade) 구조 미러링. 팔레트만 다크 퍼플, 임팩트는 5초 지속 작은 중력장.
    //   상시 수렴 → chargeT 완료 → 최대 20마리 유도 암흑 레이저 → 명중 시 체인 + 중력장 스폰
    if (hasLightElectricDarkCombo) {
      this.effectManager.startLightElectricDark(px, py);
      this.effectManager.updateLightElectricDarkPosition(px, py);

      // ── 상수 ──
      const SJ_BURST_RANGE = 460;             // 수렴점 기준 타겟 수집 반경
      const SJ_BEAM_DMG = 42;                 // 유도 레이저 명중 피해
      const SJ_CHAIN_RANGE = 160;
      const SJ_CHAIN_COUNT = 3;
      const SJ_CHAIN_DMG = 20;
      const SJ_CHAIN_STUN = 12;
      const SJ_GRAVITY_LERP = 0.04;           // 중력장 흡인 (프레임당 lerp)
      const SJ_GRAVITY_TICK_INTERVAL = 15;    // 중력장 내 15f마다 tick dmg
      const SJ_GRAVITY_TICK_DMG = 2;

      // 유도 레이저 추적 (규칙 5 — 매 프레임)
      this.effectManager.updateLightElectricDarkHoming(1, enemies);

      // 충전 완료 시 타겟 수집 → 이펙트에 전달 (최대 N마리)
      if (this.effectManager.lightElectricDarkChargeReady()) {
        const center = this.effectManager.lightElectricDarkGatherPoint() ?? { x: px, y: py };
        const maxN = this.effectManager.lightElectricDarkMaxStrikeTargets();
        const cands = this.findClosestEnemies(center.x, center.y, SJ_BURST_RANGE, maxN);
        const targets = cands.map(c => ({
          worldX: enemies[c.idx].x,
          worldY: enemies[c.idx].y,
          enemyIdx: c.idx,
        }));
        this.effectManager.setLightElectricDarkStrikeTargets(targets);
      }

      // 이번 프레임 명중 처리
      const hits = this.effectManager.lightElectricDarkHits();
      if (hits.length > 0) {
        const chainLinesBatch: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
        for (const h of hits) {
          const e = enemies[h.targetIdx];
          if (!e || !e.active) continue;

          // 주 피해
          e.hp -= SJ_BEAM_DMG;
          if (!isBossType(e.type)) {
            e.stunFrames = Math.max(e.stunFrames ?? 0, 8);
          }
          spawnHitParticles(particles, e.x, e.y, 0x8b5cf6);
          spawnHitParticles(particles, e.x, e.y, 0xc4b5fd);
          const hx = e.x;
          const hy = e.y;
          const killed = e.hp <= 0;
          if (killed) this.killEnemy(h.targetIdx);

          // 명중점에 5초 지속 중력장 스폰
          this.effectManager.spawnLightElectricDarkGravity(h.hitX, h.hitY);

          // 체인 전기 — 주변 3마리
          const chainCands = this.spatialHash.query(hx, hy, SJ_CHAIN_RANGE * 2, SJ_CHAIN_RANGE * 2, enemies.length);
          const chainR2 = SJ_CHAIN_RANGE * SJ_CHAIN_RANGE;
          const picks: Array<{ idx: number; d2: number }> = [];
          for (let ci = 0; ci < chainCands.length; ci++) {
            const i = chainCands[ci];
            if (i === h.targetIdx) continue;
            const en = enemies[i];
            if (!en.active) continue;
            const ddx = en.x - hx;
            const ddy = en.y - hy;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 > chainR2) continue;
            picks.push({ idx: i, d2 });
          }
          picks.sort((a, b) => a.d2 - b.d2);
          const top = picks.slice(0, SJ_CHAIN_COUNT);
          let prevX = hx, prevY = hy;
          for (const p of top) {
            const ce = enemies[p.idx];
            chainLinesBatch.push({ x0: prevX, y0: prevY, x1: ce.x, y1: ce.y });
            ce.hp -= SJ_CHAIN_DMG;
            if (!isBossType(ce.type)) {
              ce.stunFrames = Math.max(ce.stunFrames ?? 0, SJ_CHAIN_STUN);
            }
            spawnHitParticles(particles, ce.x, ce.y, 0x8b5cf6);
            spawnHitParticles(particles, ce.x, ce.y, 0xc4b5fd);
            prevX = ce.x;
            prevY = ce.y;
            if (ce.hp <= 0) this.killEnemy(p.idx);
          }
        }
        if (chainLinesBatch.length > 0) {
          this.effectManager.addLightElectricDarkChainLines(chainLinesBatch);
        }
      }

      // 활성 중력장 → 내부 적 흡인 + 주기적 DoT
      const gravities = this.effectManager.lightElectricDarkGravities();
      if (gravities.length > 0) {
        const gR = this.effectManager.lightElectricDarkGravityRadius();
        const gR2 = gR * gR;
        const doTick = this.state.frameCount % SJ_GRAVITY_TICK_INTERVAL === 0;
        for (const g of gravities) {
          const cands = this.spatialHash.query(g.x, g.y, gR * 2, gR * 2, enemies.length);
          for (let ci = 0; ci < cands.length; ci++) {
            const i = cands[ci];
            const en = enemies[i];
            if (!en.active) continue;
            const ddx = g.x - en.x;
            const ddy = g.y - en.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 > gR2) continue;
            if (!isBossType(en.type)) {
              en.x += ddx * SJ_GRAVITY_LERP;
              en.y += ddy * SJ_GRAVITY_LERP;
            }
            if (doTick) {
              en.hp -= SJ_GRAVITY_TICK_DMG;
              if (en.hp <= 0) this.killEnemy(i);
            }
          }
        }
      }

      // 하위 이펙트 전부 정지 — 별자리 재단이 빛/전기/암흑 모두 흡수
      this.effectManager.stopLight();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopLightElectric();
      this.effectManager.stopElectricDark();
      this.effectManager.stopLightDark();
    } else {
      this.effectManager.stopLightElectricDark();
    }

    // ── 흙+불+암흑 3단계: 심연균열 (Abyssal Rift) ──
    // X자 2대각선 바닥 균열 (45°/135°) — 배경/장판/게이트 없음, 크랙만.
    // 매 프레임: 가까운 크랙 라인으로 약한 끌어당김 (lerp 0.028)
    // 주기적 버스트 (~2.17초): X 전체 펑 + 크랙 근접 적 광역 피해 + 외측 넉백
    if (hasEarthFireDarkCombo) {
      this.effectManager.startEarthFireDark(px, py);
      this.effectManager.updateEarthFireDarkPosition(px, py);

      const segments = this.effectManager.earthFireDarkCrackSegments();
      const pullRange = this.effectManager.earthFireDarkPullRange();
      const pullRange2 = pullRange * pullRange;
      const pullLerp = this.effectManager.earthFireDarkPullLerp();

      // ── 매 프레임: 가까운 크랙 라인으로 끌어당김 ──
      if (segments.length > 0) {
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          if (isBossType(e.type)) continue; // pull 대상 아님

          // 가장 가까운 세그먼트 상 점 찾기
          let minD2 = Infinity;
          let nearestX = e.x;
          let nearestY = e.y;
          const ex = e.x;
          const ey = e.y;
          for (let k = 0; k < segments.length; k++) {
            const seg = segments[k];
            const invSegLen2 = seg.invSegLen2;
            if (invSegLen2 === 0) continue;
            let t = ((ex - seg.x0) * seg.sx + (ey - seg.y0) * seg.sy) * invSegLen2;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const cx = seg.x0 + seg.sx * t;
            const cy = seg.y0 + seg.sy * t;
            const ddx = ex - cx;
            const ddy = ey - cy;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < minD2) {
              minD2 = d2;
              nearestX = cx;
              nearestY = cy;
            }
          }
          if (minD2 < pullRange2) {
            e.x += (nearestX - e.x) * pullLerp;
            e.y += (nearestY - e.y) * pullLerp;
          }
        }
      }

      // ── 버스트 발동: 설치 크랙의 세그먼트 기준 광역 피해 + 대규모 3색 폭발 파티클 ──
      if (this.effectManager.earthFireDarkBurstFired() && segments.length > 0) {
        const hitThresh = this.effectManager.earthFireDarkBurstHitThreshold();
        const hitThresh2 = hitThresh * hitThresh;
        const dmg = this.effectManager.earthFireDarkBurstDamage();
        const knock = this.effectManager.earthFireDarkBurstKnockback();

        // ── 1) 중앙 + 4 tip 지점에 엔진 폭발 파티클 (흙/불/암흑 3색) ──
        const installedCen = this.effectManager.earthFireDarkInstalledCenter();
        const installedTips = this.effectManager.earthFireDarkInstalledTips();

        // 중앙: 큰 폭발
        spawnExplosionParticles(particles, installedCen.x, installedCen.y, 0x1c1917, 30); // stone-900 (흙)
        spawnExplosionParticles(particles, installedCen.x, installedCen.y, 0xea580c, 30); // orange-600 (불)
        spawnExplosionParticles(particles, installedCen.x, installedCen.y, 0x4c1d95, 30); // violet-900 (암흑)

        // 4 tip: 작은 폭발
        for (const tip of installedTips) {
          spawnExplosionParticles(particles, tip.x, tip.y, 0x44403c, 14); // stone-700 (흙)
          spawnExplosionParticles(particles, tip.x, tip.y, 0xf97316, 14); // orange-500 (불)
          spawnExplosionParticles(particles, tip.x, tip.y, 0x6d28d9, 14); // violet-700 (암흑)
        }

        // ── 2) 크랙 라인 근접 적에 광역 피해 + 넉백 ──
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;

          let hit = false;
          let hitCx = 0;
          let hitCy = 0;
          const ex = e.x;
          const ey = e.y;
          for (let k = 0; k < segments.length; k++) {
            const seg = segments[k];
            const invSegLen2 = seg.invSegLen2;
            if (invSegLen2 === 0) continue;
            let t = ((ex - seg.x0) * seg.sx + (ey - seg.y0) * seg.sy) * invSegLen2;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const cx = seg.x0 + seg.sx * t;
            const cy = seg.y0 + seg.sy * t;
            const ddx = ex - cx;
            const ddy = ey - cy;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < hitThresh2) {
              hit = true;
              hitCx = cx;
              hitCy = cy;
              break;
            }
          }

          if (hit) {
            e.hp -= dmg;
            spawnHitParticles(particles, e.x, e.y, 0x44403c); // stone-700 (흙)
            spawnHitParticles(particles, e.x, e.y, 0xf97316); // orange-500 (불)
            spawnHitParticles(particles, e.x, e.y, 0x6d28d9); // violet-700 (암흑)
            // 외측 넉백 — 크랙에서 수직 방향
            const kdx = e.x - hitCx;
            const kdy = e.y - hitCy;
            const kd = Math.sqrt(kdx * kdx + kdy * kdy) || 1;
            if (!isBossType(e.type)) {
              e.x += (kdx / kd) * knock;
              e.y += (kdy / kd) * knock;
            }
            if (e.hp <= 0) {
              this.killEnemy(i);
            }
          }
        }
      }

      // 하위 이펙트 전부 정지 — 심연균열이 흙/불/암흑 모두 흡수
      this.effectManager.stopEarth();
      this.effectManager.stopFire();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopEarthFire();
      this.effectManager.stopFireDark();
      this.effectManager.stopEarthDark();
    } else {
      this.effectManager.stopEarthFireDark();
    }

    // ── 불+전기+암흑 3단계: 연쇄 폭뢰 (Chain Detonation) ──
    // 핵분열 연쇄반응: 1→3→9→... 다분기 동시 폭발.
    // 암흑 마킹 → 화염 폭발 → 전기 아크 3갈래 전이 → 각각 마킹 → 폭발 → ...
    if (hasFireElectricDarkCombo) {
      this.effectManager.startFireElectricDark();

      const FED_MARK_FIRST = 40;   // 첫 마크 대기 (프레임) — 암흑 마크 충분히 보임
      const FED_MARK_BRANCH = 18;  // 분기 마크 대기 — 연쇄 과정이 눈에 보이는 속도
      const FED_BRANCHES = 3;      // 폭발당 분기 수
      const FED_COOLDOWN = 110;
      const FED_RANGE = 450;       // 첫 타겟 탐색 범위
      const FED_HOP_RANGE = 250;   // 분기 탐색 범위
      const FED_BURST_R = 90;      // 폭발 광역 반경
      const FED_BURST_DMG = 60;    // 폭발 직격 뎀
      const FED_SPLASH_DMG = 30;   // 폭발 주변 뎀
      const FED_CHAIN_DMG = 20;    // 전기 전이 뎀
      const FED_KNOCKBACK = 22;    // 폭발 넉백

      // ── 새 체인 시작 ──
      if (this._fedPending.length === 0) {
        this._fedCooldown += 1;
        if (this._fedCooldown >= FED_COOLDOWN) {
          const R2 = FED_RANGE * FED_RANGE;
          let bestIdx = -1, bestD2 = R2;
          const initialCandidates = this.spatialHash.query(px, py, FED_RANGE * 2, FED_RANGE * 2, enemies.length);
          for (let ci = 0; ci < initialCandidates.length; ci++) {
            const i = initialCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - px, dy = e.y - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
          }
          if (bestIdx >= 0) {
            const e = enemies[bestIdx];
            this._fedPending = [{ idx: bestIdx, x: e.x, y: e.y, timer: FED_MARK_FIRST }];
            this._fedUsed.clear();
            this._fedUsed.add(bestIdx);
            this._fedCooldown = 0;
            this.effectManager.addFEDMark(e.x, e.y, FED_MARK_FIRST);
          }
        }
      }

      // ── 활성 체인: 모든 pending 동시 처리 ──
      if (this._fedPending.length > 0) {
        const newPending: typeof this._fedPending = [];

        for (let pi = this._fedPending.length - 1; pi >= 0; pi--) {
          const p = this._fedPending[pi];
          p.timer -= 1;
          if (p.timer > 0) {
            newPending.push(p);
            continue;
          }

          // ── 타이머 만료 → 폭발! ──
          const te = enemies[p.idx];
          const detX = (te && te.active) ? te.x : p.x;
          const detY = (te && te.active) ? te.y : p.y;

          // 화염 폭발 비주얼
          this.effectManager.addFEDExplosion(detX, detY);

          // 직격 뎀
          if (te && te.active) {
            te.hp -= FED_BURST_DMG;
            spawnHitParticles(particles, te.x, te.y, 0xef4444);
            spawnHitParticles(particles, te.x, te.y, 0xf97316);
            if (te.hp <= 0) this.killEnemy(p.idx);
          }

          // 광역 스플래시 + 넉백 (spatialHash로 근처 후보만 순회)
          const BR2 = FED_BURST_R * FED_BURST_R;
          const splashCandidates = this.spatialHash.query(detX, detY, FED_BURST_R * 2, FED_BURST_R * 2, enemies.length);
          for (let ci = 0; ci < splashCandidates.length; ci++) {
            const i = splashCandidates[ci];
            const e = enemies[i];
            if (!e.active || i === p.idx) continue;
            const dx = e.x - detX, dy = e.y - detY;
            const d2 = dx * dx + dy * dy;
            if (d2 > BR2) continue;
            const dist = Math.sqrt(d2) || 1;
            e.hp -= FED_SPLASH_DMG;
            const knock = FED_KNOCKBACK * (1 - dist / FED_BURST_R);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
            spawnHitParticles(particles, e.x, e.y, 0xf97316);
            if (e.hp <= 0) this.killEnemy(i);
          }

          // ── 전기 분기: 가까운 적 최대 3마리에게 전이 (spatialHash로 후보 수집) ──
          const HR2 = FED_HOP_RANGE * FED_HOP_RANGE;
          const candidates: { idx: number; d2: number }[] = [];
          const branchCandidates = this.spatialHash.query(detX, detY, FED_HOP_RANGE * 2, FED_HOP_RANGE * 2, enemies.length);
          for (let ci = 0; ci < branchCandidates.length; ci++) {
            const i = branchCandidates[ci];
            const e = enemies[i];
            if (!e.active || this._fedUsed.has(i)) continue;
            const dx = e.x - detX, dy = e.y - detY;
            const d2 = dx * dx + dy * dy;
            if (d2 < HR2) candidates.push({ idx: i, d2 });
          }
          // 가까운 순 정렬, 최대 BRANCHES개
          candidates.sort((a, b) => a.d2 - b.d2);
          const branchCount = Math.min(FED_BRANCHES, candidates.length);

          for (let bi = 0; bi < branchCount; bi++) {
            const ne = enemies[candidates[bi].idx];
            const nIdx = candidates[bi].idx;
            this._fedUsed.add(nIdx);

            // 전기 아크 비주얼
            this.effectManager.addFEDArc(detX, detY, ne.x, ne.y);
            // 전기 전이 뎀
            ne.hp -= FED_CHAIN_DMG;
            spawnHitParticles(particles, ne.x, ne.y, 0x22d3ee);
            if (ne.hp <= 0) this.killEnemy(nIdx);

            // 다음 웨이브에 추가 (암흑 마크)
            this.effectManager.addFEDMark(ne.x, ne.y, FED_MARK_BRANCH);
            newPending.push({ idx: nIdx, x: ne.x, y: ne.y, timer: FED_MARK_BRANCH });
          }
        }

        this._fedPending = newPending;
      }

      // 하위 이펙트 정지 — 연쇄 폭뢰가 불/전기/암흑 모두 흡수
      this.effectManager.stopFire();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopFireElectric();
      this.effectManager.stopFireDark();
      this.effectManager.stopElectricDark();
    } else {
      this.effectManager.stopFireElectricDark();
      this._fedPending = [];
      this._fedUsed.clear();
      this._fedCooldown = 0;
    }

    // ── 흙+빛+암흑 3단계: 천지섬광 (Earth Flash) ──
    // 시전 위치 고정. 흙 퍼짐 → 블랙홀 흡인 → 섬광 폭발.
    // SPREAD: 흙 퍼짐 + 광자 수렴 시작
    // CONVERGE: 블랙홀이 흙+몬스터 흡인, 광자 급격 수렴
    // FLASH: 섬광 90뎀 + 넉백 35
    if (hasEarthLightDarkCombo) {
      // 시전 위치에서 시작 (따라다니지 않음)
      this.effectManager.startEarthLightDark(px, py);

      // ── CONVERGE: 블랙홀 몬스터 흡인 ──
      if (this.effectManager.earthLightDarkIsConverging()) {
        const anchor = this.effectManager.earthLightDarkAnchor();
        const pullLerp = this.effectManager.earthLightDarkConvergeLerp();
        const range = this.effectManager.earthLightDarkConvergeRange();
        const range2 = range * range;

        const convergeCandidates = this.spatialHash.query(anchor.x, anchor.y, range * 2, range * 2, enemies.length);
        for (let ci = 0; ci < convergeCandidates.length; ci++) {
          const i = convergeCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - anchor.x;
          const dy = e.y - anchor.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > range2) continue;
          if (!isBossType(e.type)) {
            e.x += (anchor.x - e.x) * pullLerp;
            e.y += (anchor.y - e.y) * pullLerp;
          }
        }
      }

      // ── FLASH: 섬광 데미지 + 넉백 ──
      if (this.effectManager.earthLightDarkFlashFired()) {
        const anchor = this.effectManager.earthLightDarkAnchor();
        const flashR = this.effectManager.earthLightDarkFlashRadius();
        const flashR2 = flashR * flashR;

        const flashCandidates = this.spatialHash.query(anchor.x, anchor.y, flashR * 2, flashR * 2, enemies.length);
        for (let ci = 0; ci < flashCandidates.length; ci++) {
          const i = flashCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - anchor.x;
          const dy = e.y - anchor.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > flashR2) continue;
          const dist = Math.sqrt(d2) || 1;

          e.hp -= 90;
          const knock = 35 * (0.3 + 0.7 * (1 - dist / flashR));
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          spawnHitParticles(particles, e.x, e.y, 0xfde047);
          spawnHitParticles(particles, e.x, e.y, 0xfef08a);
          spawnHitParticles(particles, e.x, e.y, 0x8b5cf6);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 하위 이펙트 정지
      this.effectManager.stopEarth();
      this.effectManager.stopLight();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
      this.effectManager.stopEarthLight();
      this.effectManager.stopEarthDark();
      this.effectManager.stopLightDark();
    } else {
      this.effectManager.stopEarthLightDark();
    }

    // ── 물+불+전기 3단계: 증기폭뢰 (Steam Thunderbolt) ──
    // 증기 압력 축적(PRESSURE) → 임계 압축(CRITICAL) → 전기 방전 대폭발(RELEASE)
    if (hasWaterFireElectricCombo) {
      this.effectManager.startWaterFireElectric(px, py);
      this.effectManager.updateWaterFireElectricPosition(px, py);

      // ── PRESSURE: 열 틱 데미지 ──
      if (this.effectManager.waterFireElectricIsPressuring()) {
        if (this.state.frameCount % 12 === 0) {
          const heatR = this.effectManager.waterFireElectricHeatRange();
          const heatR2 = heatR * heatR;
          const heatCandidates = this.spatialHash.query(px, py, heatR * 2, heatR * 2, enemies.length);
          for (let ci = 0; ci < heatCandidates.length; ci++) {
            const i = heatCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - px, dy = e.y - py;
            if (dx * dx + dy * dy < heatR2) {
              e.hp -= 5;
              spawnHitParticles(particles, e.x, e.y, 0xfb923c);
              if (e.hp <= 0) this.killEnemy(i);
            }
          }
        }
      }

      // ── RELEASE: 대폭발 + 넉백 + 전기 체인 전이 ──
      if (this.effectManager.waterFireElectricReleaseFired()) {
        const burstR = this.effectManager.waterFireElectricBurstRadius();
        const burstR2 = burstR * burstR;

        // 1) 폭발 데미지 + 넉백
        const hitIndices: number[] = [];
        const releaseCandidates = this.spatialHash.query(px, py, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < releaseCandidates.length; ci++) {
          const i = releaseCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px, dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 > burstR2) continue;
          const dist = Math.sqrt(d2) || 1;

          e.hp -= 85;
          const knock = 30 * (0.3 + 0.7 * (1 - dist / burstR));
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          spawnHitParticles(particles, e.x, e.y, 0xfb923c);
          spawnHitParticles(particles, e.x, e.y, 0xfde047);
          hitIndices.push(i);
          if (e.hp <= 0) this.killEnemy(i);
        }

        // 2) 전기 체인 — 맞은 적 전원에서 동시 확산 (거미줄)
        //    각 피격 적이 시작점, 가장 가까운 미피격 적으로 체인 → 그 적도 시작점 추가 → 반복
        if (hitIndices.length > 0) {
          const chainUsed = new Set<number>(hitIndices);
          const HOP_R2 = 250 * 250;
          const CHAIN_DMG = 20;
          // 현재 웨이브 = 폭발에 맞은 적들
          let wave = hitIndices.filter(idx => enemies[idx].active);

          const HOP_R = 250;
          for (let depth = 0; depth < 4 && wave.length > 0; depth++) {
            const nextWave: number[] = [];
            for (const srcIdx of wave) {
              const src = enemies[srcIdx];
              if (!src.active) continue;
              // 각 시작점에서 가장 가까운 미피격 적 1~2마리로 체인
              const branches = depth === 0 ? 2 : 1;
              // SpatialHash 후보 → 먼저 후보 복사 (다음 query 전에 소비 필수)
              const cand = this.spatialHash.query(src.x, src.y, HOP_R * 2, HOP_R * 2, enemies.length);
              const candidateCopy = cand.slice(); // branch 처리 중 killEnemy가 다시 query 호출할 수 있어 복사
              const found: { idx: number; d2: number }[] = [];
              for (let ci = 0; ci < candidateCopy.length; ci++) {
                const ei = candidateCopy[ci];
                if (chainUsed.has(ei) || !enemies[ei].active) continue;
                const cdx = enemies[ei].x - src.x;
                const cdy = enemies[ei].y - src.y;
                const cd2 = cdx * cdx + cdy * cdy;
                if (cd2 < HOP_R2) found.push({ idx: ei, d2: cd2 });
              }
              found.sort((a, b) => a.d2 - b.d2);
              const branchCount = Math.min(branches, found.length);
              for (let bi = 0; bi < branchCount; bi++) {
                const tgtIdx = found[bi].idx;
                const tgt = enemies[tgtIdx];
                chainUsed.add(tgtIdx);
                // 체인 데미지
                tgt.hp -= CHAIN_DMG;
                spawnHitParticles(particles, tgt.x, tgt.y, 0x22d3ee);
                if (tgt.hp <= 0) this.killEnemy(tgtIdx);
                // 체인 비주얼 (src → tgt)
                this.effectManager.fireWaterFireElectricChain([
                  { x: src.x, y: src.y },
                  { x: tgt.x, y: tgt.y },
                ]);
                nextWave.push(tgtIdx);
              }
            }
            wave = nextWave;
          }
        }
      }

      // 하위 이펙트 정지
      this.effectManager.stopWater();
      this.effectManager.stopFire();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopWaterFire();
      this.effectManager.stopWaterElectric();
      this.effectManager.stopFireElectric();
      this._fireElectricTimer = 0;
      this._fireElectricChainNodes = [];
      this._fireElectricPendingExplosions = [];
    } else {
      this.effectManager.stopWaterFireElectric();
    }

    // ── 물+흙+불 3단계: 원소 유성우 (Elemental Meteor Storm) ──
    // 불 유성 → 마그마 장판 DoT, 물 유성 → 파동 넉백
    if (hasWaterEarthFireCombo) {
      this.effectManager.startWaterEarthFire(px, py);
      this.effectManager.updateWaterEarthFirePosition(px, py);

      const impR = this.effectManager.waterEarthFireImpactRadius();
      const impR2 = impR * impR;

      // 착탄 — 전 유성 직격 뎀 + 타입별 추가 효과
      const imps = this.effectManager.waterEarthFireImpacts();
      for (const imp of imps) {
        const impCandidates = this.spatialHash.query(imp.x, imp.y, impR * 2, impR * 2, enemies.length);
        for (let ci = 0; ci < impCandidates.length; ci++) {
          const i = impCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - imp.x, dy = e.y - imp.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > impR2) continue;
          const dist = Math.sqrt(d2) || 1;
          e.hp -= 14;
          // 물 유성: 추가 넉백
          if (imp.type === 2) {
            const knock = 16 * (1 - dist / impR);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
          }
          const hitColor = imp.type === 0 ? 0xf97316 : imp.type === 1 ? 0xd4a53c : 0x3b82f6;
          spawnHitParticles(particles, e.x, e.y, hitColor);
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 장판 효과 (매 12f): 마그마=DoT, 정지=스턴, 소용돌이=흡인
      if (this.state.frameCount % 12 === 0) {
        const puddles = this.effectManager.waterEarthFirePuddles();
        for (const p of puddles) {
          const pr2 = p.radius * p.radius;
          const puddleCandidates = this.spatialHash.query(p.x, p.y, p.radius * 2, p.radius * 2, enemies.length);
          for (let ci = 0; ci < puddleCandidates.length; ci++) {
            const i = puddleCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - p.x, dy = e.y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > pr2) continue;
            if (p.type === 0) {
              // 마그마: DoT
              e.hp -= 4;
              spawnHitParticles(particles, e.x, e.y, 0xef4444);
            } else if (p.type === 1) {
              // 정지: 스턴
              e.stunFrames = Math.max(e.stunFrames ?? 0, 15);
            } else {
              // 소용돌이: 흡인 (보스 면제)
              const dist = Math.sqrt(d2) || 1;
              if (!isBossType(e.type)) {
                e.x += (p.x - e.x) * 0.04;
                e.y += (p.y - e.y) * 0.04;
              }
            }
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 하위 이펙트 정지 — 다른 슬롯에서 같은 2원소 조합이 활성 중이면 유지
      this.effectManager.stopWater();
      this.effectManager.stopEarth();
      this.effectManager.stopFire();
      if (!hasWaterEarthCombo) this.effectManager.stopWaterEarth();
      if (!hasWaterFireCombo) this.effectManager.stopWaterFire();
      if (!hasEarthFireCombo) this.effectManager.stopEarthFire();
    } else {
      this.effectManager.stopWaterEarthFire();
    }

    // ── 흙+불+전기 3단계: 화산뇌 (Volcanic Thunder) ──
    // 유성우 패턴 (연속 운석 낙하) + 불색 + 착탄 시 전기 체인 확산
    if (hasEarthFireElectricCombo) {
      this.effectManager.startEarthFireElectric(px, py);
      this.effectManager.updateEarthFireElectricPosition(px, py);

      const impacts = this.effectManager.earthFireElectricImpactsThisFrame();
      if (impacts.length > 0) {
        const impR = this.effectManager.earthFireElectricImpactRadius();
        const impR2 = impR * impR;
        const METEOR_DMG = 18;
        const METEOR_KNOCK = 8;
        const CHAIN_DMG = 12;
        const CHAIN_HOP_R2 = 180 * 180;

        for (const impact of impacts) {
          // 1) 착탄 데미지 + 넉백
          const hitIndices: number[] = [];
          const impactCandidates = this.spatialHash.query(impact.x, impact.y, impR * 2, impR * 2, enemies.length);
          for (let ci = 0; ci < impactCandidates.length; ci++) {
            const i = impactCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - impact.x, dy = e.y - impact.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > impR2) continue;
            const dist = Math.sqrt(d2) || 1;
            e.hp -= METEOR_DMG;
            const knock = METEOR_KNOCK * (1 - dist / impR);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
            spawnHitParticles(particles, e.x, e.y, 0xf97316);
            hitIndices.push(i);
            if (e.hp <= 0) this.killEnemy(i);
          }

          // 2) 전기 체인 — 피격 적에서 주변으로 확산
          const chainUsed = new Set<number>(hitIndices);
          let wave = hitIndices.filter(idx => enemies[idx].active);
          const CHAIN_HOP_R = 180;
          for (let depth = 0; depth < 3 && wave.length > 0; depth++) {
            const nextWave: number[] = [];
            for (const srcIdx of wave) {
              const src = enemies[srcIdx];
              if (!src.active) continue;
              const cand = this.spatialHash.query(src.x, src.y, CHAIN_HOP_R * 2, CHAIN_HOP_R * 2, enemies.length);
              const candCopy = cand.slice();
              let bestIdx = -1, bestD2 = CHAIN_HOP_R2;
              for (let ci = 0; ci < candCopy.length; ci++) {
                const ei = candCopy[ci];
                if (chainUsed.has(ei) || !enemies[ei].active) continue;
                const cdx = enemies[ei].x - src.x;
                const cdy = enemies[ei].y - src.y;
                const cd2 = cdx * cdx + cdy * cdy;
                if (cd2 < bestD2) { bestD2 = cd2; bestIdx = ei; }
              }
              if (bestIdx < 0) continue;
              chainUsed.add(bestIdx);
              enemies[bestIdx].hp -= CHAIN_DMG;
              spawnHitParticles(particles, enemies[bestIdx].x, enemies[bestIdx].y, 0x22d3ee);
              this.effectManager.addEarthFireElectricChain(src.x, src.y, enemies[bestIdx].x, enemies[bestIdx].y);
              if (enemies[bestIdx].hp <= 0) this.killEnemy(bestIdx);
              nextWave.push(bestIdx);
            }
            wave = nextWave;
          }
        }
      }

      // 하위 이펙트 정지
      this.effectManager.stopEarth();
      this.effectManager.stopFire();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopEarthFire();
      this.effectManager.stopEarthElectric();
      this.effectManager.stopFireElectric();
      this._fireElectricTimer = 0;
      this._fireElectricChainNodes = [];
      this._fireElectricPendingExplosions = [];
    } else {
      this.effectManager.stopEarthFireElectric();
    }

    // ── 흙+불+빛 3단계: 천붕 운석 (Empyrean Meteor) ──
    // 5초 사이클: WARNING(25f) → FALLING(55f) → EMBEDDED(80f, 진동 전조) → DETONATION(70f) → RESTING(70f)
    // DETONATION 진입 1프레임에만 광역 데미지/스턴/넉백 발동.
    if (hasEarthFireLightCombo) {
      this.effectManager.startEarthFireLight(px, py);
      this.effectManager.updateEarthFireLightPosition(px, py);

      const impacts = this.effectManager.earthFireLightImpactsThisFrame();
      if (impacts.length > 0) {
        const impR = this.effectManager.earthFireLightImpactRadius();
        const impR2 = impR * impR;
        const METEOR_DMG = 280;
        const KNOCKBACK = 40;
        const STUN_FRAMES = 120;
        for (const impact of impacts) {
          const empyreanCandidates = this.spatialHash.query(impact.x, impact.y, impR * 2, impR * 2, enemies.length);
          for (let ci = 0; ci < empyreanCandidates.length; ci++) {
            const i = empyreanCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - impact.x, dy = e.y - impact.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > impR2) continue;
            const dist = Math.sqrt(d2) || 1;
            // 거리 감쇠: 중심 1.0 → 외곽 0.5
            const distFactor = 1 - (dist / impR) * 0.5;
            e.hp -= METEOR_DMG * distFactor;
            const knock = KNOCKBACK * (1 - dist / impR);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
            e.stunFrames = Math.max(e.stunFrames ?? 0, STUN_FRAMES);
            spawnHitParticles(particles, e.x, e.y, 0xf97316);
            spawnHitParticles(particles, e.x, e.y, 0xfef08a);
            spawnHitParticles(particles, e.x, e.y, 0x44403c);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 하위 이펙트 정지
      this.effectManager.stopEarth();
      this.effectManager.stopFire();
      this.effectManager.stopLight();
      this.effectManager.stopEarthFire();
      this.effectManager.stopFireLight();
      this.effectManager.stopEarthLight();
    } else {
      this.effectManager.stopEarthFireLight();
    }

    // ── 물+흙+암흑 3단계: 은하 소용돌이 (Galactic Vortex) ──
    // 설치형 — 영역 내 적은 중심 lerp + swirl 회전, 코어 닿으면 즉사
    if (hasWaterEarthDarkCombo) {
      this.effectManager.startWaterEarthDark(px, py);
      this.effectManager.updateWaterEarthDarkPosition(px, py);

      if (this.effectManager.waterEarthDarkIsAbsorbing()) {
        const center = this.effectManager.waterEarthDarkCenter();
        const killR = this.effectManager.waterEarthDarkKillRadius();
        const gravityR = this.effectManager.waterEarthDarkGravityRadius();
        const gravityR2 = gravityR * gravityR;
        const strength = this.effectManager.waterEarthDarkAbsorbStrength();
        const absorbCandidates = this.spatialHash.query(center.x, center.y, gravityR * 2, gravityR * 2, enemies.length);
        for (let ci = 0; ci < absorbCandidates.length; ci++) {
          const i = absorbCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - center.x;
          const dy = e.y - center.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > gravityR2) continue; // 매우 먼 적은 skip (효율)
          const dist = Math.sqrt(d2);
          // 즉사 판정
          if (dist <= killR) {
            this.effectManager.waterEarthDarkSpawnAbsorb(e.x, e.y);
            spawnHitParticles(particles, e.x, e.y, 0xfde68a);
            spawnHitParticles(particles, e.x, e.y, 0x7e22ce);
            this.killEnemy(i);
            continue;
          }
          // radial lerp + swirl 회전 — 보스는 면역
          if (isBossType(e.type)) continue;
          const lerp = this.effectManager.waterEarthDarkPullLerpAt(dist) * strength;
          if (lerp <= 0) continue;
          const swirl = this.effectManager.waterEarthDarkSwirlRateAt(dist) * strength;
          if (swirl > 0.0001 && dist > 0.5) {
            const cosS = Math.cos(swirl);
            const sinS = Math.sin(swirl);
            const rx = dx * cosS - dy * sinS;
            const ry = dx * sinS + dy * cosS;
            e.x = center.x + rx;
            e.y = center.y + ry;
          }
          e.x += (center.x - e.x) * lerp;
          e.y += (center.y - e.y) * lerp;
        }
      }

      // 하위 이펙트 정지 — 다른 슬롯에서 같은 2원소 조합이 활성 중이면 유지
      this.effectManager.stopWater();
      this.effectManager.stopEarth();
      this.effectManager.stopDark();
      if (!hasWaterEarthCombo) this.effectManager.stopWaterEarth();
      if (!hasWaterDarkCombo) this.effectManager.stopWaterDark();
      if (!hasEarthDarkCombo) this.effectManager.stopEarthDark();
    } else {
      this.effectManager.stopWaterEarthDark();
    }

    // ── 물+빛+전기 3단계: 프리즘 캐스케이드 (Prism Cascade) ──
    // 반원 돔이 플레이어 머리 위 상시 존재 → 기 모음 (chargeT 0→1) → 20마리로 곡선 유도 레이저 발사
    // → 각 레이저 유도 비행 → 명중 → 3원소 임팩트 + 몬스터간 전기 체인 확산
    // → 반복 (돔 유지)
    if (hasWaterLightElectricCombo) {
      this.effectManager.startWaterLightElectric(px, py);
      this.effectManager.updateWaterLightElectricPosition(px, py);

      // ── 충전 완료 감지 → 타겟 수집 → 유도 레이저 spawn ──
      if (this.effectManager.waterLightElectricChargeReady()) {
        const MAX_RANGE = 700;
        const MAX_RANGE2 = MAX_RANGE * MAX_RANGE;
        const maxN = this.effectManager.waterLightElectricMaxStrikeTargets();

        const candidates: Array<{ idx: number; d2: number }> = [];
        const rangeCandidates = this.spatialHash.query(px, py, MAX_RANGE * 2, MAX_RANGE * 2, enemies.length);
        for (let ci = 0; ci < rangeCandidates.length; ci++) {
          const i = rangeCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= MAX_RANGE2) {
            candidates.push({ idx: i, d2 });
          }
        }
        candidates.sort((a, b) => a.d2 - b.d2);
        const top = candidates.slice(0, maxN);
        const targets: Array<{ worldX: number; worldY: number; enemyIdx: number }> = [];
        for (const c of top) {
          const e = enemies[c.idx];
          targets.push({ worldX: e.x, worldY: e.y, enemyIdx: c.idx });
        }
        this.effectManager.setWaterLightElectricStrikeTargets(targets);
      }

      // ── 유도 레이저 업데이트 (rule 5 풀 재사용 방어 내장) ──
      this.effectManager.updateWaterLightElectricHoming(1, enemies);

      // ── 이번 프레임 명중 이벤트 처리: 주 피해 + 3원소 임팩트 + 체인 확산 ──
      const hits = this.effectManager.waterLightElectricHitsThisFrame();
      if (hits.length > 0) {
        const PRIMARY_DAMAGE = 220;
        const CHAIN_DAMAGES = [150, 110, 80, 60, 50];
        const CHAIN_COUNT = 5;
        const CHAIN_RANGE = 180;
        const CHAIN_RANGE2 = CHAIN_RANGE * CHAIN_RANGE;

        const chainLinesBatch: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

        for (const hit of hits) {
          const main = enemies[hit.targetIdx];
          if (!main || !main.active) continue;

          main.hp -= PRIMARY_DAMAGE;
          spawnHitParticles(particles, main.x, main.y, 0xf472b6); // pink
          spawnHitParticles(particles, main.x, main.y, 0x67e8f9); // cyan
          spawnHitParticles(particles, main.x, main.y, 0xa78bfa); // violet

          // 이펙트 임팩트 입자 (링 펄스 + 파편 + 물방울 + 스파크)
          this.effectManager.spawnWaterLightElectricImpact(main.x, main.y);

          // 체인 확산 — 인접 3마리
          const used = new Set<number>();
          used.add(hit.targetIdx);
          let curX = main.x, curY = main.y;
          for (let c = 0; c < CHAIN_COUNT; c++) {
            let bestIdx = -1;
            let bestD2 = Infinity;
            for (let i = 0; i < enemies.length; i++) {
              if (!enemies[i].active || used.has(i)) continue;
              const dx = enemies[i].x - curX;
              const dy = enemies[i].y - curY;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2 && d2 <= CHAIN_RANGE2) {
                bestD2 = d2;
                bestIdx = i;
              }
            }
            if (bestIdx < 0) break;
            used.add(bestIdx);
            const ce = enemies[bestIdx];
            chainLinesBatch.push({ x0: curX, y0: curY, x1: ce.x, y1: ce.y });
            ce.hp -= CHAIN_DAMAGES[c];
            spawnHitParticles(particles, ce.x, ce.y, 0x67e8f9);
            spawnHitParticles(particles, ce.x, ce.y, 0xa78bfa);
            curX = ce.x;
            curY = ce.y;
            if (ce.hp <= 0) this.killEnemy(bestIdx);
          }

          if (main.hp <= 0) this.killEnemy(hit.targetIdx);
        }

        if (chainLinesBatch.length > 0) {
          this.effectManager.addWaterLightElectricChainLines(chainLinesBatch);
        }
      }

      // 하위 이펙트 전부 정지
      this.effectManager.stopWater();
      this.effectManager.stopLight();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopWaterLight();
      this.effectManager.stopWaterElectric();
      this.effectManager.stopLightElectric();
    } else {
      this.effectManager.stopWaterLightElectric();
    }

    // ── 불+빛+전기 3단계: 솔라 폭주 (Solar Ascension) ──
    // 프리즘 캐스케이드 패턴 미러링 — 미니 태양 + 코로나 링 + 플라즈마 웜 (사인 곡선 유도) + 체인 확산
    if (hasFireLightElectricCombo) {
      this.effectManager.startFireLightElectric(px, py);
      this.effectManager.updateFireLightElectricPosition(px, py);

      // ── 충전 완료 감지 → 타겟 수집 → 플라즈마 웜 spawn ──
      if (this.effectManager.fireLightElectricChargeReady()) {
        const MAX_RANGE = 700;
        const MAX_RANGE2 = MAX_RANGE * MAX_RANGE;
        const maxN = this.effectManager.fireLightElectricMaxStrikeTargets();

        const candidates: Array<{ idx: number; d2: number }> = [];
        const rangeCandidates = this.spatialHash.query(px, py, MAX_RANGE * 2, MAX_RANGE * 2, enemies.length);
        for (let ci = 0; ci < rangeCandidates.length; ci++) {
          const i = rangeCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= MAX_RANGE2) {
            candidates.push({ idx: i, d2 });
          }
        }
        candidates.sort((a, b) => a.d2 - b.d2);
        const top = candidates.slice(0, maxN);
        const targets: Array<{ worldX: number; worldY: number; enemyIdx: number }> = [];
        for (const c of top) {
          const e = enemies[c.idx];
          targets.push({ worldX: e.x, worldY: e.y, enemyIdx: c.idx });
        }
        this.effectManager.setFireLightElectricStrikeTargets(targets);
      }

      // ── 플라즈마 웜 호밍 업데이트 (rule 5 내장) ──
      this.effectManager.updateFireLightElectricHoming(1, enemies);

      // ── 이번 프레임 명중 처리 ──
      const hits = this.effectManager.fireLightElectricHitsThisFrame();
      if (hits.length > 0) {
        const PRIMARY_DAMAGE = 240;
        const CHAIN_DAMAGES = [160, 115, 80, 60, 50];
        const CHAIN_COUNT = 5;
        const CHAIN_RANGE = 180;
        const CHAIN_RANGE2 = CHAIN_RANGE * CHAIN_RANGE;

        const chainLinesBatch: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

        for (const hit of hits) {
          const main = enemies[hit.targetIdx];
          if (!main || !main.active) continue;

          main.hp -= PRIMARY_DAMAGE;
          spawnHitParticles(particles, main.x, main.y, 0xfde047); // yellow-300
          spawnHitParticles(particles, main.x, main.y, 0xf97316); // orange-500
          spawnHitParticles(particles, main.x, main.y, 0xef4444); // red-500

          // 이펙트 임팩트 입자
          this.effectManager.spawnFireLightElectricImpact(main.x, main.y);

          // 체인 확산 3마리
          const used = new Set<number>();
          used.add(hit.targetIdx);
          let curX = main.x, curY = main.y;
          for (let c = 0; c < CHAIN_COUNT; c++) {
            let bestIdx = -1;
            let bestD2 = Infinity;
            for (let i = 0; i < enemies.length; i++) {
              if (!enemies[i].active || used.has(i)) continue;
              const dx = enemies[i].x - curX;
              const dy = enemies[i].y - curY;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2 && d2 <= CHAIN_RANGE2) {
                bestD2 = d2;
                bestIdx = i;
              }
            }
            if (bestIdx < 0) break;
            used.add(bestIdx);
            const ce = enemies[bestIdx];
            chainLinesBatch.push({ x0: curX, y0: curY, x1: ce.x, y1: ce.y });
            ce.hp -= CHAIN_DAMAGES[c];
            spawnHitParticles(particles, ce.x, ce.y, 0xfacc15); // yellow-400
            spawnHitParticles(particles, ce.x, ce.y, 0x7dd3fc); // sky-300 (전기)
            curX = ce.x;
            curY = ce.y;
            if (ce.hp <= 0) this.killEnemy(bestIdx);
          }

          if (main.hp <= 0) this.killEnemy(hit.targetIdx);
        }

        if (chainLinesBatch.length > 0) {
          this.effectManager.addFireLightElectricChainLines(chainLinesBatch);
        }
      }

      // 하위 이펙트 전부 정지
      this.effectManager.stopFire();
      this.effectManager.stopLight();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopFireLight();
      this.effectManager.stopFireElectric();
      this.effectManager.stopLightElectric();
    } else {
      this.effectManager.stopFireLightElectric();
    }

    // ── 물+불+빛 3단계: 무지개 장마 포격 (Rainbow Deluge) ──
    // 캐릭터 머리 위 상시 무지개 증기 구름. 구름 하단 5개 outlet에서 끓는 빗방울이 쏟아짐.
    // 각 빗방울은 가까운 적 방향으로 미세 호밍 (rule 5 내장), 낙하 중 빨→주→노→초→파→남→보 색 순환.
    // 적 히트 시 수평 방사 폭발 (파편 + 무지개 스파크 + 물방울 + 링), 기둥 X.
    if (hasWaterFireLightCombo) {
      this.effectManager.startWaterFireLight(px, py);
      this.effectManager.updateWaterFireLightPosition(px, py);
      this.effectManager.updateWaterFireLightHoming(1, enemies);

      // 이번 프레임 빗방울 히트 → 데미지 처리
      const hits = this.effectManager.waterFireLightHitsThisFrame();
      if (hits.length > 0) {
        const IMPACT_DAMAGE = 55;
        for (const h of hits) {
          const e = enemies[h.enemyIdx];
          if (!e || !e.active) continue;
          e.hp -= IMPACT_DAMAGE;
          // 3원소 히트 파티클
          spawnHitParticles(particles, e.x, e.y, 0xdc2626); // red-600 (불/증기)
          spawnHitParticles(particles, e.x, e.y, 0xfacc15); // yellow-400 (빛)
          spawnHitParticles(particles, e.x, e.y, 0x7dd3fc); // sky-300 (물)
          if (e.hp <= 0) this.killEnemy(h.enemyIdx);
        }
      }

      // 하위 이펙트 전부 정지
      this.effectManager.stopWater();
      this.effectManager.stopFire();
      this.effectManager.stopLight();
      this.effectManager.stopWaterFire();
      this._steamBurnTargets.clear();
      this.effectManager.stopWaterLight();
      this.effectManager.stopFireLight();
    } else {
      this.effectManager.stopWaterFireLight();
    }

    // ── 물+불+암흑 3단계: 종말의 먹구름 (Doomcloud) ──
    // 상시 검은 뇌운 + 사슬 흡인 + 박동 GLSL.
    // 사슬이 범위 내 적에게 연결 (최대 8개, 랜덤 선택) → 구름(=플레이어) 방향으로 끌어당김
    // 연결 중 DoT 7/14f. 플레이어 너무 가까워지면(44px) 구름이 삼킴 + 보너스 40 피해.
    if (hasWaterFireDarkCombo) {
      this.effectManager.startWaterFireDark(px, py);
      this.effectManager.updateWaterFireDarkPosition(px, py);
      this.effectManager.updateWaterFireDarkPull(1, enemies);

      // ── 연결된 적 슬로우 (자기이동 55% 감속 — 퀵샌드/폭풍 슬로우와 유사 패턴) ──
      // 적은 AI로 플레이어 방향 이동 → 반대 방향으로 speed*0.55 counter-push
      // = 자신 속도 55% 감소 (사슬 흡인력은 그대로 유지)
      const tethered = this.effectManager.waterFireDarkTetheredIds();
      for (const ei of tethered) {
        const e = enemies[ei];
        if (!e || !e.active) continue;
        const dxp = px - e.x;
        const dyp = py - e.y;
        const dist = Math.sqrt(dxp * dxp + dyp * dyp) || 1;
        const slowStrength = e.speed * 0.55;
        if (!isBossType(e.type)) {
          e.x -= (dxp / dist) * slowStrength;
          e.y -= (dyp / dist) * slowStrength;
        }
      }

      const hits = this.effectManager.waterFireDarkHitsThisFrame();
      if (hits.length > 0) {
        for (const h of hits) {
          const e = enemies[h.enemyIdx];
          if (!e || !e.active) continue;
          e.hp -= h.damage;
          // 히트 파티클은 이펙트 내부 dotSparks가 처리 (불+암흑+크림슨+불씨 4톤 스플래시)
          if (e.hp <= 0) this.killEnemy(h.enemyIdx);
        }
      }

      // 하위 이펙트 전부 정지
      this.effectManager.stopWater();
      this.effectManager.stopFire();
      this.effectManager.stopDark();
      this._darkPlaced = false;
      this.effectManager.stopWaterFire();
      this._steamBurnTargets.clear();
      this.effectManager.stopWaterDark();
      this._waterDarkPlaced = false;
      this.effectManager.stopFireDark();
    } else {
      this.effectManager.stopWaterFireDark();
    }

    // ── 물+전기+암흑 3단계: 흑뢰 토네이도 (Dark Thunder Tornado) ──
    // 설치형 — 첫 활성 시 플레이어 위치에 토네이도가 꽂혀서 고정.
    // 흡인(260px) + 중심강타(28) + DoT(6/14f) + 천천히 전이되는 체인 번개(45f주기, 4hop 10f딜레이).
    if (hasWaterElectricDarkCombo) {
      if (!this._waterElectricDarkPlaced) {
        this._waterElectricDarkPlaced = true;
        this._waterElectricDarkPosX = px;
        this._waterElectricDarkPosY = py;
        this.effectManager.startWaterElectricDark(px, py);
      }
      this.effectManager.updateWaterElectricDarkPull(1, enemies);

      const hits = this.effectManager.waterElectricDarkHitsThisFrame();
      if (hits.length > 0) {
        for (const h of hits) {
          const e = enemies[h.enemyIdx];
          if (!e || !e.active) continue;
          e.hp -= h.damage;
          if (e.hp <= 0) this.killEnemy(h.enemyIdx);
        }
      }

      // 하위 이펙트 정지
      this.effectManager.stopWater();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopDark();
      this._darkPlaced = false;
      this.effectManager.stopWaterElectric();
      this._waterElectricStrikeTimer = 0;
      this.effectManager.stopWaterDark();
      this._waterDarkPlaced = false;
      this.effectManager.stopElectricDark();
    } else {
      if (this._waterElectricDarkPlaced) {
        this._waterElectricDarkPlaced = false;
        this.effectManager.stopWaterElectricDark();
      }
    }

    // ── 물+흙+빛 3단계: 사구아로 선인장 (Saguaro Sentinel) ──
    // 설치형 — 첫 활성 시 플레이어 위치에 선인장이 솟아오름.
    // 가시 30+개에서 시안/금색 호밍 레이저 13발/초 빠르게 격발 (촥촥촥촥), 적당 22 데미지.
    if (hasWaterEarthLightCombo) {
      if (!this._waterEarthLightPlaced) {
        this._waterEarthLightPlaced = true;
        this._waterEarthLightPosX = px;
        this._waterEarthLightPosY = py;
        this.effectManager.startWaterEarthLight(px, py);
      }
      this.effectManager.updateWaterEarthLightLasers(1, enemies);

      const hits = this.effectManager.waterEarthLightHitsThisFrame();
      if (hits.length > 0) {
        for (const h of hits) {
          const e = enemies[h.enemyIdx];
          if (!e || !e.active) continue;
          e.hp -= h.damage; // laser=32, needle=8 (효과 내부에서 결정)
          if (e.hp <= 0) this.killEnemy(h.enemyIdx);
        }
      }

      // 하위 이펙트 정지 — 다른 슬롯에서 같은 2원소 조합이 활성 중이면 유지
      this.effectManager.stopWater();
      this.effectManager.stopEarth();
      this.effectManager.stopLight();
      if (!hasWaterEarthCombo) this.effectManager.stopWaterEarth();
      if (!hasWaterLightCombo) this.effectManager.stopWaterLight();
      if (!hasEarthLightCombo) this.effectManager.stopEarthLight();
    } else {
      if (this._waterEarthLightPlaced) {
        this._waterEarthLightPlaced = false;
        this.effectManager.stopWaterEarthLight();
      }
    }


    // ── 흙+빛+전기 3단계: 크리스탈 뇌격 (Crystal Thunder) ──
    // 8 크리스탈 tight follow + tangent 배치 + 전기 벽 연결
    // 각 크리스탈이 빠른 충전으로 유도 미사일 "푱푱푱푱" 발사
    // 전기 벽에 닿으면 강한 슬로우 + DoT + 체인 확산
    if (hasEarthLightElectricCombo) {
      this.effectManager.startEarthLightElectric(px, py);
      this.effectManager.updateEarthLightElectricPosition(px, py);

      const RING_RADIUS = 130;

      // ── 준비 완료 크리스탈 → 타겟 수집 → 유도 미사일 발사 ──
      const readyList = this.effectManager.earthLightElectricReadyCrystals();
      if (readyList.length > 0) {
        const MAX_RANGE = 700;
        const MAX_RANGE2 = MAX_RANGE * MAX_RANGE;
        const fires: Array<{
          crystalIdx: number;
          targetX: number;
          targetY: number;
          enemyIdx: number;
        }> = [];
        const used = new Set<number>();

        for (const r of readyList) {
          let bestIdx = -1;
          let bestD2 = Infinity;
          const crystalCandidates = this.spatialHash.query(r.worldX, r.worldY, MAX_RANGE * 2, MAX_RANGE * 2, enemies.length);
          for (let ci = 0; ci < crystalCandidates.length; ci++) {
            const i = crystalCandidates[ci];
            const e = enemies[i];
            if (!e.active || used.has(i)) continue;
            const dx = e.x - r.worldX;
            const dy = e.y - r.worldY;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 && d2 <= MAX_RANGE2) {
              bestD2 = d2;
              bestIdx = i;
            }
          }
          if (bestIdx >= 0) {
            used.add(bestIdx);
            const e = enemies[bestIdx];
            fires.push({
              crystalIdx: r.crystalIdx,
              targetX: e.x,
              targetY: e.y,
              enemyIdx: bestIdx,
            });
          }
        }
        if (fires.length > 0) {
          this.effectManager.fireEarthLightElectricMissiles(fires);
        }
      }

      // ── 유도 미사일 호밍 업데이트 ──
      this.effectManager.updateEarthLightElectricHoming(1, enemies);

      // ── 미사일 명중 처리 ──
      const hits = this.effectManager.earthLightElectricHitsThisFrame();
      if (hits.length > 0) {
        const PRIMARY_DAMAGE = 180;
        const MISSILE_STUN = 25;
        const CHAIN_DAMAGES_HIT = [130, 95, 65, 50, 40];
        const CHAIN_COUNT_HIT = 5;
        const CHAIN_RANGE_HIT = 170;
        const CHAIN_RANGE_HIT2 = CHAIN_RANGE_HIT * CHAIN_RANGE_HIT;

        const hitChainBatch: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];

        for (const hit of hits) {
          const main = enemies[hit.targetIdx];
          if (!main || !main.active) continue;

          main.hp -= PRIMARY_DAMAGE;
          main.stunFrames = Math.max(main.stunFrames || 0, MISSILE_STUN);
          spawnHitParticles(particles, main.x, main.y, 0xfde047);
          spawnHitParticles(particles, main.x, main.y, 0xfbbf24);
          spawnHitParticles(particles, main.x, main.y, 0x7dd3fc);
          this.effectManager.spawnEarthLightElectricImpact(main.x, main.y);

          // 체인 확산 (명중 후)
          const usedHitChain = new Set<number>();
          usedHitChain.add(hit.targetIdx);
          let curX = main.x, curY = main.y;
          for (let c = 0; c < CHAIN_COUNT_HIT; c++) {
            let bestIdx = -1;
            let bestD2 = Infinity;
            for (let i = 0; i < enemies.length; i++) {
              if (!enemies[i].active || usedHitChain.has(i)) continue;
              const dx = enemies[i].x - curX;
              const dy = enemies[i].y - curY;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2 && d2 <= CHAIN_RANGE_HIT2) {
                bestD2 = d2;
                bestIdx = i;
              }
            }
            if (bestIdx < 0) break;
            usedHitChain.add(bestIdx);
            const ce = enemies[bestIdx];
            hitChainBatch.push({ x0: curX, y0: curY, x1: ce.x, y1: ce.y });
            ce.hp -= CHAIN_DAMAGES_HIT[c];
            spawnHitParticles(particles, ce.x, ce.y, 0xfacc15);
            spawnHitParticles(particles, ce.x, ce.y, 0x7dd3fc);
            curX = ce.x;
            curY = ce.y;
            if (ce.hp <= 0) this.killEnemy(bestIdx);
          }

          if (main.hp <= 0) this.killEnemy(hit.targetIdx);
        }

        if (hitChainBatch.length > 0) {
          this.effectManager.addEarthLightElectricChainLines(hitChainBatch);
        }
      }

      // ── 벽(연결 라인) 터치 검사: 강한 슬로우 + DoT + 체인 ──
      const segments = this.effectManager.earthLightElectricConnectionSegments();
      if (segments.length > 0) {
        const TOUCH_THRESHOLD = 22;
        const TOUCH_THRESHOLD2 = TOUCH_THRESHOLD * TOUCH_THRESHOLD;
        const CHECK_RANGE = RING_RADIUS + TOUCH_THRESHOLD + 10;
        const CHECK_RANGE2 = CHECK_RANGE * CHECK_RANGE;
        const LINE_DOT = 18;
        const STUN_FRAMES = 10;
        const DOT_INTERVAL = 25;
        const doTick = this.state.frameCount % DOT_INTERVAL === 0;
        // 성능 캡: 밀집 시 렉 방지
        const MAX_IMPACTS_PER_TICK = 3;
        const MAX_CHAIN_SOURCES = 6;

        const chainLinesBatch: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
        const touchedEnemies: number[] = [];
        let impactCount = 0;

        const wallCandidates = this.spatialHash.query(px, py, CHECK_RANGE * 2, CHECK_RANGE * 2, enemies.length);
        for (let ci = 0; ci < wallCandidates.length; ci++) {
          const i = wallCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;

          // 원거리 컬링
          const edx = e.x - px;
          const edy = e.y - py;
          const ed2 = edx * edx + edy * edy;
          if (ed2 > CHECK_RANGE2) continue;

          // 라인 터치 체크
          let lineTouched = false;
          for (const seg of segments) {
            const sx = seg.x1 - seg.x0;
            const sy = seg.y1 - seg.y0;
            const segLen2 = sx * sx + sy * sy;
            if (segLen2 < 0.01) continue;
            let t = ((e.x - seg.x0) * sx + (e.y - seg.y0) * sy) / segLen2;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const cx = seg.x0 + sx * t;
            const cy = seg.y0 + sy * t;
            const ddx = e.x - cx;
            const ddy = e.y - cy;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < TOUCH_THRESHOLD2) {
              lineTouched = true;
              break;
            }
          }

          if (lineTouched) {
            // ── 강한 슬로우 65% (매 프레임, 벽에 갇힌 느낌) — 보스는 면역 ──
            const WALL_SLOW = 0.65;
            const edist = Math.sqrt(ed2);
            if (edist > 0.1 && !isBossType(e.type)) {
              const toPlayerX = (px - e.x) / edist;
              const toPlayerY = (py - e.y) / edist;
              e.x -= toPlayerX * e.speed * WALL_SLOW;
              e.y -= toPlayerY * e.speed * WALL_SLOW;
            }
          }

          if (lineTouched && doTick) {
            e.hp -= LINE_DOT;
            e.stunFrames = Math.max(e.stunFrames || 0, STUN_FRAMES);
            spawnHitParticles(particles, e.x, e.y, 0xfde047);
            spawnHitParticles(particles, e.x, e.y, 0x7dd3fc);
            // ★ 임팩트 풀 버스트는 틱당 최대 3개로 캡 (밀집 시 렉 방지)
            if (impactCount < MAX_IMPACTS_PER_TICK) {
              this.effectManager.spawnEarthLightElectricImpact(e.x, e.y);
              impactCount++;
            }
            touchedEnemies.push(i);
            if (e.hp <= 0) {
              this.killEnemy(i);
            }
          }
        }

        // ── 체인 확산 (소스 최대 6개로 캡) ──
        if (doTick && touchedEnemies.length > 0) {
          const CHAIN_RANGE = 160;
          const CHAIN_RANGE2 = CHAIN_RANGE * CHAIN_RANGE;
          const CHAIN_DAMAGES = [14, 10, 7, 6, 5];
          const CHAIN_COUNT = 5;
          const chainSourceLimit = Math.min(touchedEnemies.length, MAX_CHAIN_SOURCES);

          for (let si = 0; si < chainSourceLimit; si++) {
            const fromIdx = touchedEnemies[si];
            const fromE = enemies[fromIdx];
            if (!fromE.active) continue;
            let curX = fromE.x, curY = fromE.y;
            const localUsed = new Set<number>([fromIdx]);

            for (let c = 0; c < CHAIN_COUNT; c++) {
              let bestIdx = -1;
              let bestD2 = Infinity;
              for (let i = 0; i < enemies.length; i++) {
                if (!enemies[i].active || localUsed.has(i)) continue;
                const dx = enemies[i].x - curX;
                const dy = enemies[i].y - curY;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2 && d2 <= CHAIN_RANGE2) {
                  bestD2 = d2;
                  bestIdx = i;
                }
              }
              if (bestIdx < 0) break;
              localUsed.add(bestIdx);
              const ce = enemies[bestIdx];
              chainLinesBatch.push({ x0: curX, y0: curY, x1: ce.x, y1: ce.y });
              ce.hp -= CHAIN_DAMAGES[c];
              spawnHitParticles(particles, ce.x, ce.y, 0xfacc15);
              spawnHitParticles(particles, ce.x, ce.y, 0x7dd3fc);
              curX = ce.x;
              curY = ce.y;
              if (ce.hp <= 0) this.killEnemy(bestIdx);
            }
          }

          // 체인 소스 캡에 걸려도 나머지 적은 이미 DoT+스턴 받음
          // 피해 차이 없음, 시각 체인만 제한

          if (chainLinesBatch.length > 0) {
            this.effectManager.addEarthLightElectricChainLines(chainLinesBatch);
          }
        }
      }

      // 하위 이펙트 전부 정지
      this.effectManager.stopEarth();
      this.effectManager.stopLight();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopEarthLight();
      this.effectManager.stopEarthElectric();
      this.effectManager.stopLightElectric();
    } else {
      this._crystalPulseTimer = 0;
      this.effectManager.stopEarthLightElectric();
    }

    // 불 single은 함수 끝 독립 블록으로 이동

    // ── 빛+전기 조합 vs 개별 (hasLightElectricCombo는 상단 플래그 섹션에서 선언) ──

    if (hasFireElectricCombo) {
      // ── 불+전기 조합: 체인 봄버 ──
      // 푸른 전기 체인 → 적에 도달 후 10f 시차 → 적 위치마다 화염 폭발 다중
      // 1단계 빛/전기 정지
      this.effectManager.stopLightElectric();
      this.effectManager.stopElectric();
      this._electricTimer = 0;
      this._electricChainNodes = [];

      const CHAIN_NODE_MAX_TRAVEL = 120; // 1프레임에 적이 이동할 수 있는 거리 임계 (이상이면 풀 재사용 의심)
      const CHAIN_RANGE = 400;
      const CHAIN_HOP = 200;
      const MAX_CHAIN = 8;
      const FIRE_ELECTRIC_COOLDOWN = 90; // 1.5초마다 새 체인
      const EXPLOSION_DELAY = 10; // 적 도달 후 10f 지연 후 폭발
      const CHAIN_DELAY_PER_HOP = 5; // 1단계 전기와 동일 (체인 시차)
      const CHAIN_DAMAGE_MAX = 10;
      const EXPLOSION_DAMAGE = 22;

      this._fireElectricTimer++;
      if (this._fireElectricTimer >= FIRE_ELECTRIC_COOLDOWN) {
        this._fireElectricTimer = 0;

        // 3개 체인을 동시에 발사 (공용 used set으로 체인끼리 중복 타겟 방지)
        const NUM_CHAINS = 3;
        const globalUsed = new Set<number>();
        const allChainTargets: number[] = []; // 노드 추적용 (모든 체인 통합)

        for (let chainNum = 0; chainNum < NUM_CHAINS; chainNum++) {
          const chainTargets: number[] = [];
          let curX = px, curY = py;

          for (let chain = 0; chain < MAX_CHAIN; chain++) {
            const maxD = chain === 0 ? CHAIN_RANGE : CHAIN_HOP;
            const maxD2 = maxD * maxD;
            const candidates = this.spatialHash.query(curX, curY, maxD * 2, maxD * 2, enemies.length);
            let bestIdx = -1, bestDist = Infinity;
            for (let ci = 0; ci < candidates.length; ci++) {
              const ei = candidates[ci];
              if (!enemies[ei].active || globalUsed.has(ei)) continue;
              const dx = enemies[ei].x - curX;
              const dy = enemies[ei].y - curY;
              const d = dx * dx + dy * dy;
              if (d < bestDist && d <= maxD2) {
                bestDist = d; bestIdx = ei;
              }
            }
            if (bestIdx < 0) break;
            chainTargets.push(bestIdx);
            globalUsed.add(bestIdx);
            curX = enemies[bestIdx].x;
            curY = enemies[bestIdx].y;
          }

          if (chainTargets.length === 0) break; // 타겟 소진

          // 체인 즉발 데미지 (전기 본체)
          for (let ci = 0; ci < chainTargets.length; ci++) {
            const e = enemies[chainTargets[ci]];
            const dmg = Math.max(4, CHAIN_DAMAGE_MAX - ci);
            e.hp -= dmg;
            spawnHitParticles(particles, e.x, e.y, 0xdc2626);
            if (e.hp <= 0) {
              this.killEnemy(chainTargets[ci]);
            }
          }

          // 이 체인의 시각 볼트 발동 (fireChain은 bolts 배열에 append — 여러 번 호출 OK)
          const chainPoints: Array<{ x: number; y: number }> = [{ x: px, y: py }];
          for (const ci of chainTargets) {
            chainPoints.push({ x: enemies[ci].x, y: enemies[ci].y });
          }
          this.effectManager.fireFireElectricChain(chainPoints);

          // 각 체인 노드마다 폭발 예약
          for (let ci = 0; ci < chainTargets.length; ci++) {
            const e = enemies[chainTargets[ci]];
            if (!e || !e.active) continue;
            this._fireElectricPendingExplosions.push({
              lastX: e.x,
              lastY: e.y,
              timer: ci * CHAIN_DELAY_PER_HOP + EXPLOSION_DELAY,
            });
          }

          allChainTargets.push(...chainTargets);
        }

        // 다중 체인: 볼트 수명이 짧아 적 추적 불필요 — 빈 배열로 두어 updateChainPositions 스킵
        this._fireElectricChainNodes = [];
      }

      // 매 프레임 체인 볼트 좌표 갱신 — enemies 풀 재사용 방어 (거리 체크)
      if (this._fireElectricChainNodes.length > 0) {
        const livePositions: Array<{ x: number; y: number }> = [{ x: px, y: py }];
        for (const node of this._fireElectricChainNodes) {
          const e = enemies[node.enemyIdx];
          if (e && e.active) {
            // 거리 체크: 직전 프레임 좌표와 너무 멀면 풀 재사용으로 간주 → 직전 좌표 유지
            const dxn = e.x - node.lastX;
            const dyn = e.y - node.lastY;
            if (dxn * dxn + dyn * dyn <= CHAIN_NODE_MAX_TRAVEL * CHAIN_NODE_MAX_TRAVEL) {
              node.lastX = e.x;
              node.lastY = e.y;
            }
          }
          // 적이 죽었거나 거리 초과면 lastX/Y 유지 (점프 방지)
          livePositions.push({ x: node.lastX, y: node.lastY });
        }
        this.effectManager.updateFireElectricChainPositions(livePositions);
      }

      // 폭발 예약 처리: 매 프레임 타이머 감소, 0 도달 시 고정 좌표에서 발동
      // (적 추적 안 함 — enemies 풀이 재사용되므로 인덱스 추적은 불안정)
      // 시차 10f 동안 적이 거의 못 움직이므로 처음 좌표로 충분
      for (let i = this._fireElectricPendingExplosions.length - 1; i >= 0; i--) {
        const pe = this._fireElectricPendingExplosions[i];
        pe.timer--;
        if (pe.timer <= 0) {
          // 폭발 발동 (생성 시점 고정 좌표)
          const ex = pe.lastX;
          const ey = pe.lastY;
          const explosionR = this.effectManager.fireElectricExplosionRadius();
          const explosionR2 = explosionR * explosionR;

          // 시각
          this.effectManager.spawnFireElectricExplosion(ex, ey);

          // 광역 데미지 (폭발 반경 내 적)
          const explCandidates = this.spatialHash.query(ex, ey, explosionR * 2, explosionR * 2, enemies.length);
          for (let eci = 0; eci < explCandidates.length; eci++) {
            const ej = explCandidates[eci];
            const target = enemies[ej];
            if (!target.active) continue;
            const dx = target.x - ex;
            const dy = target.y - ey;
            const d2 = dx * dx + dy * dy;
            if (d2 > explosionR2) continue;
            target.hp -= EXPLOSION_DAMAGE;
            // 화염 히트 파티클
            spawnHitParticles(particles, target.x, target.y, 0xfb923c);
            spawnHitParticles(particles, target.x, target.y, 0xfde047);
            // 가벼운 넉백
            const dist = Math.sqrt(d2) || 1;
            const knock = 8 * (1 - dist / explosionR);
            target.x += (dx / dist) * knock;
            target.y += (dy / dist) * knock;
            if (target.hp <= 0) this.killEnemy(ej);
          }

          this._fireElectricPendingExplosions.splice(i, 1);
        }
      }
    } else {
      this.effectManager.stopFireElectric();
      this._fireElectricTimer = 0;
      this._fireElectricChainNodes = [];
      this._fireElectricPendingExplosions = [];
    }

    if (hasLightElectricCombo) {
      // ── 빛+전기 조합: 프리즘 방전 (금빛 체인 라이트닝) ──
      const chainRange = 500;     // 전기 1단계(400)보다 넓음
      const chainHopRange = 220;  // 전기 1단계(180)보다 넓음
      const maxChain = 12;        // 전기 1단계(10)보다 많음

      this.effectManager.startLightElectric(px, py);
      this.effectManager.updateLightElectricPosition(px, py);

      // 차징 완료 → 3개 체인 동시 발사
      if (this.effectManager.lightElectricChainFired()) {
        const NUM_CHAINS = 3;
        const globalUsed = new Set<number>();

        for (let chainNum = 0; chainNum < NUM_CHAINS; chainNum++) {
          const chainTargets: number[] = [];
          let curX = px, curY = py;

          for (let chain = 0; chain < maxChain; chain++) {
            const maxD = chain === 0 ? chainRange : chainHopRange;
            const maxD2 = maxD * maxD;
            const candidates = this.spatialHash.query(curX, curY, maxD * 2, maxD * 2, enemies.length);
            let bestIdx = -1, bestDist = Infinity;
            for (let ci = 0; ci < candidates.length; ci++) {
              const ei = candidates[ci];
              if (!enemies[ei].active || globalUsed.has(ei)) continue;
              const dx = enemies[ei].x - curX;
              const dy = enemies[ei].y - curY;
              const d = dx * dx + dy * dy;
              if (d < bestDist && d <= maxD2) {
                bestDist = d; bestIdx = ei;
              }
            }
            if (bestIdx < 0) break;
            chainTargets.push(bestIdx);
            globalUsed.add(bestIdx);
            curX = enemies[bestIdx].x;
            curY = enemies[bestIdx].y;
          }

          if (chainTargets.length === 0) break;

          // 데미지 (순차 감소)
          for (let ci = 0; ci < chainTargets.length; ci++) {
            const e = enemies[chainTargets[ci]];
            const dmg = Math.max(8, 22 - ci * 2);
            e.hp -= dmg;
            spawnHitParticles(particles, e.x, e.y, 0xfde047);
            if (e.hp <= 0) this.killEnemy(chainTargets[ci]);
          }

          // 시각 볼트 발동 (append)
          const chainPoints: Array<{ x: number; y: number }> = [{ x: px, y: py }];
          for (const ci of chainTargets) {
            chainPoints.push({ x: enemies[ci].x, y: enemies[ci].y });
          }
          this.effectManager.fireLightElectricChain(chainPoints);
        }

        // 다중 체인: 볼트 수명이 짧아 적 추적 불필요
        this._electricChainNodes = [];
      }

      // 매 프레임: 볼트 좌표를 적 현재 위치로 갱신 — 거리 체크로 풀 재사용 방어
      if (this._electricChainNodes.length > 0) {
        const NODE_MAX_TRAVEL = 120;
        const livePositions: Array<{ x: number; y: number }> = [{ x: px, y: py }];
        for (const node of this._electricChainNodes) {
          const e = enemies[node.enemyIdx];
          if (e && e.active) {
            const dxn = e.x - node.lastX;
            const dyn = e.y - node.lastY;
            if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
              node.lastX = e.x;
              node.lastY = e.y;
            }
          }
          livePositions.push({ x: node.lastX, y: node.lastY });
        }
        this.effectManager.updateLightElectricChainPositions(livePositions);
      }

      // 개별 빛/전기 이펙트 중지
      this.effectManager.stopLight();
      this._electricTimer = 0;
      this.effectManager.stopElectric();
    } else {
      // 조합 아닐 때 조합 이펙트 중지
      this.effectManager.stopLightElectric();

      // 빛/전기 single은 함수 끝 독립 블록으로 이동
    }

    // ── 전기 × 3 (AAA) — 뇌신의 분노 (사방 체인 폭주) ──
    // 슬롯이 모두 전기일 때만 발동. 매 BURST_INTERVAL마다 캐릭터에서 가까운 N명 적에게
    // 동시 1단계 체인 발사 (각 5연쇄). 1단계 fireChain 패턴을 N개 그룹 동시 실행.
    if (hasElectricUltimate) {
      const BURST_INTERVAL = 30;        // 0.5초 주기
      const CHAIN_GROUPS = 8;           // 사방 동시 체인 수
      const CHAIN_HOPS = 5;             // 각 체인 5연쇄 (1단계와 동일)
      const FIRST_RANGE = 400;          // 첫 적까지 거리
      const HOP_RANGE = 180;            // 체인 hop 사거리

      if (!this._electricUltimateActive) {
        this.effectManager.startElectricUltimate();
        this._electricUltimateActive = true;
        this._electricUltimateBurstTimer = 0;
        this._electricUltimateChainGroups = [];
      }

      // ── 발사 주기 ──
      this._electricUltimateBurstTimer++;
      if (this._electricUltimateBurstTimer >= BURST_INTERVAL) {
        this._electricUltimateBurstTimer = 0;

        // 시작점: 캐릭터로부터 가까운 적 N명을 동시 발사 시작점으로
        const initialRanked: Array<{ i: number; d2: number }> = [];
        const initCandidates = this.spatialHash.query(px, py, FIRST_RANGE * 2, FIRST_RANGE * 2, enemies.length);
        for (let ci = 0; ci < initCandidates.length; ci++) {
          const i = initCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dxe = e.x - px;
          const dye = e.y - py;
          const d2 = dxe * dxe + dye * dye;
          if (d2 > FIRST_RANGE * FIRST_RANGE) continue;
          initialRanked.push({ i, d2 });
        }
        initialRanked.sort((a, b) => a.d2 - b.d2);
        const initialPicks = initialRanked.slice(0, CHAIN_GROUPS);

        // 각 그룹마다 1단계 체인 5연쇄 빌드
        const chains: Array<Array<{ x: number; y: number }>> = [];
        const chainGroups: Array<Array<{ enemyIdx: number; lastX: number; lastY: number }>> = [];
        const usedGlobal = new Set<number>(); // 그룹 간 중복 방지

        for (const init of initialPicks) {
          if (usedGlobal.has(init.i)) continue;
          const startE = enemies[init.i];
          if (!startE.active) continue;

          // 1단계 fireChain 패턴: [캐릭터, 적1, 적2, ..., 적N]
          const points: Array<{ x: number; y: number }> = [{ x: px, y: py }];
          const groupNodes: Array<{ enemyIdx: number; lastX: number; lastY: number }> = [
            { enemyIdx: -1, lastX: px, lastY: py }, // 캐릭터 (enemyIdx -1)
          ];

          let curX = px, curY = py;
          const localUsed = new Set<number>();
          for (let hop = 0; hop < CHAIN_HOPS; hop++) {
            let bestIdx = -1, bestDist = Infinity;
            const maxD = hop === 0 ? FIRST_RANGE : HOP_RANGE;
            const maxD2 = maxD * maxD;
            if (hop === 0) {
              // 첫 hop은 init만 고정
              const e = enemies[init.i];
              if (e && e.active) {
                const dxe = e.x - curX;
                const dye = e.y - curY;
                const d2 = dxe * dxe + dye * dye;
                if (d2 <= maxD2) { bestIdx = init.i; }
              }
            } else {
              const cand = this.spatialHash.query(curX, curY, maxD * 2, maxD * 2, enemies.length);
              const candCopy = cand.slice();
              for (let ci = 0; ci < candCopy.length; ci++) {
                const ei = candCopy[ci];
                if (!enemies[ei].active) continue;
                if (usedGlobal.has(ei) || localUsed.has(ei)) continue;
                const dxe = enemies[ei].x - curX;
                const dye = enemies[ei].y - curY;
                const d2 = dxe * dxe + dye * dye;
                if (d2 < bestDist && d2 <= maxD2) {
                  bestDist = d2; bestIdx = ei;
                }
              }
            }
            if (bestIdx < 0) break;
            const e = enemies[bestIdx];
            points.push({ x: e.x, y: e.y });
            groupNodes.push({ enemyIdx: bestIdx, lastX: e.x, lastY: e.y });
            localUsed.add(bestIdx);
            usedGlobal.add(bestIdx);
            curX = e.x;
            curY = e.y;

            // 데미지 (1단계 패턴 강화: 20→4)
            const dmg = Math.max(4, 20 - hop * 4);
            e.hp -= dmg;
            spawnHitParticles(particles, e.x, e.y, 0xa78bfa);
            if (e.hp <= 0) this.killEnemy(bestIdx);
          }

          if (points.length >= 2) {
            chains.push(points);
            chainGroups.push(groupNodes);
          }
        }

        if (chains.length > 0) {
          this._electricUltimateChainGroups = chainGroups;
          this.effectManager.fireElectricUltimateBurst(chains);
        }
      }

      // 매 프레임 chain 좌표 갱신 (풀 재사용 방어 — 거리 체크)
      if (this.effectManager.electricUltimateHasActiveBolts() && this._electricUltimateChainGroups.length > 0) {
        const NODE_MAX_TRAVEL = 120;
        const livePositions: Array<Array<{ x: number; y: number }>> = [];
        for (const group of this._electricUltimateChainGroups) {
          const groupLive: Array<{ x: number; y: number }> = [];
          for (const node of group) {
            if (node.enemyIdx === -1) {
              // 캐릭터 노드 — 항상 현재 위치
              node.lastX = px;
              node.lastY = py;
            } else {
              const e = enemies[node.enemyIdx];
              if (e && e.active) {
                const dxn = e.x - node.lastX;
                const dyn = e.y - node.lastY;
                if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
                  node.lastX = e.x;
                  node.lastY = e.y;
                }
              }
            }
            groupLive.push({ x: node.lastX, y: node.lastY });
          }
          livePositions.push(groupLive);
        }
        this.effectManager.updateElectricUltimateChainPositions(livePositions);
      }
    } else {
      if (this._electricUltimateActive) {
        this._electricUltimateActive = false;
        this._electricUltimateBurstTimer = 0;
        this._electricUltimateChainGroups = [];
        this.effectManager.stopElectricUltimate();
      }
    }

    // ── 불 × 3 (AAA) — 태양 (캐릭터 머리 위 구체 + 사방 화염 유성우) ──
    // 슬롯이 모두 불일 때만 발동. 캐릭터 따라다니는 태양 + 매 30f마다 사방 10발 발사체 분출.
    if (hasFireUltimate) {
      if (!this._fireUltimateActive) {
        this.effectManager.startFireUltimate(px, py);
        this._fireUltimateActive = true;
      }
      // 매 프레임 캐릭터 위치 갱신 (태양이 머리 위 따라다님)
      this.effectManager.updateFireUltimatePosition(px, py);

      // ── 이번 프레임 폭발 처리 (메인 + 잔해 chunk 광역 데미지) ──
      const impacts = this.effectManager.fireUltimateImpactsThisFrame();
      for (const imp of impacts) {
        const isMain = imp.type === 'main';
        const burstR = isMain ? 50 : 25;
        const burstR2 = burstR * burstR;
        const dmg = isMain ? 32 : 10;
        const knockMax = isMain ? 8 : 3;
        const fireUltCandidates = this.spatialHash.query(imp.x, imp.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < fireUltCandidates.length; ci++) {
          const i = fireUltCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dxe = e.x - imp.x;
          const dye = e.y - imp.y;
          const d2 = dxe * dxe + dye * dye;
          if (d2 >= burstR2) continue;
          const dist = Math.sqrt(d2) || 1;
          e.hp -= dmg;
          spawnHitParticles(particles, e.x, e.y, 0xea580c);
          const knock = knockMax * (1 - dist / burstR);
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dxe / dist) * knock;
              e.y += (dye / dist) * knock;
            }
          }
          if (e.hp <= 0) this.killEnemy(i);
        }
      }
    } else {
      if (this._fireUltimateActive) {
        this._fireUltimateActive = false;
        this.effectManager.stopFireUltimate();
      }
    }

    // ── 물 × 3 (AAA) — 대해일 (5페이즈 사이클 + GLSL) ──
    // 슬롯이 모두 물일 때만 발동. 캐릭터 위치 잠금. 파도가 0→350px 확장하면서
    // 적을 외측으로 강하게 밀어내고, 350px 도달 시 그 자리에서 광역 폭발.
    if (hasWaterUltimate) {
      if (!this._waterUltimateActive) {
        this.effectManager.startWaterUltimate(px, py);
        this._waterUltimateActive = true;
      }

      // ── 확장 페이즈 — 파도 띠 안 적에 외측 강한 넉백 + DoT ──
      if (this.effectManager.waterUltimateExpanding()) {
        const center = this.effectManager.waterUltimateCenter();
        const r = this.effectManager.waterUltimateWaveRadius();
        const half = this.effectManager.waterUltimateBandHalf();
        const inner = Math.max(0, r - half);
        const outer = r + half;
        const inner2 = inner * inner;
        const outer2 = outer * outer;
        const waveCandidates = this.spatialHash.query(center.x, center.y, outer * 2, outer * 2, enemies.length);
        for (let ci = 0; ci < waveCandidates.length; ci++) {
          const i = waveCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dxe = e.x - center.x;
          const dye = e.y - center.y;
          const d2 = dxe * dxe + dye * dye;
          if (d2 < inner2 || d2 > outer2) continue;
          const dist = Math.sqrt(d2) || 1;
          // 외측 강한 넉백 — 띠 중심에 가까울수록 강함
          const bandT = 1 - Math.abs(dist - r) / half;
          const knock = 10 * bandT;
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dxe / dist) * knock;
              e.y += (dye / dist) * knock;
            }
          }
          // DoT (15f 간격)
          if (this.state.frameCount % 15 === 0) {
            e.hp -= 5;
            spawnHitParticles(particles, e.x, e.y, 0x60a5fa);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // ── 폭발 시점 — 350px 안 모든 적에 광역 데미지 + 강한 외측 넉백 ──
      if (this.effectManager.waterUltimateBurstFired()) {
        const center = this.effectManager.waterUltimateCenter();
        const burstR = this.effectManager.waterUltimateBurstRadius();
        const burstR2 = burstR * burstR;
        const waterBurstCandidates = this.spatialHash.query(center.x, center.y, burstR * 2, burstR * 2, enemies.length);
        for (let ci = 0; ci < waterBurstCandidates.length; ci++) {
          const i = waterBurstCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dxe = e.x - center.x;
          const dye = e.y - center.y;
          const d2 = dxe * dxe + dye * dye;
          if (d2 >= burstR2) continue;
          const dist = Math.sqrt(d2) || 1;
          e.hp -= 50;
          spawnHitParticles(particles, e.x, e.y, 0x3b82f6);
          // 강한 외측 넉백
          const knock = 20 * (1 - dist / burstR);
          if (!isBossType(e.type)) {
            if (!isBossType(e.type)) {
              e.x += (dxe / dist) * knock;
              e.y += (dye / dist) * knock;
            }
          }
          if (e.hp <= 0) this.killEnemy(i);
        }
      }

      // 사이클 종료 감지 → 다음 프레임 새 사이클
      if (!this.effectManager.waterUltimateActive()) {
        this._waterUltimateActive = false;
      }
    } else {
      if (this._waterUltimateActive) {
        this._waterUltimateActive = false;
        this.effectManager.stopWaterUltimate();
      }
    }

    // ── 빛 × 3 (AAA) — 신광 폭격 (LightUltimateEffect, 머리 위 코어 + 호밍 발사체) ──
    // 슬롯이 모두 빛일 때만 발동. 캐릭터 머리 위 코어에서 매 볼리마다 가까운 N명 적을 잠그고
    // **1프레임에 1발씩** 우수수 캐스케이드 발사. 적중 시 단일 타겟 데미지.
    if (hasLightUltimate) {
      const BOLTS_PER_VOLLEY = 10;     // 한 볼리당 발사체 수 (가까운 N명)
      const VOLLEY_REST_FRAMES = 4;    // 볼리 종료 후 다음 볼리까지 쉼 (총 사이클 ≈ 14f)
      const TARGET_RANGE = 800;        // 적 탐색 범위
      const BOLT_DAMAGE = 16;          // 적중 데미지 (단일 타겟)
      const NODE_MAX_TRAVEL = 120;     // 풀 재사용 방어 거리 임계값

      if (!this._lightUltimateActive) {
        this.effectManager.startLightUltimate(px, py);
        this._lightUltimateActive = true;
        this._lightUltimateVolleyQueue = [];
        this._lightUltimateVolleyCooldown = 0;
        this._lightUltimateBoltMap = new Map();
      }

      // 매 프레임 캐릭터 위치 갱신 (코어가 머리 위 따라다님)
      this.effectManager.updateLightUltimatePosition(px, py);

      // ── 캐스케이드 발사: 큐가 비어있지 않으면 1발씩 우수수 ──
      if (this._lightUltimateVolleyQueue.length > 0) {
        const next = this._lightUltimateVolleyQueue.shift()!;
        const e = enemies[next.enemyIdx];
        // 적이 살아있으면 발사. 죽었으면 그냥 스킵하고 다음 프레임 큐 처리
        if (e && e.active) {
          const id = this.effectManager.fireLightUltimateBolt(e.x, e.y);
          if (id > 0) {
            this._lightUltimateBoltMap.set(id, {
              enemyIdx: next.enemyIdx,
              lastX: e.x,
              lastY: e.y,
            });
          }
        }
      } else {
        // ── 큐가 비었으면 쿨다운 카운트, 0 도달 시 새 볼리 빌드 ──
        this._lightUltimateVolleyCooldown--;
        if (this._lightUltimateVolleyCooldown <= 0) {
          // 가까운 적 N명 탐색 (거리순 정렬)
          const candidates: Array<{ i: number; d2: number }> = [];
          const maxD2 = TARGET_RANGE * TARGET_RANGE;
          const volleyCandidates = this.spatialHash.query(px, py, TARGET_RANGE * 2, TARGET_RANGE * 2, enemies.length);
          for (let ci = 0; ci < volleyCandidates.length; ci++) {
            const i = volleyCandidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dxe = e.x - px;
            const dye = e.y - py;
            const d2 = dxe * dxe + dye * dye;
            if (d2 <= maxD2) {
              candidates.push({ i, d2 });
            }
          }
          candidates.sort((a, b) => a.d2 - b.d2);
          const picks = candidates.slice(0, BOLTS_PER_VOLLEY);
          this._lightUltimateVolleyQueue = picks.map((p) => ({ enemyIdx: p.i }));
          this._lightUltimateVolleyCooldown = VOLLEY_REST_FRAMES;
        }
      }

      // ── 매 프레임 발사체 추적 좌표 갱신 (풀 재사용 방어 — 거리 체크) ──
      if (this.effectManager.lightUltimateHasActiveBolts() && this._lightUltimateBoltMap.size > 0) {
        for (const [id, node] of this._lightUltimateBoltMap) {
          const e = enemies[node.enemyIdx];
          let alive = false;
          if (e && e.active) {
            const dxn = e.x - node.lastX;
            const dyn = e.y - node.lastY;
            if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
              // 정상 이동 — 갱신
              node.lastX = e.x;
              node.lastY = e.y;
              alive = true;
            } else {
              // 풀 재사용 감지 — 적은 죽은 것으로 간주 (마지막 안전 좌표 유지)
              alive = false;
            }
          }
          this.effectManager.updateLightUltimateBoltTarget(id, node.lastX, node.lastY, alive);
        }
      }

      // ── 적중 처리 (engine이 데미지 적용 — 단일 타겟) ──
      const lightImpacts = this.effectManager.lightUltimateImpactsThisFrame();
      for (const imp of lightImpacts) {
        const node = this._lightUltimateBoltMap.get(imp.id);
        if (node && node.enemyIdx >= 0) {
          const e = enemies[node.enemyIdx];
          if (e && e.active) {
            e.hp -= BOLT_DAMAGE;
            spawnHitParticles(particles, e.x, e.y, 0xfde047);
            if (e.hp <= 0) this.killEnemy(node.enemyIdx);
          }
        }
      }

      // ── 사망한 발사체 매핑 정리 ──
      const deadIds = this.effectManager.lightUltimatePopDeadBoltIds();
      for (const id of deadIds) {
        this._lightUltimateBoltMap.delete(id);
      }
    } else {
      if (this._lightUltimateActive) {
        this._lightUltimateActive = false;
        this._lightUltimateVolleyQueue = [];
        this._lightUltimateVolleyCooldown = 0;
        this._lightUltimateBoltMap.clear();
        this.effectManager.stopLightUltimate();
      }
    }

    // ── 흙 × 3 (AAA) — 운석우 (EarthUltimateEffect, 다중 작은 운석 burst) ──
    // 슬롯이 모두 흙일 때만 발동. 사이클: 30f BURSTING (6발 spawn) → 100f REST → 반복.
    // 각 운석이 사선으로 떨어져 착탄 → 광역 데미지/스턴/넉백 + wavy ring 일렁거림.
    if (hasEarthUltimate) {
      const METEOR_DAMAGE = 45;          // 운석 1발당 데미지 (중간 사이즈)
      const DAMAGE_RADIUS = 100;         // 광역 데미지
      const KNOCKBACK_MAX = 18;
      const METEOR_STUN_FRAMES = 90;     // 1.5초/운석 (overlap으로 누적 스턴)

      // 사이클 비활성이면 새로 시작
      if (!this.effectManager.earthUltimateActive()) {
        this.effectManager.startEarthUltimate(px, py);
      }
      // 매 프레임 캐릭터 위치 갱신 (운석 spawn 중심)
      this.effectManager.updateEarthUltimatePosition(px, py);

      // 이번 프레임 착탄한 운석들 처리 (다중 가능)
      const impacts = this.effectManager.earthUltimateImpactsThisFrame();
      if (impacts.length > 0) {
        const r2 = DAMAGE_RADIUS * DAMAGE_RADIUS;
        for (const imp of impacts) {
          const candidates = this.spatialHash.query(imp.x, imp.y, DAMAGE_RADIUS * 2, DAMAGE_RADIUS * 2, enemies.length);
          for (let ci = 0; ci < candidates.length; ci++) {
            const i = candidates[ci];
            const e = enemies[i];
            if (!e.active) continue;
            const dxe = e.x - imp.x;
            const dye = e.y - imp.y;
            const d2 = dxe * dxe + dye * dye;
            if (d2 > r2) continue;
            const dist = Math.sqrt(d2) || 1;

            e.hp -= METEOR_DAMAGE;
            // 외측 넉백
            const knock = KNOCKBACK_MAX * (1 - dist / DAMAGE_RADIUS);
            if (!isBossType(e.type)) {
              e.x += (dxe / dist) * knock;
              e.y += (dye / dist) * knock;
            }
            // 스턴 (이미 더 긴 스턴이 있으면 유지)
            if (!e.stunFrames || e.stunFrames < METEOR_STUN_FRAMES) {
              e.stunFrames = METEOR_STUN_FRAMES;
            }
            // 흙 + 화염 히트 파티클
            spawnHitParticles(particles, e.x, e.y, 0x44403c);
            spawnHitParticles(particles, e.x, e.y, 0xb45309);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      if (this.effectManager.earthUltimateActive()) {
        this.effectManager.stopEarthUltimate();
      }
    }

    // 암흑 single은 함수 끝 독립 블록으로 이동

    // ── 암흑 × 3 (AAA) — 블랙홀 (DarkUltimateEffect, 설치형) ──
    // 1단계 극대화: 슬롯이 모두 암흑일 때만 발동되는 거대 블랙홀.
    // 시각: GLSL 중력 렌즈 + 강착원반 + 사건의 지평선 (DarkUltimateEffect 그대로)
    // 거동: 거대한 반경 + 강한 흡인 + 강한 DoT
    if (hasDarkUltimate) {
      const ultRadius = 200;
      if (!this._darkUltimatePlaced) {
        this._darkUltimatePlaced = true;
        this._darkUltimatePosX = px;
        this._darkUltimatePosY = py;
        this.effectManager.startDarkUltimate(px, py, ultRadius);
      }

      // 강한 흡인 + 강한 지속 데미지 — 완전체 블랙홀
      const uhx = this._darkUltimatePosX;
      const uhy = this._darkUltimatePosY;
      const ultCandidates = this.spatialHash.query(uhx, uhy, ultRadius * 2, ultRadius * 2, enemies.length);
      for (let ci = 0; ci < ultCandidates.length; ci++) {
        const i = ultCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - uhx;
        const dy = e.y - uhy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < ultRadius && dist > 1) {
          // 강한 흡인 (1단계의 5배)
          const pullStrength = 6.0 * (1 - dist / ultRadius);
          if (!isBossType(e.type)) {
            e.x -= (dx / dist) * pullStrength;
            e.y -= (dy / dist) * pullStrength;
          }

          // 강한 DoT: 20데미지 / 20프레임 (1단계의 8배 dps)
          if (this.state.frameCount % 20 === 0) {
            e.hp -= 20;
            spawnHitParticles(particles, e.x, e.y, 0x7c3aed);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      if (this._darkUltimatePlaced) {
        this._darkUltimatePlaced = false;
        this.effectManager.stopDarkUltimate();
      }
    }

    // ── 전기+암흑 조합: 자기장 폭풍 (충전→재연결→폭발→재형성 사이클) ──
    if (hasElectricDarkCombo) {
      this.effectManager.startElectricDark(px, py);
      this.effectManager.updateElectricDarkPosition(px, py);

      const fieldR = this.effectManager.electricDarkFieldRadius();
      const fieldR2 = fieldR * fieldR;

      // ── 충전 페이즈: 영역 내 모든 적에 약한 견인 + DoT + 자기력선 좌표 수집 ──
      if (this.effectManager.electricDarkChargingActive()) {
        // 게임 메커니즘은 모든 적, 시각화(자기력선)는 가까운 N개만 — 렉 방지
        const MAGNETIC_VISUAL_MAX = 12;
        // [d2, lx, ly, curveDir] 튜플로 수집 (객체 GC 압력 줄임)
        const magneticAll: Array<{ d2: number; lx: number; ly: number; curveDir: number }> = [];

        const fieldCandidates = this.spatialHash.query(px, py, fieldR * 2, fieldR * 2, enemies.length);
        for (let ci = 0; ci < fieldCandidates.length; ci++) {
          const i = fieldCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 >= fieldR2) continue;
          const dist = Math.sqrt(d2) || 1;
          const t = dist / fieldR;

          // 자기 견인 (약함 — 메일스트롬 4.2 / 항성붕괴 3.5보다 훨씬 약함)
          // 함정이 아닌 "모음" — 적이 천천히 끌려와 폭발 시점에 모여있도록
          const pull = 0.6 * (1 - t);
          if (!isBossType(e.type)) {
            e.x -= (dx / dist) * pull;
            e.y -= (dy / dist) * pull;
          }

          // 충전 DoT (30프레임마다 6뎀)
          if (this.state.frameCount % 30 === 0) {
            e.hp -= 6;
            spawnHitParticles(particles, e.x, e.y, 0x06b6d4); // 시안
            spawnHitParticles(particles, e.x, e.y, 0xd946ef); // 마젠타
            if (e.hp <= 0) {
              this.killEnemy(i);
              continue;
            }
          }

          // 자기력선 후보 (시각화용 — 거리 기반으로 후순위 정렬)
          // 휘어짐 방향: 적 인덱스 기반 결정론 (덜덜거림 방지)
          magneticAll.push({
            d2,
            lx: dx,
            ly: dy,
            curveDir: (i % 2 === 0) ? 1 : -1,
          });
        }

        // 가까운 N개만 시각화 (자기력선 그리기 부하 제한)
        let magneticTargets: Array<{ lx: number; ly: number; curveDir: number }>;
        if (magneticAll.length <= MAGNETIC_VISUAL_MAX) {
          magneticTargets = magneticAll;
        } else {
          magneticAll.sort((a, b) => a.d2 - b.d2);
          magneticTargets = magneticAll.slice(0, MAGNETIC_VISUAL_MAX);
        }
        this.effectManager.updateElectricDarkMagneticTargets(magneticTargets);
      }

      // ── 재연결 폭발 발동 순간: 잠긴 위치마다 광역 데미지 + 넉백 ──
      if (this.effectManager.electricDarkBurstFired()) {
        const burstPositions = this.effectManager.electricDarkBurstPositions();
        const burstR = this.effectManager.electricDarkBurstRadius();
        const burstR2 = burstR * burstR;
        const BURST_DAMAGE = 28;
        const KNOCKBACK_MAX = 22;

        // 적이 여러 폭발에 의해 중복 처리되지 않도록 (같은 적이 여러 번 데미지 받으면 OP)
        const hitOnce = new Set<number>();

        for (const burst of burstPositions) {
          // spatialHash 재활용: burst 근처 후보만 순회
          const candidates = this.spatialHash.query(burst.x, burst.y, burstR * 2, burstR * 2, enemies.length);
          for (let ci = 0; ci < candidates.length; ci++) {
            const i = candidates[ci];
            if (hitOnce.has(i)) continue;
            const e = enemies[i];
            if (!e.active) continue;
            const dx = e.x - burst.x;
            const dy = e.y - burst.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > burstR2) continue;
            const dist = Math.sqrt(d2) || 1;

            // 메인 데미지
            e.hp -= BURST_DAMAGE;
            // 넉백 (충격파 방향)
            const knock = KNOCKBACK_MAX * (1 - dist / burstR);
            if (!isBossType(e.type)) {
              e.x += (dx / dist) * knock;
              e.y += (dy / dist) * knock;
            }
            // 시안/마젠타/백 히트 파티클
            spawnHitParticles(particles, e.x, e.y, 0x06b6d4);
            spawnHitParticles(particles, e.x, e.y, 0xd946ef);
            spawnHitParticles(particles, e.x, e.y, 0xffffff);

            hitOnce.add(i);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }

      // 1단계 전기/암흑 정지 (조합이 둘 다 흡수)
      this._electricTimer = 0;
      this._electricChainNodes = [];
      this.effectManager.stopElectric();
      if (this._darkPlaced) {
        this._darkPlaced = false;
        this.effectManager.stopDark();
      }
    } else {
      this.effectManager.stopElectricDark();
    }

    // ═══════════════════════════════════════════════════════════════
    // 단일 원소 이펙트 (슬롯별 독립 재생 보장)
    // 콤보가 다른 슬롯에서 활성이어도, 단일 원소 슬롯이 있으면 가려지지 않도록
    // 모든 콤보 블록 뒤에 배치. 각 이펙트는 activeEffects Set 판정으로 1회만 동작.
    // ═══════════════════════════════════════════════════════════════

    // ── 물 1단계 (동심원 파동) ──
    // 슬로우 + 주기적 넉백 펄스 (매 30프레임 반경 바깥으로 밀어냄)
    if (activeEffects.has('s1:물')) {
      const waterRadius = 130;
      const pulseFrame = this.state.frameCount % 30 === 0;
      this.effectManager.startWater(px, py, waterRadius);
      this.effectManager.updateWaterPosition(px, py);
      const waterCandidates = this.spatialHash.query(px, py, waterRadius * 2, waterRadius * 2, enemies.length);
      for (let ci = 0; ci < waterCandidates.length; ci++) {
        const i = waterCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < waterRadius && dist > 1) {
          const tpx = (px - e.x) / dist; // e → player 방향 단위
          const tpy = (py - e.y) / dist;
          // 지속 슬로우/카운터 푸시 (0.6 → 0.85) — 보스 면역
          if (!isBossType(e.type)) {
            e.x -= tpx * e.speed * 0.85;
            e.y -= tpy * e.speed * 0.85;
          }
          if (pulseFrame) {
            // 주기적 넉백 펄스 — 반경 바깥으로 24px 순간 이동 (보스 면역)
            if (!isBossType(e.type)) {
              e.x -= tpx * 24;
              e.y -= tpy * 24;
            }
            e.hp -= 8;
            spawnHitParticles(particles, e.x, e.y, 0x2563eb);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      this.effectManager.stopWater();
    }

    // ── 흙 1단계 (모래지옥 장판) ──
    // 퀵샌드 스타일 강한 슬로우 (기존 0.4 → 0.7) + 주기적 끌어당김 펄스
    if (activeEffects.has('s1:흙')) {
      const earthRadius = 130;
      const pulseFrame = this.state.frameCount % 30 === 0;
      this.effectManager.startEarth(px, py, earthRadius);
      this.effectManager.updateEarthPosition(px, py);
      const earthCandidates = this.spatialHash.query(px, py, earthRadius * 2, earthRadius * 2, enemies.length);
      for (let ci = 0; ci < earthCandidates.length; ci++) {
        const i = earthCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px;
        const dy = e.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < earthRadius && dist > 1) {
          const toPlayerX = (px - e.x) / dist;
          const toPlayerY = (py - e.y) / dist;
          // 강한 슬로우: 적이 플레이어 쪽으로 이동하는 속도를 90% 상쇄 (거의 정지) — 보스 면역
          if (!isBossType(e.type)) {
            e.x -= toPlayerX * e.speed * 0.9;
            e.y -= toPlayerY * e.speed * 0.9;
          }
          if (pulseFrame) {
            e.hp -= 6;
            spawnHitParticles(particles, e.x, e.y, 0xa16207);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      this.effectManager.stopEarth();
    }

    // ── 불 1단계 (화염방사기) ──
    if (activeEffects.has('s1:불')) {
      const fireRange = 700;
      const coneHalfAngle = Math.PI / 16;
      let fireAngle = Math.atan2(this.facingY, this.facingX);
      let nearestFireDist = Infinity;
      const fireRange2 = fireRange * fireRange;
      const fireAimCandidates = this.spatialHash.query(px, py, fireRange * 2, fireRange * 2, enemies.length);
      for (let ci = 0; ci < fireAimCandidates.length; ci++) {
        const i = fireAimCandidates[ci];
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - px;
        const dy = enemies[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestFireDist && d <= fireRange2) {
          nearestFireDist = d;
          fireAngle = Math.atan2(dy, dx);
        }
      }
      this.effectManager.startFire(px, py, fireRange, fireAngle);
      this.effectManager.updateFirePosition(px, py);
      this.effectManager.updateFireDirection(fireAngle);
      if (this.state.frameCount % 10 === 0) {
        const fireConeCandidates = this.spatialHash.query(px, py, fireRange * 2, fireRange * 2, enemies.length);
        for (let ci = 0; ci < fireConeCandidates.length; ci++) {
          const i = fireConeCandidates[ci];
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > fireRange || dist < 1) continue;
          const enemyAngle = Math.atan2(dy, dx);
          let angleDiff = enemyAngle - fireAngle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          if (Math.abs(angleDiff) < coneHalfAngle) {
            e.hp -= 5;
            spawnHitParticles(particles, e.x, e.y, 0xef4444);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      this.effectManager.stopFire();
    }

    // ── 빛 1단계 (레이저 빔) ──
    if (activeEffects.has('s1:빛')) {
      const beamRange = 2000;
      const beamWidth = 20;
      let lightAngle = Math.atan2(this.facingY, this.facingX);
      let nearestLightDist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - px;
        const dy = enemies[i].y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestLightDist) {
          nearestLightDist = d;
          lightAngle = Math.atan2(dy, dx);
        }
      }
      this.effectManager.startLight(px, py);
      this.effectManager.updateLightPosition(px, py);
      this.effectManager.updateLightDirection(lightAngle);
      if (this.effectManager.lightBeamFired()) {
        const angle = this.effectManager.lightBeamAngle();
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        for (let i = 0; i < enemies.length; i++) {
          const e = enemies[i];
          if (!e.active) continue;
          const dx = e.x - px;
          const dy = e.y - py;
          const proj = dx * dirX + dy * dirY;
          if (proj < 0 || proj > beamRange) continue;
          const perpDist = Math.abs(dx * (-dirY) + dy * dirX);
          if (perpDist < beamWidth) {
            e.hp -= 25;
            spawnHitParticles(particles, e.x, e.y, 0xfef08a);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      this.effectManager.stopLight();
    }

    // ── 전기 1단계 (감전 체인) ──
    // 콤보가 _electricTimer / _electricChainNodes를 리셋해도 단일은 별도 변수로 독립 구동
    if (activeEffects.has('s1:전기')) {
      this._electricSingleTimer += 1;
      if (this._electricSingleTimer >= 120) {
        this._electricSingleTimer = 0;
        const range = 400;
        const chainRange = 180;
        const chainTargets: number[] = [];
        const used = new Set<number>();
        let curX = px, curY = py;
        for (let chain = 0; chain < 10; chain++) {
          const maxD = chain === 0 ? range : chainRange;
          const maxD2 = maxD * maxD;
          // SpatialHash 기반 후보 쿼리 — 풀 재사용 버퍼 (다음 query 호출 전까지만 유효)
          const candidates = this.spatialHash.query(curX, curY, maxD * 2, maxD * 2, enemies.length);
          let bestIdx = -1, bestDist = Infinity;
          for (let ci = 0; ci < candidates.length; ci++) {
            const ei = candidates[ci];
            if (!enemies[ei].active || used.has(ei)) continue;
            const dx = enemies[ei].x - curX;
            const dy = enemies[ei].y - curY;
            const d = dx * dx + dy * dy;
            if (d < bestDist && d <= maxD2) {
              bestDist = d; bestIdx = ei;
            }
          }
          if (bestIdx < 0) break;
          chainTargets.push(bestIdx);
          used.add(bestIdx);
          curX = enemies[bestIdx].x;
          curY = enemies[bestIdx].y;
        }
        if (chainTargets.length > 0) {
          for (let ci = 0; ci < chainTargets.length; ci++) {
            const e = enemies[chainTargets[ci]];
            const dmg = Math.max(5, 16 - ci * 2);
            e.hp -= dmg;
            spawnHitParticles(particles, e.x, e.y, 0xa78bfa);
            if (e.hp <= 0) this.killEnemy(chainTargets[ci]);
          }
          this._electricSingleChainNodes = chainTargets.map((ci) => ({
            enemyIdx: ci,
            lastX: enemies[ci].x,
            lastY: enemies[ci].y,
          }));
          const chainPoints: Array<{ x: number; y: number }> = [{ x: px, y: py }];
          for (const ci of chainTargets) {
            chainPoints.push({ x: enemies[ci].x, y: enemies[ci].y });
          }
          this.effectManager.fireElectricChain(chainPoints);
        }
      }
      if (this._electricSingleChainNodes.length > 0) {
        const NODE_MAX_TRAVEL = 120;
        const livePositions: Array<{ x: number; y: number }> = [{ x: px, y: py }];
        for (const node of this._electricSingleChainNodes) {
          const e = enemies[node.enemyIdx];
          if (e && e.active) {
            const dxn = e.x - node.lastX;
            const dyn = e.y - node.lastY;
            if (dxn * dxn + dyn * dyn <= NODE_MAX_TRAVEL * NODE_MAX_TRAVEL) {
              node.lastX = e.x;
              node.lastY = e.y;
            }
          }
          livePositions.push({ x: node.lastX, y: node.lastY });
        }
        this.effectManager.updateElectricPositions(livePositions);
      }
    } else {
      this._electricSingleTimer = 0;
      this._electricSingleChainNodes = [];
      this.effectManager.stopElectric();
    }

    // ── 암흑 1단계 (미니 중력 우물 — 설치형) ──
    // 콤보가 _darkPlaced를 건드려도 단일은 별도 설치 상태로 독립 관리
    if (activeEffects.has('s1:암흑')) {
      const darkRadius = 90;
      if (!this._darkSinglePlaced) {
        this._darkSinglePlaced = true;
        this._darkSinglePosX = px;
        this._darkSinglePosY = py;
        this.effectManager.startDark(px, py, darkRadius);
      }
      const dhx = this._darkSinglePosX;
      const dhy = this._darkSinglePosY;
      const darkCandidates = this.spatialHash.query(dhx, dhy, darkRadius * 2, darkRadius * 2, enemies.length);
      for (let ci = 0; ci < darkCandidates.length; ci++) {
        const i = darkCandidates[ci];
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - dhx;
        const dy = e.y - dhy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < darkRadius && dist > 1) {
          const pullStrength = 1.2 * (1 - dist / darkRadius);
          if (!isBossType(e.type)) {
            e.x -= (dx / dist) * pullStrength;
            e.y -= (dy / dist) * pullStrength;
          }
          if (this.state.frameCount % 40 === 0) {
            e.hp -= 5;
            spawnHitParticles(particles, e.x, e.y, 0x7c3aed);
            if (e.hp <= 0) this.killEnemy(i);
          }
        }
      }
    } else {
      if (this._darkSinglePlaced) {
        this._darkSinglePlaced = false;
        this.effectManager.stopDark();
      }
    }
  }

  private updateWave() {
    this.state.waveTimer--;
    if (this.state.waveAnnounceTimer > 0) this.state.waveAnnounceTimer--;

    if (this.state.waveTimer <= 0) {
      this.state.wave++;
      this.state.waveTimer = WAVE_DURATION;
      this.state.waveAnnounceTimer = 90;
    }
  }

  private autoAttack() {
    const { player, enemies, projectiles } = this.state;

    this.state.autoAttackTimer++;
    if (this.state.autoAttackTimer < AUTO_ATTACK_INTERVAL) return;
    this.state.autoAttackTimer = 0;

    // 슬롯에 채워진 원소들 수집 (완성된 무기 슬롯 제외, 진행 중인 슬롯만)
    const filledElements: ElementType[] = [];
    for (const slot of player.weaponSlots) {
      if (slot.weapon) continue; // 완성된 슬롯은 무기 시스템이 처리
      for (const el of slot.elements) {
        if (el) filledElements.push(el);
      }
    }

    // 가장 가까운 적 찾기
    const findNearest = () => {
      let idx = -1, dist = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        if (!enemies[i].active) continue;
        const dx = enemies[i].x - player.x;
        const dy = enemies[i].y - player.y;
        const d = dx * dx + dy * dy;
        if (d < dist) { dist = d; idx = i; }
      }
      return { idx, dist };
    };

    const range = 400;
    const { idx: nearestIdx, dist: nearestDist } = findNearest();

    // 원소가 없으면 기본 검정 투사체 (데미지 20 — 첫 원소 획득 전까지 주력)
    if (filledElements.length === 0) {
      if (nearestIdx >= 0 && nearestDist <= range * range) {
        const e = enemies[nearestIdx];
        fireProjectile(projectiles, player.x, player.y, e.x, e.y, 20, 0x000000, 5, 4);
      }
      return;
    }

    // 원소별 공격 패턴
    const elColorMap: Record<string, number> = {
      '빛': 0xfef08a, '암흑': 0x7c3aed, '흙': 0xa16207,
      '불': 0xef4444, '물': 0x3b82f6, '전기': 0xa78bfa,
    };

    for (const el of filledElements) {
      const color = elColorMap[el] || 0xFFFFFF;

      switch (el) {
        case '물': {
          // 물: updateElementEffects()에서 매 프레임 처리. 여기서는 아무것도 안 함.
          break;
        }
        case '흙': {
          // 흙: updateElementEffects()에서 매 프레임 처리. 여기서는 아무것도 안 함.
          break;
        }
        case '전기': {
          // 전기: updateElementEffects()에서 처리.
          break;
        }
        case '불': {
          // 불: updateElementEffects()에서 매 프레임 처리. 여기서는 아무것도 안 함.
          break;
        }
        case '빛': {
          // 빛: updateElementEffects()에서 매 프레임 처리. 여기서는 아무것도 안 함.
          break;
        }
        case '암흑': {
          // 암흑: updateElementEffects()에서 처리.
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private spawnAutoEffect(effect: WeaponEffectState) {
    const effects = this.state.weaponEffects;
    for (let i = 0; i < effects.length; i++) {
      if (!effects[i].active) {
        effects[i] = effect;
        return;
      }
    }
    if (effects.length < 200) {
      effects.push(effect);
    }
  }

  private handleElementOrbPickup() {
    const { player, elementOrbs } = this.state;
    const pickedElement = updateElementOrbs(elementOrbs, player);

    if (pickedElement) {
      this.addElementToSlot(pickedElement);
    }
  }

  private addElementToSlot(element: ElementType) {
    const { player } = this.state;

    // Try active slot first
    const trySlot = (index: number): boolean => {
      const slot = player.weaponSlots[index];
      if (slot.weapon !== null) return false; // already completed
      for (let i = 0; i < 3; i++) {
        if (slot.elements[i] === null) {
          slot.elements[i] = element;
          this._activeEffectsDirty = true;
          // Check if all 3 sub-slots are now filled
          if (slot.elements.every(e => e !== null)) {
            const weapon = getWeaponForElements(slot.elements);
            slot.weapon = weapon;
            slot.weaponTimer = 0;
          }
          return true;
        }
      }
      return false;
    };

    // Try active slot first, then others
    if (trySlot(player.activeSlotIndex)) return;
    for (let i = 0; i < 3; i++) {
      if (i === player.activeSlotIndex) continue;
      if (trySlot(i)) return;
    }
  }

  private devClearSlots() {
    for (const slot of this.state.player.weaponSlots) {
      slot.elements = [null, null, null];
      slot.weapon = null;
      slot.weaponTimer = 0;
    }
    // Clear active weapon effects
    for (const eff of this.state.weaponEffects) {
      eff.active = false;
    }
    this._activeEffectsDirty = true;
  }

  private devFillAll() {
    for (let s = 0; s < 3; s++) {
      const slot = this.state.player.weaponSlots[s];
      if (slot.weapon) continue; // already complete
      for (let e = 0; e < 3; e++) {
        if (slot.elements[e] === null) {
          slot.elements[e] = ALL_ELEMENTS[Math.floor(Math.random() * ALL_ELEMENTS.length)];
        }
      }
      if (slot.elements.every(el => el !== null)) {
        const weapon = getWeaponForElements(slot.elements);
        slot.weapon = weapon;
        slot.weaponTimer = 0;
      }
    }
    this._activeEffectsDirty = true;
  }

  /** DEV: 큐 순서대로 다음 보스 강제 소환 (level/slot 조건 우회, 플레이어 바로 앞에 배치) */
  private devSpawnNextBoss() {
    const bossType = this._bossQueue[this._bossQueueIndex % this._bossQueue.length];
    const p = this.state.player;
    const ok = spawnEnemy(this.state.enemies, bossType, p.x, p.y, this.state.cameraX, this.state.cameraY, this.state.wave);
    if (ok) {
      this.placeBossInView(bossType);
      this._bossQueueIndex++;
      console.info(`[dev] spawned ${bossType} (queueIdx→${this._bossQueueIndex})`);
    } else {
      console.warn('[dev] spawn failed — pool full');
    }
  }

  /** DEV: 모든 활성 보스 즉사 */
  private devKillAllBosses() {
    for (let i = 0; i < this.state.enemies.length; i++) {
      const e = this.state.enemies[i];
      if (e.active && isBossType(e.type)) {
        this.killEnemy(i);
      }
    }
  }

  /** DEV: 즉시 레벨업 (XP 조건 우회, pendingEvent 없을 때만) */
  private devLevelUp() {
    if (this.state.pendingLevelEvent) return;
    const p = this.state.player;
    p.xp = p.xpToNext;  // 다음 checkLevelUp 에서 무조건 통과
  }

  /**
   * 방금 spawn된 해당 타입 보스를 플레이어 화면 내 잘 보이는 위치로 이동.
   * spawnEnemy 는 화면 edge 에 배치 — 보스는 스크린 중앙~플레이어 상단쪽으로 리포지션.
   */
  private placeBossInView(bossType: EnemyType) {
    // 가장 최근 spawn된 해당 type 찾기 (뒤에서 역순)
    const enemies = this.state.enemies;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (!e.active) continue;
      if (e.type !== bossType) continue;
      // 플레이어 기준 위쪽 240px (잘 보이면서 너무 가깝지 않게)
      e.x = this.state.player.x;
      e.y = this.state.player.y - 240;
      // 월드 경계 내 클램프
      e.x = Math.max(120, Math.min(WORLD_W - 120, e.x));
      e.y = Math.max(120, Math.min(WORLD_H - 120, e.y));
      e.angle = Math.atan2(this.state.player.y - e.y, this.state.player.x - e.x);
      return;
    }
  }

  private handleCollisions() {
    const { enemies, projectiles, player, particles, xpOrbs, weaponEffects } = this.state;

    // Build spatial hash for enemies
    this.spatialHash.clear();
    for (let i = 0; i < enemies.length; i++) {
      if (enemies[i].active) {
        this.spatialHash.insert(i, enemies[i].x, enemies[i].y, enemies[i].width, enemies[i].height);
      }
    }

    // Projectile-enemy collisions
    const projHits = checkProjectileEnemyCollisions(projectiles, enemies, this.spatialHash);
    for (const { pi, ei } of projHits) {
      const p = projectiles[pi];
      const e = enemies[ei];
      e.hp -= p.damage;
      spawnHitParticles(particles, e.x, e.y, p.color || 0xFFFFFF);

      // 불 투사체: 파편 분산 — 주변 적에게 약한 데미지
      if (p.onHitEffect === 'fire_splash') {
        // 파편 이펙트
        this.spawnAutoEffect({
          type: 'explosion',
          uniqueId: 'auto_fire_splash',
          x: e.x, y: e.y,
          vx: 0, vy: 0,
          radius: 55,
          damage: 6, // 파편 데미지 (본체 18보다 약함)
          color: 0xef4444,
          life: 40,
          maxLife: 40,
          active: true,
          angle: 0,
          hitEnemies: new Set([ei]), // 이미 맞은 적 제외
        });
      }

      if (p.pierce > 0) {
        p.pierce--;
      } else {
        p.active = false;
      }

      if (e.hp <= 0) {
        this.killEnemy(ei);
      }
    }

    // Weapon effect-enemy collisions
    const wHits = checkWeaponEffectEnemyCollisions(weaponEffects, enemies, this.spatialHash);
    for (const { wi, ei } of wHits) {
      const w = weaponEffects[wi];
      const e = enemies[ei];
      e.hp -= w.damage;
      w.hitEnemies.add(ei);
      spawnHitParticles(particles, e.x, e.y, w.color);

      if (e.hp <= 0) {
        this.killEnemy(ei);
      }
    }

    // Player-enemy collisions (DEV: 무적 — 피격 무시)
    // const playerHits = checkPlayerEnemyCollisions(player, enemies, this.spatialHash);
    // if (playerHits.length > 0) {
    //   player.hp -= 10;
    //   player.invincibleFrames = INVINCIBLE_FRAMES;
    //   this.state.shakeFrames = 8;
    //   if (player.hp <= 0) {
    //     player.hp = 0;
    //     this.state.gameOver = true;
    //     showGameOver(this.gameOverOverlay, this.state, () => this.restart());
    //   }
    // }
  }

  private killEnemy(ei: number) {
    const e = this.state.enemies[ei];
    if (!e.active) return;

    const wasBoss = isBossType(e.type);
    spawnExplosionParticles(this.state.particles, e.x, e.y, e.color, wasBoss ? 40 : 10);

    // DEV: XP 오브, 원소 오브 드랍 제거
    // spawnXPOrb(this.state.xpOrbs, e.x, e.y, e.xp);
    // if (Math.random() < ELEMENT_ORB_DROP_CHANCE) {
    //   spawnRandomElementOrb(this.state.elementOrbs, e.x, e.y);
    // }

    e.active = false;

    this.state.player.kills++;
    this.state.player.score += e.xp;
    // DEV: XP 오브 대신 즉시 지급 (orb 드랍 비활성 상태)
    this.state.player.xp += Math.round(e.xp * this.state.player.stats.xpGainMul);
    this.state.player.comboCount++;
    this.state.player.comboTimer = 90; // 1.5 seconds

    if (this.state.player.comboCount >= 5) {
      this.state.comboDisplayCount = this.state.player.comboCount;
      this.state.comboDisplayTimer = 60;
    }

    // 보스 처치 → 해당 속성 스킬 해금
    if (wasBoss) {
      this.unlockSkillForBoss(e.type);
    }
  }

  private unlockSkillForBoss(bossType: EnemyType) {
    const element = BOSS_TO_ELEMENT[bossType];
    if (!element) return;
    const skillMap: Record<ElementType, SkillId> = {
      '물': 'water_tidal',
      '불': 'fire_inferno',
      '흙': 'earth_quake',
      '빛': 'light_judgment',
      '전기': 'electric_storm',
      '암흑': 'dark_abyss',
    };
    const skillId = skillMap[element];
    const slot = this.state.player.skills[skillId];
    if (!slot.unlocked) {
      slot.unlocked = true;
      slot.cooldown = 0; // 즉시 사용 가능
    }
  }

  private updateCombo() {
    if (this.state.comboDisplayTimer > 0) this.state.comboDisplayTimer--;
  }

  private updateLevelUpText() {
    if (this.state.levelUpTextTimer > 0) this.state.levelUpTextTimer--;
  }

  private checkLevelUp() {
    const { player } = this.state;
    // 이미 처리 대기 이벤트가 있으면 추가 레벨업 보류 (순차 처리)
    if (this.state.pendingLevelEvent) return;
    if (player.xp < player.xpToNext) return;

    player.xp -= player.xpToNext;
    player.level++;
    player.xpToNext = computeXpToNext(player.level);

    spawnLevelUpParticles(this.state.particles, player.x, player.y);
    this.state.levelUpTextTimer = 60;

    // 최대 레벨 도달 시 이벤트 생성하지 않음
    if (player.level > 150) return;

    // 이벤트 발생 레벨:
    //   Lv 3/6/9 → 고정 슬롯에 원소 배치 (element_select)
    //   Lv 10/20/.../150 (10 배수, 빈 칸 있을 때) → 원하는 슬롯에 배치 (element_place)
    //   Lv 10 배수 + 9슬롯 완성 → 원소 보스 등장
    //   그 외 → 자동 스탯
    const isElementLevel = player.level === 3 || player.level === 6 || player.level === 9;
    const allSlotsFilled = !this.hasEmptyElementSlot();
    const isBossLevel = player.level >= 10 && player.level % 10 === 0 && allSlotsFilled;
    const isPlaceLevel = player.level >= 10 && player.level % 10 === 0 && !allSlotsFilled;

    if (isBossLevel) {
      // ※ hasActiveBoss 스킵 제거 — 이전 보스가 살아있어도 큐는 진행 (아니면 상위 보스가 영영 안 나오는 버그)
      const bossType = this._bossQueue[this._bossQueueIndex % this._bossQueue.length];
      const ok = spawnEnemy(this.state.enemies, bossType, player.x, player.y, this.state.cameraX, this.state.cameraY, this.state.wave);
      if (ok) {
        this.placeBossInView(bossType);
        this._bossQueueIndex++;
        console.info(`[boss] spawned ${bossType} (level ${player.level}, queueIdx→${this._bossQueueIndex})`);
      } else {
        console.warn('[boss] spawn failed (pool full?)', bossType);
      }
    }

    if (!isElementLevel && !isPlaceLevel) {
      const [choice] = rollStatChoices(1);
      if (choice) applyStatChoice(player, choice.id);
      return;
    }

    // DEV 모드: 레벨업 선택 UI 스킵 (devFillAll 로 슬롯은 이미 채워져있으니 스탯만 적용)
    if (this.devMode) {
      const [choice] = rollStatChoices(1);
      if (choice) applyStatChoice(player, choice.id);
      return;
    }

    const event = this.buildLevelEvent(player.level, isElementLevel);
    this.state.pendingLevelEvent = event;
    this.state.paused = true;
    if (this.onLevelEvent) this.onLevelEvent(event);
  }

  /** Lv 3/6/9: 고정 슬롯 원소 선택. Lv 10배수: 원하는 슬롯 배치. */
  private buildLevelEvent(level: number, isElementLevel: boolean): LevelEvent {
    const elementChoices = pickRandomElements(3);
    if (isElementLevel) {
      const targetWeaponIndex = (level / 3) - 1; // 0, 1, 2
      return { kind: 'element_select', level, elementChoices, targetWeaponIndex };
    }
    // element_place: 슬롯 스냅샷 포함 (UI가 빈 칸 시각화)
    const slotsSnapshot = this.state.player.weaponSlots.map((s) => [...s.elements]);
    return { kind: 'element_place', level, elementChoices, slotsSnapshot };
  }

  private hasEmptyElementSlot(): boolean {
    for (const slot of this.state.player.weaponSlots) {
      for (const el of slot.elements) {
        if (el === null) return true;
      }
    }
    return false;
  }

  /** React 오버레이가 플레이어 선택을 넘겨주면 적용 후 게임 재개. */
  resolveLevelEvent(resolution: LevelEventResolution): void {
    const event = this.state.pendingLevelEvent;
    if (!event) return;
    if (event.kind !== resolution.kind) return;

    const { player } = this.state;

    if (resolution.kind === 'element_select') {
      const weaponIndex = event.targetWeaponIndex ?? 0;
      placeElementIntoFirstEmpty(this.state, weaponIndex, resolution.element);
      this._activeEffectsDirty = true;
    } else if (resolution.kind === 'element_place') {
      placeElementIntoSlot(this.state, resolution.weaponIndex, resolution.slotIndex, resolution.element);
      this._activeEffectsDirty = true;
    } else if (resolution.kind === 'stat_upgrade') {
      applyStatChoice(player, resolution.choiceId);
    }

    this.state.pendingLevelEvent = null;
    this.state.paused = false;
  }

  private render() {
    drawPlayer(this.playerGfx, this.state);

    drawEnemies(this.entityLayer, this.state, this.enemyGfx);
    drawProjectiles(this.effectLayer, this.state, this.projGfx);
    // DEV: 오브 렌더링 제거
    // drawXPOrbs(this.entityLayer, this.state, this.orbGfx);
    // drawElementOrbs(this.entityLayer, this.state, this.elementOrbGfx);
    drawParticles(this.particleRenderer, this.state);
    drawWeaponEffects(this.effectLayer, this.state, this.effectGfx);
    drawEnemyProjectiles(this.enemyProjectileGfx, this.state);
    drawPlayerBars(this.playerBarsGfx, this.state);
    applyCamera(this.worldContainer, this.state, this.playerLayer);
    updateUI(this.ui, this.state);
  }

  restart() {
    // Clean up all graphics
    this.enemyGfx.forEach(g => { g.destroy(); });
    this.projGfx.forEach(g => { g.destroy(); });
    this.orbGfx.forEach(g => { g.destroy(); });
    this.elementOrbGfx.forEach(g => { g.destroy(); });
    this.effectGfx.forEach(g => { g.destroy(); });
    this.enemyGfx = [];
    this.projGfx = [];
    this.orbGfx = [];
    this.elementOrbGfx = [];
    this.effectGfx = [];
    // 파티클 sprites는 ParticleContainer 안에 있어 container 삭제 시 정리됨 (재시작에선 재사용)

    this.gameOverOverlay.container.visible = false;

    this.setupState();
  }

  destroy() {
    this.destroyed = true;
    this.effectManager?.destroy();
    window.removeEventListener('keydown', this._keyDown);
    window.removeEventListener('keyup', this._keyUp);
    this.app.ticker.remove(this.gameLoop);
    this.app.destroy(true, { children: true, texture: true });
  }
}

// ── 레벨업 시스템 유틸 (모듈 스코프) ──

/** 초반은 매우 빠르게(첫 10레벨 빠른 피드백), 후반은 완만. */
function computeXpToNext(level: number): number {
  // L=1: 18, L=3: 27, L=6: 43, L=9: 64, L=10: 72, L=20: 220, L=30: 460, L=60: 1750, L=100: 4810, L=150: 8260
  return Math.floor(10 + level * 8 + level * level * 0.3);
}

function pickRandomElements(count: number): ElementType[] {
  const pool = [...ALL_ELEMENTS];
  const result: ElementType[] = [];
  for (let i = 0; i < count; i++) {
    if (pool.length === 0) {
      // 6개 초과 요청 시 중복 허용
      result.push(ALL_ELEMENTS[Math.floor(Math.random() * ALL_ELEMENTS.length)]);
    } else {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool.splice(idx, 1)[0]);
    }
  }
  return result;
}

/** 지정 무기 슬롯의 첫 번째 빈 칸에 원소 배치. 이미 완성된 무기면 no-op. */
function placeElementIntoFirstEmpty(state: GameState, weaponIndex: number, element: ElementType): void {
  const slot = state.player.weaponSlots[weaponIndex];
  if (!slot || slot.weapon) return;
  for (let i = 0; i < 3; i++) {
    if (slot.elements[i] === null) {
      slot.elements[i] = element;
      tryCompleteWeapon(slot);
      return;
    }
  }
}

function placeElementIntoSlot(state: GameState, weaponIndex: number, slotIndex: number, element: ElementType): void {
  const slot = state.player.weaponSlots[weaponIndex];
  if (!slot) return;
  if (slotIndex < 0 || slotIndex > 2) return;
  if (slot.elements[slotIndex] !== null) return;
  slot.elements[slotIndex] = element;
  tryCompleteWeapon(slot);
}

function tryCompleteWeapon(slot: GameState['player']['weaponSlots'][number]): void {
  if (slot.elements.every((e) => e !== null)) {
    slot.weapon = getWeaponForElements(slot.elements);
    slot.weaponTimer = 0;
  }
}
