// Next handles plain `.css` side-effect imports, but nothing in its shipped types declares the
// module shape, so `tsc --noEmit` rejects the import without this.
declare module '*.css';
