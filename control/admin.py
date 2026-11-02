#!/usr/bin/env python3
"""Local administrator setup/recovery. Passwords are prompted privately, never argv."""
import argparse
import getpass
import json
from pathlib import Path
import re

from app import auth, config


def read_password():
    password = getpass.getpass('Administrator password (at least 12 characters): ')
    if len(password) < 12 or len(password) > 256:
        raise SystemExit('Use a password of 12–256 characters')
    if password != getpass.getpass('Repeat password: '):
        raise SystemExit('Passwords do not match')
    return password


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('setup', 'password', 'status'), nargs='?', default='password')
    parser.add_argument('--optional', action='store_true', help='Ask whether to create the first account now')
    args = parser.parse_args()
    auth.init()
    exists = auth.configured()
    if args.command == 'status':
        print(json.dumps({'configured': exists}))
        return
    if args.command == 'setup':
        if exists:
            print('Administrator already configured. Existing account was preserved.')
            return
        if args.optional and input('Create the administrator now? [Y/n] ').strip().lower() in ('n', 'no'):
            print('Web setup is ready; run install.sh setup-code to display its one-time code.')
            return
        username = input('Administrator username [admin]: ').strip() or 'admin'
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', username):
            raise SystemExit('Invalid username')
        password = read_password()
        with auth._lock, auth.conn() as c:
            if c.execute('SELECT 1 FROM admin').fetchone():
                raise SystemExit('Administrator was already created; no changes made')
            c.execute('INSERT INTO admin VALUES(1,?,?)', (username, auth.password_hash(password)))
        (Path(config.DATA_DIR) / 'auth/setup-code').unlink(missing_ok=True)
        print(f'Administrator {username} created. Sign in to the WebUI; no setup code is needed.')
        return
    if not exists:
        raise SystemExit('No administrator yet. Run install.sh setup-admin or use the WebUI setup code.')
    password = read_password()
    with auth.conn() as c:
        c.execute('UPDATE admin SET password=?', (auth.password_hash(password),))
        c.execute('DELETE FROM sessions')
        c.execute('DELETE FROM attempts')
    print('Administrator password reset; all sessions revoked.')


if __name__ == '__main__':
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        raise SystemExit('Administrator setup cancelled; no password was saved')
