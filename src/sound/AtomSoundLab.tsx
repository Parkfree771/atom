import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { unlockAudio, stopAll, setMasterVolume } from './context';
import { ATOM_VARIANTS, type AtomVariant } from './atomVariants';

interface Props {
  onContinue: () => void;
}

export default function AtomSoundLab({ onContinue }: Props) {
  const [volume, setVolume] = useState(0.23);
  const [filter, setFilter] = useState<'all' | 'hit' | 'kill'>('all');
  const [lastPlayed, setLastPlayed] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    void unlockAudio();
  }, []);

  useEffect(() => {
    setMasterVolume(volume);
  }, [volume]);

  function flash(id: string) {
    setLastPlayed(id);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setLastPlayed(null), 250);
  }

  function fireOne(v: AtomVariant) {
    void unlockAudio();
    v.play();
    flash(v.id);
  }

  function fireRapid(v: AtomVariant, count: number, gapMs: number) {
    void unlockAudio();
    flash(v.id);
    for (let i = 0; i < count; i++) {
      window.setTimeout(() => v.play(), i * gapMs);
    }
  }

  const visible = filter === 'all' ? ATOM_VARIANTS : ATOM_VARIANTS.filter((v) => v.kind === filter);

  return (
    <div style={overlay}>
      <div style={panel}>
        <header style={head}>
          <div>
            <h1 style={title}>⚛ ATOM Sound Lab</h1>
            <p style={subtitle}>
              원자 테마 hit/kill 후보 10종 — Rapid 버튼으로 이어지는 공격(체인) 테스트
            </p>
          </div>
          <button onClick={onContinue} style={btnPrimary}>게임 시작 →</button>
        </header>

        <div style={controls}>
          <div style={filterGroup}>
            {(['all', 'hit', 'kill'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{ ...btnFilter, ...(filter === f ? btnFilterActive : {}) }}
              >
                {f === 'all' ? '전체' : f === 'hit' ? '타격용' : '처치용'}
              </button>
            ))}
          </div>
          <label style={vol}>
            볼륨 {Math.round(volume * 100)}%
            <input
              type="range" min={0} max={1} step={0.01}
              value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))}
              style={{ width: 140 }}
            />
          </label>
          <button onClick={stopAll} style={btnDanger}>전체 정지</button>
        </div>

        <div style={grid}>
          {visible.map((v) => (
            <div key={v.id} style={{ ...card, ...(lastPlayed === v.id ? cardActive : {}) }}>
              <div style={cardHead}>
                <span style={kindTag(v.kind)}>{v.kind === 'hit' ? '타격' : '처치'}</span>
                <h3 style={cardTitle}>{v.label}</h3>
              </div>
              <p style={cardDesc}>{v.description}</p>
              <div style={cardActions}>
                <button onClick={() => fireOne(v)} style={btnPlay}>▶ 1회</button>
                <button onClick={() => fireRapid(v, 5, 60)} style={btnRapid}>×5 (60ms)</button>
                <button onClick={() => fireRapid(v, 10, 30)} style={btnChain}>×10 (30ms · 체인)</button>
              </div>
            </div>
          ))}
        </div>

        <footer style={foot}>
          마음에 드는 후보 ID를 말씀해 주시면 <code style={code}>gameSounds.ts</code>에 적용해 드립니다.
        </footer>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.94)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 10000, padding: 20, overflow: 'auto',
};
const panel: CSSProperties = {
  background: 'linear-gradient(180deg, #0f172a, #1e293b)',
  border: '1px solid #334155', borderRadius: 12, padding: 24,
  maxWidth: 1100, width: '100%', maxHeight: '92vh', overflow: 'auto',
  fontFamily: 'system-ui, sans-serif',
};
const head: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  marginBottom: 16, gap: 16,
};
const title: CSSProperties = { margin: 0, fontSize: 22, color: '#e2e8f0' };
const subtitle: CSSProperties = { margin: '4px 0 0', fontSize: 12, color: '#94a3b8' };
const btnPrimary: CSSProperties = {
  padding: '10px 18px', background: 'linear-gradient(180deg, #2563eb, #1d4ed8)',
  color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(37, 99, 235, 0.4)', whiteSpace: 'nowrap',
};
const controls: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
  padding: 12, background: '#020617', borderRadius: 8,
  marginBottom: 16, border: '1px solid #1e293b',
};
const filterGroup: CSSProperties = { display: 'flex', gap: 6 };
const btnFilter: CSSProperties = {
  padding: '6px 12px', background: '#1e293b', color: '#94a3b8',
  border: '1px solid #334155', borderRadius: 6,
  fontSize: 12, cursor: 'pointer',
};
const btnFilterActive: CSSProperties = {
  background: '#475569', color: '#f1f5f9', borderColor: '#64748b',
};
const vol: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 12, color: '#94a3b8', marginLeft: 'auto',
};
const btnDanger: CSSProperties = {
  padding: '6px 12px', background: '#7f1d1d', color: '#fee2e2',
  border: '1px solid #991b1b', borderRadius: 6,
  fontSize: 12, cursor: 'pointer',
};
const grid: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 12,
};
const card: CSSProperties = {
  background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 14,
  transition: 'border-color 0.18s, box-shadow 0.18s',
};
const cardActive: CSSProperties = {
  borderColor: '#3b82f6', boxShadow: '0 0 0 1px #3b82f6',
};
const cardHead: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
};
const cardTitle: CSSProperties = { margin: 0, fontSize: 14, color: '#f1f5f9' };
const cardDesc: CSSProperties = {
  fontSize: 11, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.4,
};
const cardActions: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' };
const btnPlay: CSSProperties = {
  padding: '6px 10px', background: '#1e40af', color: '#dbeafe',
  border: 'none', borderRadius: 5, fontSize: 11, cursor: 'pointer', fontWeight: 600,
};
const btnRapid: CSSProperties = {
  padding: '6px 10px', background: '#5b21b6', color: '#ede9fe',
  border: 'none', borderRadius: 5, fontSize: 11, cursor: 'pointer',
};
const btnChain: CSSProperties = {
  padding: '6px 10px', background: '#7e22ce', color: '#f3e8ff',
  border: 'none', borderRadius: 5, fontSize: 11, cursor: 'pointer',
};
function kindTag(k: 'hit' | 'kill'): CSSProperties {
  return {
    fontSize: 10, padding: '2px 8px', borderRadius: 999,
    background: k === 'hit' ? '#1e3a8a' : '#7c2d12',
    color: k === 'hit' ? '#bfdbfe' : '#fed7aa',
    fontWeight: 600,
  };
}
const foot: CSSProperties = {
  marginTop: 16, paddingTop: 12, borderTop: '1px solid #1e293b',
  fontSize: 11, color: '#64748b', textAlign: 'center',
};
const code: CSSProperties = {
  background: '#020617', padding: '1px 6px', borderRadius: 3,
  color: '#cbd5e1', fontSize: 11,
};
