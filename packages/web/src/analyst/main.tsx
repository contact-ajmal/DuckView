/**
 * The Analyst WebUI (analyst.html, served at /analyst): the agent alone — Agent Home and missions — for people who
 * work through the agent. It is a client of the same Agent API as the Console, with the same components; it has no
 * agent logic of its own, and it can be deployed on its own. Console links leave for the full DuckView console,
 * which checks access again.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '../store/theme';
import { ConfirmHost, Toaster } from '../components/ui';
import { setSurface } from '../features/agent/surface';
import { AnalystApp } from './AnalystApp';

setSurface('analyst');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AnalystApp />
    <Toaster />
    <ConfirmHost />
  </React.StrictMode>,
);
