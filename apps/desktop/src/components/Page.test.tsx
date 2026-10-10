import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Page, PlainPage } from './Page.tsx';

describe('Page', () => {
  it('renders the header outside the body so it cannot scroll with it', () => {
    render(<Page header={<span>Title</span>}><p>content</p></Page>);

    const header = screen.getByTestId('page-header');
    const body = screen.getByTestId('page-body');
    expect(header).toContainElement(screen.getByText('Title'));
    expect(body).toContainElement(screen.getByText('content'));
    expect(header).not.toContainElement(body);
    expect(body).not.toContainElement(header);
    expect(header.nextElementSibling).toBe(body);
  });

  it('fills the available height and pins a distinct, bordered header', () => {
    render(<Page header="Title">x</Page>);

    expect(screen.getByTestId('page')).toHaveStyle({ display: 'flex', flexDirection: 'column', height: '100%' });
    const header = screen.getByTestId('page-header');
    expect(header).toHaveStyle({ flexShrink: '0' });
    // Compared as strings: jsdom lower-cases custom-property names in computed styles.
    expect(header.style.background.toLowerCase()).toBe('var(--colorneutralbackground2)');
    expect(header.style.borderBottom.toLowerCase()).toBe('1px solid var(--colorneutralstroke2)');
    expect(header.style.position).not.toBe('sticky');
  });

  it('makes the body the scroll container by default', () => {
    render(<Page header="Title">x</Page>);

    expect(screen.getByTestId('page-body')).toHaveStyle({ flex: '1', overflow: 'auto', padding: '16px' });
  });

  it('lets a fill body lay out its own scrollers without scrolling itself', () => {
    render(<Page header="Title" body="fill">x</Page>);

    const body = screen.getByTestId('page-body');
    expect(body).toHaveStyle({ flex: '1', display: 'flex', flexDirection: 'column', padding: '16px' });
    expect(body).not.toHaveStyle({ overflow: 'auto' });
  });
});

describe('PlainPage', () => {
  it('scrolls its own overflow with the standard padding', () => {
    const { container } = render(<PlainPage>x</PlainPage>);

    expect(container.firstElementChild).toHaveStyle({ flex: '1', overflow: 'auto', padding: '16px' });
  });
});
