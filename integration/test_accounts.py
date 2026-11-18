import hashlib
import hmac
import sqlite3
import unittest
from uuid import uuid4
from accounts_core import AccountError, initialize_accounts, create_account, update_account, account_list, link_account, provision_shared_session
from datetime import datetime, timezone


class Connection:
    def __init__(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        def factory(cursor, row):
            result = {description[0]: value for description, value in zip(cursor.description, row)}
            if 'active' in result:
                result['active'] = bool(result['active'])
            return result
        self.db.row_factory = factory
        self.db.executescript('''CREATE TABLE admins(id text PRIMARY KEY,username text UNIQUE,password_hash text);
        CREATE TABLE sessions(token_hash text PRIMARY KEY,actor_id text,role text,expires_at text);''')
        self.original = str(uuid4())
        self.db.execute('INSERT INTO admins VALUES(?,?,?)', (self.original, 'original', 'legacy-hash'))
        self.db.commit()
        with self.db:
            initialize_accounts(self)

    def execute(self, sql, args=()):
        if 'pg_advisory_xact_lock' in sql:
            return self.db.execute('SELECT 1')
        sql = sql.replace('ADD COLUMN IF NOT EXISTS', 'ADD COLUMN').replace('%s', '?').replace(' FOR UPDATE', '').replace('now()', 'CURRENT_TIMESTAMP')
        return self.db.execute(sql, tuple(v.isoformat() if isinstance(v, datetime) else v for v in args))


class AccountTests(unittest.TestCase):
    def test_existing_accounts_and_create(self):
        conn = Connection()
        self.assertTrue(account_list(conn)[0]['active'])
        with conn.db:
            result = create_account(conn, {'username': 'New.Admin', 'password': 'new-password-123'}, 'dc-admin')
        self.assertEqual(result['username'], 'new.admin')
        account = conn.execute('SELECT * FROM admins WHERE id=?', (result['id'],)).fetchone()
        salt, digest = account['password_hash'].split(':')
        self.assertTrue(hmac.compare_digest(digest, hashlib.scrypt(b'new-password-123', salt=salt.encode(), n=16384, r=8, p=1).hex()))
        self.assertTrue(all(set(a) == {'id', 'username', 'active', 'central_id'} for a in account_list(conn)))
        with self.assertRaises(AccountError) as error, conn.db:
            create_account(conn, {'username': 'NEW.ADMIN', 'password': 'new-password-123'}, 'dc-admin')
        self.assertEqual(error.exception.status, 409)

    def test_disable_revoke_and_last_admin(self):
        conn = Connection()
        with conn.db:
            other = create_account(conn, {'username': 'other', 'password': 'new-password-123'}, 'dc-admin')
            conn.execute('INSERT INTO sessions(token_hash,actor_id,role) VALUES(?,?,?)', ('token', other['id'], 'admin'))
        with conn.db:
            result = update_account(conn, other['id'], {'username': 'renamed', 'active': False}, 'dc-admin')
        self.assertFalse(result['active'])
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM sessions').fetchone()['n'], 0)
        with self.assertRaises(AccountError) as error, conn.db:
            update_account(conn, conn.original, {'active': False}, 'dc-admin')
        self.assertEqual(error.exception.status, 409)
        self.assertTrue(conn.execute('SELECT active FROM admins WHERE id=?', (conn.original,)).fetchone()['active'])
        with conn.db:
            update_account(conn, other['id'], {'active': True}, 'dc-admin')
        self.assertTrue(conn.execute('SELECT active FROM admins WHERE id=?', (other['id'],)).fetchone()['active'])

    def test_password_reset_validation_and_audit(self):
        conn = Connection()
        with conn.db:
            conn.execute('INSERT INTO sessions(token_hash,actor_id,role) VALUES(?,?,?)', ('admin-token', conn.original, 'admin'))
            conn.execute('INSERT INTO sessions(token_hash,actor_id,role) VALUES(?,?,?)', ('worker-token', conn.original, 'worker'))
            update_account(conn, conn.original, {'password': 'replacement-password'}, 'dc-admin', True)
        self.assertEqual(conn.execute('SELECT role FROM sessions').fetchone()['role'], 'worker')
        audit = conn.execute('SELECT * FROM hdc_account_audit').fetchall()
        self.assertEqual(audit[0]['action'], 'account.password')
        self.assertNotIn('replacement-password', str(audit))
        for data in [{'password': 'short'}, {'password': None}]:
            with self.assertRaises(AccountError), conn.db:
                update_account(conn, conn.original, data, 'dc-admin', True)
        with self.assertRaises(AccountError), conn.db:
            update_account(conn, conn.original, {'active': 'false'}, 'dc-admin')
        with self.assertRaises(AccountError), conn.db:
            update_account(conn, 'bad-id', {'active': True}, 'dc-admin')

    def test_link_preserves_id_and_prevents_local_password_changes(self):
        conn = Connection()
        central_id = str(uuid4())
        with conn.db:
            conn.execute('INSERT INTO sessions(token_hash,actor_id,role) VALUES(?,?,?)', ('old', conn.original, 'admin'))
            result = link_account(conn, conn.original, {'central_id': central_id, 'username': 'original'}, 'dc-admin')
        self.assertEqual(result['id'], conn.original)
        self.assertEqual(result['central_id'], central_id)
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM sessions').fetchone()['n'], 0)
        with self.assertRaises(AccountError), conn.db:
            update_account(conn, conn.original, {'password': 'bypass-password'}, 'dc-admin', True)
        with self.assertRaises(AccountError), conn.db:
            link_account(conn, conn.original, {'central_id': str(uuid4()), 'username': 'original'}, 'dc-admin')

    def test_shared_session_does_not_overwrite_colliding_legacy_account(self):
        conn = Connection()
        identity = {'id': str(uuid4()), 'username': 'original', 'token': 'x' * 43, 'expires': int(datetime.now(timezone.utc).timestamp() * 1000) + 28800000}
        class Response:
            def set_cookie(self, *args, **kwargs):
                self.cookie = (args, kwargs)
        response = Response()
        with self.assertRaises(AccountError) as error, conn.db:
            provision_shared_session(conn, identity, response, 'session')
        self.assertEqual(error.exception.status, 409)
        self.assertIsNone(conn.execute('SELECT central_id FROM admins WHERE id=?', (conn.original,)).fetchone()['central_id'])
        with conn.db:
            link_account(conn, conn.original, {'central_id': identity['id'], 'username': 'original'}, 'dc-admin')
            session = provision_shared_session(conn, identity, response, 'session')
        self.assertEqual(session['id'], conn.original)
        self.assertTrue(response.cookie[1]['httponly'])
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM hdc_shared_sessions').fetchone()['n'], 1)


if __name__ == '__main__':
    unittest.main()
