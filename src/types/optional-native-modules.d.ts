// Optional native packages may be removed by npm when their platform binding is unavailable. Keep a compile-time
// contract here so TypeScript builds do not accidentally turn a best-effort runtime accelerator into a required
// installation dependency. Runtime imports must still handle load failure and preserve their documented fallback.
declare module "@zvec/zvec";
