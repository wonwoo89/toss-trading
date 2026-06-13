import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { applyTheme, getInitialTheme } from "../shared/lib/themePreference';
import './styles/theme.css';
import './index.css';
import App from './App.tsx';

applyTheme(getInitialTheme());

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
