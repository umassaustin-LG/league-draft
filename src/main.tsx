import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { ViewProvider, ViewMode } from './contexts/ViewContext'
import { AuthProvider } from './contexts/AuthContext'
import { initTelemetry } from './telemetry'

initTelemetry();

// Check URL parameter for view mode
const urlParams = new URLSearchParams(window.location.search);
const viewMode: ViewMode = urlParams.get('view') === 'public' ? 'public' : 'admin';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <ViewProvider mode={viewMode}>
        <App />
      </ViewProvider>
    </AuthProvider>
  </React.StrictMode>,
)
