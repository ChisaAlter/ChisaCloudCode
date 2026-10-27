# Chisa SSH workspace helper. Protocol 1 / helper 1.0.2. Windows PowerShell 5.1+.
# One bounded JSON request on stdin and exactly one JSON result on stdout.
# This is an on-demand SSH process, not an agent/service or a command sandbox.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:Leases = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$script:Root = $null
$script:RootIdentity = $null
$script:JobBase = $null
$script:MaxFile = 8 * 1024 * 1024
$script:MaxEntries = 2000

function Fail([string]$Code, [string]$Message) {
    $e = New-Object System.InvalidOperationException($Message)
    $e.Data['Code'] = $Code
    throw $e
}
function Has-Field($Object, [string]$Name) { return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name] }

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 'SSH_PLATFORM_UNSUPPORTED' 'The workspace helper requires Windows.' }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class ChisaWorkspaceNative {
    const uint READ = 0x80000000, WRITE = 0x40000000, OPEN_EXISTING = 3, CREATE_NEW = 1;
    const uint BACKUP = 0x02000000, REPARSE = 0x00200000;
    [StructLayout(LayoutKind.Sequential)] public struct FILEINFO { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FILEINFO info);
    public static FILEINFO Info(SafeFileHandle handle) { FILEINFO value; if (!GetFileInformationByHandle(handle, out value)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return value; }
    static SafeFileHandle Checked(string path, uint access, uint share, uint creation, bool directory) {
        var handle = CreateFile(path, access, share, IntPtr.Zero, creation, BACKUP | REPARSE, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
        try {
            var info = Info(handle);
            if ((info.Attributes & 0x400) != 0) throw new IOException("Reparse points are not supported in workspace file operations.");
            if (directory != ((info.Attributes & 0x10) != 0)) throw new IOException(directory ? "Expected a directory." : "Expected a file.");
            if (!directory && info.Links > 1) throw new IOException("Hard-linked files are not supported in workspace file operations.");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    public static SafeFileHandle LockDirectory(string path) { return Checked(path, 0, 3, OPEN_EXISTING, true); }
    public static SafeFileHandle Inspect(string path, bool directory) { return Checked(path, 0, 7, OPEN_EXISTING, directory); }
    public static FileStream ReadFile(string path) { return new FileStream(Checked(path, READ, 1, OPEN_EXISTING, false), FileAccess.Read); }
    public static FileStream WriteFile(string path, bool create) { return new FileStream(Checked(path, READ | WRITE, 0, create ? CREATE_NEW : OPEN_EXISTING, false), FileAccess.ReadWrite); }
    public static string Identity(SafeFileHandle handle) { var i = Info(handle); return i.Volume.ToString("x8") + ":" + i.IndexHigh.ToString("x8") + i.IndexLow.ToString("x8"); }
    public static long Length(FILEINFO i) { return ((long)i.SizeHigh << 32) | i.SizeLow; }
    public static double Mtime(FILEINFO i) { long value = ((long)i.Write.dwHighDateTime << 32) | (uint)i.Write.dwLowDateTime; return (DateTime.FromFileTimeUtc(value) - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalSeconds; }
}

public sealed class ChisaWorkspaceJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUP { public int cb; public IntPtr reserved, desktop, title; public int x,y,cx,cy,xchars,ychars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPEX { public STARTUP startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASICLIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint processLimit; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASICLIMIT basic; public IOC io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref LIMIT info, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNT info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY security, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPEX startup, out PROCESS process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    IntPtr job, process;
    Task<Capture> output, error;
    public int Pid { get; private set; }
    public string StartTime { get; private set; }
    public sealed class Capture { public string Text; public bool Truncated; }
    static Capture Drain(IntPtr handle) {
        using (var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read))
        using (var bytes = new MemoryStream()) {
            var buffer = new byte[16384]; bool cut = false; int n;
            while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) { int keep = Math.Min(n, 1024*1024-(int)bytes.Length); if (keep > 0) bytes.Write(buffer,0,keep); if (keep < n) cut = true; }
            return new Capture { Text = Encoding.UTF8.GetString(bytes.ToArray()), Truncated = cut };
        }
    }
    public ChisaWorkspaceJob(string name, string executable, string commandLine, string cwd, string environment) {
        job = CreateJobObject(IntPtr.Zero, name);
        int creationError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(creationError);
        if (creationError == 183) { Dispose(); throw new IOException("The command job already exists."); }
        var limits = new LIMIT(); limits.basic.flags = 0x2000 | 0x400 | 0x8; limits.basic.processLimit = 128;
        if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(LIMIT)))) { Dispose(); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
        IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,inRead=IntPtr.Zero,inWrite=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero;
        PROCESS pi = new PROCESS(); bool assigned = false;
        try {
            var sa = new SECURITY { length = Marshal.SizeOf(typeof(SECURITY)), inherit = true };
            if (!CreatePipe(out outRead,out outWrite,ref sa,0) || !CreatePipe(out errRead,out errWrite,ref sa,0) || !CreatePipe(out inRead,out inWrite,ref sa,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!SetHandleInformation(outRead,1,0) || !SetHandleInformation(errRead,1,0) || !SetHandleInformation(inWrite,1,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attrs=Marshal.AllocHGlobal(size); if (!InitializeProcThreadAttributeList(attrs,1,0,ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,inRead); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
            if (!UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            env=Marshal.StringToHGlobalUni(environment);
            var si=new STARTUPEX(); si.startup.cb=Marshal.SizeOf(typeof(STARTUPEX)); si.startup.flags=0x100; si.startup.stdin=inRead; si.startup.stdout=outWrite; si.startup.stderr=errWrite; si.attributes=attrs;
            if (!CreateProcess(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x80000|0x08000000,env,cwd,ref si,out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job,pi.process)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            assigned=true; process=pi.process; pi.process=IntPtr.Zero; Pid=(int)pi.pid;
            using (var p=Process.GetProcessById(Pid)) StartTime=p.StartTime.ToUniversalTime().ToString("o");
            if (ResumeThread(pi.thread)==0xffffffff) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero; CloseHandle(inRead); inRead=IntPtr.Zero; CloseHandle(inWrite); inWrite=IntPtr.Zero;
            var r1=outRead; var r2=errRead; outRead=IntPtr.Zero; errRead=IntPtr.Zero;
            output=Task.Run(()=>Drain(r1)); error=Task.Run(()=>Drain(r2));
        } catch { if (assigned) TerminateJobObject(job,1); else if (pi.process!=IntPtr.Zero) TerminateProcess(pi.process,1); Dispose(); throw; }
        finally {
            if (pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if (pi.process!=IntPtr.Zero) CloseHandle(pi.process);
            foreach (var h in new[]{outRead,outWrite,errRead,errWrite,inRead,inWrite}) if (h!=IntPtr.Zero) CloseHandle(h);
            if (attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
            if (handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if (env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }
    public static uint Active(string name) { var j=OpenJobObject(4,false,name); if(j==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return 0; throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } try { return ActiveHandle(j); } finally { CloseHandle(j); } }
    static uint ActiveHandle(IntPtr j) { ACCOUNT a; if(!QueryInformationJobObject(j,1,out a,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return a.activeProcesses; }
    public uint ActiveProcesses { get { return ActiveHandle(job); } }
    public static bool StopNamed(string name) { var j=OpenJobObject(8|4,false,name); if(j==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return false; throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } try { if(!TerminateJobObject(j,130)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); var end=DateTime.UtcNow.AddSeconds(5); while(ActiveHandle(j)>0 && DateTime.UtcNow<end) System.Threading.Thread.Sleep(20); return ActiveHandle(j)==0; } finally { CloseHandle(j); } }
    public void Stop(uint code) { if(!TerminateJobObject(job,code)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    public bool Exited { get { uint code; if(!GetExitCodeProcess(process,out code)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return code!=259; } }
    public int ExitCode { get { uint code; if(!GetExitCodeProcess(process,out code)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return unchecked((int)code); } }
    public Capture Stdout { get { return output.GetAwaiter().GetResult(); } }
    public Capture Stderr { get { return error.GetAwaiter().GetResult(); } }
    public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } if(process!=IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; } }
}
'@

    function Lock-Directory([string]$Path) {
        try { $h = [ChisaWorkspaceNative]::LockDirectory($Path); $script:Leases.Add($h); return $h }
        catch { Fail 'SSH_WORKSPACE_PATH_UNSAFE' 'Workspace directories must be ordinary accessible directories without links.' }
    }
    function Initialize-Root([string]$RootPath) {
        if ($RootPath -notmatch '^[a-zA-Z]:[\\/]' -or $RootPath.Length -gt 1024 -or $RootPath.Substring(2).Contains(':') -or $RootPath -match '[\x00-\x1f]') { Fail 'SSH_WORKSPACE_ROOT_INVALID' 'Select an absolute Windows project subdirectory.' }
        $root = [IO.Path]::GetFullPath($RootPath).TrimEnd('\')
        if ($root.Length -le 3) { Fail 'SSH_WORKSPACE_ROOT_INVALID' 'An entire drive cannot be a workspace.' }
        $drive = [IO.Path]::GetPathRoot($root)
        $cursor = $drive
        $null = Lock-Directory $drive
        foreach ($part in $root.Substring($drive.Length).Split('\')) {
            Assert-Segment $part
            $cursor = [IO.Path]::Combine($cursor, $part)
            $last = Lock-Directory $cursor
        }
        $script:Root = $root
        $script:RootIdentity = [ChisaWorkspaceNative]::Identity($last)
        $helper = [IO.Path]::GetFullPath($PSCommandPath)
        if ($helper.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $helper.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { Fail 'SSH_HELPER_UNSAFE' 'Install the workspace helper outside the writable project.' }
    }
    function Assert-Segment([string]$Part) {
        if (!$Part -or $Part -eq '.' -or $Part -eq '..' -or $Part -match '[<>:"|?*\x00-\x1f]' -or $Part.EndsWith('.') -or $Part.EndsWith(' ') -or $Part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Fail 'SSH_WORKSPACE_PATH_INVALID' 'Invalid project path component.' }
    }
    function Resolve-ProjectPath([string]$Virtual, [bool]$CreateParents = $false) {
        if (!$Virtual) { $Virtual = '/workspace' }
        if ($Virtual.Length -gt 2048 -or $Virtual -match '[\x00-\x1f]' -or $Virtual.Contains('\') -or $Virtual.Contains(':')) { Fail 'SSH_WORKSPACE_PATH_INVALID' 'Use project-relative paths or /workspace paths.' }
        if ($Virtual -eq '/workspace' -or $Virtual -eq '/workspace/') { return $script:Root }
        if ($Virtual.StartsWith('/workspace/')) { $relative = $Virtual.Substring(11) }
        elseif ($Virtual.StartsWith('/')) { Fail 'SSH_WORKSPACE_PATH_INVALID' 'Path is outside the project.' }
        else { $relative = $Virtual }
        $parts = $relative.Split('/')
        $cursor = $script:Root
        for ($i=0; $i -lt $parts.Length; $i++) {
            Assert-Segment $parts[$i]
            $cursor = [IO.Path]::Combine($cursor,$parts[$i])
            if ($i -lt $parts.Length-1) {
                if ($CreateParents -and ![IO.Directory]::Exists($cursor)) { $null = [IO.Directory]::CreateDirectory($cursor) }
                $null = Lock-Directory $cursor
            }
        }
        return $cursor
    }
    function Virtual-Path([string]$Path) {
        if ($Path.Equals($script:Root,[StringComparison]::OrdinalIgnoreCase)) { return '/workspace' }
        return '/workspace/' + $Path.Substring($script:Root.Length+1).Replace('\','/')
    }
    function File-Stats([string]$Path) {
        if (![IO.File]::Exists($Path) -and ![IO.Directory]::Exists($Path)) { Fail 'ENOENT' 'Project path does not exist.' }
        $directory = [IO.Directory]::Exists($Path)
        try { $handle = [ChisaWorkspaceNative]::Inspect($Path,$directory) }
        catch { Fail 'SSH_WORKSPACE_PATH_UNSAFE' 'Linked or inaccessible project paths are not supported.' }
        try { $info = [ChisaWorkspaceNative]::Info($handle); return @{size=[ChisaWorkspaceNative]::Length($info);mtime=[ChisaWorkspaceNative]::Mtime($info);mode=$(if($directory){16877}else{33188});dir=$directory;symlink=$false} }
        finally { $handle.Dispose() }
    }
    function Hash-Stream([IO.Stream]$Stream) {
        $Stream.Position=0
        $sha=[Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose(); $Stream.Position=0 }
    }
    function Read-File([string]$Path) {
        if (![IO.File]::Exists($Path)) { Fail 'ENOENT' 'Project file does not exist.' }
        try { $stream = [ChisaWorkspaceNative]::ReadFile($Path) }
        catch { Fail 'SSH_WORKSPACE_PATH_UNSAFE' 'Linked, locked or inaccessible project file.' }
        try {
            if($stream.Length -gt $script:MaxFile) { Fail 'FILE_TOO_LARGE' 'Project files are limited to 8 MiB.' }
            $hash=Hash-Stream $stream
            $memory=New-Object IO.MemoryStream
            try { $stream.CopyTo($memory); return @{b64=[Convert]::ToBase64String($memory.ToArray());hash=$hash} }
            finally { $memory.Dispose() }
        } finally { $stream.Dispose() }
    }
    function Safe-Remove([string]$Path) {
        if($Path.Equals($script:Root,[StringComparison]::OrdinalIgnoreCase)) { Fail 'SSH_WORKSPACE_PATH_INVALID' 'The project root cannot be removed.' }
        $stats=File-Stats $Path
        if($stats.dir) {
            $lease=[ChisaWorkspaceNative]::LockDirectory($Path)
            try { foreach($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Safe-Remove $child } }
            finally { $lease.Dispose() }
            [IO.Directory]::Delete($Path,$false)
        } else { [IO.File]::Delete($Path) }
    }
    function Safe-Search([string]$Base,[string]$Query,[bool]$Content) {
        if([string]::IsNullOrEmpty($Query) -or $Query.Length -gt 1024) { Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Search needs a nonempty query up to 1024 characters.' }
        $queue=New-Object 'System.Collections.Generic.Queue[string]'
        $queue.Enqueue($Base)
        $matches=New-Object 'System.Collections.Generic.List[object]'
        $visited=0; $truncated=$false
        while($queue.Count -gt 0 -and $visited -lt 10000 -and $matches.Count -lt 1000) {
            $current=$queue.Dequeue(); $visited++
            try { $current=Resolve-ProjectPath (Virtual-Path $current); $stats=File-Stats $current } catch { continue }
            if($stats.dir) {
                $directoryLease=[ChisaWorkspaceNative]::LockDirectory($current)
                try { foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) { if($queue.Count -ge 10000) {$truncated=$true;break}; $queue.Enqueue($entry) } }
                finally { $directoryLease.Dispose() }
            } elseif($Content) {
                if($stats.size -gt 1024*1024) {continue}
                try { $r=Read-File $current; $text=$script:Utf8.GetString([Convert]::FromBase64String($r.b64)); if($text.Contains([char]0)){continue} }
                catch { continue }
                $lineNumber=0
                foreach($line in $text.Split("`n")) { $lineNumber++; if($line.IndexOf($Query,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $matches.Add(@{path=(Virtual-Path $current);line=$lineNumber;text=$line.TrimEnd("`r").Substring(0,[Math]::Min(1000,$line.TrimEnd("`r").Length))});if($matches.Count -ge 1000){break} } }
            }
            if(!$Content -and (Virtual-Path $current).IndexOf($Query,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $matches.Add(@{path=(Virtual-Path $current)}) }
        }
        if($queue.Count -gt 0) {$truncated=$true}
        return @{matches=@($matches.ToArray());truncated=$truncated}
    }
    function Job-Name([string]$Id) { return 'Global\ChisaSshWorkspace_' + ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value.Replace('-','_')) + '_' + $Id }
    function Job-Directory([string]$Id) {
        if($Id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Invalid command job ID.' }
        return [IO.Path]::Combine($script:JobBase,$Id)
    }
    function Save-Job([string]$Directory,$Record) {
        $temp=[IO.Path]::Combine($Directory,([Guid]::NewGuid().ToString()+'.tmp'))
        [IO.File]::WriteAllText($temp,($Record|ConvertTo-Json -Depth 12 -Compress),$script:Utf8)
        $file=[IO.Path]::Combine($Directory,'state.json')
        if([IO.File]::Exists($file)) { [IO.File]::Replace($temp,$file,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp,$file) }
    }
    function Read-Job([string]$Directory) {
        $file=[IO.Path]::Combine($Directory,'state.json')
        if(![IO.File]::Exists($file)) {return $null}
        try {
            $stateStream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {$stateReader=New-Object IO.StreamReader($stateStream,$script:Utf8);try{$record=$stateReader.ReadToEnd()|ConvertFrom-Json}finally{$stateReader.Dispose()}}
            finally {$stateStream.Dispose()}
        }
        catch {Fail 'SSH_JOB_STATE_INVALID' 'Command job state could not be read.'}
        if($record.rootIdentity -ne $script:RootIdentity) {Fail 'SSH_WORKSPACE_CHANGED' 'The command belongs to a different workspace root.'}
        return $record
    }
    function Job-Status([string]$Id,[bool]$Cancel) {
        $directory=Job-Directory $Id
        if($Cancel) {
            $null=[IO.Directory]::CreateDirectory($directory)
            $marker=[IO.Path]::Combine($directory,'cancel')
            $s=[IO.File]::Open($marker,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$s.Dispose()
        }
        $state=Read-Job $directory
        if(!$state -and $Cancel) {
            # Compete for the same permanent claim as Run-Command. Winning it
            # proves no command with this ID can start, even on a delayed SSH channel.
            $claim=[IO.Path]::Combine($directory,'claimed')
            $claimStream=$null
            try {$claimStream=[IO.File]::Open($claim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)} catch {}
            if($claimStream) {
                $claimStream.Dispose()
                $state=@{jobId=$Id;rootIdentity=$script:RootIdentity;state='cancelled';cleanupConfirmed=$true;exitCode=130}
                Save-Job $directory $state
                return @{jobId=$Id;state='cancelled';cleanupConfirmed=$true;cancelled=$true;exitCode=130}
            }
            # A v2 executor holds its claim handle through terminal publication.
            # Exclusive access to that marked handle plus no named job proves a
            # crashed pre-state executor cannot dispatch a delayed child.
            $deadClaim=$null
            try {$deadClaim=[IO.File]::Open($claim,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} catch {}
            if($deadClaim) {
                try {
                    $claimReader=New-Object IO.StreamReader($deadClaim,$script:Utf8,$false,1024,$true)
                    try {$claimText=$claimReader.ReadToEnd()} finally {$claimReader.Dispose()}
                    if($claimText -eq ('claim-v2:'+$script:RootIdentity) -and [ChisaWorkspaceJob]::Active((Job-Name $Id)) -eq 0) {
                        $state=@{jobId=$Id;rootIdentity=$script:RootIdentity;state='interrupted';cleanupConfirmed=$true;exitCode=1}
                        Save-Job $directory $state
                    }
                } finally {$deadClaim.Dispose()}
            }
            # Unmarked old claims remain uncertain; never steal them.
            $state=Read-Job $directory
        }
        if(!$state) { return @{jobId=$Id;state='not_found';cleanupConfirmed=$false} }
        if($state.cleanupConfirmed -eq $true) {return @{jobId=$Id;state=$state.state;cleanupConfirmed=$true;exitCode=$state.exitCode}}
        $name=Job-Name $Id
        $active=[ChisaWorkspaceJob]::Active($name)
        if($Cancel -and $active -gt 0) { $null=[ChisaWorkspaceJob]::StopNamed($name) }
        $end=[DateTime]::UtcNow.AddSeconds($(if($Cancel){5}else{0}))
        do {
            $state=Read-Job $directory
            if($state.cleanupConfirmed -eq $true) {return @{jobId=$Id;state=$state.state;cleanupConfirmed=$true;exitCode=$state.exitCode}}
            $active=[ChisaWorkspaceJob]::Active($name)
            $ownerAlive=$false
            try {$owner=Get-Process -Id $state.ownerPid -ErrorAction Stop;$ownerAlive=$owner.StartTime.ToUniversalTime().ToString('o') -eq $state.ownerStartedAt} catch {}
            if(!$ownerAlive -and $active -eq 0) {
                $childAlive=$false
                if($state.childPid) {try {$child=Get-Process -Id $state.childPid -ErrorAction Stop;$childAlive=$child.StartTime.ToUniversalTime().ToString('o') -eq $state.childStartedAt}catch{}}
                if(!$childAlive) {return @{jobId=$Id;state='interrupted';cleanupConfirmed=$true;cancelled=$Cancel}}
            }
            if([DateTime]::UtcNow -ge $end){break}
            Start-Sleep -Milliseconds 50
        } while($true)
        return @{jobId=$Id;state='running';cleanupConfirmed=$false}
    }
    function Run-Command($Request) {
        if($Request.readOnly -eq $true) {Fail 'SSH_READ_ONLY_COMMAND_UNSUPPORTED' 'Windows SSH cannot enforce read-only commands.'}
        $directory=Job-Directory ([string]$Request.jobId)
        # Resolve/lock cwd and validate every command argument before claiming
        # the permanent ID. A refusal must never leave an ownerless claim.
        $cwd=Resolve-ProjectPath ([string]$Request.path)
        $null=Lock-Directory $cwd
        $hasCommand=(Has-Field $Request 'command') -and ![string]::IsNullOrWhiteSpace([string]$Request.command)
        $hasArgv=(Has-Field $Request 'argv') -and @($Request.argv).Count -gt 0
        if($hasCommand -eq $hasArgv) {Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Supply one command or argument vector.'}
        $seconds=60
        if(Has-Field $Request 'timeoutSeconds') {$seconds=[int]$Request.timeoutSeconds}
        if($seconds -lt 1 -or $seconds -gt 600) {Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Command timeout must be 1 to 600 seconds.'}
        $record=@{jobId=[string]$Request.jobId;rootIdentity=$script:RootIdentity;state='starting';cleanupConfirmed=$false;ownerPid=$PID;ownerStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')}
        $mappedArgv=@()
        if($hasArgv) {
            foreach($argument in @($Request.argv)) {
                $value=[string]$argument
                if($value -eq '/workspace' -or $value.StartsWith('/workspace/')) { $value=Resolve-ProjectPath $value }
                $mappedArgv+=,$value
            }
        }
        $data=@{command=$Request.command;argv=$mappedArgv}|ConvertTo-Json -Depth 4 -Compress
        $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($data))
        $run='$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$OutputEncoding=[Console]::OutputEncoding;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'+$encoded+'"))|ConvertFrom-Json;$global:LASTEXITCODE=0;try{if($p.command){& ([ScriptBlock]::Create([string]$p.command))}else{$a=@($p.argv);$exe=[string]$a[0];$rest=@();if($a.Length -gt 1){$rest=$a[1..($a.Length-1)]};& $exe @rest};$success=$?;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};if(!$success){exit 1};exit 0}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}'
        $executable=[IO.Path]::Combine($env:SystemRoot,'System32\WindowsPowerShell\v1.0\powershell.exe')
        $commandLine='"'+$executable+'" -NoLogo -NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($run))
        $variables=New-Object 'System.Collections.Generic.SortedDictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach($key in @('SystemRoot','SystemDrive','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS')) { $value=[Environment]::GetEnvironmentVariable($key);if($value){$variables[$key]=$value} }
        $environment='';foreach($pair in $variables.GetEnumerator()){$environment+=$pair.Key+'='+$pair.Value+[char]0};$environment+=[char]0
        $null=[IO.Directory]::CreateDirectory($directory)
        $claim=[IO.Path]::Combine($directory,'claimed')
        # Keep this handle open until a terminal record is published. Cancellation
        # can distinguish a dead pre-state executor from one still preparing.
        try {$claimStream=[IO.File]::Open($claim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$claimBytes=$script:Utf8.GetBytes('claim-v2:'+$script:RootIdentity);$claimStream.Write($claimBytes,0,$claimBytes.Length);$claimStream.Flush($true)}
        catch {Fail 'SSH_JOB_EXISTS' 'The command ID was already used; commands are never replayed.'}
        $job=$null;$timedOut=$false;$cancelled=$false
        try {
            Save-Job $directory $record
            $cancelFile=[IO.Path]::Combine($directory,'cancel')
            if([IO.File]::Exists($cancelFile)) {$record.state='cancelled';$record.cleanupConfirmed=$true;$record.exitCode=130;Save-Job $directory $record;return @{jobId=$record.jobId;state='cancelled';cleanupConfirmed=$true;cancelled=$true;stdout='';stderr='';exitCode=130}}
            $job=New-Object ChisaWorkspaceJob((Job-Name $record.jobId),$executable,$commandLine,$cwd,$environment)
            $record.state='running';$record.childPid=$job.Pid;$record.childStartedAt=$job.StartTime;Save-Job $directory $record
            $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
            while(!$job.Exited) {
                if([IO.File]::Exists($cancelFile)) {$cancelled=$true;$job.Stop(130);break}
                if([DateTime]::UtcNow -ge $deadline) {$timedOut=$true;$job.Stop(124);break}
                Start-Sleep -Milliseconds 50
            }
            # Background descendants must not outlive this foreground operation.
            if($job.ActiveProcesses -gt 0) {$job.Stop($(if($timedOut){124}elseif($cancelled){130}else{0}))}
            $drainEnd=[DateTime]::UtcNow.AddSeconds(5)
            while($job.ActiveProcesses -gt 0 -and [DateTime]::UtcNow -lt $drainEnd) {Start-Sleep -Milliseconds 20}
            if($job.ActiveProcesses -gt 0) {Fail 'SSH_EXECUTION_UNCONFIRMED' 'Windows command process cleanup was not confirmed.'}
            $stdout=$job.Stdout;$stderr=$job.Stderr;$exit=$job.ExitCode
            if($timedOut){$exit=124};if($cancelled){$exit=130}
            $record.state=$(if($timedOut){'timed_out'}elseif($cancelled){'cancelled'}else{'completed'});$record.cleanupConfirmed=$true;$record.exitCode=$exit
            Save-Job $directory $record
            return @{jobId=$record.jobId;state=$record.state;stdout=$stdout.Text;stderr=$stderr.Text;exitCode=$exit;truncated=($stdout.Truncated -or $stderr.Truncated);cleanupConfirmed=$true;timedOut=$timedOut;cancelled=$cancelled}
        } catch {
            # Any postclaim refusal before a child exists is terminal. Once a
            # child was created, dispose its kill-on-close job and confirm zero.
            if($job){$job.Dispose();$job=$null}
            if([ChisaWorkspaceJob]::Active((Job-Name $record.jobId)) -eq 0) {
                $record.state='interrupted';$record.cleanupConfirmed=$true;$record.exitCode=1
                Save-Job $directory $record
            }
            throw
        } finally {if($job){$job.Dispose()};$claimStream.Dispose()}
    }
    function Invoke-Operation($Request) {
        $op=[string]$Request.op
        if($op -eq 'probe') { return @{rootPath=$script:Root;rootIdentity=$script:RootIdentity;username=[Security.Principal.WindowsIdentity]::GetCurrent().Name;capabilities=@{files=$true;exec=$true;terminal=$false}} }
        if($op -eq 'job_status' -or $op -eq 'job_cancel') {return Job-Status ([string]$Request.jobId) ($op -eq 'job_cancel')}
        if($op -eq 'exec') {return Run-Command $Request}
        if($op -eq 'batch') {
            $rows=@($Request.requests)
            if($rows.Count -lt 1 -or $rows.Count -gt 64){Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Batch requires 1 to 64 file operations.'}
            $results=New-Object 'System.Collections.Generic.List[object]'
            foreach($row in $rows) {
                if(@('stat','lstat','list','realpath','read','search','grep') -notcontains [string]$row.op){Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Batch supports file inspection only.'}
                $results.Add((Invoke-Operation $row))
            }
            return @{results=@($results.ToArray())}
        }
        $p=Resolve-ProjectPath ([string]$Request.path) ($op -eq 'mkdir' -and $Request.recursive -eq $true)
        switch($op) {
            {$_ -eq 'stat' -or $_ -eq 'lstat'} {return File-Stats $p}
            'realpath' {$null=File-Stats $p;return @{path=(Virtual-Path $p)}}
            'list' {
                $null=Lock-Directory $p
                $entries=New-Object 'System.Collections.Generic.List[object]';$cut=$false
                foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($p)) {
                    if($entries.Count -ge $script:MaxEntries){$cut=$true;break}
                    try {$s=File-Stats $entry} catch {continue}
                    $item=@{name=[IO.Path]::GetFileName($entry);dir=$s.dir}
                    if($Request.includeStats -eq $true){$item.stats=$s}
                    $entries.Add($item)
                }
                return @{entries=@($entries.ToArray());truncated=$cut}
            }
            'read' {return Read-File $p}
            'write' {
                if(!(Has-Field $Request 'expectedHash')){Fail 'CONTENT_CONFLICT' 'Read the file before writing; expectedHash is required.'}
                if([string]$Request.b64 -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'){Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Invalid base64 content.'}
                $bytes=[Convert]::FromBase64String([string]$Request.b64)
                if($bytes.Length -gt $script:MaxFile){Fail 'FILE_TOO_LARGE' 'Project files are limited to 8 MiB.'}
                $create=$null -eq $Request.expectedHash
                if(!$create -and [string]$Request.expectedHash -notmatch '^[a-f0-9]{64}$'){Fail 'CONTENT_CONFLICT' 'A current SHA256 file hash is required.'}
                try {$stream=[ChisaWorkspaceNative]::WriteFile($p,$create)}
                catch {if($create -and [IO.File]::Exists($p)){Fail 'CONTENT_CONFLICT' 'The file already exists.'};if(!$create -and ![IO.File]::Exists($p)){Fail 'CONTENT_CONFLICT' 'The file was removed.'};Fail 'SSH_WORKSPACE_PATH_UNSAFE' 'The file is locked, linked or inaccessible.'}
                try {
                    if(!$create){if($stream.Length -gt $script:MaxFile -or (Hash-Stream $stream) -ne [string]$Request.expectedHash){Fail 'CONTENT_CONFLICT' 'File contents changed; read the file again.'}}
                    $stream.Position=0;$stream.SetLength(0);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
                    return @{hash=(Hash-Stream $stream)}
                } finally {$stream.Dispose()}
            }
            'mkdir' {
                if($p -eq $script:Root){return @{}}
                if($Request.recursive -eq $true){$p=Resolve-ProjectPath (([string]$Request.path).TrimEnd('/')+'/__chisa_parent_probe__') $true;$p=[IO.Path]::GetDirectoryName($p)}
                else{$null=[IO.Directory]::CreateDirectory($p)}
                $null=Lock-Directory $p
                return @{}
            }
            'rename' {
                if($p -eq $script:Root){Fail 'SSH_WORKSPACE_PATH_INVALID' 'The project root cannot be renamed.'}
                $s=File-Stats $p;$dest=Resolve-ProjectPath ([string]$Request.destination)
                if([IO.File]::Exists($dest)-or[IO.Directory]::Exists($dest)){Fail 'CONTENT_CONFLICT' 'The destination already exists.'}
                if($s.dir){[IO.Directory]::Move($p,$dest)}else{[IO.File]::Move($p,$dest)}
                return @{}
            }
            'copy' {
                $dest=Resolve-ProjectPath ([string]$Request.destination)
                $read=$null;$write=$null
                try{$read=[ChisaWorkspaceNative]::ReadFile($p);if($read.Length -gt $script:MaxFile){Fail 'FILE_TOO_LARGE' 'Project files are limited to 8 MiB.'};$write=[ChisaWorkspaceNative]::WriteFile($dest,$true);$read.CopyTo($write);$write.Flush($true);return @{}}
                finally {if($write){$write.Dispose()};if($read){$read.Dispose()}}
            }
            'remove' {
                if($p.Equals($script:Root,[StringComparison]::OrdinalIgnoreCase)){Fail 'SSH_WORKSPACE_PATH_INVALID' 'The project root cannot be removed.'}
                $removeStats=File-Stats $p
                if($removeStats.dir -and $Request.recursive -ne $true){[IO.Directory]::Delete($p,$false)}else{Safe-Remove $p}
                return @{}
            }
            'search' {return Safe-Search $p ([string]$Request.query) $false}
            'grep' {return Safe-Search $p ([string]$Request.query) $true}
            default {Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Unsupported workspace operation.'}
        }
    }

    $textBuilder=New-Object Text.StringBuilder
    $buffer=New-Object char[] 8192
    while(($read=[Console]::In.Read($buffer,0,$buffer.Length)) -gt 0){$null=$textBuilder.Append($buffer,0,$read);if($textBuilder.Length -gt 12*1024*1024){Fail 'SSH_WORKSPACE_REQUEST_TOO_LARGE' 'Workspace input exceeds the allowed size.'}}
    try {$envelope=$textBuilder.ToString()|ConvertFrom-Json} catch {Fail 'SSH_WORKSPACE_REQUEST_INVALID' 'Workspace input must be valid JSON.'}
    if($envelope.protocol -ne 1 -or !(Has-Field $envelope 'request')){Fail 'SSH_WORKSPACE_PROTOCOL_INVALID' 'Unsupported workspace helper protocol.'}
    Initialize-Root ([string]$envelope.rootPath)
    if((Has-Field $envelope 'expectedRootIdentity') -and $envelope.expectedRootIdentity -and [string]$envelope.expectedRootIdentity -ne $script:RootIdentity){Fail 'SSH_WORKSPACE_CHANGED' 'The physical workspace directory changed; verify its binding again.'}
    $script:JobBase=[IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'ChisaCloudCode','ssh-workspace-jobs','v1')
    if($script:JobBase.StartsWith($script:Root+'\',[StringComparison]::OrdinalIgnoreCase)){Fail 'SSH_HELPER_UNSAFE' 'Workspace task state must be outside the project.'}
    $null=[IO.Directory]::CreateDirectory($script:JobBase)
    $result=Invoke-Operation $envelope.request
    $result.ok=$true;$result.protocol=1;$result.platform='win32';$result.helperVersion='1.0.2';$result.rootIdentity=$script:RootIdentity
    [Console]::Out.Write(($result|ConvertTo-Json -Depth 32 -Compress))
} catch {
    $code='SSH_WORKSPACE_OPERATION_FAILED';$message='Windows workspace operation failed.'
    $errorValue=$_.Exception
    if ($env:CHISA_SSH_HELPER_DIAGNOSTICS -eq '1') { [Console]::Error.WriteLine($_.ToString() + ' at ' + $_.ScriptStackTrace) }
    while($errorValue){
        if($errorValue.Data -and $errorValue.Data['Code']){$code=[string]$errorValue.Data['Code'];$message=$errorValue.Message;break}
        if($errorValue -is [UnauthorizedAccessException]){$code='EACCES';$message='Windows account cannot access this project path.'}
        if($errorValue -is [IO.FileNotFoundException] -or $errorValue -is [IO.DirectoryNotFoundException]){$code='ENOENT';$message='Project path does not exist.'}
        $errorValue=$errorValue.InnerException
    }
    $failure=@{ok=$false;protocol=1;platform='win32';code=$code;error=$message}
    if($script:RootIdentity){$failure.rootIdentity=$script:RootIdentity}
    [Console]::Out.Write(($failure|ConvertTo-Json -Compress))
    exit 1
} finally {
    foreach($lease in $script:Leases){$lease.Dispose()}
}
