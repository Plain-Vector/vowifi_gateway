import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from app import auth
import admin
from conftest import ROOT


def test_installer_is_executable_and_help_explains_account_setup():
    path = ROOT / 'install.sh'
    assert os.access(path, os.X_OK)
    result = subprocess.run([str(path), '--help'], capture_output=True, text=True, check=True)
    for command in ('setup-admin', 'setup-code', 'reset-password'):
        assert command in result.stdout
    subprocess.run(['sh', '-n', str(path)], check=True)


def test_terminal_admin_setup_is_private_idempotent_and_consumes_code(db, monkeypatch, capsys):
    secret = 'terminal-test-password-42'
    monkeypatch.setattr(sys, 'argv', ['admin.py','setup'])
    with patch('builtins.input',return_value='admin'), patch.object(admin.getpass,'getpass',return_value=secret):
        admin.main()
    assert auth.configured() and not (db/'auth/setup-code').exists()
    output = capsys.readouterr().out
    assert secret not in output
    with auth.conn() as c:
        stored = c.execute('SELECT password FROM admin').fetchone()[0]
    assert auth.password_matches(secret, stored)
    with patch.object(admin.getpass,'getpass',side_effect=AssertionError('Must preserve existing account')):
        admin.main()
    with auth.conn() as c:
        assert c.execute('SELECT password FROM admin').fetchone()[0] == stored


def test_terminal_setup_can_be_skipped_without_opening_admin(db, monkeypatch):
    monkeypatch.setattr(sys,'argv',['admin.py','setup','--optional'])
    with patch('builtins.input',return_value='n'):
        admin.main()
    assert not auth.configured() and (db/'auth/setup-code').exists()
