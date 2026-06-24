import { Route, Routes } from 'react-router-dom';
import { Header } from '../widgets/Header';
import { PwaUpdatePrompt } from '../widgets/PwaUpdatePrompt';
import { AppProvider, useAppContext } from './providers/AppContext';
import { ThemeProvider } from './providers/ThemeContext';
import { ToastProvider } from './providers/ToastContext';
import { StockPage } from '../pages/trading/StockPage';
import { BacktestPage } from '../pages/backtest/BacktestPage';
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
      </Routes>
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
