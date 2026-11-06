import { Duplex } from 'node:stream';

class FixtureSocket extends Duplex {
  input=[];
  _read(){}
  _write(chunk,_encoding,callback){this.input.push(Buffer.from(chunk));callback();}
  frame(text){const bytes=Buffer.from(text);const header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(bytes.length,4);this.push(Buffer.concat([header,bytes]));}
}

/** Test-only deterministic daemon. The real semantic broker still owns all grant,
 * profile, registry, identity, stream, teardown and quiescence checks. */
export class AuthorityFixtureEngine {
  count=0;containers=new Map();networks=new Map();sockets=new Map();removeFailure=false;offline=false;createUncertain=false;
  next(){return(++this.count).toString(16).padStart(64,'0');}
  check(){if(this.offline)throw new Error('fixture-daemon-offline');}
  async createSandbox(input){this.check();if(this.createUncertain)throw new Error('fixture-create-uncertain');const id=this.next();this.containers.set(id,{id,name:input.name,imageDigest:input.imageDigest,labels:input.labels,running:false,restarting:false,exitCode:0,networkId:input.networkId,address:'172.30.0.2',uid:input.uid+':'+input.gid,privileged:false,hostPid:false,readOnlyRootfs:true,capDrop:['ALL'],securityOpt:['no-new-privileges'],memoryBytes:input.memoryBytes,nanoCpus:input.nanoCpus,pidsLimit:input.pidsLimit,mounts:input.mounts,restartPolicy:'no'});return id;}
  async attachContainer(id){const socket=new FixtureSocket({allowHalfOpen:true});this.sockets.set(id,socket);return socket;}
  async startContainer(id){this.check();this.containers.get(id).running=true;const socket=this.sockets.get(id);setTimeout(()=>socket.frame('{"kind":"done","code":0}\n'),20);}
  async inspectContainer(target){this.check();return structuredClone(this.containers.get(target)??[...this.containers.values()].find(value=>value.name===target)??null);}
  async listWorkspaceContainers(key){this.check();return[...this.containers.values()].filter(value=>value.labels['chisa.broker.workspace']===key).map(value=>value.id);}
  async removeContainer(id){this.check();if(this.removeFailure)throw new Error('fixture-remove-pending');this.containers.delete(id);this.sockets.get(id)?.push(null);}
  async createExec(){return this.next();}async startExec(){return new FixtureSocket();}async inspectExec(){return{running:false,exitCode:0};}async logs(){return Buffer.from('fixture log');}
  async inspectNetwork(target){this.check();return structuredClone(this.networks.get(target)??[...this.networks.values()].find(value=>value.name===target)??null);}
  async createNetwork(input){this.check();const id=this.next();this.networks.set(id,{id,name:input.name,driver:'bridge',scope:'local',internal:input.internal,defaultBridge:false,labels:input.labels});return id;}
  async retireContainer(id){const value=this.containers.get(id);if(value)value.running=false;}
}
