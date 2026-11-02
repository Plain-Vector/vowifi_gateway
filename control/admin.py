#!/usr/bin/env python3
"""Local administrator recovery. Uses VOWIFI_DATA; never accepts passwords in argv."""
import getpass
from app import auth


def main():
    auth.init()
    if not auth.configured():
        print('Use the WebUI and the one-time code in VOWIFI_DATA/auth/setup-code for first setup.')
        return
    password = getpass.getpass('New administrator password (at least 12 characters): ')
    if len(password) < 12 or len(password) > 256 or password != getpass.getpass('Repeat password: '):
        raise SystemExit('Password length or confirmation invalid')
    with auth.conn() as c:
        c.execute('UPDATE admin SET password=?', (auth.password_hash(password),))
        c.execute('DELETE FROM sessions')
        c.execute('DELETE FROM attempts')
    print('Administrator password reset; all sessions revoked.')


if __name__ == '__main__': main()
