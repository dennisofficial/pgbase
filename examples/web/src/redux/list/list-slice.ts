import { createSlice } from '@reduxjs/toolkit';
import type { RootState } from '../store';

// Static placeholder — @workspace/pgbase/react has no live-query hooks yet, so this slice exists
// only to give the page something real to select and render through the store.
const PLACEHOLDER_ITEMS = ['alpha', 'beta', 'gamma'];

const listSlice = createSlice({
  name: 'list',
  initialState: { items: PLACEHOLDER_ITEMS },
  reducers: {},
});

export const listReducer = listSlice.reducer;

export const selectListItems = (state: RootState) => state.list.items;
