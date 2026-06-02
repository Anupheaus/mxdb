import type { Db } from '../providers/dbs/Db';
import type { MXDBRemoteSqliteQueryRequest, MXDBRemoteSqliteQueryResponse } from '../../common/mcpModels';
import { classifyClientSql } from './sqlClassifier';
import type { RemoteSqlMutatingRequestInfo } from './models';

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function handleRemoteSqliteQuery(
  db: Db,
  request: MXDBRemoteSqliteQueryRequest,
  ensureMutatingAllowed: (info: RemoteSqlMutatingRequestInfo) => Promise<boolean>,
): Promise<MXDBRemoteSqliteQueryResponse> {
  const start = nowMs();
  const { isMutating } = classifyClientSql(request.sql);

  if (isMutating) {
    const allowed = await ensureMutatingAllowed({
      requestedBy: 'mcp',
      operator: request.requestedBy,
    });
    if (!allowed) {
      const end = nowMs();
      return {
        requestId: request.requestId,
        rows: [],
        elapsedMs: Math.max(0, Math.round(end - start)),
        error: { message: 'MXDB_REMOTE_MUTATING_SQL_NOT_ALLOWED' },
      };
    }

    try {
      await db.execRaw(request.sql, request.params);
      const end = nowMs();
      return {
        requestId: request.requestId,
        rows: [],
        elapsedMs: Math.max(0, Math.round(end - start)),
      };
    } catch {
      const end = nowMs();
      return {
        requestId: request.requestId,
        rows: [],
        elapsedMs: Math.max(0, Math.round(end - start)),
        error: { message: 'MXDB_REMOTE_SQL_EXEC_FAILED' },
      };
    }
  }

  try {
    const rows = await db.queryRaw<Record<string, unknown>>(request.sql, request.params);
    const end = nowMs();
    return {
      requestId: request.requestId,
      rows,
      elapsedMs: Math.max(0, Math.round(end - start)),
    };
  } catch {
    const end = nowMs();
    return {
      requestId: request.requestId,
      rows: [],
      elapsedMs: Math.max(0, Math.round(end - start)),
      error: { message: 'MXDB_REMOTE_SQL_EXEC_FAILED' },
    };
  }
}

