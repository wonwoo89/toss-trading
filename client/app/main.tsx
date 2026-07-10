import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { applyTheme, getInitialTheme } from '../shared/lib/themePreference';
import { setIndicatorBackend } from '../shared/lib/indicatorBackend';
import {
  atrFromCandlesWasm,
  bollingerWindowsWasm,
  initIndicatorsWasm,
} from '../shared/lib/wasm/indicators';
import './styles/theme.css';
import './index.css';
import App from './App.tsx';

applyTheme(getInitialTheme());

// WASM 지표 커널(Bollinger·ATR) 등록 — 차트 오버레이·백테스트·AI 판단 페이로드가 사용.
// init 완료 전에는 래퍼가 null 을 돌려줘 JS 로 폴백하므로 기다리지 않고 등록한다.
setIndicatorBackend({
  bollingerWindows: bollingerWindowsWasm,
  atrFromCandles: atrFromCandlesWasm,
});
void initIndicatorsWasm();

// PWA 서비스워커 등록 + 새 배포 업데이트 배너는 <PwaUpdatePrompt /> (useRegisterSW) 에서 처리한다.

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
