import { useEffect, useRef, useState } from 'react';
import { unlockAudio, stopAll, setMasterVolume } from './context';
import type { SoundVariant, VariantSet } from './types';

type Handle = { stop: (at?: number) => void };

export default function SoundPreviewPanel({
  set, onClose,
}: { set: VariantSet; onClose: () => void }) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.7);
  const [attackDur, setAttackDur] = useState(2.5);
  const activeRef = useRef<Handle | null>(null);
  const continuousAttacks = set.attacksAreContinuous ?? true;

  useEffect(() => {
    void unlockAudio();
  }, []);

  useEffect(() => {
    setMasterVolume(volume);
  }, [volume]);

  const stopCurrent = () => {
    if (activeRef.current) {
      activeRef.current.stop();
      activeRef.current = null;
    }
    setPlayingId(null);
  };

  const playVariant = (v: SoundVariant, isAttack: boolean) => {
    void unlockAudio();
    stopCurrent();
    const attackAsBurst = isAttack && !continuousAttacks;
    const h = isAttack && continuousAttacks ? v.play(attackDur) : v.play();
    activeRef.current = h;
    setPlayingId(v.id);
    const timeout = isAttack && continuousAttacks ? (attackDur + 0.5) * 1000 : (attackAsBurst ? 3500 : 1500);
    window.setTimeout(() => {
      if (activeRef.current === h) {
        activeRef.current = null;
        setPlayingId((id) => (id === v.id ? null : id));
      }
    }, timeout);
  };

  const handleStopAll = () => {
    stopAll();
    activeRef.current = null;
    setPlayingId(null);
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <h2 style={styles.title}>{set.title}</h2>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.controlBar}>
          <label style={styles.ctrlLabel}>
            마스터 볼륨 <span style={styles.val}>{Math.round(volume * 100)}%</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              style={styles.slider}
            />
          </label>
          {continuousAttacks && (
            <label style={styles.ctrlLabel}>
              공격 지속 <span style={styles.val}>{attackDur.toFixed(1)}s</span>
              <input
                type="range" min={0.5} max={5} step={0.1}
                value={attackDur}
                onChange={(e) => setAttackDur(parseFloat(e.target.value))}
                style={styles.slider}
              />
            </label>
          )}
          <button style={styles.stopAllBtn} onClick={handleStopAll}>■ 전체 정지</button>
        </div>

        <Section
          title={continuousAttacks ? '① 공격 사운드 (지속형)' : '① 공격 사운드 (원샷 방전)'}
          subtitle={set.attackSectionSubtitle ?? (continuousAttacks ? '이펙트 활성 중 루프되는 소리' : '이벤트 발생 시 1회 재생')}
        >
          {set.attacks.map((v, i) => (
            <Row
              key={v.id}
              index={i + 1}
              label={v.label}
              desc={v.description}
              playing={playingId === v.id}
              onPlay={() => playVariant(v, true)}
              onStop={stopCurrent}
            />
          ))}
        </Section>

        <Section
          title="② 타격 사운드 (원샷)"
          subtitle={set.hitSectionSubtitle ?? '적에게 피해가 들어갈 때 재생'}
        >
          {set.hits.map((v, i) => (
            <Row
              key={v.id}
              index={i + 1}
              label={v.label}
              desc={v.description}
              playing={playingId === v.id}
              onPlay={() => playVariant(v, false)}
              onStop={stopCurrent}
            />
          ))}
        </Section>

        <div style={styles.footer}>
          마음에 드는 번호 알려주시면 확정하고 다음 이펙트로 넘어갑니다.
        </div>
      </div>
    </div>
  );
}

function Section({
  title, subtitle, children,
}: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <div style={styles.sectionTitle}>{title}</div>
        <div style={styles.sectionSubtitle}>{subtitle}</div>
      </div>
      <div style={styles.rowList}>{children}</div>
    </div>
  );
}

function Row({
  index, label, desc, playing, onPlay, onStop,
}: {
  index: number; label: string; desc: string;
  playing: boolean; onPlay: () => void; onStop: () => void;
}) {
  return (
    <div style={{ ...styles.row, ...(playing ? styles.rowActive : {}) }}>
      <span style={styles.rowIdx}>#{index}</span>
      <div style={styles.rowText}>
        <div style={styles.rowLabel}>{label}</div>
        <div style={styles.rowDesc}>{desc}</div>
      </div>
      {playing ? (
        <button style={{ ...styles.playBtn, ...styles.stopBtn }} onClick={onStop}>■ 정지</button>
      ) : (
        <button style={styles.playBtn} onClick={onPlay}>▶ 재생</button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(0, 0, 0, 0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  panel: {
    width: 'min(720px, 92vw)', maxHeight: '92vh', overflow: 'auto',
    background: 'linear-gradient(180deg, #1a1208 0%, #0f0a04 100%)',
    color: '#f3e4c7',
    border: '1px solid rgba(180, 130, 50, 0.35)',
    borderRadius: 12,
    boxShadow: '0 20px 60px rgba(160, 110, 40, 0.25), inset 0 0 40px rgba(160, 110, 40, 0.08)',
    padding: '20px 22px',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 14,
  },
  title: {
    margin: 0, fontSize: 18, letterSpacing: 0.3,
    color: '#d4a53c',
  },
  closeBtn: {
    background: 'transparent', border: '1px solid rgba(212, 165, 60, 0.4)',
    color: '#d4a53c', width: 32, height: 32, borderRadius: 6, cursor: 'pointer',
    fontSize: 14,
  },
  controlBar: {
    display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap',
    padding: '10px 12px', marginBottom: 16,
    background: 'rgba(0, 0, 0, 0.3)', borderRadius: 8,
    border: '1px solid rgba(180, 130, 50, 0.15)',
  },
  ctrlLabel: {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontSize: 12, color: '#d4a53caa',
  },
  val: { color: '#d4a53c', fontWeight: 600 },
  slider: { width: 160, accentColor: '#b8860b' },
  stopAllBtn: {
    marginLeft: 'auto', padding: '8px 14px',
    background: 'rgba(120, 82, 10, 0.5)',
    border: '1px solid rgba(180, 130, 50, 0.55)',
    color: '#f3e4c7', borderRadius: 6, cursor: 'pointer',
    fontSize: 13, fontWeight: 600,
  },
  section: { marginBottom: 16 },
  sectionHeader: { marginBottom: 8 },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: '#d4a53c' },
  sectionSubtitle: { fontSize: 12, color: '#d4a53caa', marginTop: 2 },
  rowList: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px',
    background: 'rgba(0, 0, 0, 0.35)',
    border: '1px solid rgba(180, 130, 50, 0.12)',
    borderRadius: 8,
    transition: 'background 0.15s, border-color 0.15s',
  },
  rowActive: {
    background: 'rgba(184, 134, 11, 0.18)',
    border: '1px solid rgba(212, 165, 60, 0.55)',
  },
  rowIdx: {
    width: 32, textAlign: 'center',
    fontSize: 13, fontWeight: 700, color: '#d4a53c',
    opacity: 0.7,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 14, fontWeight: 600, color: '#f3e4c7' },
  rowDesc: { fontSize: 12, color: '#d4a53caa', marginTop: 2 },
  playBtn: {
    padding: '7px 14px',
    background: 'linear-gradient(180deg, #b8860b, #92400e)',
    border: 'none', color: '#fff', borderRadius: 6, cursor: 'pointer',
    fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
  },
  stopBtn: {
    background: 'linear-gradient(180deg, #7f1d1d, #450a0a)',
  },
  footer: {
    marginTop: 8, padding: '10px 12px',
    fontSize: 12, color: '#d4a53caa',
    textAlign: 'center',
    borderTop: '1px solid rgba(180, 130, 50, 0.15)',
  },
};
