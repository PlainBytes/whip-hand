import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DangerButton } from './DangerButton.tsx';
import { hasInjectedStyle } from '../test/badge-style.ts';

describe('DangerButton', () => {
  it('renders and forwards onClick and aria-label', () => {
    const onClick = vi.fn();
    render(<DangerButton aria-label="Delete thing" onClick={onClick}>Delete</DangerButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Delete thing' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards disabled', () => {
    const onClick = vi.fn();
    render(<DangerButton disabled onClick={onClick}>Delete</DangerButton>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('filled is a red fill with white text', () => {
    render(<DangerButton variant="filled">Delete</DangerButton>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(hasInjectedStyle(button, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(true);
    expect(hasInjectedStyle(button, 'color', 'var(--colorNeutralForegroundOnBrand)')).toBe(true);
  });

  it('subtle has red text and no red fill', () => {
    render(<DangerButton variant="subtle">Delete</DangerButton>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(hasInjectedStyle(button, 'color', 'var(--colorPaletteRedForeground1)')).toBe(true);
    expect(hasInjectedStyle(button, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(false);
  });
});
