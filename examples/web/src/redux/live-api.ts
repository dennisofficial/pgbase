import { liveQueryEndpoint } from '@dltech/pgbase/client';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { pgbase, type AuditLog } from '../pgbase/client';

/**
 * The same subscriptions, reached through RTK Query instead of the React hook. `liveQueryEndpoint`
 * opens the subscription in `queryFn` and keeps the cache entry fed from deltas for as long as RTK
 * holds it — there is no polling interval and no manual invalidation anywhere.
 */
export const liveApi = createApi({
  reducerPath: 'live',
  baseQuery: fakeBaseQuery<string>(),
  endpoints: (build) => ({
    activity: build.query<readonly AuditLog[], void>(liveQueryEndpoint(pgbase.AuditLog)),
  }),
});

export const { useActivityQuery } = liveApi;
