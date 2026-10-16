import { useEffect, useSyncExternalStore } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

// Keep in sync with the inline script in index.html, which applies the theme before the first paint.
const KEY = 'nx.theme';
/** Sign-in and public pages keep their light, branded look whatever the theme. */
const LIGHT_ONLY = ['/login', '/register', '/forgot-password', '/reset-password', '/accept-invite', '/f/', '/submit-feedback', '/track'];

const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
let forcedLight = 0;

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply() {
  const choice = getThemeChoice();
  const dark = !forcedLight && (choice === 'dark' || (choice === 'system' && media().matches));
  document.documentElement.classList.toggle('dark', dark);
  listeners.forEach((l) => l());
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* private mode: applies for this visit only */ }
  apply();
}

/** Start following the stored choice and the OS setting. Call once at startup. */
export function initTheme() {
  if (LIGHT_ONLY.some((p) => window.location.pathname.startsWith(p))) forcedLight = 1;
  media().addEventListener('change', apply);
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); }); // changed in another tab
  apply();
  // Once React has mounted, ForceLightTheme decides; the path check above only covers the first paint.
  forcedLight = 0;
}

export function useThemeChoice() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, getThemeChoice);
}

/** Whether dark mode is showing right now (the resolved theme, not the stored choice). */
export function useIsDark() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => document.documentElement.classList.contains('dark'));
}

/** Keeps the page light while mounted (sign-in and public pages). */
export function ForceLightTheme() {
  useEffect(() => {
    forcedLight++;
    apply();
    return () => { forcedLight--; apply(); };
  }, []);
  return null;
}
