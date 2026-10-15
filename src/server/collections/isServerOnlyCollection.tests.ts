import { describe, it, expect } from 'vitest';
import type { Record } from '@anupheaus/common';
import { defineCollection } from '../../common/defineCollection';
import type { MXDBCollection } from '../../common';
import { isServerOnlyCollection } from './isServerOnlyCollection';

const serverOnly = defineCollection<Record>({ name: 'server_only_tokens', indexes: [], syncMode: 'ServerOnly' });
const synchronised = defineCollection<Record>({ name: 'server_only_synced', indexes: [], syncMode: 'Synchronised' });
const defaulted = defineCollection<Record>({ name: 'server_only_default', indexes: [] });
const clientOnly = defineCollection<Record>({ name: 'server_only_client', indexes: [], syncMode: 'ClientOnly' });

describe('isServerOnlyCollection', () => {
  it('is true for a collection declared ServerOnly', () => {
    expect(isServerOnlyCollection(serverOnly)).toBe(true);
  });

  it('is false for a synchronised collection, declared or by default', () => {
    expect(isServerOnlyCollection(synchronised)).toBe(false);
    expect(isServerOnlyCollection(defaulted)).toBe(false);
  });

  it('is false for a client-only collection: this rule is about server-only data', () => {
    expect(isServerOnlyCollection(clientOnly)).toBe(false);
  });

  it('is false for an unknown collection, or one never defined', () => {
    expect(isServerOnlyCollection(undefined)).toBe(false);
    const undefinedCollection = { name: 'never_defined', type: null } as unknown as MXDBCollection;
    expect(isServerOnlyCollection(undefinedCollection)).toBe(false);
  });
});
