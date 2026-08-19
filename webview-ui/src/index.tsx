import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WebviewErrorBoundary } from './WebviewErrorBoundary';
import { webviewDiagnostics } from './WebviewDiagnostics';

const container = document.getElementById('app');
if (!container) throw new Error('Root #app element not found');

webviewDiagnostics.start();

createRoot(container).render(
  <React.StrictMode>
    <WebviewErrorBoundary>
      <App />
    </WebviewErrorBoundary>
  </React.StrictMode>,
);
