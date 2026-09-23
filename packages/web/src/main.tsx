import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './store/theme';
import App from './App';
import { EmbedApp } from './features/embed/EmbedApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {location.pathname.startsWith('/embed/') ? <EmbedApp /> : <App />}
  </React.StrictMode>,
);
