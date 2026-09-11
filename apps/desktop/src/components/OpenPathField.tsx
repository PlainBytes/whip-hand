import { useState } from 'react';
import { Button, Input } from '@fluentui/react-components';

/**
 * Types a workspace path in, for hosts with no native folder picker.
 *
 * Without this a browser could only ever reopen workspaces already in the
 * recents list, which is a bad first-run story on a fresh device. The path is
 * not validated here on purpose — `touchRecentWorkspace` already refuses
 * anything that is not an existing directory, and duplicating that check in
 * the UI would be a second answer to the same question.
 */
export function OpenPathField(
  { onOpen, disabled, label = 'Open' }: {
    onOpen: (path: string) => void | Promise<void>;
    disabled?: boolean;
    label?: string;
  },
) {
  const [value, setValue] = useState('');

  function submit(): void {
    const path = value.trim();
    if (!path) return;
    void onOpen(path);
    setValue('');
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <Input
        aria-label="Workspace path"
        placeholder="/path/to/workspace"
        value={value}
        disabled={disabled}
        style={{ flex: 1 }}
        onChange={(_e, data) => setValue(data.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
        }}
      />
      <Button appearance="primary" disabled={disabled || !value.trim()} onClick={submit}>
        {label}
      </Button>
    </div>
  );
}
