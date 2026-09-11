/**
 * Whether the app is currently rendering dark. Extracted from App.tsx so
 * anything that has to match the theme by value rather than by CSS token —
 * mermaid, which renders an SVG with baked-in colours — can read the same
 * answer the FluentProvider does.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store.ts';

/** jsdom (vitest) doesn't implement matchMedia, so this degrades to light mode there. */
function usePrefersDarkMode(): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [prefersDark, setPrefersDark] = useState(
    () => supported && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (!supported) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setPrefersDark(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [supported]);

  return prefersDark;
}

export function useDarkTheme(): boolean {
  const prefersDark = usePrefersDarkMode();
  const themePref = useAppStore(state => state.appState?.theme ?? 'system');
  return themePref === 'system' ? prefersDark : themePref === 'dark';
}
