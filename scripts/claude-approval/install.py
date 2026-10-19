#!/usr/bin/env python3
"""Idempotently link claude-feishu into ~/.local/bin; never edit shell config."""
import os
from pathlib import Path
import shlex
import shutil
import sys


def install():
    source = Path(__file__).resolve().with_name('claude-feishu')
    if not source.is_file() or not source.with_name('launch.py').is_file() or not os.access(source, os.X_OK):
        raise ValueError('Repository entry/launch.py is missing or entry is not executable')
    target = Path.home() / '.local' / 'bin' / 'claude-feishu'
    existing = shutil.which('claude-feishu')
    if existing and Path(existing).resolve() != source:
        raise ValueError('A different claude-feishu command already exists on PATH; nothing replaced')
    if os.path.lexists(target):
        if not target.is_symlink() or target.resolve() != source:
            raise ValueError('~/.local/bin/claude-feishu already exists; nothing replaced')
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(source)  # Exclusive creation: never replace a raced-in file.
    print('Installed: ' + str(target))
    print('Repository must remain at: ' + str(source.parent.parent.parent))
    print('For this shell only, if needed: export PATH=' + shlex.quote(str(target.parent)) + ':"$PATH"')
    print('No shell configuration, Claude settings, credentials or services changed.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise ValueError('install.py accepts no arguments')
        install()
    except (ValueError, OSError) as error:
        print('Install failed: ' + (str(error) if isinstance(error, ValueError) else 'filesystem operation failed; nothing overwritten'), file=sys.stderr)
        sys.exit(2)
