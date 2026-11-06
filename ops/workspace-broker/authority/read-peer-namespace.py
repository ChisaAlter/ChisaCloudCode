#!/usr/bin/env python3
"""Fixed least-privilege namespace reader for a kernel-observed peer PID.

Only the root front/signer invoke this operator-installed program. There is no
API-selected executable, source path or operation. The child clears supplementary
and ambient privileges and adopts the peer's observed effective UID/GID before
reading its one fixed proc symlink. A non-dumpable target remains unavailable.
"""
import ctypes
import os
import re
import sys


def main():
    if os.name != 'posix' or os.getuid() != 0 or len(sys.argv) != 4 or any(not re.fullmatch(r'[0-9]{1,10}', item) for item in sys.argv[1:]):
        raise ValueError('AUTHORITY_NAMESPACE_HELPER_INPUT')
    pid, uid, gid = (int(item) for item in sys.argv[1:])
    if not 0 < pid <= 2147483647 or not 0 <= uid <= 2147483647 or not 0 <= gid <= 2147483647:
        raise ValueError('AUTHORITY_NAMESPACE_HELPER_INPUT')
    libc = ctypes.CDLL(None, use_errno=True)
    # Neither exec nor a set-id path can restore a privilege after this point.
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'AUTHORITY_NAMESPACE_NO_NEW_PRIVS')
    if libc.prctl(47, 4, 0, 0, 0) != 0:  # PR_CAP_AMBIENT_CLEAR_ALL
        raise OSError(ctypes.get_errno(), 'AUTHORITY_NAMESPACE_AMBIENT')
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
    header = Header(0x20080522, 0)  # Linux capability ABI version 3
    capabilities = (Data * 2)()
    if libc.capset(ctypes.byref(header), ctypes.byref(capabilities)) != 0:
        raise OSError(ctypes.get_errno(), 'AUTHORITY_NAMESPACE_CAP_DROP')
    with open('/proc/self/status', encoding='ascii') as stream:
        status = stream.read()
    if any(int(re.search(r'^' + name + r':\s*([0-9a-fA-F]+)$', status, re.M).group(1), 16) != 0 for name in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb')):
        raise ValueError('AUTHORITY_NAMESPACE_CAP_RETAINED')
    if (os.getuid(), os.geteuid(), os.getgid(), os.getegid(), os.getgroups()) != (uid, uid, gid, gid, []):
        raise ValueError('AUTHORITY_NAMESPACE_IDENTITY')
    result = os.readlink('/proc/' + str(pid) + '/ns/pid')
    if not re.fullmatch(r'pid:\[[0-9]{1,20}\]', result):
        raise ValueError('AUTHORITY_NAMESPACE_VALUE')
    sys.stdout.write(result + '\n')


if __name__ == '__main__':
    main()
