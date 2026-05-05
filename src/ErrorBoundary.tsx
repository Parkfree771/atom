import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#0F172A',
          color: '#F1F5F9',
          fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚛</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
            게임을 불러오는 중 문제가 발생했습니다
          </h1>
          <p style={{ fontSize: 14, color: '#94A3B8', marginBottom: 20, maxWidth: 480 }}>
            브라우저가 WebGL 또는 오디오를 지원하지 않거나, 일시적인 오류가 발생했을 수 있습니다.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px',
              fontSize: 14,
              fontWeight: 700,
              background: '#FFFFFF',
              color: '#0F172A',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            새로고침
          </button>
          {import.meta.env.DEV && (
            <pre style={{
              marginTop: 24,
              fontSize: 11,
              color: '#FCA5A5',
              maxWidth: 720,
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            }}>
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
