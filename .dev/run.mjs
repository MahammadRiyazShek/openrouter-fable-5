/* Boots app.js against the stub DOM to catch module-evaluation and boot() errors. */
import './shim.mjs';
const errs = [];
process.on('unhandledRejection', (e) => errs.push('unhandledRejection: ' + (e?.message || e)));
process.on('uncaughtException',  (e) => errs.push('uncaughtException: '  + (e?.message || e)));
await import('./app.js');
await new Promise((r) => setTimeout(r, 400));
const real = errs.filter((e) => !/offline-stub|Could not load|CDN/i.test(e));
console.log('listeners registered:', globalThis.__listeners.length);
if (real.length) { console.log('ERRORS:'); real.forEach((e) => console.log('  -', e)); process.exitCode = 1; }
else console.log('no module-evaluation or boot() errors');
