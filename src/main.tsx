import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const base = import.meta.env.BASE_URL
  void navigator.serviceWorker.register(`${base}sw.js`, { scope: base })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
