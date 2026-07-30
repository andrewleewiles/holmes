import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'
import { boilFontsReady } from './boil/boilFonts'

// Ask for all ten faces of the display type at once, before the first paint,
// rather than letting the boil animation request them one keyframe at a time —
// see boilFonts.ts. Deliberately not awaited: the app renders immediately and
// index.css keeps the type still (and the wordmark hidden) until this lands.
void boilFontsReady()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
