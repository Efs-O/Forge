import { describe, expect, it } from 'vitest';
import { orderOpenItems } from '../../webview-ui/src/openItemOrder';

describe('open session panel order', () => {
  it('holds captured order, prepends later tabs, and drops closed tabs', () => {
    const capturedOrder = ['first', 'second'];
    const updatedByActivity = [{ id: 'second' }, { id: 'first' }];

    expect(orderOpenItems(updatedByActivity, capturedOrder).map((item) => item.id)).toEqual([
      'first',
      'second',
    ]);

    const withNewTab = orderOpenItems(
      [{ id: 'later' }, { id: 'second' }, { id: 'first' }],
      capturedOrder,
    );
    expect(withNewTab.map((item) => item.id)).toEqual(['later', 'first', 'second']);

    const nextSnapshot = withNewTab.map((item) => item.id);
    expect(orderOpenItems([{ id: 'later' }, { id: 'first' }], nextSnapshot).map((item) => item.id))
      .toEqual(['later', 'first']);
  });
});
