import { useEffect, useRef, useState } from 'react';
import { GameEngine } from './engine';
import { LevelEvent, LevelEventResolution, SkillId, PlayerState } from './types';
import { LevelUpOverlay } from './levelup/LevelUpOverlay';
import { unlockAudio } from '../sound/context';

// ── 라이트 테마 토큰 ──
const C = {
  panelBg: '#FFFFFF',
  panelBorder: '#E2E8F0',
  panelShadow: '0 1px 3px rgba(15, 23, 42, 0.05), 0 4px 12px rgba(15, 23, 42, 0.06)',
  textPri: '#0F172A',
  textSec: '#475569',
  textMuted: '#94A3B8',
  accentGold: '#D97706',
  accentCyan: '#0891B2',
  keyBg: '#F1F5F9',
};

const CANVAS_W = 960;
const CANVAS_H = 540;
const SIDEBAR_W = 220;

const SKILL_META: { id: SkillId; key: string; symbol: string; name: string; color: string }[] = [
  { id: 'water_tidal',     key: '1', symbol: '💧', name: '대해일',   color: '#2563eb' },
  { id: 'fire_inferno',    key: '2', symbol: '🔥', name: '지옥염',   color: '#dc2626' },
  { id: 'earth_quake',     key: '3', symbol: '⛰️', name: '대지진',   color: '#92400e' },
  { id: 'electric_storm',  key: '4', symbol: '⚡', name: '뇌전폭풍', color: '#7c3aed' },
  { id: 'light_judgment',  key: '5', symbol: '✨', name: '심판광',   color: '#ca8a04' },
  { id: 'dark_abyss',      key: '6', symbol: '🌑', name: '심연',     color: '#4c1d95' },
];

export default function SurvivorsGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [pendingEvent, setPendingEvent] = useState<LevelEvent | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    if (engineRef.current) return;

    const devMode = new URLSearchParams(window.location.search).get('test') === '1';

    const engine = new GameEngine({ devMode });
    engineRef.current = engine;
    engine.onLevelEvent = (event) => setPendingEvent(event);
    engine.init(containerRef.current);

    // Unlock Web Audio on first user gesture (autoplay policy)
    const unlock = () => {
      void unlockAudio();
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);

    // HUD refresh — ~30Hz
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 33) { setTick((v) => v + 1); last = t; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pointerdown', unlock);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  function handleResolve(resolution: LevelEventResolution) {
    engineRef.current?.resolveLevelEvent(resolution);
    setPendingEvent(null);
  }

  const eng = engineRef.current;
  const player = eng?.state.player ?? null;
  const frameCount = eng?.state.frameCount ?? 0;
  const wave = eng?.state.wave ?? 1;
  void tick;

  const mins = Math.floor(frameCount / 60 / 60);
  const secs = Math.floor(frameCount / 60) % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

  return (
    <div style={{
      width: '100%',
      minHeight: '100vh',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      padding: '20px 16px',
      boxSizing: 'border-box',
      fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
    }}>
      <div style={{
        display: 'flex',
        gap: 14,
        alignItems: 'stretch',
      }}>
        {/* ── 좌측 사이드바: 스킬 콘솔 (캔버스 높이와 매칭) ── */}
        <SkillSidebar player={player} />

        {/* ── 중앙: 게임 캔버스 ── */}
        <div
          ref={containerRef}
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            position: 'relative',
            borderRadius: 10,
            overflow: 'hidden',
            border: `1px solid ${C.panelBorder}`,
            boxShadow: C.panelShadow,
            flexShrink: 0,
          }}
        >
          <LevelUpOverlay event={pendingEvent} onResolve={handleResolve} />
        </div>

        {/* ── 우측 사이드바 ── */}
        <Sidebar
          score={player?.score ?? 0}
          kills={player?.kills ?? 0}
          level={player?.level ?? 1}
          wave={wave}
          timeStr={timeStr}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  Skill Sidebar (left, vertical, matches canvas height)
// ═══════════════════════════════════════════════════════════
function SkillSidebar({ player }: { player: PlayerState | null }) {
  // 헤더 36px + 6 슬롯 균등 분배 + padding
  const HEADER_H = 32;
  const PADDING = 10;
  const GAP = 6;
  const slotH = (CANVAS_H - HEADER_H - PADDING * 2 - GAP * 5) / 6;

  return (
    <aside style={{
      width: SIDEBAR_W,
      height: CANVAS_H,
      display: 'flex',
      flexDirection: 'column',
      padding: PADDING,
      gap: GAP,
      background: C.panelBg,
      border: `1px solid ${C.panelBorder}`,
      borderRadius: 10,
      boxShadow: C.panelShadow,
      boxSizing: 'border-box',
    }}>
      <div style={{
        height: HEADER_H - 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 2.5,
        color: C.textMuted,
        borderBottom: `1px solid ${C.panelBorder}`,
        paddingBottom: 2,
      }}>
        SKILLS
      </div>

      {SKILL_META.map((meta) => {
        const skill = player?.skills[meta.id];
        const unlocked = skill?.unlocked ?? false;
        const cd = skill?.cooldown ?? 0;
        const maxCd = skill?.maxCooldown ?? 600;
        const ratio = unlocked && cd > 0 ? cd / maxCd : 0;
        const secsLeft = Math.ceil(cd / 60);
        return (
          <SkillRow
            key={meta.id}
            meta={meta}
            height={slotH}
            unlocked={unlocked}
            cooldownRatio={ratio}
            secsLeft={secsLeft}
          />
        );
      })}
    </aside>
  );
}

function SkillRow({ meta, height, unlocked, cooldownRatio, secsLeft }: {
  meta: (typeof SKILL_META)[number];
  height: number;
  unlocked: boolean;
  cooldownRatio: number;
  secsLeft: number;
}) {
  const cooling = unlocked && cooldownRatio > 0;
  const ready = unlocked && !cooling;

  const conic = cooling
    ? `conic-gradient(from 0deg, rgba(148, 163, 184, 0.75) 0deg, rgba(148, 163, 184, 0.75) ${cooldownRatio * 360}deg, transparent ${cooldownRatio * 360}deg 360deg)`
    : 'none';

  return (
    <div style={{
      height,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 4px',
      borderRadius: 8,
      background: unlocked ? `${meta.color}0a` : 'transparent',
      border: `1px solid ${ready ? meta.color : unlocked ? `${meta.color}55` : C.panelBorder}`,
      transition: 'border-color 0.15s',
    }}>
      {/* 키 캡 */}
      <div style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        background: C.keyBg,
        border: `1px solid ${C.panelBorder}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontWeight: 800,
        color: ready ? meta.color : C.textMuted,
      }}>
        {meta.key}
      </div>

      {/* 아이콘 + 쿨다운 */}
      <div style={{
        position: 'relative',
        width: 34,
        height: 34,
        borderRadius: 8,
        background: unlocked ? '#F8FAFC' : '#F1F5F9',
        border: `1px solid ${unlocked ? `${meta.color}55` : C.panelBorder}`,
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: ready ? `0 0 0 2px ${meta.color}22` : 'none',
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          filter: unlocked ? 'none' : 'grayscale(1) opacity(0.45)',
        }}>
          {unlocked ? meta.symbol : '🔒'}
        </div>
        {cooling && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: conic, pointerEvents: 'none' }} />
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 800,
              color: C.textPri,
              textShadow: '0 1px 2px rgba(255,255,255,0.9)',
              pointerEvents: 'none',
            }}>
              {secsLeft}
            </div>
          </>
        )}
      </div>

      {/* 이름 */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: unlocked ? C.textPri : C.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {unlocked ? meta.name : 'LOCKED'}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  Right Sidebar
// ═══════════════════════════════════════════════════════════
function Sidebar({ score, kills, level, wave, timeStr }: {
  score: number; kills: number; level: number; wave: number; timeStr: string;
}) {
  return (
    <aside style={{
      width: SIDEBAR_W,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      color: C.textPri,
    }}>
      <PanelCard title="SCORE" accent={C.accentGold}>
        <div style={{ fontSize: 32, fontWeight: 800, color: C.accentGold, letterSpacing: 0.5, lineHeight: 1.1 }}>
          {score.toLocaleString()}
        </div>
        <Row label="KILLS" value={kills.toLocaleString()} />
        <Row label="TIME" value={timeStr} />
      </PanelCard>

      <PanelCard title="RUN" accent={C.accentCyan}>
        <StatRow label="LEVEL" value={level} />
        <StatRow label="WAVE" value={wave} />
      </PanelCard>

      <PanelCard title="CONTROLS">
        <ControlRow keys="WASD" label="이동" />
        <ControlRow keys="1 2 3" label="무기 슬롯" />
        <ControlRow keys="Q W E R T Y" label="스킬" />
      </PanelCard>
    </aside>
  );
}

function PanelCard({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: C.panelBg,
      border: `1px solid ${C.panelBorder}`,
      borderRadius: 10,
      padding: 14,
      boxShadow: C.panelShadow,
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 2,
        color: accent ?? C.textMuted,
        marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginTop: 8,
      paddingTop: 8,
      borderTop: `1px solid ${C.panelBorder}`,
    }}>
      <span style={{ fontSize: 10, color: C.textMuted, letterSpacing: 1.5, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: C.textPri }}>{value}</span>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: C.textMuted, letterSpacing: 1.5, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 800, color: C.textPri }}>{value}</span>
    </div>
  );
}

function ControlRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '4px 0',
    }}>
      <span style={{
        fontSize: 10,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        color: C.textPri,
        padding: '3px 7px',
        background: C.keyBg,
        border: `1px solid ${C.panelBorder}`,
        borderRadius: 4,
        letterSpacing: 1,
        fontWeight: 700,
      }}>{keys}</span>
      <span style={{ fontSize: 11, color: C.textSec }}>{label}</span>
    </div>
  );
}
