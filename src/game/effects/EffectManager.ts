import * as PIXI from 'pixi.js';
import { WaterEffect } from './WaterEffect';
import { EarthEffect } from './EarthEffect';
import { FireEffect } from './FireEffect';
import { LightEffect } from './LightEffect';
import { ElectricEffect } from './ElectricEffect';
import { DarkEffect } from './DarkEffect';
import { DarkUltimateEffect } from './DarkUltimateEffect';
import { ElectricUltimateEffect } from './ElectricUltimateEffect';
import { FireUltimateEffect } from './FireUltimateEffect';
import { WaterUltimateEffect } from './WaterUltimateEffect';
import { LightUltimateEffect } from './LightUltimateEffect';
import { EarthUltimateEffect } from './EarthUltimateEffect';
import { LightElectricEffect } from './LightElectricEffect';
import { WaterElectricEffect } from './WaterElectricEffect';
import { WaterEarthEffect } from './WaterEarthEffect';
import { WaterFireEffect } from './WaterFireEffect';
import { EarthFireEffect } from './EarthFireEffect';
import { WaterLightEffect } from './WaterLightEffect';
import { WaterDarkEffect } from './WaterDarkEffect';
import { FireDarkEffect } from './FireDarkEffect';
import { FireElectricEffect } from './FireElectricEffect';
import { EarthElectricEffect } from './EarthElectricEffect';
import { WaterEarthElectricEffect } from './WaterEarthElectricEffect';
import { FireLightEffect } from './FireLightEffect';
import { ElectricDarkEffect } from './ElectricDarkEffect';
import { EarthLightEffect } from './EarthLightEffect';
import { LightDarkEffect } from './LightDarkEffect';
import { EarthDarkEffect } from './EarthDarkEffect';
import { FireLightDarkEffect } from './FireLightDarkEffect';
import { LightElectricDarkEffect } from './LightElectricDarkEffect';
import { EarthFireDarkEffect } from './EarthFireDarkEffect';
import { WaterLightElectricEffect } from './WaterLightElectricEffect';
import { FireLightElectricEffect } from './FireLightElectricEffect';
import { EarthLightElectricEffect } from './EarthLightElectricEffect';
import { WaterLightDarkEffect } from './WaterLightDarkEffect';
import { FireElectricDarkEffect } from './FireElectricDarkEffect';
import { EarthLightDarkEffect } from './EarthLightDarkEffect';
import { WaterFireElectricEffect } from './WaterFireElectricEffect';
import { EarthFireElectricEffect } from './EarthFireElectricEffect';
import { WaterEarthFireEffect } from './WaterEarthFireEffect';
import { WaterFireLightEffect } from './WaterFireLightEffect';
import { WaterFireDarkEffect } from './WaterFireDarkEffect';
import { WaterElectricDarkEffect } from './WaterElectricDarkEffect';
import { WaterEarthLightEffect } from './WaterEarthLightEffect';
import { EarthFireLightEffect } from './EarthFireLightEffect';
import { WaterEarthDarkEffect } from './WaterEarthDarkEffect';
import { EarthElectricDarkEffect } from './EarthElectricDarkEffect';

/**
 * 이펙트 매니저 — 모든 속성 이펙트의 중앙 관리
 */
export class EffectManager {
  private effectLayer: PIXI.Container;
  /**
   * GLSL Filter target. groundLayer를 받음 (background tiles 만 포함).
   * 캐릭터/몬스터/이펙트는 이 위 레이어에 있어 filter 영향 안 받음 (안 가려짐).
   * 변수명은 호환성 위해 worldContainer 유지.
   */
  private worldContainer: PIXI.Container;
  private overlayLayer: PIXI.Container;
  private waterEffect: WaterEffect | null = null;
  private earthEffect: EarthEffect | null = null;
  private fireEffect: FireEffect | null = null;
  private lightEffect: LightEffect | null = null;
  private electricEffect: ElectricEffect | null = null;
  private darkEffect: DarkEffect | null = null;
  private darkUltimateEffect: DarkUltimateEffect | null = null;
  private electricUltimateEffect: ElectricUltimateEffect | null = null;
  private fireUltimateEffect: FireUltimateEffect | null = null;
  private waterUltimateEffect: WaterUltimateEffect | null = null;
  private lightUltimateEffect: LightUltimateEffect | null = null;
  private earthUltimateEffect: EarthUltimateEffect | null = null;
  private lightElectricEffect: LightElectricEffect | null = null;
  private waterElectricEffect: WaterElectricEffect | null = null;
  private waterEarthEffect: WaterEarthEffect | null = null;
  private waterFireEffect: WaterFireEffect | null = null;
  private earthFireEffect: EarthFireEffect | null = null;
  private waterLightEffect: WaterLightEffect | null = null;
  private waterDarkEffect: WaterDarkEffect | null = null;
  private fireDarkEffect: FireDarkEffect | null = null;
  private fireElectricEffect: FireElectricEffect | null = null;
  private earthElectricEffect: EarthElectricEffect | null = null;
  private waterEarthElectricEffect: WaterEarthElectricEffect | null = null;
  private fireLightEffect: FireLightEffect | null = null;
  private electricDarkEffect: ElectricDarkEffect | null = null;
  private earthLightEffect: EarthLightEffect | null = null;
  private lightDarkEffect: LightDarkEffect | null = null;
  private earthDarkEffect: EarthDarkEffect | null = null;
  private fireLightDarkEffect: FireLightDarkEffect | null = null;
  private lightElectricDarkEffect: LightElectricDarkEffect | null = null;
  private earthFireDarkEffect: EarthFireDarkEffect | null = null;
  private waterLightElectricEffect: WaterLightElectricEffect | null = null;
  private fireLightElectricEffect: FireLightElectricEffect | null = null;
  private earthLightElectricEffect: EarthLightElectricEffect | null = null;
  private waterLightDarkEffect: WaterLightDarkEffect | null = null;
  private fireElectricDarkEffect: FireElectricDarkEffect | null = null;
  private earthLightDarkEffect: EarthLightDarkEffect | null = null;
  private waterFireElectricEffect: WaterFireElectricEffect | null = null;
  private earthFireElectricEffect: EarthFireElectricEffect | null = null;
  private waterEarthFireEffect: WaterEarthFireEffect | null = null;
  private waterFireLightEffect: WaterFireLightEffect | null = null;
  private waterFireDarkEffect: WaterFireDarkEffect | null = null;
  private waterElectricDarkEffect: WaterElectricDarkEffect | null = null;
  private waterEarthLightEffect: WaterEarthLightEffect | null = null;
  private earthFireLightEffect: EarthFireLightEffect | null = null;
  private waterEarthDarkEffect: WaterEarthDarkEffect | null = null;
  private earthElectricDarkEffect: EarthElectricDarkEffect | null = null;
  private cameraX = 0;
  private cameraY = 0;
  private renderer: PIXI.Renderer | null = null;

  constructor(effectLayer: PIXI.Container, worldContainer?: PIXI.Container, overlayLayer?: PIXI.Container, renderer?: PIXI.Renderer) {
    this.effectLayer = effectLayer;
    this.worldContainer = worldContainer || effectLayer;
    this.overlayLayer = overlayLayer || effectLayer;
    this.renderer = renderer || null;
  }

  updateCamera(cx: number, cy: number) {
    this.cameraX = cx;
    this.cameraY = cy;
  }

  // ── 물 ──

  startWater(x: number, y: number, radius: number) {
    if (!this.waterEffect) {
      this.waterEffect = new WaterEffect(this.effectLayer);
    }
    if (!this.waterEffect.active) {
      this.waterEffect.start(x, y, radius);
    }
  }

  updateWaterPosition(x: number, y: number) {
    if (this.waterEffect?.active) {
      this.waterEffect.setPosition(x, y);
    }
  }

  stopWater() {
    this.waterEffect?.stop();
  }

  // ── 흙 ──

  startEarth(x: number, y: number, radius: number) {
    if (!this.earthEffect) {
      this.earthEffect = new EarthEffect(this.effectLayer);
    }
    if (!this.earthEffect.active) {
      this.earthEffect.start(x, y, radius);
    }
  }

  updateEarthPosition(x: number, y: number) {
    if (this.earthEffect?.active) {
      this.earthEffect.setPosition(x, y);
    }
  }

  stopEarth() {
    this.earthEffect?.stop();
  }

  // ── 불 ──

  startFire(x: number, y: number, range: number, direction: number) {
    if (!this.fireEffect) {
      this.fireEffect = new FireEffect(this.effectLayer);
    }
    if (!this.fireEffect.active) {
      this.fireEffect.start(x, y, range, direction);
    }
  }

  updateFirePosition(x: number, y: number) {
    if (this.fireEffect?.active) {
      this.fireEffect.setPosition(x, y);
    }
  }

  updateFireDirection(angle: number) {
    if (this.fireEffect?.active) {
      this.fireEffect.setDirection(angle);
    }
  }

  stopFire() {
    this.fireEffect?.stop();
  }

  // ── 빛 ──

  startLight(x: number, y: number) {
    if (!this.lightEffect) {
      this.lightEffect = new LightEffect(this.effectLayer);
    }
    if (!this.lightEffect.active) {
      this.lightEffect.start(x, y);
    }
  }

  updateLightPosition(x: number, y: number) {
    if (this.lightEffect?.active) {
      this.lightEffect.setPosition(x, y);
    }
  }

  updateLightDirection(angle: number) {
    if (this.lightEffect?.active) {
      this.lightEffect.setDirection(angle);
    }
  }

  stopLight() {
    this.lightEffect?.stop();
  }

  /** 빔이 이번 프레임에 발사됐는지 (엔진이 데미지 판정에 사용) */
  lightBeamFired(): boolean {
    return this.lightEffect?.beamFiredThisFrame ?? false;
  }

  lightBeamAngle(): number {
    return this.lightEffect?.beamDirection ?? 0;
  }

  // ── 전기 ──

  fireElectricChain(points: Array<{ x: number; y: number }>) {
    if (!this.electricEffect) {
      this.electricEffect = new ElectricEffect(this.effectLayer);
    }
    this.electricEffect.fireChain(points);
  }

  updateElectricPositions(positions: Array<{ x: number; y: number }>) {
    this.electricEffect?.updateChainPositions(positions);
  }

  stopElectric() {
    this.electricEffect?.stop();
  }

  // ── 물+흙 조합 ──

  startWaterEarth(x: number, y: number, radius: number) {
    if (!this.waterEarthEffect) {
      this.waterEarthEffect = new WaterEarthEffect(this.effectLayer);
    }
    if (!this.waterEarthEffect.active) {
      this.waterEarthEffect.start(x, y, radius);
    }
  }

  updateWaterEarthPosition(x: number, y: number) {
    if (this.waterEarthEffect?.active) {
      this.waterEarthEffect.setPosition(x, y);
    }
  }

  stopWaterEarth() {
    this.waterEarthEffect?.stop();
  }

  // ── 빛+전기 조합 ──

  startLightElectric(x: number, y: number) {
    if (!this.lightElectricEffect) {
      this.lightElectricEffect = new LightElectricEffect(this.effectLayer);
    }
    if (!this.lightElectricEffect.active) {
      this.lightElectricEffect.start(x, y);
    }
  }

  updateLightElectricPosition(x: number, y: number) {
    if (this.lightElectricEffect?.active) {
      this.lightElectricEffect.setPosition(x, y);
    }
  }

  /** 차징 완료 → 체인 발사 시 true */
  lightElectricChainFired(): boolean {
    return this.lightElectricEffect?.chainFiredThisFrame ?? false;
  }

  /** 엔진이 체인 타겟 좌표를 전달 (월드 좌표) */
  fireLightElectricChain(points: Array<{ x: number; y: number }>) {
    this.lightElectricEffect?.fireChain(points);
  }

  /** 매 프레임 볼트 좌표를 적 현재 위치로 갱신 */
  updateLightElectricChainPositions(positions: Array<{ x: number; y: number }>) {
    this.lightElectricEffect?.updateChainPositions(positions);
  }

  stopLightElectric() {
    this.lightElectricEffect?.stop();
  }

  // ── 물+전기 조합 ──

  startWaterElectric(x: number, y: number, radius: number) {
    if (!this.waterElectricEffect) {
      this.waterElectricEffect = new WaterElectricEffect(this.effectLayer);
    }
    if (!this.waterElectricEffect.active) {
      this.waterElectricEffect.start(x, y, radius);
    }
  }

  updateWaterElectricPosition(x: number, y: number) {
    if (this.waterElectricEffect?.active) {
      this.waterElectricEffect.setPosition(x, y);
    }
  }

  getWaterElectricRadius(): number {
    return this.waterElectricEffect?.radius ?? 0;
  }

  stopWaterElectric() {
    this.waterElectricEffect?.stop();
  }

  // ── 물+불 조합 ──

  startWaterFire(x: number, y: number) {
    if (!this.waterFireEffect) {
      this.waterFireEffect = new WaterFireEffect(this.effectLayer);
    }
    if (!this.waterFireEffect.active) {
      this.waterFireEffect.start(x, y);
    }
  }

  updateWaterFirePosition(x: number, y: number) {
    if (this.waterFireEffect?.active) {
      this.waterFireEffect.setPosition(x, y);
    }
  }

  /** Phase 3 진입 순간 (엔진이 광역 데미지/넉백/화상 적용) */
  waterFireBurstFired(): boolean {
    return this.waterFireEffect?.burstFiredThisFrame ?? false;
  }

  /** 폭발 중심 좌표 (월드) — 잠긴 컨테이너 위치 */
  waterFireBurstCenter(): { x: number; y: number } {
    if (!this.waterFireEffect) return { x: 0, y: 0 };
    return { x: this.waterFireEffect.centerX, y: this.waterFireEffect.centerY };
  }

  waterFireBurstRadius(): number {
    return this.waterFireEffect?.burstRadius ?? 280;
  }

  stopWaterFire() {
    this.waterFireEffect?.stop();
  }

  // ── 흙+불 조합 ──

  startEarthFire(x: number, y: number) {
    if (!this.earthFireEffect) {
      this.earthFireEffect = new EarthFireEffect(this.effectLayer);
    }
    if (!this.earthFireEffect.active) {
      this.earthFireEffect.start(x, y);
    }
  }

  /** 매 프레임 컨테이너 위치 = 캐릭터 위치 (장판형) */
  updateEarthFirePosition(x: number, y: number) {
    if (this.earthFireEffect?.active) {
      this.earthFireEffect.setPosition(x, y);
    }
  }

  /** 이번 프레임에 폭발이 시작된 링들 (도넛 영역) */
  earthFireBurstFires(): Array<{ radius: number; ringWidth: number }> {
    return this.earthFireEffect?.burstFiredThisFrame ?? [];
  }

  /** 현재 활성 도넛 풀들 */
  earthFireActivePools(): Array<{ radius: number; ringWidth: number }> {
    return this.earthFireEffect?.activePools ?? [];
  }

  stopEarthFire() {
    this.earthFireEffect?.stop();
  }

  // ── 물+빛 조합 ──

  startWaterLight(x: number, y: number) {
    if (!this.waterLightEffect) {
      this.waterLightEffect = new WaterLightEffect(this.effectLayer);
    }
    if (!this.waterLightEffect.active) {
      this.waterLightEffect.start(x, y);
    }
  }

  updateWaterLightPosition(x: number, y: number) {
    if (this.waterLightEffect?.active) {
      this.waterLightEffect.setPosition(x, y);
    }
  }

  updateWaterLightDirection(angle: number) {
    if (this.waterLightEffect?.active) {
      this.waterLightEffect.setDirection(angle);
    }
  }

  /** 빔 발사 순간 */
  waterLightBeamFired(): boolean {
    return this.waterLightEffect?.beamFiredThisFrame ?? false;
  }

  /** 메인 빔 방향 */
  waterLightBeamAngle(): number {
    return this.waterLightEffect?.beamDirection ?? 0;
  }

  stopWaterLight() {
    this.waterLightEffect?.stop();
  }

  // ── 암흑 ──

  startDark(x: number, y: number, radius: number) {
    if (!this.darkEffect) {
      this.darkEffect = new DarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.darkEffect.active) {
      this.darkEffect.start(x, y, radius);
    }
  }

  stopDark() {
    this.darkEffect?.stop();
  }

  // ── 암흑 × 3 (AAA) — 블랙홀 (DarkUltimateEffect, 설치형) ──

  startDarkUltimate(x: number, y: number, radius: number) {
    if (!this.darkUltimateEffect) {
      this.darkUltimateEffect = new DarkUltimateEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.darkUltimateEffect.active) {
      this.darkUltimateEffect.start(x, y, radius);
    }
  }

  stopDarkUltimate() {
    this.darkUltimateEffect?.stop();
  }

  // ── 전기 × 3 (AAA) — 뇌신의 분노 (사방 체인 폭주) ──

  startElectricUltimate() {
    if (!this.electricUltimateEffect) {
      this.electricUltimateEffect = new ElectricUltimateEffect(this.effectLayer);
    }
    if (!this.electricUltimateEffect.active) {
      this.electricUltimateEffect.start();
    }
  }

  stopElectricUltimate() {
    this.electricUltimateEffect?.stop();
  }

  electricUltimateActive(): boolean {
    return this.electricUltimateEffect?.active ?? false;
  }

  /** 사방 체인 발사 — engine이 발사 주기마다 호출. chains[g] = [캐릭터, 적1, 적2, ...] */
  fireElectricUltimateBurst(chains: Array<Array<{ x: number; y: number }>>) {
    if (this.electricUltimateEffect?.active) {
      this.electricUltimateEffect.fireBurst(chains);
    }
  }

  /** 매 프레임 chain 좌표 갱신 (풀 재사용 방어) */
  updateElectricUltimateChainPositions(positions: Array<Array<{ x: number; y: number }>>) {
    if (this.electricUltimateEffect?.active) {
      this.electricUltimateEffect.updateChainPositions(positions);
    }
  }

  electricUltimateHasActiveBolts(): boolean {
    return this.electricUltimateEffect?.hasActiveBolts() ?? false;
  }

  // ── 불 × 3 (AAA) — 태양 (FireUltimateEffect) ──

  startFireUltimate(x: number, y: number) {
    if (!this.fireUltimateEffect) {
      this.fireUltimateEffect = new FireUltimateEffect(this.effectLayer);
    }
    if (!this.fireUltimateEffect.active) {
      this.fireUltimateEffect.start(x, y);
    }
  }

  updateFireUltimatePosition(x: number, y: number) {
    if (this.fireUltimateEffect?.active) {
      this.fireUltimateEffect.setPosition(x, y);
    }
  }

  fireUltimateImpactsThisFrame(): Array<{ x: number; y: number; type: 'main' | 'chunk' }> {
    return this.fireUltimateEffect?.popImpacts() ?? [];
  }

  stopFireUltimate() {
    this.fireUltimateEffect?.stop();
  }

  fireUltimateActive(): boolean {
    return this.fireUltimateEffect?.active ?? false;
  }

  // ── 물 × 3 (AAA) — 대해일 (WaterUltimateEffect, 5페이즈 사이클 + GLSL) ──

  startWaterUltimate(x: number, y: number) {
    if (!this.waterUltimateEffect) {
      this.waterUltimateEffect = new WaterUltimateEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.waterUltimateEffect.active) {
      this.waterUltimateEffect.start(x, y);
    }
  }

  stopWaterUltimate() {
    this.waterUltimateEffect?.stop();
  }

  waterUltimateActive(): boolean {
    return this.waterUltimateEffect?.active ?? false;
  }

  waterUltimateBurstFired(): boolean {
    return this.waterUltimateEffect?.burstFiredThisFrame ?? false;
  }

  waterUltimateCenter(): { x: number; y: number } {
    if (!this.waterUltimateEffect) return { x: 0, y: 0 };
    return { x: this.waterUltimateEffect.centerX, y: this.waterUltimateEffect.centerY };
  }

  waterUltimateBurstRadius(): number {
    return this.waterUltimateEffect?.burstRadius ?? 350;
  }

  waterUltimateExpanding(): boolean {
    return this.waterUltimateEffect?.isExpanding() ?? false;
  }

  waterUltimateWaveRadius(): number {
    return this.waterUltimateEffect?.currentRadius ?? 0;
  }

  waterUltimateBandHalf(): number {
    return this.waterUltimateEffect?.bandHalfThickness ?? 25;
  }

  // ── 빛 × 3 (AAA) — 신광 폭격 (LightUltimateEffect, 머리 위 코어 + 호밍 발사체) ──

  startLightUltimate(x: number, y: number) {
    if (!this.lightUltimateEffect) {
      this.lightUltimateEffect = new LightUltimateEffect(this.effectLayer);
    }
    if (!this.lightUltimateEffect.active) {
      this.lightUltimateEffect.start(x, y);
    }
  }

  updateLightUltimatePosition(x: number, y: number) {
    if (this.lightUltimateEffect?.active) {
      this.lightUltimateEffect.setPosition(x, y);
    }
  }

  /** 발사체 1발 spawn — 반환 = boltId (engine이 enemyIdx와 매핑) */
  fireLightUltimateBolt(targetX: number, targetY: number): number {
    if (!this.lightUltimateEffect?.active) return 0;
    return this.lightUltimateEffect.fireBolt(targetX, targetY);
  }

  /** 매 프레임 발사체 추적 좌표 갱신 (engine이 풀 재사용 방어 처리 후 호출) */
  updateLightUltimateBoltTarget(id: number, targetX: number, targetY: number, alive: boolean) {
    if (this.lightUltimateEffect?.active) {
      this.lightUltimateEffect.updateBoltTarget(id, targetX, targetY, alive);
    }
  }

  /** 이번 프레임에 적중한 발사체 정보 (engine이 데미지 처리에 사용) */
  lightUltimateImpactsThisFrame(): Array<{ id: number; x: number; y: number }> {
    return this.lightUltimateEffect?.popImpacts() ?? [];
  }

  /** 이번 프레임에 사망한 발사체 ID들 (engine이 매핑 정리) */
  lightUltimatePopDeadBoltIds(): number[] {
    return this.lightUltimateEffect?.popDeadBoltIds() ?? [];
  }

  lightUltimateHasActiveBolts(): boolean {
    return this.lightUltimateEffect?.hasActiveBolts() ?? false;
  }

  stopLightUltimate() {
    this.lightUltimateEffect?.stop();
  }

  lightUltimateActive(): boolean {
    return this.lightUltimateEffect?.active ?? false;
  }

  // ── 흙 × 3 (AAA) — 운석우 (EarthUltimateEffect, 다중 작은 운석 burst) ──

  startEarthUltimate(x: number, y: number) {
    if (!this.earthUltimateEffect) {
      this.earthUltimateEffect = new EarthUltimateEffect(this.effectLayer, this.renderer);
    }
    if (!this.earthUltimateEffect.active) {
      this.earthUltimateEffect.start(x, y);
    }
  }

  updateEarthUltimatePosition(x: number, y: number) {
    if (this.earthUltimateEffect?.active) {
      this.earthUltimateEffect.setPosition(x, y);
    }
  }

  stopEarthUltimate() {
    this.earthUltimateEffect?.stop();
  }

  earthUltimateActive(): boolean {
    return this.earthUltimateEffect?.active ?? false;
  }

  /** 이번 프레임에 착탄한 운석 좌표들 (월드) — engine이 광역 데미지/스턴/넉백 처리 */
  earthUltimateImpactsThisFrame(): Array<{ x: number; y: number }> {
    return this.earthUltimateEffect?.popImpacts() ?? [];
  }

  // ── 물+암흑 조합 (메일스트롬, 설치형) ──

  startWaterDark(x: number, y: number, radius: number) {
    if (!this.waterDarkEffect) {
      this.waterDarkEffect = new WaterDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.waterDarkEffect.active) {
      this.waterDarkEffect.start(x, y, radius);
    }
  }

  stopWaterDark() {
    this.waterDarkEffect?.stop();
  }

  // ── 불+암흑 조합 (항성 붕괴, 장판형 + 위치 잠금) ──

  startFireDark(x: number, y: number) {
    if (!this.fireDarkEffect) {
      this.fireDarkEffect = new FireDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.fireDarkEffect.active) {
      this.fireDarkEffect.start(x, y);
    }
  }

  updateFireDarkPosition(x: number, y: number) {
    if (this.fireDarkEffect?.active) {
      this.fireDarkEffect.setPosition(x, y);
    }
  }

  /** Phase 3 진입 순간 (엔진이 광역 데미지/넉백/화상 적용) */
  fireDarkBurstFired(): boolean {
    return this.fireDarkEffect?.burstFiredThisFrame ?? false;
  }

  /** 폭발/블랙홀 중심 좌표 (월드) — 잠긴 컨테이너 위치 */
  fireDarkCenter(): { x: number; y: number } {
    if (!this.fireDarkEffect) return { x: 0, y: 0 };
    return { x: this.fireDarkEffect.centerX, y: this.fireDarkEffect.centerY };
  }

  fireDarkBurstRadius(): number {
    return this.fireDarkEffect?.burstRadius ?? 260;
  }

  fireDarkBlackholeRadius(): number {
    return this.fireDarkEffect?.blackholeRadius ?? 150;
  }

  /** 블랙홀 페이즈 활성 여부 (엔진이 흡인/DoT 처리) */
  fireDarkBlackholeActive(): boolean {
    return this.fireDarkEffect?.blackholeActive ?? false;
  }

  stopFireDark() {
    this.fireDarkEffect?.stop();
  }

  // ── 불+전기 조합 (체인 봄버) ──

  /** 체인 발사 (engine이 적 인덱스 결정 후 호출) */
  fireFireElectricChain(points: Array<{ x: number; y: number }>) {
    if (!this.fireElectricEffect) {
      this.fireElectricEffect = new FireElectricEffect(this.effectLayer);
    }
    this.fireElectricEffect.fireChain(points);
  }

  /** 매 프레임 볼트 좌표를 적 현재 위치로 갱신 */
  updateFireElectricChainPositions(positions: Array<{ x: number; y: number }>) {
    this.fireElectricEffect?.updateChainPositions(positions);
  }

  /** 좌표 (x, y)에 폭발 시각 발동 (engine이 시차 타이머 만료 시 호출) */
  spawnFireElectricExplosion(x: number, y: number) {
    if (!this.fireElectricEffect) {
      this.fireElectricEffect = new FireElectricEffect(this.effectLayer);
    }
    this.fireElectricEffect.spawnExplosion(x, y);
  }

  fireElectricExplosionRadius(): number {
    return this.fireElectricEffect?.explosionRadius ?? 70;
  }

  stopFireElectric() {
    this.fireElectricEffect?.stop();
  }

  // ── 흙+전기 조합 (감전 늪) ──

  startEarthElectric(x: number, y: number, radius: number) {
    if (!this.earthElectricEffect) {
      this.earthElectricEffect = new EarthElectricEffect(this.effectLayer);
    }
    if (!this.earthElectricEffect.active) {
      this.earthElectricEffect.start(x, y, radius);
    }
  }

  updateEarthElectricPosition(x: number, y: number) {
    if (this.earthElectricEffect?.active) {
      this.earthElectricEffect.setPosition(x, y);
    }
  }

  /** engine이 매 프레임 호출 — 영역 내 적의 캐릭터 기준 로컬 좌표 전달 */
  updateEarthElectricTeslaTargets(targets: Array<{ lx: number; ly: number }>) {
    if (this.earthElectricEffect?.active) {
      this.earthElectricEffect.setTeslaTargets(targets);
    }
  }

  stopEarthElectric() {
    this.earthElectricEffect?.stop();
  }

  // ── 물+흙+전기 3단계 (감전 퀵샌드) ──

  startWaterEarthElectric(x: number, y: number, radius: number) {
    if (!this.waterEarthElectricEffect) {
      this.waterEarthElectricEffect = new WaterEarthElectricEffect(this.effectLayer);
    }
    if (!this.waterEarthElectricEffect.active) {
      this.waterEarthElectricEffect.start(x, y, radius);
    }
  }

  updateWaterEarthElectricPosition(x: number, y: number) {
    if (this.waterEarthElectricEffect?.active) {
      this.waterEarthElectricEffect.setPosition(x, y);
    }
  }

  updateWaterEarthElectricTeslaTargets(targets: Array<{ lx: number; ly: number }>) {
    if (this.waterEarthElectricEffect?.active) {
      this.waterEarthElectricEffect.setTeslaTargets(targets);
    }
  }

  stopWaterEarthElectric() {
    this.waterEarthElectricEffect?.stop();
  }

  // ── 흙+전기+암흑 3단계 (자철 다이나모 / Magnetite Dynamo) ──

  startEarthElectricDark(x: number, y: number, radius: number) {
    if (!this.earthElectricDarkEffect) {
      // worldContainer(groundLayer) — entityLayer 아래로 렌더 (캐릭터/몬스터 가리지 X, 카메라 변환 ✓)
      this.earthElectricDarkEffect = new EarthElectricDarkEffect(this.worldContainer);
    } else {
      // 이미 인스턴스 있음 — parent가 worldContainer가 아니면 강제 re-parent (HMR/layer 변경 대응)
      const c = this.earthElectricDarkEffect.getContainer();
      if (c.parent !== this.worldContainer) {
        this.worldContainer.addChild(c); // PIXI는 자동으로 old parent에서 remove
      }
    }
    if (!this.earthElectricDarkEffect.active) {
      this.earthElectricDarkEffect.start(x, y, radius);
    }
  }

  updateEarthElectricDarkPosition(x: number, y: number) {
    if (this.earthElectricDarkEffect?.active) {
      this.earthElectricDarkEffect.setPosition(x, y);
    }
  }

  updateEarthElectricDarkTargets(targets: Array<{ lx: number; ly: number }>) {
    if (this.earthElectricDarkEffect?.active) {
      this.earthElectricDarkEffect.setTargets(targets);
    }
  }

  /** 이번 프레임에 RECONNECT 발화 (전원 동시 검은 번개 + 쇼크웨이브) */
  earthElectricDarkReconnectFired(): boolean {
    return this.earthElectricDarkEffect?.reconnectFiredThisFrame ?? false;
  }

  /** 이번 프레임에 CHARGE 시작 (자화 마킹 + 초기 타격) */
  earthElectricDarkChargeStarted(): boolean {
    return this.earthElectricDarkEffect?.chargeStartedThisFrame ?? false;
  }

  earthElectricDarkIsSustain(): boolean {
    return this.earthElectricDarkEffect?.isSustain() ?? false;
  }

  stopEarthElectricDark() {
    this.earthElectricDarkEffect?.stop();
  }

  // ── 불+빛+암흑 3단계 (빅뱅) ──

  startFireLightDark(x: number, y: number) {
    if (!this.fireLightDarkEffect) {
      this.fireLightDarkEffect = new FireLightDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.fireLightDarkEffect.active) {
      this.fireLightDarkEffect.start(x, y);
    }
  }

  /** 특이점을 캐릭터 위치로 매 프레임 갱신 — 비대칭 수렴 방지 */
  updateFireLightDarkPosition(x: number, y: number) {
    if (this.fireLightDarkEffect?.active) {
      this.fireLightDarkEffect.setPosition(x, y);
    }
  }

  stopFireLightDark() {
    this.fireLightDarkEffect?.stop();
  }

  fireLightDarkActive(): boolean {
    return this.fireLightDarkEffect?.active ?? false;
  }

  /** CONVERGE + SILENCE + FLASH 동안 true — 엔진이 적 스턴 + lerp 적용 */
  fireLightDarkShouldFreezeEnemies(): boolean {
    return this.fireLightDarkEffect?.shouldFreezeEnemies() ?? false;
  }

  /** 현재 lerp factor (수렴 가속용) */
  fireLightDarkConvergeLerp(): number {
    return this.fireLightDarkEffect?.convergeLerp() ?? 0;
  }

  /** 특이점 월드 좌표 */
  fireLightDarkConvergeCenter(): { x: number; y: number } {
    return this.fireLightDarkEffect?.convergeCenterWorld() ?? { x: 0, y: 0 };
  }

  /** 이번 프레임에 폭발 시작했는가 (광역 데미지 발동용) */
  fireLightDarkExplosionFired(): boolean {
    return this.fireLightDarkEffect?.explosionFiredThisFrame ?? false;
  }

  /** 폭발 반경 */
  fireLightDarkExplosionRadius(): number {
    return this.fireLightDarkEffect?.explosionRadius() ?? 400;
  }

  /** CONVERGE 페이즈인가 (DoT 틱용) */
  fireLightDarkConverging(): boolean {
    return this.fireLightDarkEffect?.isConverging() ?? false;
  }

  // ── 물+빛+암흑 3단계 (개기일식 / Total Eclipse) ──

  startWaterLightDark(x: number, y: number) {
    if (!this.waterLightDarkEffect) {
      this.waterLightDarkEffect = new WaterLightDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.waterLightDarkEffect.active) {
      this.waterLightDarkEffect.start(x, y);
    }
  }

  updateWaterLightDarkPosition(x: number, y: number) {
    if (this.waterLightDarkEffect?.active) {
      this.waterLightDarkEffect.setPosition(x, y);
    }
  }

  stopWaterLightDark() {
    this.waterLightDarkEffect?.stop();
  }

  waterLightDarkActive(): boolean {
    return this.waterLightDarkEffect?.active ?? false;
  }

  waterLightDarkShouldFreezeEnemies(): boolean {
    return this.waterLightDarkEffect?.shouldFreezeEnemies() ?? false;
  }

  waterLightDarkConvergeLerp(): number {
    return this.waterLightDarkEffect?.convergeLerp() ?? 0;
  }

  waterLightDarkConvergeCenter(): { x: number; y: number } {
    return this.waterLightDarkEffect?.convergeCenter() ?? { x: 0, y: 0 };
  }

  waterLightDarkBurstFired(): boolean {
    return this.waterLightDarkEffect?.burstFiredThisFrame ?? false;
  }

  waterLightDarkBurstRadius(): number {
    return this.waterLightDarkEffect?.burstRadius() ?? 300;
  }

  waterLightDarkIsConverging(): boolean {
    return this.waterLightDarkEffect?.isConverging() ?? false;
  }

  waterLightDarkConvergeRange(): number {
    return this.waterLightDarkEffect?.convergeRange() ?? 320;
  }

  // ── 불+전기+암흑 3단계 (연쇄 폭뢰 / Chain Detonation) ──

  startFireElectricDark() {
    if (!this.fireElectricDarkEffect) {
      this.fireElectricDarkEffect = new FireElectricDarkEffect(this.overlayLayer);
    }
    if (!this.fireElectricDarkEffect.active) {
      this.fireElectricDarkEffect.start();
    }
  }

  stopFireElectricDark() {
    this.fireElectricDarkEffect?.stop();
  }

  fireElectricDarkActive(): boolean {
    return this.fireElectricDarkEffect?.active ?? false;
  }

  addFEDMark(wx: number, wy: number, duration: number) {
    this.fireElectricDarkEffect?.addMark(wx, wy, duration);
  }

  addFEDExplosion(wx: number, wy: number) {
    this.fireElectricDarkEffect?.addExplosion(wx, wy);
  }

  addFEDArc(x0: number, y0: number, x1: number, y1: number) {
    this.fireElectricDarkEffect?.addArc(x0, y0, x1, y1);
  }

  // ── 흙+빛+암흑 3단계 (일월석진 / Eclipse Stone Formation) ──

  startEarthLightDark(x: number, y: number) {
    if (!this.earthLightDarkEffect) {
      this.earthLightDarkEffect = new EarthLightDarkEffect(this.overlayLayer);
    }
    if (!this.earthLightDarkEffect.active) {
      this.earthLightDarkEffect.start(x, y);
    }
  }

  stopEarthLightDark() {
    this.earthLightDarkEffect?.stop();
  }

  earthLightDarkIsConverging(): boolean {
    return this.earthLightDarkEffect?.isConverging() ?? false;
  }

  earthLightDarkConvergeLerp(): number {
    return this.earthLightDarkEffect?.convergeLerp() ?? 0;
  }

  earthLightDarkConvergeRange(): number {
    return this.earthLightDarkEffect?.convergeRange() ?? 300;
  }

  earthLightDarkAnchor(): { x: number; y: number } {
    return this.earthLightDarkEffect?.anchor() ?? { x: 0, y: 0 };
  }

  earthLightDarkFlashFired(): boolean {
    return this.earthLightDarkEffect?.flashFiredThisFrame ?? false;
  }

  earthLightDarkFlashRadius(): number {
    return this.earthLightDarkEffect?.flashRadius() ?? 280;
  }

  // ── 물+불+전기 3단계 (증기폭뢰 / Steam Thunderbolt) ──

  startWaterFireElectric(x: number, y: number) {
    if (!this.waterFireElectricEffect) {
      this.waterFireElectricEffect = new WaterFireElectricEffect(this.overlayLayer);
    }
    if (!this.waterFireElectricEffect.active) {
      this.waterFireElectricEffect.start(x, y);
    }
  }

  updateWaterFireElectricPosition(x: number, y: number) {
    if (this.waterFireElectricEffect?.active) {
      this.waterFireElectricEffect.setPosition(x, y);
    }
  }

  stopWaterFireElectric() {
    this.waterFireElectricEffect?.stop();
  }

  waterFireElectricIsPressuring(): boolean {
    return this.waterFireElectricEffect?.isPressuring() ?? false;
  }

  waterFireElectricReleaseFired(): boolean {
    return this.waterFireElectricEffect?.releaseFiredThisFrame ?? false;
  }

  waterFireElectricHeatRange(): number {
    return this.waterFireElectricEffect?.heatRange() ?? 140;
  }

  waterFireElectricBurstRadius(): number {
    return this.waterFireElectricEffect?.burstRadius() ?? 280;
  }

  fireWaterFireElectricChain(worldPoints: { x: number; y: number }[]) {
    this.waterFireElectricEffect?.addChainArc(worldPoints);
  }


  // ── 물+흙+불 3단계 (원소 유성우 / Elemental Meteor Storm) ──

  startWaterEarthFire(x: number, y: number) {
    if (!this.waterEarthFireEffect) {
      this.waterEarthFireEffect = new WaterEarthFireEffect(this.overlayLayer);
    }
    if (!this.waterEarthFireEffect.active) {
      this.waterEarthFireEffect.start(x, y);
    }
  }

  updateWaterEarthFirePosition(x: number, y: number) {
    if (this.waterEarthFireEffect?.active) {
      this.waterEarthFireEffect.setPosition(x, y);
    }
  }

  stopWaterEarthFire() {
    this.waterEarthFireEffect?.stop();
  }

  waterEarthFireImpacts(): { x: number; y: number; type: number }[] {
    return this.waterEarthFireEffect?.impactsThisFrame() ?? [];
  }

  waterEarthFireImpactRadius(): number {
    return this.waterEarthFireEffect?.impactRadius() ?? 60;
  }

  waterEarthFirePuddles(): { x: number; y: number; radius: number; type: number }[] {
    return this.waterEarthFireEffect?.activePuddles() ?? [];
  }

  waterEarthFireWaveKnockbackR(): number {
    return this.waterEarthFireEffect?.waveKnockbackRadius() ?? 90;
  }

  // ── 물+불+빛 3단계 (무지개 장마 포격 / Rainbow Deluge) ──

  startWaterFireLight(x: number, y: number) {
    if (!this.waterFireLightEffect) {
      this.waterFireLightEffect = new WaterFireLightEffect(this.effectLayer);
    }
    if (!this.waterFireLightEffect.active) {
      this.waterFireLightEffect.start(x, y);
    }
  }

  updateWaterFireLightPosition(x: number, y: number) {
    if (this.waterFireLightEffect?.active) {
      this.waterFireLightEffect.setPosition(x, y);
    }
  }

  /** 빗방울 호밍 + 히트 판정 (rule 5 내장). 매 프레임 엔진이 호출. */
  updateWaterFireLightHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.waterFireLightEffect?.updateHoming(dt, enemies);
  }

  /** 이번 프레임 빗방울이 적중시킨 {x, y, enemyIdx} 리스트. 엔진이 데미지 처리. */
  waterFireLightHitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number }> {
    return this.waterFireLightEffect?.hitsThisFrame() ?? [];
  }

  stopWaterFireLight() {
    this.waterFireLightEffect?.stop();
  }

  // ── 물+불+암흑 3단계 (종말의 먹구름 / Doomcloud) ──

  startWaterFireDark(x: number, y: number) {
    if (!this.waterFireDarkEffect) {
      this.waterFireDarkEffect = new WaterFireDarkEffect(this.effectLayer);
    }
    if (!this.waterFireDarkEffect.active) {
      this.waterFireDarkEffect.start(x, y);
    }
  }

  updateWaterFireDarkPosition(x: number, y: number) {
    if (this.waterFireDarkEffect?.active) {
      this.waterFireDarkEffect.setPosition(x, y);
    }
  }

  /** 사슬 흡인 + DoT 틱 + 소멸 처리 (rule 5 내장) */
  updateWaterFireDarkPull(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.waterFireDarkEffect?.updatePull(dt, enemies);
  }

  /** 이번 프레임 사슬 피해 이벤트 — 엔진이 적 HP 차감 */
  waterFireDarkHitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number; damage: number }> {
    return this.waterFireDarkEffect?.hitsThisFrame() ?? [];
  }

  /** 현재 사슬로 연결된 적 인덱스 목록 — 엔진이 슬로우 적용에 사용 */
  waterFireDarkTetheredIds(): number[] {
    return this.waterFireDarkEffect?.tetheredEnemyIds() ?? [];
  }

  stopWaterFireDark() {
    this.waterFireDarkEffect?.stop();
  }

  // ── 물+전기+암흑 3단계 (흑뢰 토네이도 / Dark Thunder Tornado) ──

  /** 첫 활성 시 한 번만 호출 — 위치 고정 */
  startWaterElectricDark(x: number, y: number) {
    if (!this.waterElectricDarkEffect) {
      this.waterElectricDarkEffect = new WaterElectricDarkEffect(this.effectLayer);
    }
    if (!this.waterElectricDarkEffect.active) {
      this.waterElectricDarkEffect.start(x, y);
    }
  }

  /** 흡인 + DoT + 체인 (rule 5 내장) */
  updateWaterElectricDarkPull(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.waterElectricDarkEffect?.updatePull(dt, enemies);
  }

  /** 이번 프레임 피해 이벤트 */
  waterElectricDarkHitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number; damage: number }> {
    return this.waterElectricDarkEffect?.hitsThisFrame() ?? [];
  }

  stopWaterElectricDark() {
    this.waterElectricDarkEffect?.stop();
  }

  // ── 물+흙+빛 3단계 (사구아로 선인장 / Saguaro Sentinel) ──

  startWaterEarthLight(x: number, y: number) {
    if (!this.waterEarthLightEffect) {
      this.waterEarthLightEffect = new WaterEarthLightEffect(this.effectLayer);
    }
    if (!this.waterEarthLightEffect.active) {
      this.waterEarthLightEffect.start(x, y);
    }
  }

  /** 레이저 spawn + 호밍 + 히트 (rule 5) */
  updateWaterEarthLightLasers(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.waterEarthLightEffect?.updateLasers(dt, enemies);
  }

  /** 이번 프레임 피해 이벤트 (laser=32, needle=8 — damage 필드 포함) */
  waterEarthLightHitsThisFrame(): Array<{ x: number; y: number; enemyIdx: number; damage: number }> {
    return this.waterEarthLightEffect?.hitsThisFrame() ?? [];
  }

  stopWaterEarthLight() {
    this.waterEarthLightEffect?.stop();
  }

  // ── 흙+불+전기 3단계 (화산뇌 / Volcanic Thunder) ──

  startEarthFireElectric(x: number, y: number) {
    if (!this.earthFireElectricEffect) {
      this.earthFireElectricEffect = new EarthFireElectricEffect(this.overlayLayer);
    }
    if (!this.earthFireElectricEffect.active) {
      this.earthFireElectricEffect.start(x, y);
    }
  }

  updateEarthFireElectricPosition(x: number, y: number) {
    if (this.earthFireElectricEffect?.active) {
      this.earthFireElectricEffect.setPosition(x, y);
    }
  }

  stopEarthFireElectric() {
    this.earthFireElectricEffect?.stop();
  }

  earthFireElectricImpactsThisFrame(): { x: number; y: number }[] {
    return this.earthFireElectricEffect?.impactsThisFrame() ?? [];
  }

  earthFireElectricImpactRadius(): number {
    return this.earthFireElectricEffect?.impactRadius() ?? 55;
  }

  addEarthFireElectricChain(x0: number, y0: number, x1: number, y1: number) {
    this.earthFireElectricEffect?.addChainLine(x0, y0, x1, y1);
  }

  // ── 흙+불+빛 3단계 (천붕 운석 / Empyrean Meteor) ──

  startEarthFireLight(x: number, y: number) {
    if (!this.earthFireLightEffect) {
      this.earthFireLightEffect = new EarthFireLightEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.earthFireLightEffect.active) {
      this.earthFireLightEffect.start(x, y);
    }
  }

  updateEarthFireLightPosition(x: number, y: number) {
    if (this.earthFireLightEffect?.active) {
      this.earthFireLightEffect.setPosition(x, y);
    }
  }

  stopEarthFireLight() {
    this.earthFireLightEffect?.stop();
  }

  earthFireLightImpactsThisFrame(): { x: number; y: number }[] {
    return this.earthFireLightEffect?.impactsThisFrame() ?? [];
  }

  earthFireLightImpactRadius(): number {
    return this.earthFireLightEffect?.impactRadius() ?? 220;
  }

  // ── 물+흙+암흑 3단계 (은하 소용돌이 / Galactic Vortex) ──

  startWaterEarthDark(x: number, y: number) {
    if (!this.waterEarthDarkEffect) {
      this.waterEarthDarkEffect = new WaterEarthDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.waterEarthDarkEffect.active) {
      this.waterEarthDarkEffect.start(x, y);
    }
  }

  updateWaterEarthDarkPosition(x: number, y: number) {
    if (this.waterEarthDarkEffect?.active) {
      this.waterEarthDarkEffect.setPosition(x, y);
    }
  }

  stopWaterEarthDark() {
    this.waterEarthDarkEffect?.stop();
  }

  waterEarthDarkIsAbsorbing(): boolean {
    return this.waterEarthDarkEffect?.isAbsorbing() ?? false;
  }
  waterEarthDarkAbsorbStrength(): number {
    return this.waterEarthDarkEffect?.absorbStrength() ?? 0;
  }
  waterEarthDarkCenter(): { x: number; y: number } {
    return this.waterEarthDarkEffect?.galaxyCenter() ?? { x: 0, y: 0 };
  }
  waterEarthDarkPullRadius(): number {
    return this.waterEarthDarkEffect?.pullRadius() ?? 220;
  }
  waterEarthDarkKillRadius(): number {
    return this.waterEarthDarkEffect?.killRadius() ?? 24;
  }
  waterEarthDarkGravityRadius(): number {
    return this.waterEarthDarkEffect?.gravityRadius() ?? 1000;
  }
  waterEarthDarkPullLerpAt(dist: number): number {
    return this.waterEarthDarkEffect?.pullLerpAt(dist) ?? 0;
  }
  waterEarthDarkSwirlRateAt(dist: number): number {
    return this.waterEarthDarkEffect?.swirlRateAt(dist) ?? 0;
  }
  waterEarthDarkSpawnAbsorb(wx: number, wy: number) {
    this.waterEarthDarkEffect?.spawnAbsorbBurst(wx, wy);
  }

  // ── 빛+전기+암흑 3단계 (심연 진동 / Voidpulse Cascade) ──

  startLightElectricDark(x: number, y: number) {
    if (!this.lightElectricDarkEffect) {
      this.lightElectricDarkEffect = new LightElectricDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.lightElectricDarkEffect.active) {
      this.lightElectricDarkEffect.start(x, y);
    }
  }

  updateLightElectricDarkPosition(x: number, y: number) {
    if (this.lightElectricDarkEffect?.active) {
      this.lightElectricDarkEffect.setPosition(x, y);
    }
  }

  stopLightElectricDark() {
    this.lightElectricDarkEffect?.stop();
  }

  lightElectricDarkActive(): boolean {
    return this.lightElectricDarkEffect?.active ?? false;
  }

  lightElectricDarkChargeReady(): boolean {
    return this.lightElectricDarkEffect?.chargeReady() ?? false;
  }

  lightElectricDarkGatherPoint(): { x: number; y: number } {
    return this.lightElectricDarkEffect?.getGatherPoint() ?? { x: 0, y: 0 };
  }

  setLightElectricDarkStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    this.lightElectricDarkEffect?.setStrikeTargets(targets);
  }

  updateLightElectricDarkHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.lightElectricDarkEffect?.updateHoming(dt, enemies);
  }

  lightElectricDarkHits(): Array<{ targetIdx: number; hitX: number; hitY: number }> {
    return this.lightElectricDarkEffect?.hitsThisFrame() ?? [];
  }

  addLightElectricDarkChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    this.lightElectricDarkEffect?.addChainLines(lines);
  }

  spawnLightElectricDarkGravity(x: number, y: number) {
    this.lightElectricDarkEffect?.spawnGravityAt(x, y);
  }

  lightElectricDarkMaxStrikeTargets(): number {
    return this.lightElectricDarkEffect?.maxStrikeTargets() ?? 20;
  }

  /** 현재 활성 중력장 리스트 (엔진이 흡인 처리에 사용) */
  lightElectricDarkGravities(): Array<{ x: number; y: number; life: number; maxLife: number }> {
    const list = this.lightElectricDarkEffect?.activeGravities() ?? [];
    return list.map(g => ({ x: g.x, y: g.y, life: g.life, maxLife: g.maxLife }));
  }

  lightElectricDarkGravityRadius(): number {
    return this.lightElectricDarkEffect?.gravityMaxRadius() ?? 56;
  }

  // ── 흙+불+암흑 3단계 (심연균열 / Abyssal Rift) ──

  startEarthFireDark(x: number, y: number) {
    if (!this.earthFireDarkEffect) {
      // Rule 7: GLSL Filter는 groundLayer(=this.worldContainer)에만, Graphics는 overlayLayer에
      this.earthFireDarkEffect = new EarthFireDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.earthFireDarkEffect.active) {
      this.earthFireDarkEffect.start(x, y);
    }
  }

  /** 매 프레임 플레이어 위치 갱신 (크랙은 월드 고정, 이 값은 새 크랙 spawn에만 사용) */
  updateEarthFireDarkPosition(x: number, y: number) {
    if (this.earthFireDarkEffect?.active) {
      this.earthFireDarkEffect.setPosition(x, y);
    }
  }

  stopEarthFireDark() {
    this.earthFireDarkEffect?.stop();
  }

  earthFireDarkActive(): boolean {
    return this.earthFireDarkEffect?.active ?? false;
  }

  /** 현재 활성 크랙의 X자 2대각선 세그먼트 (월드 좌표) — 풀링용 */
  earthFireDarkCrackSegments(): Array<{
    x0: number; y0: number; x1: number; y1: number;
    sx: number; sy: number; invSegLen2: number;
  }> {
    return this.earthFireDarkEffect?.getCrackSegments() ?? [];
  }

  /** 이번 프레임에 버스트가 발동됐는가 */
  earthFireDarkBurstFired(): boolean {
    return this.earthFireDarkEffect?.burstFiredThisFrame ?? false;
  }

  /** 설치점 월드 좌표 */
  earthFireDarkInstalledCenter(): { x: number; y: number } {
    return this.earthFireDarkEffect?.installedCenter() ?? { x: 0, y: 0 };
  }

  /** 4 tip 월드 좌표 */
  earthFireDarkInstalledTips(): Array<{ x: number; y: number }> {
    return this.earthFireDarkEffect?.installedTips() ?? [];
  }

  /** 끌어당김 범위 */
  earthFireDarkPullRange(): number {
    return this.earthFireDarkEffect?.pullRange() ?? 220;
  }

  /** 끌어당김 lerp factor */
  earthFireDarkPullLerp(): number {
    return this.earthFireDarkEffect?.pullLerp() ?? 0.032;
  }

  /** 버스트 피해 판정 반경 */
  earthFireDarkBurstHitThreshold(): number {
    return this.earthFireDarkEffect?.burstHitThreshold() ?? 38;
  }

  /** 버스트 피해량 */
  earthFireDarkBurstDamage(): number {
    return this.earthFireDarkEffect?.burstDamage() ?? 85;
  }

  /** 버스트 넉백 */
  earthFireDarkBurstKnockback(): number {
    return this.earthFireDarkEffect?.burstKnockback() ?? 9;
  }

  // ── 물+빛+전기 3단계 (프리즘 캐스케이드) ──

  startWaterLightElectric(x: number, y: number) {
    if (!this.waterLightElectricEffect) {
      this.waterLightElectricEffect = new WaterLightElectricEffect(this.effectLayer);
    }
    if (!this.waterLightElectricEffect.active) {
      this.waterLightElectricEffect.start(x, y);
    }
  }

  updateWaterLightElectricPosition(x: number, y: number) {
    if (this.waterLightElectricEffect?.active) {
      this.waterLightElectricEffect.setPosition(x, y);
    }
  }

  stopWaterLightElectric() {
    this.waterLightElectricEffect?.stop();
  }

  waterLightElectricActive(): boolean {
    return this.waterLightElectricEffect?.active ?? false;
  }

  /** 충전 완료 (engine이 수집해서 setStrikeTargets로 consume) */
  waterLightElectricChargeReady(): boolean {
    return this.waterLightElectricEffect?.chargeReady() ?? false;
  }

  /** 타겟 최대 수 */
  waterLightElectricMaxStrikeTargets(): number {
    return this.waterLightElectricEffect?.maxStrikeTargets() ?? 20;
  }

  /** engine이 수집한 타겟 리스트로 유도 레이저 spawn */
  setWaterLightElectricStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    this.waterLightElectricEffect?.setStrikeTargets(targets);
  }

  /** 유도 레이저 업데이트 — engine이 매 프레임 enemies ref 넘김 (rule 5) */
  updateWaterLightElectricHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.waterLightElectricEffect?.updateHoming(dt, enemies);
  }

  /** 이번 프레임 유도 레이저 명중 이벤트 */
  waterLightElectricHitsThisFrame(): Array<{ targetIdx: number; hitX: number; hitY: number }> {
    return this.waterLightElectricEffect?.hitsThisFrame() ?? [];
  }

  /** 명중 지점에 3원소 임팩트 입자 spawn */
  spawnWaterLightElectricImpact(x: number, y: number) {
    this.waterLightElectricEffect?.spawnImpactAt(x, y);
  }

  /** 체인 확산 라인 추가 (명중 후 몬스터간 번개) */
  addWaterLightElectricChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    this.waterLightElectricEffect?.addChainLines(lines);
  }

  // ── 불+빛+전기 3단계 (솔라 폭주 / Solar Ascension) ──

  startFireLightElectric(x: number, y: number) {
    if (!this.fireLightElectricEffect) {
      this.fireLightElectricEffect = new FireLightElectricEffect(this.effectLayer);
    }
    if (!this.fireLightElectricEffect.active) {
      this.fireLightElectricEffect.start(x, y);
    }
  }

  updateFireLightElectricPosition(x: number, y: number) {
    if (this.fireLightElectricEffect?.active) {
      this.fireLightElectricEffect.setPosition(x, y);
    }
  }

  stopFireLightElectric() {
    this.fireLightElectricEffect?.stop();
  }

  fireLightElectricActive(): boolean {
    return this.fireLightElectricEffect?.active ?? false;
  }

  fireLightElectricChargeReady(): boolean {
    return this.fireLightElectricEffect?.chargeReady() ?? false;
  }

  fireLightElectricMaxStrikeTargets(): number {
    return this.fireLightElectricEffect?.maxStrikeTargets() ?? 18;
  }

  setFireLightElectricStrikeTargets(targets: Array<{ worldX: number; worldY: number; enemyIdx: number }>) {
    this.fireLightElectricEffect?.setStrikeTargets(targets);
  }

  updateFireLightElectricHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.fireLightElectricEffect?.updateHoming(dt, enemies);
  }

  fireLightElectricHitsThisFrame(): Array<{ targetIdx: number; hitX: number; hitY: number }> {
    return this.fireLightElectricEffect?.hitsThisFrame() ?? [];
  }

  spawnFireLightElectricImpact(x: number, y: number) {
    this.fireLightElectricEffect?.spawnImpactAt(x, y);
  }

  addFireLightElectricChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    this.fireLightElectricEffect?.addChainLines(lines);
  }

  // ── 흙+빛+전기 3단계 (크리스탈 뇌격 / Crystal Thunder) ──

  startEarthLightElectric(x: number, y: number) {
    if (!this.earthLightElectricEffect) {
      this.earthLightElectricEffect = new EarthLightElectricEffect(this.effectLayer);
    }
    if (!this.earthLightElectricEffect.active) {
      this.earthLightElectricEffect.start(x, y);
    }
  }

  updateEarthLightElectricPosition(x: number, y: number) {
    if (this.earthLightElectricEffect?.active) {
      this.earthLightElectricEffect.setPosition(x, y);
    }
  }

  stopEarthLightElectric() {
    this.earthLightElectricEffect?.stop();
  }

  earthLightElectricActive(): boolean {
    return this.earthLightElectricEffect?.active ?? false;
  }

  /** 크리스탈 간 연결 세그먼트 (월드 좌표) — 엔진 콜리전 체크용 */
  earthLightElectricConnectionSegments(): Array<{
    x0: number; y0: number; x1: number; y1: number;
  }> {
    return this.earthLightElectricEffect?.getCrystalConnectionSegments() ?? [];
  }

  /** 준비 완료된 크리스탈 리스트 */
  earthLightElectricReadyCrystals(): Array<{ crystalIdx: number; worldX: number; worldY: number }> {
    return this.earthLightElectricEffect?.readyCrystals() ?? [];
  }

  /** 크리스탈에 타겟 할당 후 유도 미사일 spawn */
  fireEarthLightElectricMissiles(fires: Array<{
    crystalIdx: number;
    targetX: number;
    targetY: number;
    enemyIdx: number;
  }>) {
    this.earthLightElectricEffect?.fireMissiles(fires);
  }

  /** 유도 미사일 호밍 업데이트 (rule 5 내장) */
  updateEarthLightElectricHoming(dt: number, enemies: Array<{ x: number; y: number; active: boolean }>) {
    this.earthLightElectricEffect?.updateHoming(dt, enemies);
  }

  /** 이번 프레임 명중 이벤트 */
  earthLightElectricHitsThisFrame(): Array<{ targetIdx: number; hitX: number; hitY: number }> {
    return this.earthLightElectricEffect?.hitsThisFrame() ?? [];
  }

  spawnEarthLightElectricImpact(x: number, y: number) {
    this.earthLightElectricEffect?.spawnImpactAt(x, y);
  }

  addEarthLightElectricChainLines(lines: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
    this.earthLightElectricEffect?.addChainLines(lines);
  }

  // ── 불+빛 조합 (헬파이어 빔) ──

  startFireLight(x: number, y: number) {
    if (!this.fireLightEffect) {
      this.fireLightEffect = new FireLightEffect(this.effectLayer);
    }
    if (!this.fireLightEffect.active) {
      this.fireLightEffect.start(x, y);
    }
  }

  updateFireLightPosition(x: number, y: number) {
    if (this.fireLightEffect?.active) {
      this.fireLightEffect.setPosition(x, y);
    }
  }

  updateFireLightDirection(angle: number) {
    if (this.fireLightEffect?.active) {
      this.fireLightEffect.setDirection(angle);
    }
  }

  fireLightBeamFired(): boolean {
    return this.fireLightEffect?.beamFiredThisFrame ?? false;
  }

  fireLightBeamAngle(): number {
    return this.fireLightEffect?.beamDirection ?? 0;
  }

  /** 빔 타격 시 적 위치에 작은 화염 폭발 */
  spawnFireLightHitFlame(worldX: number, worldY: number) {
    this.fireLightEffect?.spawnHitFlame(worldX, worldY);
  }

  stopFireLight() {
    this.fireLightEffect?.stop();
  }

  // ── 전기+암흑 조합 (자기장 폭풍) ──

  startElectricDark(x: number, y: number) {
    if (!this.electricDarkEffect) {
      this.electricDarkEffect = new ElectricDarkEffect(this.overlayLayer, this.worldContainer);
    }
    if (!this.electricDarkEffect.active) {
      this.electricDarkEffect.start(x, y);
    }
  }

  updateElectricDarkPosition(x: number, y: number) {
    if (this.electricDarkEffect?.active) {
      this.electricDarkEffect.setPosition(x, y);
    }
  }

  /** 매 프레임 — 영역 내 적의 캐릭터 기준 로컬 좌표 + 휘어짐 방향 전달 */
  updateElectricDarkMagneticTargets(targets: Array<{ lx: number; ly: number; curveDir: number }>) {
    if (this.electricDarkEffect?.active) {
      this.electricDarkEffect.setMagneticTargets(targets);
    }
  }

  /** 재연결 폭발 발동 순간 (엔진이 광역 데미지/넉백 처리에 사용) */
  electricDarkBurstFired(): boolean {
    return this.electricDarkEffect?.burstFiredThisFrame ?? false;
  }

  /** 잠긴 폭발 위치들 (월드 좌표) — engine이 각 위치마다 데미지 처리 */
  electricDarkBurstPositions(): Array<{ x: number; y: number }> {
    return this.electricDarkEffect?.lockedBurstPositions ?? [];
  }

  /** 재연결 폭발 반경 (각 적 위치당) */
  electricDarkBurstRadius(): number {
    return this.electricDarkEffect?.burstRadiusEach ?? 80;
  }

  /** 자기장 반경 (영역 내 적 판정) */
  electricDarkFieldRadius(): number {
    return this.electricDarkEffect?.fieldRadius ?? 180;
  }

  /** 충전 페이즈 활성 여부 (engine이 견인/DoT 처리) */
  electricDarkChargingActive(): boolean {
    return this.electricDarkEffect?.chargingActive ?? false;
  }

  /** 자기장 중심 (월드) */
  electricDarkCenter(): { x: number; y: number } {
    if (!this.electricDarkEffect) return { x: 0, y: 0 };
    return { x: this.electricDarkEffect.centerX, y: this.electricDarkEffect.centerY };
  }

  stopElectricDark() {
    this.electricDarkEffect?.stop();
  }

  // ── 흙+빛 조합 (풀구라이트) ──

  startEarthLight(x: number, y: number) {
    if (!this.earthLightEffect) {
      this.earthLightEffect = new EarthLightEffect(this.effectLayer);
    }
    if (!this.earthLightEffect.active) {
      this.earthLightEffect.start(x, y);
    }
  }

  updateEarthLightPosition(x: number, y: number) {
    if (this.earthLightEffect?.active) {
      this.earthLightEffect.setPosition(x, y);
    }
  }

  updateEarthLightDirection(angle: number) {
    if (this.earthLightEffect?.active) {
      this.earthLightEffect.setDirection(angle);
    }
  }

  /** 발사 순간 (엔진이 7발 데미지 처리) */
  earthLightBeamFired(): boolean {
    return this.earthLightEffect?.beamFiredThisFrame ?? false;
  }

  /** 메인 빔 방향 (분산은 ±15/30/45도 자동) */
  earthLightBeamMainAngle(): number {
    return this.earthLightEffect?.beamMainAngle ?? 0;
  }

  /** 분산 빔 각도 오프셋 배열 */
  earthLightSpreadOffsets(): readonly number[] {
    return EarthLightEffect.SPREAD_OFFSETS;
  }

  stopEarthLight() {
    this.earthLightEffect?.stop();
  }

  // ── 빛+암흑 조합 (초신성 — Supernova) ──

  startLightDark(x: number, y: number) {
    if (!this.lightDarkEffect) {
      this.lightDarkEffect = new LightDarkEffect(this.effectLayer);
    }
    if (!this.lightDarkEffect.active) {
      this.lightDarkEffect.start(x, y);
    }
  }

  updateLightDarkPosition(x: number, y: number) {
    if (this.lightDarkEffect?.active) {
      this.lightDarkEffect.setPosition(x, y);
    }
  }

  /** SUPERNOVA 폭발 발동 순간 */
  lightDarkSupernovaFired(): boolean {
    return this.lightDarkEffect?.supernovaFiredThisFrame ?? false;
  }

  /** 폭발 중심 좌표 (월드, 잠긴 위치) */
  lightDarkSupernovaCenter(): { x: number; y: number } {
    if (!this.lightDarkEffect) return { x: 0, y: 0 };
    return { x: this.lightDarkEffect.centerX, y: this.lightDarkEffect.centerY };
  }

  /** 폭발 반경 (광역) */
  lightDarkSupernovaRadius(): number {
    return this.lightDarkEffect?.burstRadius ?? 350;
  }

  /** 사방 빔 사거리 */
  lightDarkBeamRange(): number {
    return this.lightDarkEffect?.beamRange ?? 1500;
  }

  /** 사방 빔 16발 angle 배열 */
  lightDarkBeamAngles(): readonly number[] {
    return LightDarkEffect.BEAM_ANGLES;
  }

  stopLightDark() {
    this.lightDarkEffect?.stop();
  }

  // ── 흙+암흑 조합 (유성우 — Meteor Shower) ──

  startEarthDark(x: number, y: number) {
    if (!this.earthDarkEffect) {
      this.earthDarkEffect = new EarthDarkEffect(this.effectLayer);
    }
    if (!this.earthDarkEffect.active) {
      this.earthDarkEffect.start(x, y);
    }
  }

  updateEarthDarkPosition(x: number, y: number) {
    if (this.earthDarkEffect?.active) {
      this.earthDarkEffect.setPosition(x, y);
    }
  }

  /** 이번 프레임에 착탄한 운석들의 좌표 (월드) */
  earthDarkImpactsThisFrame(): Array<{ x: number; y: number }> {
    return this.earthDarkEffect?.impactsThisFrame ?? [];
  }

  /** 운석 폭발 반경 */
  earthDarkImpactRadius(): number {
    return this.earthDarkEffect?.impactRadius ?? 50;
  }

  stopEarthDark() {
    this.earthDarkEffect?.stop();
  }

  // ── 공통 ──

  update(dt: number) {
    if (this.waterEffect?.active) {
      this.waterEffect.update(dt);
    }
    if (this.earthEffect?.active) {
      this.earthEffect.update(dt);
    }
    if (this.fireEffect?.active) {
      this.fireEffect.update(dt);
    }
    if (this.lightEffect?.active) {
      this.lightEffect.update(dt);
    }
    if (this.electricEffect && this.electricEffect.hasActiveBolts()) {
      this.electricEffect.update(dt);
    }
    if (this.lightElectricEffect?.active) {
      this.lightElectricEffect.update(dt);
    }
    if (this.waterElectricEffect?.active) {
      this.waterElectricEffect.update(dt);
    }
    if (this.waterEarthEffect?.active) {
      this.waterEarthEffect.update(dt);
    }
    if (this.waterFireEffect?.active) {
      this.waterFireEffect.update(dt);
    }
    if (this.earthFireEffect?.active) {
      this.earthFireEffect.update(dt);
    }
    if (this.waterLightEffect?.active) {
      this.waterLightEffect.update(dt);
    }
    if (this.darkEffect?.active) {
      this.darkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.darkUltimateEffect?.active) {
      this.darkUltimateEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.electricUltimateEffect?.active) {
      this.electricUltimateEffect.update(dt);
    }
    if (this.fireUltimateEffect?.active) {
      this.fireUltimateEffect.update(dt);
    }
    if (this.waterUltimateEffect?.active) {
      this.waterUltimateEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.lightUltimateEffect?.active) {
      this.lightUltimateEffect.update(dt);
    }
    if (this.earthUltimateEffect?.active) {
      this.earthUltimateEffect.update(dt);
    }
    if (this.waterDarkEffect?.active) {
      this.waterDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.fireDarkEffect?.active) {
      this.fireDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.fireElectricEffect && this.fireElectricEffect.hasActiveWork()) {
      this.fireElectricEffect.update(dt);
    }
    if (this.earthElectricEffect?.active) {
      this.earthElectricEffect.update(dt);
    }
    if (this.waterEarthElectricEffect?.active) {
      this.waterEarthElectricEffect.update(dt);
    }
    if (this.fireLightEffect?.active) {
      this.fireLightEffect.update(dt);
    }
    if (this.electricDarkEffect?.active) {
      this.electricDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.earthLightEffect?.active) {
      this.earthLightEffect.update(dt);
    }
    if (this.lightDarkEffect?.active) {
      this.lightDarkEffect.update(dt);
    }
    if (this.earthDarkEffect?.active) {
      this.earthDarkEffect.update(dt);
    }
    if (this.fireLightDarkEffect?.active) {
      this.fireLightDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.lightElectricDarkEffect?.active) {
      this.lightElectricDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.earthFireDarkEffect?.active) {
      this.earthFireDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.waterLightElectricEffect?.active) {
      this.waterLightElectricEffect.update(dt);
    }
    if (this.fireLightElectricEffect?.active) {
      this.fireLightElectricEffect.update(dt);
    }
    if (this.earthLightElectricEffect?.active) {
      this.earthLightElectricEffect.update(dt);
    }
    if (this.waterLightDarkEffect?.active) {
      this.waterLightDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.fireElectricDarkEffect?.active) {
      this.fireElectricDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.earthLightDarkEffect?.active) {
      this.earthLightDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.waterFireElectricEffect?.active) {
      this.waterFireElectricEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.earthFireElectricEffect?.active) {
      this.earthFireElectricEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.waterEarthFireEffect?.active) {
      this.waterEarthFireEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.waterFireLightEffect?.active) {
      this.waterFireLightEffect.update(dt);
    }
    if (this.waterFireDarkEffect?.active) {
      this.waterFireDarkEffect.update(dt);
    }
    if (this.waterElectricDarkEffect?.active) {
      this.waterElectricDarkEffect.update(dt);
    }
    if (this.waterEarthLightEffect?.active) {
      this.waterEarthLightEffect.update(dt);
    }
    if (this.earthFireLightEffect?.active) {
      this.earthFireLightEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.waterEarthDarkEffect?.active) {
      this.waterEarthDarkEffect.update(dt, this.cameraX, this.cameraY);
    }
    if (this.earthElectricDarkEffect?.active) {
      this.earthElectricDarkEffect.update(dt);
    }
  }

  destroy() {
    this.waterEffect?.destroy();
    this.waterEffect = null;
    this.earthEffect?.destroy();
    this.earthEffect = null;
    this.fireEffect?.destroy();
    this.fireEffect = null;
    this.lightEffect?.destroy();
    this.lightEffect = null;
    this.electricEffect?.destroy();
    this.electricEffect = null;
    this.darkEffect?.destroy();
    this.darkEffect = null;
    this.darkUltimateEffect?.destroy();
    this.darkUltimateEffect = null;
    this.electricUltimateEffect?.destroy();
    this.electricUltimateEffect = null;
    this.fireUltimateEffect?.destroy();
    this.fireUltimateEffect = null;
    this.waterUltimateEffect?.destroy();
    this.waterUltimateEffect = null;
    this.lightUltimateEffect?.destroy();
    this.lightUltimateEffect = null;
    this.earthUltimateEffect?.destroy();
    this.earthUltimateEffect = null;
    this.lightElectricEffect?.destroy();
    this.lightElectricEffect = null;
    this.waterElectricEffect?.destroy();
    this.waterElectricEffect = null;
    this.waterEarthEffect?.destroy();
    this.waterEarthEffect = null;
    this.waterFireEffect?.destroy();
    this.waterFireEffect = null;
    this.earthFireEffect?.destroy();
    this.earthFireEffect = null;
    this.waterLightEffect?.destroy();
    this.waterLightEffect = null;
    this.waterDarkEffect?.destroy();
    this.waterDarkEffect = null;
    this.fireDarkEffect?.destroy();
    this.fireDarkEffect = null;
    this.fireElectricEffect?.destroy();
    this.fireElectricEffect = null;
    this.earthElectricEffect?.destroy();
    this.earthElectricEffect = null;
    this.waterEarthElectricEffect?.destroy();
    this.waterEarthElectricEffect = null;
    this.fireLightEffect?.destroy();
    this.fireLightEffect = null;
    this.electricDarkEffect?.destroy();
    this.electricDarkEffect = null;
    this.earthLightEffect?.destroy();
    this.earthLightEffect = null;
    this.lightDarkEffect?.destroy();
    this.lightDarkEffect = null;
    this.earthDarkEffect?.destroy();
    this.earthDarkEffect = null;
    this.fireLightDarkEffect?.destroy();
    this.fireLightDarkEffect = null;
    this.lightElectricDarkEffect?.destroy();
    this.lightElectricDarkEffect = null;
    this.earthFireDarkEffect?.destroy();
    this.earthFireDarkEffect = null;
    this.waterLightElectricEffect?.destroy();
    this.waterLightElectricEffect = null;
    this.fireLightElectricEffect?.destroy();
    this.fireLightElectricEffect = null;
    this.earthLightElectricEffect?.destroy();
    this.earthLightElectricEffect = null;
    this.waterLightDarkEffect?.destroy();
    this.waterLightDarkEffect = null;
    this.fireElectricDarkEffect?.destroy();
    this.fireElectricDarkEffect = null;
    this.earthLightDarkEffect?.destroy();
    this.earthLightDarkEffect = null;
    this.waterFireElectricEffect?.destroy();
    this.waterFireElectricEffect = null;
    this.earthFireElectricEffect?.destroy();
    this.earthFireElectricEffect = null;
    this.waterEarthFireEffect?.destroy();
    this.waterEarthFireEffect = null;
    this.waterFireLightEffect?.destroy();
    this.waterFireLightEffect = null;
    this.waterFireDarkEffect?.destroy();
    this.waterFireDarkEffect = null;
    this.waterElectricDarkEffect?.destroy();
    this.waterElectricDarkEffect = null;
    this.waterEarthLightEffect?.destroy();
    this.waterEarthLightEffect = null;
    this.earthFireLightEffect?.destroy();
    this.earthFireLightEffect = null;
    this.waterEarthDarkEffect?.destroy();
    this.waterEarthDarkEffect = null;
    this.earthElectricDarkEffect?.destroy();
    this.earthElectricDarkEffect = null;
  }
}
