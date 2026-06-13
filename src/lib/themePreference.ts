export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'toss-trading:theme'

export function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function getStoredTheme(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') {
      return stored
    }
  } catch {
    // ignore storage read errors
  }

  return null
}

export function getInitialTheme(): ThemeMode {
  return getStoredTheme() ?? getSystemTheme()
}

export function setStoredTheme(theme: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // ignore storage write errors
  }
}

export function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme)
}