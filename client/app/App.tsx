import { Route, Routes } from 'react-router-dom';
import { DesktopNav } from '../widgets/DesktopNav';
import { Header } from '../widgets/Header';
import { PwaUpdatePrompt } from '../widgets/PwaUpdatePrompt';
import { AppProvider, useAppContext } from './providers/AppContext';
import { ThemeProvider } from './providers/ThemeContext';
import { ToastProvider } from './providers/ToastContext';
import { StockPage } from '../pages/trading/StockPage';
import { BacktestPage } from '../pages/backtest/BacktestPage';
import { ServerAiPage } from '../pages/server-ai/ServerAiPage';
import './App.css';

function AppShell() {
  const { bootstrapError } = useAppContext();

  return (
    <div className="app">
      <PwaUpdatePrompt />
      <Header />

      {bootstrapError && <div className="banner error">{bootstrapError}</div>}

      <Routes>
        <Route path="/" element={<StockPage />} />
        <Route path="/portfolio" element={<StockPage />} />
        <Route path="/stock/:symbol" element={<StockPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/server-ai" element={<ServerAiPage />} />
      </Routes>

      {/* 데스크톱 전용 플로팅 하단 내비게이션(모바일은 CSS 로 숨김 — MobileTabBar 사용) */}
      <DesktopNav />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppProvider>
          <AppShell />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
