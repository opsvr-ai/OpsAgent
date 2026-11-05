import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { applyTheme, resolveTheme } from './theme/resolve.js';
import './styles.css';

applyTheme(resolveTheme('light'));

interface BoundaryState {
  readonly error: Error | null;
}

class AppErrorBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app" style={{ padding: 32 }}>
        <div className="card" style={{ maxWidth: 720, margin: '48px auto' }}>
          <div className="card-body stack">
            <div className="eyebrow">OpsAgent</div>
            <h1>页面加载出现异常</h1>
            <p className="muted">{this.state.error.message}</p>
            <div className="row-sm">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                重新加载
              </button>
              <button type="button" className="btn btn-outline" onClick={() => this.setState({ error: null })}>
                返回
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
