export type ThemeMode = 'light' | 'dark';
/** 사용자 선택 — 'system' 은 OS 설정을 따라간다(저장값 없음 상태). */
export type ThemePreference = 'system' | ThemeMode;

const STORAGE_KEY = 'toss-trading:theme';

export function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getStoredTheme(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // ignore storage read errors
  }

  return null;
}

export function getInitialTheme(): ThemeMode {
  return getStoredTheme() ?? getSystemTheme();
}

export function getStoredThemePreference(): ThemePreference {
  return getStoredTheme() ?? 'system';
}

export function setStoredThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') {
      localStorage.removeItem(STORAGE_KEY); // 저장값 없음 = 시스템 추종
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // ignore storage write errors
  }
}

export function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme);
}
