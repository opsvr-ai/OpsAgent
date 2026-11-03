import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { applyTheme, resolveTheme } from './theme/resolve.js';
import './styles.css';

applyTheme(resolveTheme('light'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
