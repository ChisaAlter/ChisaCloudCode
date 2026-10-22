"""Build the unreleased Windows/Linux .3 engine from the verified source patch.

Writes only to a new output directory. Never installs, deploys, packages a release
or changes an installed daemon. Run explicitly; source replay needs Python+Git.
"""
from pathlib import Path
import argparse,gzip,hashlib,io,json,os,shutil,subprocess,sys,tarfile

HERE=Path(__file__).resolve().parent

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--go',default='go')
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--skip-tests',action='store_true',help='Compile only; the generated receipt explicitly records that tests were skipped.')
    args=parser.parse_args()
    output=args.output.resolve()
    if output.exists():raise RuntimeError('Choose a new output directory; existing files are preserved.')
    go=shutil.which(args.go)
    if not go:raise RuntimeError('Go executable not found.')
    version=subprocess.check_output([go,'version'],text=True).strip()
    if 'go1.27.1 ' not in version:raise RuntimeError('Use Go 1.27.1 for this source recipe.')
    module=json.loads(subprocess.check_output([go,'mod','download','-json','github.com/mutagen-io/mutagen@v0.18.1'],text=True))
    if module.get('Sum')!='h1:uYR9CHuynFNO0zGFMypI2LseX9VkIYlgfWQeI/j4824=':raise RuntimeError('Pinned upstream module checksum mismatch.')
    manifest=json.loads((HERE/'source-manifest.json').read_text(encoding='utf-8'))
    output.mkdir(parents=True)
    source=output/'source'
    subprocess.run([sys.executable,str(HERE/'replay-source.py'),'--upstream-source',module['Dir'],'--destination',str(source)],check=True)
    environment=os.environ.copy()
    environment.update({'CGO_ENABLED':'0','GOARCH':'amd64','GOCACHE':str(output/'go-cache')})
    # The in-process controller tests must run natively, independent of a
    # caller's cross-compilation settings. They create only private temp roots.
    environment.pop('GOOS',None)
    if not args.skip_tests:
        subprocess.run([go,'test','./pkg/synchronization','./pkg/synchronization/endpoint/local','./pkg/synchronization/endpoint/remote','-run','^TestGitPolicy|^TestCompletion','-short','-count=1','-timeout=300s'],cwd=source,env=environment,check=True)
    for goos,tags,package,name in [('windows','mutagencli','./cmd/mutagen','mutagen.exe'),('linux','mutagenagent','./cmd/mutagen-agent','mutagen-agent_linux_amd64')]:
        build_environment=environment.copy();build_environment['GOOS']=goos
        subprocess.run([go,'build','-trimpath','-tags',tags,'-o',str(output/name),package],cwd=source,env=build_environment,check=True)
    # Mutagen's loader selects the platform member by its exact unextended name.
    # This product supports one Linux agent platform, without SSPL enhancements.
    payload=(output/'mutagen-agent_linux_amd64').read_bytes()
    with (output/'mutagen-agents.tar.gz').open('wb') as archive:
        with gzip.GzipFile(filename='',mode='wb',fileobj=archive,mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w') as bundle:
                entry=tarfile.TarInfo('linux_amd64');entry.size=len(payload);entry.mode=0o755;entry.mtime=0
                bundle.addfile(entry,io.BytesIO(payload))
    with tarfile.open(output/'mutagen-agents.tar.gz','r:gz') as bundle:
        if bundle.getnames()!=['linux_amd64'] or bundle.extractfile('linux_amd64').read()!=payload:raise RuntimeError('Agent archive payload mismatch.')
    receipt={'version':manifest['version'],'sourceVersion':'v0.18.1','patchSha256':manifest['patchSha256'],'testsRun':not args.skip_tests,'goVersion':version,'clientPlatform':'windows_amd64','agentPlatforms':['linux_amd64'],'ssplEnhancements':False,'files':[]}
    for name in ['mutagen.exe','mutagen-agents.tar.gz']:
        data=(output/name).read_bytes()
        receipt['files'].append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    (output/'runtime-dependencies.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'output':str(output),'version':manifest['version'],'testsRun':not args.skip_tests,'installed':False,'releasePackaged':False}))

if __name__=='__main__':main()
