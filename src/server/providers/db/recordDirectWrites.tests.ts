import { describe, expect, it, vi } from 'vitest';
import type { Logger, Record } from '@anupheaus/common';
import type { MongoDocOf } from '../../../common';
import type { ServerDbCollection } from './ServerDbCollection';
import { dbUtils } from './db-transforms';
import { recordDirectWrites } from './recordDirectWrites';

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), silly: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

const makeCollection = (recordDirectWritesImpl: (ids: string[]) => Promise<void> = async () => undefined) =>
  ({ name: 'fits', recordDirectWrites: vi.fn(recordDirectWritesImpl) }) as unknown as ServerDbCollection & { recordDirectWrites: ReturnType<typeof vi.fn> };

const fit = (id: string, status: string): Record => ({ id, status }) as Record;

describe('recordDirectWrites (sc-5449)', () => {
  it('asks the collection to record only the documents written without mxdb', async () => {
    const collection = makeCollection();
    const byMxdb = await dbUtils.serializeWithMeta(fit('fit-1', 'booked'));
    const byHand = { ...await dbUtils.serializeWithMeta(fit('fit-2', 'booked')), status: 'cancelled' };
    const metaRemoved = dbUtils.serialize(fit('fit-3', 'cancelled'));

    await recordDirectWrites({ collection, documents: [byMxdb, byHand, metaRemoved] as MongoDocOf<Record>[], logger: makeLogger() });

    expect(collection.recordDirectWrites.mock.calls).toEqual([[['fit-2', 'fit-3']]]);
  });

  it('logs a failure and never throws into the change stream', async () => {
    const collection = makeCollection(async () => { throw new Error('audit collection unavailable'); });
    const logger = makeLogger();

    await expect(recordDirectWrites({ collection, documents: [dbUtils.serialize(fit('fit-1', 'cancelled'))] as MongoDocOf<Record>[], logger })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith('[ServerDb] could not record a change written without mxdb', { collectionName: 'fits', error: 'audit collection unavailable' });
  });
});
