import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Yahoo Finance proxy — bypasses browser CORS for free market data.
      // Requests to /api/yahoo/* are forwarded to query1.finance.yahoo.com/*
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; InvestmentDesk/1.0)',
        },
      },
    },
  },
});
