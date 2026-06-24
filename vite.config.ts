import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // .env 의 PORT 를 그대로 따라가 BFF 프록시 타깃과 서버 포트가 어긋나지 않게 한다.
  const env = loadEnv(mode, process.cwd(), '');
  const bffPort = env.PORT ?? '3001';
  return {
    plugins: [
      react(),
      VitePWA({
        // 새 배포 감지 시 '업데이트' 배너를 띄워 사용자가 적용·리로드하도록 한다(조용한 자동갱신 X).
        registerType: 'prompt',
        // 등록을 PwaUpdatePrompt(useRegisterSW) 에서 처리(앱 복귀 시 업데이트 체크 포함) → 자동 주입 비활성
        injectRegister: false,
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Toss Trading',
          short_name: 'Toss Trading',
          description: 'Toss 증권 Open API 기반 개인용 미국 주식 트레이딩',
          lang: 'ko',
          // scope/start_url 을 '/' 로 고정 → standalone 에서 /stock/* 등 내부 이동 시
          // iOS 가 in-app 브라우저(상단 X·하단 공유바)를 띄우지 않는다.
          id: '/',
          scope: '/',
          start_url: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#0a0a0a',
          background_color: '#0a0a0a',
          icons: [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/pwa-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
          // 앱 셸(빌드 정적 자산)만 프리캐시. /api 는 절대 캐시하지 않고 항상 네트워크로.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          // vendor 라이브러리를 별도 청크로 분리.
          // 앱 코드는 배포마다 바뀌지만 vendor 는 거의 안 바뀌므로
          // 장기 캐시되어 PWA 업데이트/재방문 시 앱 청크만 다시 받는다.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('lightweight-charts')) return 'charts';
            if (
              id.includes('/react-router') ||
              id.includes('/react-dom/') ||
              id.includes('/react/') ||
              id.includes('/scheduler/')
            ) {
              return 'react-vendor';
            }
            return 'vendor';
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': `http://localhost:${bffPort}`,
      },
    },
  };
});
