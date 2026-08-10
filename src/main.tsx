import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { StoreProvider } from './app/StoreProvider.tsx'
import { FRAME_ASPECT } from './core/geometry.ts'
import './styles/global.css'
import './styles/capture.css'

/**
 * The frame's aspect ratio has exactly one definition, and it is the one the
 * capture maths uses. The stylesheet carries a fallback for the pre-hydration
 * frame, but this assignment is what the layout actually runs on — otherwise a
 * future edit could change the CSS alone and silently give the preview and the
 * saved photo different crops, which is the one bug this app exists to prevent.
 */
document.documentElement.style.setProperty('--frame-aspect', String(FRAME_ASPECT))

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <div className="shell">
      <div className="shell__inner">
        <StoreProvider>
          <App />
        </StoreProvider>
      </div>
    </div>
  </StrictMode>,
)
