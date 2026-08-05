/**
 * Kept as a literal rather than read from package.json so the bundle works
 * identically in ESM, CJS, and bundlers that cannot resolve JSON at runtime.
 * The release workflow verifies it matches the published version.
 */
export const VERSION = "0.1.0";
