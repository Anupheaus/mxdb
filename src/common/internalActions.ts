import { defineAction } from '@anupheaus/nexus/common';
import type {
  DistinctRequest,
  DistinctResponse,
  GetAllRequest,
  GetRequest,
  GetResponse,
  QueryRequest,
  QueryResponse,
  ReconcileRequest,
  ReconcileResponse,
} from './models';
import type {
  ClientDispatcherRequest,
  MXDBRecordCursors,
  MXDBSyncEngineResponse,
} from './sync-engine';

// Socket only: an emit can be up to 4 MB (sc-623), far past the REST transport's 512 KB body limit
export const mxdbClientToServerSyncAction = defineAction<ClientDispatcherRequest, MXDBSyncEngineResponse>()('mxdbClientToServerSyncAction', { transport: ['socket'] });
export const mxdbServerToClientSyncAction = defineAction<MXDBRecordCursors, MXDBSyncEngineResponse>()('mxdbServerToClientSyncAction');
export const mxdbReconcileAction = defineAction<ReconcileRequest, ReconcileResponse>()('mxdbReconcileAction');
export const mxdbGetAction = defineAction<GetRequest, GetResponse>()('mxdbGetAction');
export const mxdbGetAllAction = defineAction<GetAllRequest, GetResponse>()('mxdbGetAllAction');
export const mxdbQueryAction = defineAction<QueryRequest, QueryResponse>()('mxdbQueryAction');
export const mxdbDistinctAction = defineAction<DistinctRequest, DistinctResponse>()('mxdbDistinctAction');
