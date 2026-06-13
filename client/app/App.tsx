import { Route, Routes } from 'react-router-dom';
import { Header } from './components/Header';
import { AppProvider, useAppContext } from './providers/AppContext';
import { ThemeProvider } from './providers/ThemeContext';
import { ToastProvider } from './providers/ToastContext';
import { StockPage } from '../pages/trading/StockPage';
import './App.css';

function AppShell() {
  const { bootstrapError } = useAppContext();

  return (
    <div className="app">
      <Header />

      {bootstrapError && <div className="banner error">{bootstrapError}</div>}

      <Routes>
        <Route path="/" element={<StockPage />} />
        <Route path="/portfolio" element={<StockPage />} />
        <Route path="/stock/:symbol" element={<StockPage />} />
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
