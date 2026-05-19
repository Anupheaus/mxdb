import type { DistinctRequest, DistinctResponse, GetAllRequest, GetResponse, QueryRequest, QueryResponse } from './models';
import { defineSubscription } from '@anupheaus/nexus/common';

export const mxdbQuerySubscription = defineSubscription<QueryRequest, QueryResponse>()('mxdbQuerySubscription');
export const mxdbDistinctSubscription = defineSubscription<DistinctRequest, DistinctResponse>()('mxdbDistinctSubscription');
export const mxdbGetAllSubscription = defineSubscription<GetAllRequest, GetResponse>()('mxdbGetAllSubscription');
