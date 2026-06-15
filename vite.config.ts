import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // .env 의 PORT 를 그대로 따라가 BFF 프록시 타깃과 서버 포트가 어긋나지 않게 한다.
  const env = loadEnv(mode, process.cwd(), '');
  const bffPort = env.PORT ?? '3001';
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://localhost:${bffPort}`,
      },
    },
  };
});
