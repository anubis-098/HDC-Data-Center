import json
import sqlite3
import unittest
from sync_core import validate_snapshot, apply_snapshot, CenterClient


class Connection:
    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA foreign_keys=ON;
        CREATE TABLE stores(code text PRIMARY KEY,name text,active boolean,deleted_at text,memberships text NOT NULL DEFAULT '[]');
        CREATE TABLE shipments(store_code text REFERENCES stores(code),store_name text);
        CREATE TABLE hdc_store_sync(id integer PRIMARY KEY,source text,version integer,last_success text,last_error text,store_count integer);
        INSERT INTO stores(code,name,active,deleted_at) VALUES('1','Historical Store',1,NULL),('legacy','Legacy',1,NULL);
        INSERT INTO shipments VALUES('1','Historical Store');''')

    def execute(self, sql, args=()):
        if 'pg_advisory_xact_lock' in sql:
            return self.db.execute('SELECT 1')
        return self.db.execute(sql.replace('%s', '?').replace(' FOR UPDATE', '').replace('now()', 'CURRENT_TIMESTAMP'), args)


class StoreSyncTests(unittest.TestCase):
    def test_explicit_delete_all_disables_stores_but_keeps_history(self):
        conn = Connection()
        with conn.db:
            apply_snapshot(conn, 'http://center', {'version': 1, 'stores': [{'code': '1', 'name': 'Current', 'active': True}]})
        with self.assertRaises(ValueError), conn.db:
            apply_snapshot(conn, 'http://center', {'version': 2, 'stores': []})
        with conn.db:
            result = apply_snapshot(conn, 'http://center', {'version': 2, 'stores': [], 'allow_empty': True})
        self.assertEqual(result['store_count'], 0)
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM stores WHERE active=true').fetchone()['n'], 0)
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM stores WHERE deleted_at IS NULL').fetchone()['n'], 0)
        self.assertEqual(conn.execute('SELECT store_name FROM shipments').fetchone()['store_name'], 'Historical Store')
        with conn.db:
            apply_snapshot(conn, 'http://center', {'version': 3, 'stores': [{'code': '1', 'name': 'Reimported', 'active': True}]})
        self.assertEqual(conn.execute("SELECT active FROM stores WHERE code='1'").fetchone()['active'], 1)
        self.assertIsNone(conn.execute("SELECT deleted_at FROM stores WHERE code='1'").fetchone()['deleted_at'])

    def test_same_version_hides_old_cache_rows_from_management(self):
        conn = Connection()
        payload = {'version': 1, 'stores': [{'code': '1', 'name': 'Current Store', 'active': True}]}
        with conn.db:
            apply_snapshot(conn, 'http://center', payload)
            conn.execute("UPDATE stores SET deleted_at=NULL WHERE code='legacy'")
            apply_snapshot(conn, 'http://center', payload)
        self.assertIsNotNone(conn.execute("SELECT deleted_at FROM stores WHERE code='legacy'").fetchone()['deleted_at'])
        self.assertIsNone(conn.execute("SELECT deleted_at FROM stores WHERE code='1'").fetchone()['deleted_at'])

    def test_memberships_replicate_and_invalid_categories_rollback(self):
        conn = Connection()
        links = [{'group': '1PX', 'category': 'Transfer CDC'}, {'group': 'HLE', 'category': 'Direct'}]
        record = {'code': '1', 'name': 'Grouped Store', 'active': True, 'memberships': links}
        with conn.db:
            apply_snapshot(conn, 'http://center', {'version': 1, 'stores': [record]})
        self.assertEqual(json.loads(conn.execute("SELECT memberships FROM stores WHERE code='1'").fetchone()['memberships']), links)
        for invalid in [[{'group': 'HLE', 'category': 'Transfer CDC'}], links + links, 'HLE']:
            with self.assertRaises(ValueError), conn.db:
                apply_snapshot(conn, 'http://center', {'version': 2, 'stores': [{**record, 'memberships': invalid}]})
        self.assertEqual(conn.execute('SELECT version FROM hdc_store_sync').fetchone()['version'], 1)

    def test_cache_history_and_status(self):
        conn = Connection()
        payload = {'version': 1, 'stores': [{'code': '1', 'name': 'Current Store', 'active': True}, {'code': '002', 'name': 'Closed Store', 'active': False}]}
        with conn.db:
            result = apply_snapshot(conn, 'http://center', payload)
        self.assertEqual(result, {'version': 1, 'store_count': 2})
        self.assertEqual(conn.execute("SELECT name FROM stores WHERE code='1'").fetchone()['name'], 'Current Store')
        self.assertEqual(conn.execute("SELECT store_name FROM shipments").fetchone()['store_name'], 'Historical Store')
        self.assertEqual(conn.execute("SELECT active FROM stores WHERE code='legacy'").fetchone()['active'], 0)
        self.assertEqual(conn.execute("SELECT active FROM stores WHERE code='002'").fetchone()['active'], 0)
        with conn.db:
            apply_snapshot(conn, 'http://center', payload)
        self.assertEqual(conn.execute('SELECT count(*) AS n FROM stores').fetchone()['n'], 3)
        with self.assertRaises(ValueError), conn.db:
            apply_snapshot(conn, 'http://center', {'version': 0, 'stores': []})
        self.assertEqual(conn.execute("SELECT active FROM stores WHERE code='1'").fetchone()['active'], 1)

    def test_validation_rejects_partial_or_invalid_snapshot(self):
        good = {'code': '001', 'name': 'Store', 'active': True}
        for payload in [{'version': True, 'stores': [good]}, {'version': 1, 'stores': []}, {'version': 1, 'stores': [good, good]}, {'version': 1, 'stores': [{**good, 'active': 'true'}]}, {'version': 1, 'stores': [{**good, 'code': 'bad code'}]}, {'version': 1, 'stores': [{**good, 'name': ''}]}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                validate_snapshot(payload)

    def test_rollback_and_older_version(self):
        conn = Connection()
        with conn.db:
            apply_snapshot(conn, 'http://center', {'version': 2, 'stores': [{'code': '1', 'name': 'New', 'active': True}]})
        with self.assertRaises(ValueError), conn.db:
            apply_snapshot(conn, 'http://center', {'version': 1, 'stores': [{'code': '1', 'name': 'Old', 'active': False}]})
        self.assertEqual(conn.execute("SELECT name FROM stores WHERE code='1'").fetchone()['name'], 'New')
        conn.execute("CREATE TRIGGER reject_write BEFORE INSERT ON stores WHEN NEW.code='bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError), conn.db:
            apply_snapshot(conn, 'http://center', {'version': 3, 'stores': [{'code': '1', 'name': 'Should roll back', 'active': False}, {'code': 'bad', 'name': 'Rejected', 'active': True}]})
        self.assertEqual(conn.execute("SELECT name,active FROM stores WHERE code='1'").fetchone()['name'], 'New')
        self.assertEqual(conn.execute('SELECT version FROM hdc_store_sync').fetchone()['version'], 2)

    def test_client_configuration(self):
        for url in ['file:///data', 'http://user:pass@host', 'http://host/?key=secret']:
            with self.assertRaises(ValueError):
                CenterClient(url, 'key')


if __name__ == '__main__':
    unittest.main()
