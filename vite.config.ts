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
        // 새 배포 시 SW 자동 갱신(우리 update.sh 흐름과 맞음)
        registerType: 'autoUpdate',
        // 등록을 main.tsx 에서 직접 처리(앱 복귀 시 업데이트 체크 추가) → 자동 주입 비활성
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
    server: {
      proxy: {
        '/api': `http://localhost:${bffPort}`,
      },
    },
  };
});
