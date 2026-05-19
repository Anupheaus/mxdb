import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSubscriptionDataKeys,
  subscriptionDataGet,
  subscriptionDataIsAvailable,
  subscriptionDataSet,
} from './subscriptionDataStore';

// All subscription IDs used anywhere in this suite — cleared before each test
// so no test can bleed state into another.
const allTestIds = ['sub-a', 'sub-b', 'sub-x', 's1', 'never-set-key'] as const;

describe('subscriptionDataStore', () => {
  beforeEach(() => {
    for (const id of allTestIds) {
      clearSubscriptionDataKeys(id);
    }
  });

  it('reports data store as available', () => {
    expect(subscriptionDataIsAvailable()).toBe(true);
  });

  it('round-trips values by key', () => {
    subscriptionDataSet('subscription-data.sub-x', 42);
    expect(subscriptionDataGet<number>('subscription-data.sub-x')).toBe(42);
  });

  it('clearSubscriptionDataKeys removes both standard keys for an id', () => {
    subscriptionDataSet('subscription-data.s1', 'prev');
    subscriptionDataSet('subscription-data.additional.s1', ['a', 'b']);
    clearSubscriptionDataKeys('s1');
    expect(subscriptionDataGet('subscription-data.s1')).toBeUndefined();
    expect(subscriptionDataGet('subscription-data.additional.s1')).toBeUndefined();
  });

  it('returns undefined for a key that was never set', () => {
    expect(subscriptionDataGet('subscription-data.never-set-key')).toBeUndefined();
  });
});
