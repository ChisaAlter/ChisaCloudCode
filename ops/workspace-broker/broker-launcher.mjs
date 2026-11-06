#!/usr/bin/env node
// Independent broker process. Run the compiled candidate module; do not import the API entrypoint.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'linux') throw new Error('Broker deployment requires Linux');
process.umask(0o077);
const [manifestPath, modulePath] = process.argv.slice(2);
for (const value of [manifestPath,modulePath]) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || await realpath(value) !== value) throw new Error('Use canonical absolute manifest/module paths');
}
const manifest = await open(manifestPath,constants.O_RDONLY | constants.O_NOFOLLOW);
let deployment;
try {
  const metadata = await manifest.stat();
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024*1024 || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid()) throw new Error('Manifest must be broker-owned and private');
  deployment = JSON.parse(await manifest.readFile('utf8'));
} finally { await manifest.close(); }
const allowed = ['configuration','dockerSocketPath','brokerSocketPath','clientGroupId'];
if (!deployment || Object.keys(deployment).some(key => !allowed.includes(key))) throw new Error('Invalid deployment manifest');
const daemon = await lstat(deployment.dockerSocketPath);
if (!daemon.isSocket() || daemon.isSymbolicLink()) throw new Error('Docker socket is not an enrolled Unix socket');
const { createWorkspaceBroker,createWorkspaceBrokerDockerAdapter,createWorkspaceBrokerServer } = await import(pathToFileURL(modulePath).href);
const broker = await createWorkspaceBroker(deployment.configuration,createWorkspaceBrokerDockerAdapter({ socketPath: deployment.dockerSocketPath }));
let server;
try { server = await createWorkspaceBrokerServer(broker,{ socketPath: deployment.brokerSocketPath,clientGroupId: deployment.clientGroupId }); }
catch (error) { await broker.close(); throw error; }
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  await server.close(); await broker.close();
};
process.once('SIGTERM',() => { void stop().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT',() => { void stop().catch(() => { process.exitCode = 1; }); });
console.log(JSON.stringify({ event: 'broker-listening',protocol: 1 }));
