import * as PIXI from 'pixi.js';
import { GameState, ElementType, ELEMENT_COLORS, CANVAS_W, CANVAS_H } from './types';

// 인-캔버스 UI는 게임 진행에 필요한 overlay만 유지:
//   - waveAnnounce (Wave 시작 플래시)
//   - comboText (콤보 플래시)
//   - levelUpFlash
//   - weapon slots (하단 중앙 — 활성 슬롯 표시가 gameplay에 직결)
// HUD (HP/XP, 점수, 스킬)는 canvas 밖 React 컴포넌트로 이동.

export interface UIElements {
  waveAnnounce: PIXI.Text;
  comboText: PIXI.Text;
  levelUpFlash: PIXI.Text;
  // Weapon slot UI (bottom center)
  weaponSlotContainer: PIXI.Container;
  slotBgs: PIXI.Graphics[];
  subSlotGraphics: PIXI.Graphics[][];
  weaponNameTexts: PIXI.Text[];
  slotKeyTexts: PIXI.Text[];
}

const FONT_FAMILY = 'Inter, "Segoe UI", system-ui, sans-serif';

const textStyle = (size: number, fill: string, weight: PIXI.TextStyleFontWeight = 'bold', letterSpacing = 0) =>
  new PIXI.TextStyle({
    fontFamily: FONT_FAMILY,
    fontSize: size,
    fill,
    fontWeight: weight,
    letterSpacing,
    dropShadow: true,
    dropShadowColor: '#000000',
    dropShadowAlpha: 0.35,
    dropShadowBlur: 3,
    dropShadowDistance: 1,
  });

export function createUI(container: PIXI.Container): UIElements {
  // ── 중앙 오버레이 ──
  const waveAnnounce = new PIXI.Text('', textStyle(36, '#1e293b', 'bold', 3));
  waveAnnounce.anchor.set(0.5);
  waveAnnounce.x = CANVAS_W / 2;
  waveAnnounce.y = CANVAS_H / 3;
  waveAnnounce.visible = false;

  const comboText = new PIXI.Text('', textStyle(22, '#fb923c', 'bold', 2));
  comboText.anchor.set(0.5);
  comboText.x = CANVAS_W / 2;
  comboText.y = CANVAS_H / 2 - 60;
  comboText.visible = false;

  const levelUpFlash = new PIXI.Text('LEVEL UP', textStyle(30, '#1e293b', 'bold', 4));
  levelUpFlash.anchor.set(0.5);
  levelUpFlash.x = CANVAS_W / 2;
  levelUpFlash.y = CANVAS_H / 2 - 100;
  levelUpFlash.visible = false;

  // ── Weapon slots (하단 중앙) ──
  const weaponSlotContainer = new PIXI.Container();
  const slotBgs: PIXI.Graphics[] = [];
  const subSlotGraphics: PIXI.Graphics[][] = [];
  const weaponNameTexts: PIXI.Text[] = [];
  const slotKeyTexts: PIXI.Text[] = [];

  const SLOT_W = 96;
  const SLOT_H = 50;
  const SLOT_GAP = 10;
  const TOTAL_W = SLOT_W * 3 + SLOT_GAP * 2;
  const START_X = (CANVAS_W - TOTAL_W) / 2;
  const START_Y = CANVAS_H - 70;

  for (let s = 0; s < 3; s++) {
    const sx = START_X + s * (SLOT_W + SLOT_GAP);

    const bg = new PIXI.Graphics();
    bg.x = sx;
    bg.y = START_Y;
    slotBgs.push(bg);

    const keyText = new PIXI.Text(`${s + 1}`, textStyle(10, '#64748b', 'bold', 1));
    keyText.anchor.set(0.5, 0);
    keyText.x = sx + SLOT_W / 2;
    keyText.y = START_Y - 14;
    slotKeyTexts.push(keyText);

    const subGfx: PIXI.Graphics[] = [];
    const subCX = sx + SLOT_W / 2 - 22;
    const subCY = START_Y + 20;
    for (let e = 0; e < 3; e++) {
      const g = new PIXI.Graphics();
      g.x = subCX + e * 22;
      g.y = subCY;
      subGfx.push(g);
    }
    subSlotGraphics.push(subGfx);

    const nameText = new PIXI.Text('', textStyle(9, '#475569', 'bold', 0.5));
    nameText.anchor.set(0.5, 0);
    nameText.x = sx + SLOT_W / 2;
    nameText.y = START_Y + SLOT_H - 16;
    weaponNameTexts.push(nameText);
  }

  container.addChild(waveAnnounce, comboText, levelUpFlash);
  container.addChild(weaponSlotContainer);
  for (const bg of slotBgs) weaponSlotContainer.addChild(bg);
  for (const kt of slotKeyTexts) weaponSlotContainer.addChild(kt);
  for (const subArr of subSlotGraphics) for (const g of subArr) weaponSlotContainer.addChild(g);
  for (const nt of weaponNameTexts) weaponSlotContainer.addChild(nt);

  return {
    waveAnnounce, comboText, levelUpFlash,
    weaponSlotContainer, slotBgs, subSlotGraphics, weaponNameTexts, slotKeyTexts,
  };
}

const _uiCache = {
  slotHash: '',
  activeSlot: -1,
};

export function updateUI(ui: UIElements, state: GameState) {
  const { player, wave } = state;

  // Wave announce
  if (state.waveAnnounceTimer > 0) {
    ui.waveAnnounce.visible = true;
    ui.waveAnnounce.text = `WAVE ${wave}`;
    ui.waveAnnounce.alpha = Math.min(state.waveAnnounceTimer / 30, 1);
  } else {
    ui.waveAnnounce.visible = false;
  }

  // Combo
  if (state.comboDisplayTimer > 0 && state.comboDisplayCount >= 5) {
    ui.comboText.visible = true;
    ui.comboText.text = `×${state.comboDisplayCount} COMBO`;
    ui.comboText.alpha = Math.min(state.comboDisplayTimer / 20, 1);
  } else {
    ui.comboText.visible = false;
  }

  // Level up flash
  if (state.levelUpTextTimer > 0) {
    ui.levelUpFlash.visible = true;
    ui.levelUpFlash.alpha = Math.min(state.levelUpTextTimer / 20, 1);
    ui.levelUpFlash.scale.set(1 + (60 - state.levelUpTextTimer) * 0.006);
  } else {
    ui.levelUpFlash.visible = false;
  }

  // Weapon slots
  let slotHash = '';
  for (let s = 0; s < 3; s++) {
    const slot = player.weaponSlots[s];
    slotHash += (slot.weapon ? slot.weapon.name : '') + '|'
      + slot.elements[0] + ',' + slot.elements[1] + ',' + slot.elements[2] + ';';
  }
  const slotsChanged = slotHash !== _uiCache.slotHash;
  const activeChanged = player.activeSlotIndex !== _uiCache.activeSlot;

  if (slotsChanged || activeChanged) {
    const SLOT_W = 96;
    const SLOT_H = 50;

    for (let s = 0; s < 3; s++) {
      const slot = player.weaponSlots[s];
      const isActive = s === player.activeSlotIndex;
      const bg = ui.slotBgs[s];

      bg.clear();
      // 흰 배경 위에 올라가는 밝은 패널
      bg.beginFill(0xffffff, 0.95);
      bg.drawRoundedRect(0, 0, SLOT_W, SLOT_H, 10);
      bg.endFill();

      if (slot.weapon) {
        bg.beginFill(slot.weapon.color, 0.08);
        bg.drawRoundedRect(0, 0, SLOT_W, SLOT_H, 10);
        bg.endFill();
      }

      if (isActive) {
        bg.lineStyle(2, 0xd97706, 1);
      } else if (slot.weapon) {
        bg.lineStyle(1.5, slot.weapon.color, 0.7);
      } else {
        bg.lineStyle(1, 0xcbd5e1, 1);
      }
      bg.drawRoundedRect(0, 0, SLOT_W, SLOT_H, 10);

      for (let e = 0; e < 3; e++) {
        const g = ui.subSlotGraphics[s][e];
        g.clear();
        const el = slot.elements[e];
        if (el) {
          const color = parseInt(ELEMENT_COLORS[el].replace('#', ''), 16);
          g.beginFill(color, 0.18);
          g.drawCircle(0, 0, 12);
          g.endFill();
          g.beginFill(color, 0.95);
          g.drawCircle(0, 0, 8);
          g.endFill();
          g.beginFill(0xffffff, 0.55);
          g.drawCircle(-2, -2, 3);
          g.endFill();
        } else {
          // 빈 소켓 — 연한 회색 원
          g.beginFill(0xf1f5f9, 1);
          g.drawCircle(0, 0, 8);
          g.endFill();
          g.lineStyle(1, 0xcbd5e1, 1);
          g.drawCircle(0, 0, 8);
        }
      }

      if (slot.weapon) {
        ui.weaponNameTexts[s].text = slot.weapon.name.toUpperCase();
        ui.weaponNameTexts[s].style.fill = isActive ? '#d97706' : '#0f172a';
      } else {
        const filledCount = slot.elements.filter(Boolean).length;
        ui.weaponNameTexts[s].text = filledCount > 0 ? `${filledCount} / 3` : 'EMPTY';
        ui.weaponNameTexts[s].style.fill = filledCount > 0 ? '#475569' : '#94a3b8';
      }

      ui.slotKeyTexts[s].style.fill = isActive ? '#d97706' : '#94a3b8';
    }

    _uiCache.slotHash = slotHash;
    _uiCache.activeSlot = player.activeSlotIndex;
  }
}

// ═══════════════════════════════════════════════════════════
//  Dev Panel (기존 유지 — 간단 패널)
// ═══════════════════════════════════════════════════════════

export interface DevPanel {
  container: PIXI.Container;
  visible: boolean;
}

export function createDevPanel(
  parent: PIXI.Container,
  onAddElement: (e: ElementType) => void,
  onClear: () => void,
  onFill: () => void,
  onSpawnNextBoss?: () => void,
  onKillAllBosses?: () => void,
): DevPanel {
  const container = new PIXI.Container();
  container.x = 10;
  container.y = 10;
  parent.addChild(container);

  const panelH = 188;  // boss 버튼 2개 추가로 키움
  const bg = new PIXI.Graphics();
  bg.beginFill(0x0b1020, 0.88);
  bg.drawRoundedRect(0, 0, 190, panelH, 8);
  bg.endFill();
  bg.lineStyle(1, 0x334155, 0.65);
  bg.drawRoundedRect(0, 0, 190, panelH, 8);
  container.addChild(bg);

  const title = new PIXI.Text('DEV', textStyle(10, '#64748b', 'bold', 2));
  title.x = 10;
  title.y = 6;
  container.addChild(title);

  const elements: ElementType[] = ['물', '불', '흙', '빛', '전기', '암흑'];
  const btnSize = 46;
  const btnGap = 4;
  for (let i = 0; i < 6; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const bx = 10 + col * (btnSize + btnGap);
    const by = 22 + row * (btnSize + btnGap);

    const btn = new PIXI.Graphics();
    const color = parseInt(ELEMENT_COLORS[elements[i]].replace('#', ''), 16);
    btn.beginFill(color, 0.18);
    btn.drawRoundedRect(0, 0, btnSize, btnSize, 6);
    btn.endFill();
    btn.lineStyle(1.5, color, 0.75);
    btn.drawRoundedRect(0, 0, btnSize, btnSize, 6);
    btn.x = bx;
    btn.y = by;
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointerdown', () => onAddElement(elements[i]));
    container.addChild(btn);

    const label = new PIXI.Text(elements[i], textStyle(14, ELEMENT_COLORS[elements[i]], 'bold'));
    label.anchor.set(0.5);
    label.x = bx + btnSize / 2;
    label.y = by + btnSize / 2;
    container.addChild(label);
  }

  const clearBtn = new PIXI.Graphics();
  clearBtn.beginFill(0xf87171, 0.18);
  clearBtn.drawRoundedRect(0, 0, 70, 24, 6);
  clearBtn.endFill();
  clearBtn.lineStyle(1, 0xf87171, 0.65);
  clearBtn.drawRoundedRect(0, 0, 70, 24, 6);
  clearBtn.x = 10;
  clearBtn.y = 120;
  clearBtn.eventMode = 'static';
  clearBtn.cursor = 'pointer';
  clearBtn.on('pointerdown', onClear);
  container.addChild(clearBtn);

  const clearLabel = new PIXI.Text('CLEAR', textStyle(10, '#F87171', 'bold', 1));
  clearLabel.anchor.set(0.5);
  clearLabel.x = 45;
  clearLabel.y = 132;
  container.addChild(clearLabel);

  const fillBtn = new PIXI.Graphics();
  fillBtn.beginFill(0x4ade80, 0.18);
  fillBtn.drawRoundedRect(0, 0, 70, 24, 6);
  fillBtn.endFill();
  fillBtn.lineStyle(1, 0x4ade80, 0.65);
  fillBtn.drawRoundedRect(0, 0, 70, 24, 6);
  fillBtn.x = 90;
  fillBtn.y = 120;
  fillBtn.eventMode = 'static';
  fillBtn.cursor = 'pointer';
  fillBtn.on('pointerdown', onFill);
  container.addChild(fillBtn);

  const fillLabel = new PIXI.Text('FILL ALL', textStyle(10, '#4ADE80', 'bold', 1));
  fillLabel.anchor.set(0.5);
  fillLabel.x = 125;
  fillLabel.y = 132;
  container.addChild(fillLabel);

  // ── 보스 테스트 버튼 ──
  if (onSpawnNextBoss) {
    const bossBtn = new PIXI.Graphics();
    bossBtn.beginFill(0x8b5cf6, 0.20);
    bossBtn.drawRoundedRect(0, 0, 105, 24, 6);
    bossBtn.endFill();
    bossBtn.lineStyle(1, 0x8b5cf6, 0.70);
    bossBtn.drawRoundedRect(0, 0, 105, 24, 6);
    bossBtn.x = 10;
    bossBtn.y = 152;
    bossBtn.eventMode = 'static';
    bossBtn.cursor = 'pointer';
    bossBtn.on('pointerdown', onSpawnNextBoss);
    container.addChild(bossBtn);

    const bossLabel = new PIXI.Text('NEXT BOSS (N)', textStyle(10, '#C4B5FD', 'bold', 1));
    bossLabel.anchor.set(0.5);
    bossLabel.x = 62;
    bossLabel.y = 164;
    container.addChild(bossLabel);
  }

  if (onKillAllBosses) {
    const killBtn = new PIXI.Graphics();
    killBtn.beginFill(0xef4444, 0.20);
    killBtn.drawRoundedRect(0, 0, 65, 24, 6);
    killBtn.endFill();
    killBtn.lineStyle(1, 0xef4444, 0.70);
    killBtn.drawRoundedRect(0, 0, 65, 24, 6);
    killBtn.x = 120;
    killBtn.y = 152;
    killBtn.eventMode = 'static';
    killBtn.cursor = 'pointer';
    killBtn.on('pointerdown', onKillAllBosses);
    container.addChild(killBtn);

    const killLabel = new PIXI.Text('KILL (K)', textStyle(10, '#FCA5A5', 'bold', 1));
    killLabel.anchor.set(0.5);
    killLabel.x = 152;
    killLabel.y = 164;
    container.addChild(killLabel);
  }

  return { container, visible: true };
}

// ═══════════════════════════════════════════════════════════
//  Game Over Overlay
// ═══════════════════════════════════════════════════════════

export interface GameOverOverlay {
  container: PIXI.Container;
  visible: boolean;
}

export function createGameOverOverlay(parent: PIXI.Container): GameOverOverlay {
  const container = new PIXI.Container();
  container.visible = false;
  parent.addChild(container);
  return { container, visible: false };
}

export function showGameOver(
  overlay: GameOverOverlay,
  state: GameState,
  onRestart: () => void,
) {
  const c = overlay.container;
  c.removeChildren();
  c.visible = true;

  const bg = new PIXI.Graphics();
  bg.beginFill(0x000000, 0.78);
  bg.drawRect(0, 0, CANVAS_W, CANVAS_H);
  bg.endFill();

  const panel = new PIXI.Graphics();
  panel.beginFill(0x0b1020, 0.95);
  panel.drawRoundedRect(0, 0, 360, 280, 14);
  panel.endFill();
  panel.lineStyle(1, 0x334155, 0.75);
  panel.drawRoundedRect(0, 0, 360, 280, 14);
  panel.x = (CANVAS_W - 360) / 2;
  panel.y = (CANVAS_H - 280) / 2;

  const gameOverText = new PIXI.Text('GAME OVER', textStyle(36, '#F87171', 'bold', 4));
  gameOverText.anchor.set(0.5);
  gameOverText.x = CANVAS_W / 2;
  gameOverText.y = (CANVAS_H - 280) / 2 + 50;

  const mins = Math.floor(state.frameCount / 60 / 60);
  const secs = Math.floor(state.frameCount / 60) % 60;
  const secStr = secs.toString().padStart(2, '0');
  const weaponCount = state.player.weaponSlots.filter(s => s.weapon).length;
  const weaponNames = state.player.weaponSlots
    .filter(s => s.weapon)
    .map(s => s.weapon!.name)
    .join(', ');

  const statsText = new PIXI.Text(
    `킬 수: ${state.player.kills}\n점수: ${state.player.score}\nWave: ${state.wave}\n시간: ${mins}:${secStr}\n무기: ${weaponCount > 0 ? weaponNames : '없음'}`,
    textStyle(14, '#F8FAFC')
  );
  statsText.anchor.set(0.5, 0);
  statsText.x = CANVAS_W / 2;
  statsText.y = (CANVAS_H - 280) / 2 + 100;

  const btnBg = new PIXI.Graphics();
  btnBg.beginFill(0x22d3ee, 0.2);
  btnBg.drawRoundedRect(0, 0, 180, 48, 10);
  btnBg.endFill();
  btnBg.lineStyle(2, 0x22d3ee, 0.9);
  btnBg.drawRoundedRect(0, 0, 180, 48, 10);
  btnBg.x = (CANVAS_W - 180) / 2;
  btnBg.y = (CANVAS_H - 280) / 2 + 210;
  btnBg.eventMode = 'static';
  btnBg.cursor = 'pointer';
  btnBg.on('pointerdown', () => {
    c.visible = false;
    onRestart();
  });

  const btnText = new PIXI.Text('RESTART', textStyle(18, '#22D3EE', 'bold', 3));
  btnText.anchor.set(0.5);
  btnText.x = CANVAS_W / 2;
  btnText.y = (CANVAS_H - 280) / 2 + 234;

  overlay.container.addChild(bg, panel, gameOverText, statsText, btnBg, btnText);
}
