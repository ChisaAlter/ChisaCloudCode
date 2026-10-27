import { readFileSync } from 'node:fs';

import { createDesktopGateway } from './modules/desktop-gateway/index.js';

const configuration = JSON.parse(readFileSync(process.env.CHISA_GATEWAY_CONFIG ?? '', 'utf8'));
const server = createDesktopGateway({ ...configuration,
  key: readFileSync(process.env.CHISA_GATEWAY_KEY ?? ''),
  cert: readFileSync(process.env.CHISA_GATEWAY_CERT ?? ''),
});
server.listen(Number(process.env.CHISA_GATEWAY_PORT ?? 8794), process.env.CHISA_GATEWAY_HOST ?? '0.0.0.0', () => {
  console.log('ChisaCloudCode encrypted account gateway is listening');
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
