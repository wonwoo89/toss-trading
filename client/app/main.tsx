import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { applyTheme, getInitialTheme } from '../shared/lib/themePreference';
import './styles/theme.css';
import './index.css';
import App from './App.tsx';

applyTheme(getInitialTheme());

// PWA 서비스워커 등록. registerType:'autoUpdate' 라 새 SW 가 잡히면 자동 적용·새로고침된다.
// 캐시-우선이라 재실행 시 갱신이 한 박자 늦으므로, 앱이 다시 보일 때(복귀/포커스)
// 능동적으로 업데이트를 확인해 새 배포가 빠르게 반영되도록 한다.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') {
        void registration.update();
      }
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
  },
});

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
