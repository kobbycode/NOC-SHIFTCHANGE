// Build stub: the "server-only" package's guard exists for Next.js client/server
// module boundaries. The Cloud Functions runtime is unambiguously server-side;
// esbuild aliases "server-only" to this no-op so the bundle does not embed the
// package's default export, which throws when loaded without the react-server
// condition (functions/package.json build script).
module.exports = {};
