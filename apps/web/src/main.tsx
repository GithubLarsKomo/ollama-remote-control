import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import HelpCenter from './help/HelpCenter.js';
import './styles.css';
import './models-navigation.css';
import './accessibility-responsive.css';
import './impeccable-polish.css';

const root = document.getElementById('root');
if (!root) throw new Error('Web application root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
    <HelpCenter />
  </StrictMode>,
);