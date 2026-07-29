import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  applyTheme,
  getStoredThemePreference,
  getSystemTheme,
  setStoredThemePreference,
  type ThemeMode,
  type ThemePreference,
} from '../../shared/lib/themePreference';

interface ThemeContextValue {
  /** 실제 적용되는 테마(시스템 선택 시 OS 값으로 해석됨). */
  theme: ThemeMode;
  /** 사용자 선택 — system | dark | light. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** 헤더 토글용 — 현재 적용 테마의 반대(명시적 light/dark)로 전환. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredThemePreference);
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(getSystemTheme);

  const theme = preference === 'system' ? systemTheme : preference;

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setStoredThemePreference(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === 'dark' ? 'light' : 'dark');
  }, [setPreference, theme]);

  // data-theme 속성은 렌더 중에 적용한다(멱등이라 안전).
  // useEffect 로 적용하면 자식 이펙트(차트 색상 재적용 등)가 부모 이펙트보다 먼저 실행돼
  // 이전 테마의 CSS 변수를 읽는다 — 다크→라이트 전환 시 차트 격자가 흰색으로 남아
  // 보이지 않던 문제의 원인.
  useMemo(() => applyTheme(theme), [theme]);

  // OS 테마 변경 추적 — preference 가 system 일 때 theme 이 따라 바뀐다.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setPreference,
      toggleTheme,
    }),
    [theme, preference, setPreference, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
