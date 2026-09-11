import { useLayoutEffect, useRef } from 'react';
import { Textarea, type TextareaProps } from '@fluentui/react-components';

const MAX_HEIGHT_PX = 320;

/**
 * Drop-in replacement for `Input` that grows with its content up to a cap, then scrolls.
 * Sizing is done via `scrollHeight` in an effect rather than CSS `field-sizing: content`
 * because the Tauri webview on Linux (WebKitGTK) doesn't support that property.
 */
export function AutoGrowTextarea(props: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight > 0) {
      el.style.height = 'auto';
      const nextHeight = Math.min(el.scrollHeight, MAX_HEIGHT_PX);
      el.style.height = `${nextHeight}px`;
      el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
    }
  }, [props.value]);

  return (
    <Textarea
      {...props}
      rows={3}
      resize="none"
      textarea={{ ref }}
      style={{ width: '100%', ...props.style }}
    />
  );
}
