import { forwardRef } from 'react';
import { Button, makeStyles, mergeClasses, tokens, type ButtonProps } from '@fluentui/react-components';

export type DangerButtonProps = ButtonProps & {
  /** `filled` for page-header and confirm-dialog actions; `subtle` for list rows and icon-only buttons. */
  variant?: 'filled' | 'subtle';
};

const useStyles = makeStyles({
  filled: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
    ':hover': {
      backgroundColor: tokens.colorStatusDangerBackground3Hover,
      color: tokens.colorNeutralForegroundOnBrand,
    },
    ':hover:active': {
      backgroundColor: tokens.colorStatusDangerBackground3Pressed,
      color: tokens.colorNeutralForegroundOnBrand,
    },
    ':disabled': {
      backgroundColor: tokens.colorNeutralBackgroundDisabled,
      color: tokens.colorNeutralForegroundDisabled,
    },
  },
  subtle: {
    color: tokens.colorPaletteRedForeground1,
    ':hover': { color: tokens.colorPaletteRedForeground1 },
    ':hover:active': { color: tokens.colorPaletteRedForeground1 },
    ':disabled': { color: tokens.colorNeutralForegroundDisabled },
  },
  // Fluent colours the icon slot through its own selector, so it needs the same colour.
  filledIcon: {
    '& .fui-Button__icon': { color: 'inherit' },
  },
});

/**
 * A Button for destructive actions (Delete and the like), red so it never
 * reads as a neutral choice. Takes every Button prop and forwards them.
 */
export const DangerButton = forwardRef<HTMLButtonElement, DangerButtonProps>(
  function DangerButton({ variant = 'filled', className, appearance, ...rest }, ref) {
    const styles = useStyles();
    return (
      <Button
        ref={ref}
        appearance={appearance ?? (variant === 'filled' ? 'primary' : 'subtle')}
        className={mergeClasses(variant === 'filled' ? styles.filled : styles.subtle, styles.filledIcon, className)}
        {...rest}
      />
    );
  },
);
