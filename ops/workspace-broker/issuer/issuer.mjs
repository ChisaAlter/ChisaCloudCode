#!/usr/bin/env node
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const fail = code => Object.assign(new Error(code),{ code });
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const privateEntry = metadata => metadata.nlink === 1 && metadata.isFile() && !metadata.isSymbolicLink() &&
  (process.platform === 'win32' || (metadata.mode & 0o077) === 0) && (typeof process.getuid !== 'function' || metadata.uid === process.getuid());
async function privateJson(filename, maximum = 1024 * 1024, readableWitness = false) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || await realpath(filename) !== filename) throw fail('ISSUER_PATH_INVALID');
  const handle = await open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!(readableWitness ? metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && (process.platform === 'win32' || (metadata.mode & 0o027) === 0) &&
      (typeof process.getuid !== 'function' || metadata.uid === process.getuid()) : privateEntry(metadata)) || metadata.size > maximum) throw fail('ISSUER_FILE_UNTRUSTED');
    const value = JSON.parse(await handle.readFile('utf8'));
    const named = await lstat(filename);
    if (named.dev !== metadata.dev || named.ino !== metadata.ino) throw fail('ISSUER_FILE_REPLACED');
    return value;
  } finally { await handle.close(); }
}
async function canonicalDirectory(filename, privateOnly = false) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || await realpath(filename) !== filename) throw fail('ISSUER_ROOT_INVALID');
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current,part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw fail('ISSUER_ROOT_SYMLINK');
    if (process.platform !== 'win32') {
      const stickyRoot = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
      if ((metadata.mode & 0o022) !== 0 && !stickyRoot) throw fail('ISSUER_ROOT_WRITABLE_ANCESTOR');
    }
  }
  const metadata = await lstat(filename);
  if (privateOnly && ((process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) || (typeof process.getuid === 'function' && metadata.uid !== process.getuid()))) throw fail('ISSUER_DIRECTORY_UNTRUSTED');
  const exact = await lstat(filename,{ bigint: true });
  return { dev: exact.dev.toString(),ino: exact.ino.toString() };
}

/** Independent operator service. API never receives this private key or registry path. */
export async function createWorkspaceGrantIssuer(manifest) {
  if (!manifest || manifest.version !== 1 || !id(manifest.audience) || !id(manifest.keyId) || !Array.isArray(manifest.entries) || !manifest.entries.length) throw fail('ISSUER_MANIFEST_INVALID');
  const key = createPrivateKey(manifest.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw fail('ISSUER_KEY_INVALID');
  await mkdir(manifest.registryDirectory,{ recursive: true,mode: 0o700 });
  await canonicalDirectory(manifest.registryDirectory,true);
  await canonicalDirectory(manifest.witnessDirectory);
  const witnessDirectoryMetadata = await lstat(manifest.witnessDirectory);
  if ((process.platform !== 'win32' && (witnessDirectoryMetadata.mode & 0o027) !== 0) || (typeof process.getuid === 'function' && witnessDirectoryMetadata.uid !== process.getuid())) throw fail('ISSUER_WITNESS_DIRECTORY_UNTRUSTED');
  for (const filename of ['catalog.sqlite','issuer-lock.sqlite']) {
    const target = path.join(manifest.registryDirectory,filename);
    try { const handle = await open(target,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600); await handle.sync(); await handle.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!privateEntry(await lstat(target))) throw fail('ISSUER_REGISTRY_UNTRUSTED');
  }
  const lock = new DatabaseSync(path.join(manifest.registryDirectory,'issuer-lock.sqlite'));
  let database;
  try {
    lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS issuer_lock(id INTEGER); BEGIN EXCLUSIVE;');
    database = new DatabaseSync(path.join(manifest.registryDirectory,'catalog.sqlite'));
    database.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS enrollment(ticket_hash TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY, manifest_hash TEXT NOT NULL);');
    const fingerprint = hash(JSON.stringify({ ...manifest,privateKey: createPublicKey(key).export({ type: 'spki',format: 'pem' }).toString() }));
    const saved = database.prepare('SELECT manifest_hash FROM metadata WHERE id=1').get();
    if (saved && saved.manifest_hash !== fingerprint) throw fail('ISSUER_CATALOG_CHANGED');
    database.prepare('INSERT OR IGNORE INTO metadata(id,manifest_hash) VALUES(1,?)').run(fingerprint);
    if (manifest.providerPreparedDirectory !== undefined) await canonicalDirectory(manifest.providerPreparedDirectory);
    for (const entry of manifest.entries) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.ticketHash) || ![entry.ownerId,entry.userId,entry.workspaceId,entry.generation,entry.sessionId,entry.leaseId,entry.bindingEpoch,entry.witnessId].every(id) ||
        !Array.isArray(entry.profiles) || !entry.profiles.length || !entry.profiles.every(id) || !Array.isArray(entry.permissions) || !entry.permissions.length || !entry.permissions.every(id) ||
        (entry.permissions.includes('quiesce') && !['legacy-writer-release','live-writer-release'].includes(entry.recoveryPurpose)) ||
        !Number.isSafeInteger(entry.expiresAt) || (entry.providerSlotId !== undefined && (!id(entry.providerSlotId) || typeof manifest.providerPreparedDirectory !== 'string'))) throw fail('ISSUER_ENROLLMENT_INVALID');
      const pin = await canonicalDirectory(entry.root);
      if (!/^\d+$/.test(String(entry.rootDev)) || !/^\d+$/.test(String(entry.rootIno)) || pin.dev !== String(entry.rootDev) || pin.ino !== String(entry.rootIno)) throw fail('ISSUER_ROOT_PIN_MISMATCH');
      const value = JSON.stringify(entry);
      const existing = database.prepare('SELECT value FROM enrollment WHERE ticket_hash=?').get(entry.ticketHash);
      if (existing && existing.value !== value) throw fail('ISSUER_ENROLLMENT_CHANGED');
      database.prepare('INSERT OR IGNORE INTO enrollment(ticket_hash,value) VALUES(?,?)').run(entry.ticketHash,value);
    }
  } catch (error) { database?.close(); lock.close(); throw error; }
  let closed = false;
  let windowStart = Date.now(); let count = 0;
  return {
    async grant(request) {
      if (closed) throw fail('ISSUER_CLOSED');
      if (Date.now()-windowStart >= 60000) { windowStart = Date.now(); count = 0; }
      if (++count > 600 || !request || Object.keys(request).some(key => !['ticket','userId','workspaceId','root','generation','leaseId','bindingEpoch','sessionId','permission','profileId','recoveryPurpose'].includes(key)) ||
        typeof request.ticket !== 'string' || !/^[a-f0-9]{64,128}$/.test(request.ticket)) throw fail('ISSUER_DENIED');
      const digest = hash(request.ticket);
      const row = database.prepare('SELECT value FROM enrollment WHERE ticket_hash=?').get(digest);
      if (!row) throw fail('ISSUER_DENIED');
      const entry = JSON.parse(row.value);
      if (!timingSafeEqual(Buffer.from(entry.ticketHash),Buffer.from(digest)) || entry.expiresAt <= Date.now() ||
        ['userId','workspaceId','root','generation'].some(field => request[field] !== entry[field]) ||
        ['leaseId','bindingEpoch','sessionId'].some(field => request[field] !== undefined && request[field] !== entry[field]) ||
        !entry.permissions.includes(request.permission) || !entry.profiles.includes(request.profileId)) throw fail('ISSUER_DENIED');
      const pin = await canonicalDirectory(entry.root);
      if (pin.dev !== String(entry.rootDev) || pin.ino !== String(entry.rootIno)) throw fail('ISSUER_ROOT_REPLACED');
      await canonicalDirectory(manifest.witnessDirectory);
      const witness = await privateJson(path.join(manifest.witnessDirectory,entry.witnessId + '.json'),16384,true);
      if (witness.version !== 1 || witness.active !== true || !Number.isSafeInteger(witness.expiresAt) || witness.expiresAt <= Date.now() ||
        ['workspaceId','generation','sessionId','leaseId','bindingEpoch'].some(field => witness[field] !== entry[field]) ||
        (request.permission === 'quiesce' && (request.recoveryPurpose !== entry.recoveryPurpose || witness.recoveryPurpose !== entry.recoveryPurpose))) throw fail('ISSUER_WITNESS_INVALID');
      if (request.permission === 'quiesce') {
        const writer = witness.writer;
        if (witness.root !== entry.root || !writer || !Number.isInteger(writer.pid) || writer.pid <= 0 || !/^\d+$/.test(writer.processStartTime) ||
          !/^[a-f0-9-]{36}$/.test(writer.bootId) || !/^pid:\[\d+\]$/.test(writer.pidNamespace)) throw fail('ISSUER_WRITER_WITNESS_INVALID');
        if (entry.recoveryPurpose === 'legacy-writer-release') {
          const stopped = witness.supervisorStopped;
          if (!stopped || stopped.stopped !== true || !id(stopped.stopId) || stopped.leaseId !== entry.leaseId || stopped.bindingEpoch !== entry.bindingEpoch ||
            ['pid','processStartTime','bootId','pidNamespace'].some(field => stopped[field] !== writer[field])) throw fail('ISSUER_STOP_WITNESS_REQUIRED');
        }
      }
      let preparedExpiresAt = Infinity;
      if (entry.providerSlotId !== undefined && ['run','exec'].includes(request.permission)) {
        await canonicalDirectory(manifest.providerPreparedDirectory);
        const prepared = await privateJson(path.join(manifest.providerPreparedDirectory,entry.providerSlotId + '.json'),16384,true);
        if (prepared.version !== 1 || prepared.active !== true || prepared.prepared !== true || prepared.slotId !== entry.providerSlotId || !/^[a-f0-9]{64}$/.test(prepared.fingerprint) ||
          !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= Date.now() || ['root','ownerId','userId','workspaceId','generation','leaseId','bindingEpoch','sessionId'].some(field => prepared[field] !== entry[field]) || prepared.profileId !== request.profileId) throw fail('ISSUER_PROVIDER_SLOT_UNPREPARED');
        preparedExpiresAt = prepared.expiresAt;
      }
      const now = Date.now(); const expiresAt = Math.min(now+120000,entry.expiresAt,witness.expiresAt,preparedExpiresAt);
      if (expiresAt <= now+1000) throw fail('ISSUER_AUTHORIZATION_EXPIRING');
      const claims = { version: 1,keyId: manifest.keyId,audience: manifest.audience,ownerId: entry.ownerId,workspaceId: entry.workspaceId,generation: entry.generation,
        leaseId: entry.leaseId,profiles: [request.profileId],permissions: [request.permission],issuedAt: now,expiresAt,grantId: randomUUID() };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return { proof: payload + '.' + sign(null,Buffer.from(payload),key).toString('base64url'),expiresAt,
        workspaceId: entry.workspaceId,generation: entry.generation,leaseId: entry.leaseId,sessionId: entry.sessionId,bindingEpoch: entry.bindingEpoch,profileId: request.profileId };
    },
    close() { if (closed) return; closed = true; database.close(); lock.exec('ROLLBACK'); lock.close(); },
  };
}

export async function createWorkspaceGrantIssuerServer(issuer,options) {
  if (process.platform !== 'win32') {
    const parent = path.dirname(options.socketPath); const metadata = await lstat(parent);
    if (await realpath(parent) !== parent || (metadata.mode & 0o027) !== 0 || metadata.uid !== process.getuid()) throw fail('ISSUER_SOCKET_DIRECTORY');
    if (options.clientGroupId !== undefined && metadata.gid !== options.clientGroupId) throw fail('ISSUER_SOCKET_GROUP');
    try { await lstat(options.socketPath); throw fail('ISSUER_SOCKET_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const server = createServer(async (request,response) => {
    const finish = (status,body) => { response.writeHead(status,{ 'Content-Type': 'application/json','Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (request.method !== 'POST' || request.url !== '/v1/grant' || request.headers['content-type'] !== 'application/json') throw fail('ISSUER_DENIED');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) throw fail('ISSUER_DENIED'); chunks.push(Buffer.from(chunk)); }
      finish(200,await issuer.grant(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch { finish(403,{ error: 'ISSUER_DENIED' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxConnections = 32; server.on('clientError',(_error,socket) => socket.destroy());
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(options.socketPath,resolve); });
  let pin;
  if (process.platform !== 'win32') {
    if (options.clientGroupId !== undefined) await chown(options.socketPath,process.getuid(),options.clientGroupId);
    await chmod(options.socketPath,options.clientGroupId === undefined ? 0o600 : 0o660); pin = await lstat(options.socketPath);
  }
  return { async close() {
    server.closeAllConnections(); await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    if (pin) { const named = await lstat(options.socketPath).catch(() => undefined); if (named?.isSocket() && named.dev === pin.dev && named.ino === pin.ino) await unlink(options.socketPath); }
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.platform !== 'linux') throw fail('ISSUER_LINUX_REQUIRED');
  process.umask(0o077);
  const manifest = await privateJson(process.argv[2]);
  const issuer = await createWorkspaceGrantIssuer(manifest);
  const server = await createWorkspaceGrantIssuerServer(issuer,{ socketPath: manifest.socketPath,clientGroupId: manifest.clientGroupId });
  const stop = async () => { await server.close(); issuer.close(); };
  process.once('SIGTERM',() => { void stop(); }); process.once('SIGINT',() => { void stop(); });
  console.log(JSON.stringify({ event: 'issuer-listening',protocol: 1 }));
}
