#!/usr/bin/env python3
"""Hold an exclusive OS lock (flock) on a file for as long as stdin stays open.

Usage: issue-work-lock.py LOCKFILE TIMEOUT_SECONDS

Prints "locked" once the lock is held, then blocks reading stdin. When stdin closes
(the parent released it, or the parent died), the process exits and the kernel releases
the lock, so a crashed holder never leaves a stale lock behind. Prints "busy" and exits 2
when the lock cannot be taken within the timeout.
"""
import fcntl
import os
import sys
import time


def main():
    path, timeout = sys.argv[1], float(sys.argv[2])
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                print('busy', flush=True)
                sys.exit(2)
            time.sleep(0.05)
    print('locked', flush=True)
    sys.stdin.read()  # until the parent closes stdin or dies


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(1)
