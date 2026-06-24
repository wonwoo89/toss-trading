import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { applyTheme, getInitialTheme } from '../shared/lib/themePreference';
import './styles/theme.css';
import './index.css';
import App from './App.tsx';

applyTheme(getInitialTheme());

// PWA 서비스워커 등록 + 새 배포 업데이트 배너는 <PwaUpdatePrompt /> (useRegisterSW) 에서 처리한다.

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
