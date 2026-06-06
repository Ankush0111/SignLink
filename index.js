// 1. All imports must reside strictly at the absolute top of the module
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Buffer } from 'buffer';
import process from 'process';
import App from './App';

// 2. Inject global polyfills immediately after imports, prior to mounting the React application shell
window.global = window;
window.process = process;
window.Buffer = Buffer;

// 3. Render the application safely
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);