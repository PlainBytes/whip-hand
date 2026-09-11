import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

describe('markdown links', () => {
  it('follows a resolvable relative link in-app', () => {
    const onNavigate = vi.fn();
    const resolve = vi.fn().mockReturnValue({ path: '/ws/review.md', kind: 'link' });
    render(<Markdown text="[review](./review.md)" resolve={resolve} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('link', { name: 'review' }));
    expect(resolve).toHaveBeenCalledWith('./review.md');
    expect(onNavigate).toHaveBeenCalledWith('/ws/review.md');
  });

  it('never lets a link navigate the webview itself', () => {
    // A real navigation would replace the whole app with the target file.
    const onNavigate = vi.fn();
    render(
      <Markdown
        text="[review](./review.md)"
        resolve={() => ({ path: '/ws/review.md', kind: 'link' })}
        onNavigate={onNavigate}
      />,
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByRole('link', { name: 'review' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('never lets a middle-click auxclick navigate the webview itself', () => {
    // auxclick (middle-click) fires instead of click and React's onClick
    // never sees it, so the anchor's default new-window behaviour would
    // otherwise go unchecked.
    const onNavigate = vi.fn();
    render(
      <Markdown
        text="[review](./review.md)"
        resolve={() => ({ path: '/ws/review.md', kind: 'link' })}
        onNavigate={onNavigate}
      />,
    );
    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true });
    screen.getByRole('link', { name: 'review' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens an external link in the system browser', () => {
    const openExternal = vi.fn();
    render(<Markdown text="[rfc](https://example.com/x)" openExternal={openExternal} />);
    fireEvent.click(screen.getByRole('link', { name: /rfc/ }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  it('marks an unresolvable target inert instead of offering a dead link', () => {
    render(<Markdown text="[gone](./missing.md)" resolve={() => null} onNavigate={vi.fn()} />);
    const link = screen.getByText('gone');
    expect(link).toHaveAttribute('data-inert', 'true');
    expect(link).not.toHaveAttribute('href');
  });

  it('is inert when the consumer offers no capabilities at all', () => {
    render(<Markdown text="[review](./review.md) and [rfc](https://example.com)" />);
    expect(screen.getByText('review')).toHaveAttribute('data-inert', 'true');
    expect(screen.getByText('rfc')).toHaveAttribute('data-inert', 'true');
  });

  it('renders a scheme the app cannot open as inert, not as a live external link', () => {
    // rehype-sanitize's defaultSchema allows irc/ircs/xmpp on href, and so
    // does react-markdown's urlTransform — but Tauri's shell scope is
    // roughly http/https/mailto/tel, so opening one rejects inside the
    // plugin. A link that cannot be followed must not look like one.
    const openExternal = vi.fn();
    render(<Markdown text="[chat](xmpp:room@example.com)" openExternal={openExternal} />);
    const chat = screen.getByText('chat');
    expect(chat).toHaveAttribute('data-inert', 'true');
    expect(chat).not.toHaveAttribute('href');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(chat);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('still opens the schemes the app can open', () => {
    // The other half: narrowing the protocol list must not take mailto with
    // it, or the test above would pass on a renderer that offers nothing.
    const openExternal = vi.fn();
    render(<Markdown text="[mail](mailto:someone@example.com)" openExternal={openExternal} />);
    fireEvent.click(screen.getByRole('link', { name: /mail/ }));
    expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com');
  });

  it('leaves an in-page fragment as a real anchor', () => {
    render(<Markdown text={'## Approach\n\n[jump](#approach)'} resolve={() => null} onNavigate={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'jump' })).toHaveAttribute('href', '#approach');
  });
});
