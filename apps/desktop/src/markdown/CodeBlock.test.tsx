import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

function renderFence(markdown: string) {
  return render(<Markdown text={markdown} />);
}

describe('code blocks', () => {
  it('highlights a fenced block by its language', () => {
    const { container } = renderFence('```ts\nconst x = 1;\n```');
    const code = container.querySelector('code.hljs');
    expect(code?.textContent).toBe('const x = 1;\n');
    // highlight.js splits tokens into spans; unhighlighted text would have none.
    expect(code?.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('labels the block with its language', () => {
    renderFence('```python\nx = 1\n```');
    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('renders an unlabelled fence as plain escaped text', () => {
    const { container } = renderFence('```\n<not-html>\n```');
    expect(container.querySelector('code')?.textContent).toBe('<not-html>\n');
    expect(container.querySelector('not-html')).toBeNull();
  });

  it('leaves inline code alone', () => {
    const { container } = renderFence('use `npm test` here');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('npm test');
  });

  it('does not leak react-markdown\'s internal node prop onto the DOM', () => {
    const { container } = renderFence('use `npm test` here');
    expect(container.querySelector('code')?.hasAttribute('node')).toBe(false);
  });

  it('copies the block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderFence('```sh\nnpm test\n```');
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test\n'));
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of claiming success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    renderFence('```sh\nnpm test\n```');
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(await screen.findByRole('button', { name: /copy failed/i })).toBeInTheDocument();
  });
});
