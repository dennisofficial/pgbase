import { isLiveSerializable } from '@dltech/pgbase/client';
import { configureStore } from '@reduxjs/toolkit';
import { liveApi } from './live-api';

export const makeStore = () => {
  return configureStore({
    reducer: {
      [liveApi.reducerPath]: liveApi.reducer,
    },
    middleware: (getDefault) =>
      getDefault({ serializableCheck: { isSerializable: isLiveSerializable } }).concat(
        liveApi.middleware,
      ),
  });
};

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
