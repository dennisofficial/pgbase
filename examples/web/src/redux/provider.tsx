'use client';

import { useRef, type FC, type PropsWithChildren } from 'react';
import { Provider } from 'react-redux';
import { makeStore, type AppStore } from './store';

// One store per mount, created lazily inside a ref — never at module scope. A module-scope store
// would be a singleton shared across requests on the server, which is the classic RSC + RTK trap:
// this file is the boundary where "client store" stops being a server-side singleton.
export const StoreProvider: FC<PropsWithChildren> = ({ children }) => {
  const storeRef = useRef<AppStore>(undefined);
  if (!storeRef.current) {
    storeRef.current = makeStore();
  }
  return <Provider store={storeRef.current}>{children}</Provider>;
};
