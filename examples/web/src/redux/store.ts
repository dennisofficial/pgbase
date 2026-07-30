import { configureStore } from '@reduxjs/toolkit';
import { listReducer } from './list/list-slice';

export const makeStore = () => {
  return configureStore({
    reducer: {
      list: listReducer,
    },
  });
};

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
