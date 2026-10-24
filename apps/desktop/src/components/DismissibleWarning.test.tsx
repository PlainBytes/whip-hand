import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DismissibleWarning } from './DismissibleWarning.tsx';

function renderWarning(props: { dismissKey: string; persist?: boolean }) {
  const ui = (key: string) => (
    <FluentProvider theme={webLightTheme}>
      <DismissibleWarning dismissKey={key} persist={props.persist}>Careful</DismissibleWarning>
    </FluentProvider>
  );
  const result = render(ui(props.dismissKey));
  return { ...result, rerenderWithKey: (key: string) => result.rerender(ui(key)) };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DismissibleWarning', () => {
  it('hides on dismiss and comes back when its key changes', () => {
    const { rerenderWithKey } = renderWarning({ dismissKey: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Careful')).not.toBeInTheDocument();

    rerenderWithKey('b');
    expect(screen.getByText('Careful')).toBeInTheDocument();
  });

  it('comes back on remount unless persisted — a recurring condition shows it again', () => {
    const first = renderWarning({ dismissKey: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    first.unmount();
    renderWarning({ dismissKey: 'a' });
    expect(screen.getByText('Careful')).toBeInTheDocument();
  });

  it('stays dismissed across remounts when persisted', () => {
    const first = renderWarning({ dismissKey: 'static-note', persist: true });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    first.unmount();
    renderWarning({ dismissKey: 'static-note', persist: true });
    expect(screen.queryByText('Careful')).not.toBeInTheDocument();
  });

  it('still renders and dismisses when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    renderWarning({ dismissKey: 'static-note', persist: true });
    expect(screen.getByText('Careful')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Careful')).not.toBeInTheDocument();
  });
});

/**
 * Every warning bar must be dismissible, so a raw warning MessageBar anywhere
 * else fails here. The exceptions are not really warnings to wave away: the
 * PDF password bar is the viewer's whole content, and the rotate-token bar is
 * a confirm prompt with its own Cancel.
 */
describe('warning bars across the app', () => {
  const ALLOWED: Record<string, number> = {
    'DismissibleWarning.tsx': 1,
    'PdfView.tsx': 1,
    'RemoteAccessCard.tsx': 1,
  };

  it('all go through DismissibleWarning', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true });
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.tsx')) continue;
      const hits = source.match(/<MessageBar\b[^>]*?\bintent=(?:"warning"|\{[^}]*'warning')/g)?.length ?? 0;
      const allowed = ALLOWED[path.split('/').pop()!] ?? 0;
      if (hits > allowed) offenders.push(`${path} (${hits} warning bars, ${allowed} allowed)`);
    }
    expect(offenders).toEqual([]);
  });
});
