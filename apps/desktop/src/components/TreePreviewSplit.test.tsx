import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TreePreviewSplit } from './TreePreviewSplit.tsx';

function split(hasSelection: boolean, onBack = vi.fn()) {
  render(
    <TreePreviewSplit
      tree={<div>the tree</div>}
      preview={<div>the preview</div>}
      hasSelection={hasSelection}
      onBack={onBack}
      storageKey="test.treeWidth"
    />,
  );
  return onBack;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TreePreviewSplit', () => {
  it('wide: renders the tree and the preview side by side behind a resize separator', () => {
    split(false);
    expect(screen.getByText('the tree')).toBeInTheDocument();
    expect(screen.getByText('the preview')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to files' })).not.toBeInTheDocument();
  });

  describe('narrow', () => {
    const narrow = () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));

    it('shows only the tree until something is selected', () => {
      narrow();
      split(false);
      expect(screen.getByText('the tree')).toBeInTheDocument();
      expect(screen.queryByText('the preview')).not.toBeInTheDocument();
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });

    it('shows only the preview under Back to files once a file is selected', () => {
      narrow();
      const onBack = split(true);
      expect(screen.queryByText('the tree')).not.toBeInTheDocument();
      expect(screen.getByText('the preview')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back to files' }));
      expect(onBack).toHaveBeenCalledOnce();
    });
  });
});
