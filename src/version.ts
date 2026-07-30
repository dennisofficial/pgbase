/**
 * Version of the `StaticSchema` artifact FORMAT — not of the package. pgbase is consumed as a git
 * submodule, so its package version stays put while the code moves; comparing package versions
 * would be a check that always passes.
 *
 * Bump only when `StaticSchema` changes such that an artifact from an older generator is wrong to
 * read (removed/renamed field, changed meaning, new required field).
 */
export const SCHEMA_FORMAT_VERSION = 1;
