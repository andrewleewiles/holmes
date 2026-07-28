import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The desktop's types are the contract. Importing them directly means a
      // change to ElectronAPI breaks this build instead of drifting silently.
      '@shared': resolve(here, '../src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  server: {
    host: true,
    port: 5183,
  },
})
