import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { WorkspaceDot } from './WorkspaceDot.tsx';

describe('WorkspaceDot', () => {
  it('renders 16px by default — big enough to read, still centred in the 20px glyph slot', () => {
    const { container } = render(<WorkspaceDot path="/repos/alpha" />);
    const dot = container.firstChild as HTMLElement;
    expect(dot.style.width).toBe('16px');
    expect(dot.style.height).toBe('16px');
  });

  it('paints one workspace one colour by its identity key, whatever path it was opened by', () => {
    const paint = (path: string) => (render(<WorkspaceDot path={path} identityKey="c:/program files/proj" />)
      .container.firstChild as HTMLElement).style.background;
    expect(paint('C:\\PROGRA~1\\Proj')).toBe(paint('C:\\Program Files\\Proj'));
  });
});
