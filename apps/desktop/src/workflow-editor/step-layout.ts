/**
 * An expanded step card's body layout: the prose column takes every spare
 * pixel, and the rail beside it goes to two columns once the card is wide
 * enough to keep a usable prompt next to both.
 *
 * The switch is a container query on the card body, not a media query on the
 * window: a loop's body steps are indented per depth, and the app's sidebar
 * takes width too, so the card's own width is the one that matters. Inline
 * styles can't express a container query, which is the only reason these
 * rules live in a class rather than beside the rest of the card's styles.
 */
import { makeStyles } from '@fluentui/react-components';

/** Each rail column's width; surplus goes to the prose, not to wider fields. */
const RAIL_COLUMN = '260px';

export const useStepLayoutStyles = makeStyles({
  body: { containerType: 'inline-size', containerName: 'step-body' },
  // Filled row by row in DOM order, so one column reads exactly as it always
  // did, and two pair up neighbours: Runner | Model, Writes | Allowed paths,
  // Verdict | Output filename. That needs every field to be its own cell.
  rail: {
    display: 'grid',
    gridTemplateColumns: RAIL_COLUMN,
    columnGap: '16px',
    rowGap: '8px',
    alignItems: 'start',
    flex: '0 0 auto',
    // A body too narrow for a 260px column beside any prose (a phone, or a
    // deeply nested loop body): one column that is never wider than the body.
    '@container step-body (max-width: 599px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
      flex: '1 1 100%',
      minWidth: 0,
    },
    // A ~480px prompt, the 16px gap, and two columns with theirs.
    '@container step-body (min-width: 1040px)': {
      gridTemplateColumns: `repeat(2, ${RAIL_COLUMN})`,
    },
  },
});
