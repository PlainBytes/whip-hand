import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

describe('Markdown', () => {
  it('renders markdown rather than its source', () => {
    render(<Markdown text={'# Title\n\nBody text.'} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.queryByText('# Title')).not.toBeInTheDocument();
  });

  it('scopes its styles with a class so nothing else inherits them', () => {
    const { container } = render(<Markdown text="text" />);
    expect(container.querySelector('.whiphand-markdown')).not.toBeNull();
  });

  it('renders an empty document without crashing', () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector('.whiphand-markdown')).not.toBeNull();
  });

  it('takes the heading anchor out of the accessibility tree and tab order', () => {
    // Regression guard for the accessible-name collision: the anchor
    // pipeline.ts appends to every heading must not be announced (it would
    // pollute the heading's own accessible name) and must not be a tab stop
    // (aria-hidden on a focusable element is a WCAG 4.1.2 defect).
    const { container } = render(<Markdown text="## The Approach" />);
    const anchor = container.querySelector('.whiphand-markdown-anchor');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('aria-hidden', 'true');
    expect(anchor).toHaveAttribute('tabindex', '-1');
  });
});
