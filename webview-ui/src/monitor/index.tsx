import { createRoot } from 'react-dom/client';
import { App } from './App';

const app = document.getElementById('app');
if (!app) throw new Error('Root #app element not found');
createRoot(app).render(<App />);
