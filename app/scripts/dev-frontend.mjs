import { serveFrontend } from './frontend.mjs';

let server;
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(code || 1), 5000);
  timer.unref();
  try { await server?.close(); }
  finally { process.exit(code); }
}
process.once('SIGINT', () => close());
process.once('SIGTERM', () => close());
if (process.send) {
  process.once('disconnect', () => close());
  process.on('message', (message) => { if (message === 'shutdown') close(); });
}
try {
  server = await serveFrontend();
  if (closing) await server.close();
  else process.send?.({ type: 'ready' });
} catch (error) {
  console.error(`[frontend] ${error.stack || error}`);
  await close(1);
}
