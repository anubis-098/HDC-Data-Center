import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
from datetime import datetime, timezone
from uuid import uuid4
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from test_accounts import Connection
from accounts_core import link_account
from shared_identity import IdentityFailure


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class FakeApp:
    router = types.SimpleNamespace(lifespan_context=None)
    def route(self, *args, **kwargs):
        return lambda fn: fn
    middleware = get = post = put = route


class AccountSecurityTests(unittest.TestCase):
    def test_disabled_identity_login_and_management_key_isolation(self):
        conn = Connection()
        @contextmanager
        def connect():
            yield conn
        security = types.ModuleType('app.core.security')
        security.identity = lambda request, role: {'id': conn.original, 'role': role, 'name': 'original'}
        exec("def admin(request):\n    return identity(request, 'admin')", security.__dict__)
        fastapi = types.ModuleType('fastapi')
        fastapi.Depends = lambda value: value
        fastapi.HTTPException = HTTPException
        fastapi.Request = object
        responses = types.ModuleType('fastapi.responses')
        class Response:
            def __init__(self, body, status_code):
                self.body, self.status_code, self.cookies = body, status_code, {}
            def set_cookie(self, name, value, **options):
                self.cookies[name] = value
        responses.JSONResponse = Response
        security.settings = lambda: types.SimpleNamespace(cookie_secure=False)
        modules = {'fastapi': fastapi, 'fastapi.responses': responses,
                   'app': types.ModuleType('app'), 'app.main': types.SimpleNamespace(app=FakeApp()),
                   'app.core': types.SimpleNamespace(security=security), 'app.core.security': security,
                   'app.db': types.ModuleType('app.db'), 'app.db.connection': types.SimpleNamespace(connect=connect)}
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, modules), patch.dict(os.environ, {
            'HDC_DATA_CENTER_URL': 'http://center', 'HDC_DATA_CENTER_API_KEY': 'store-read-key',
            'HDC_ACCOUNT_MANAGEMENT_KEY_FILE': str(Path(folder) / 'management.key')
        }):
            spec = importlib.util.spec_from_file_location('bridge_security_test', Path(__file__).with_name('hdc_bridge.py'))
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            bridge.identity_request = lambda endpoint, payload: {'mode': 'local'}
            request = types.SimpleNamespace(headers={})
            self.assertEqual(security.admin(request)['id'], conn.original)
            conn.execute('UPDATE admins SET active=false WHERE id=?', (conn.original,))
            with self.assertRaises(HTTPException) as error:
                security.admin(request)
            self.assertEqual(error.exception.status_code, 401)
            async def body():
                return {'username': 'original', 'password': 'irrelevant-password'}
            request.url = types.SimpleNamespace(path='/api/admin/login')
            request.method, request.json = 'POST', body
            login_checks = []
            async def original_login(_):
                login_checks.append('password and rate limit checked')
                conn.execute('INSERT INTO sessions(token_hash,actor_id,role) VALUES(?,?,?)', ('disabled-session', conn.original, 'admin'))
                return types.SimpleNamespace(status_code=200)
            response = asyncio.run(bridge.centrally_managed_stores(request, original_login))
            self.assertEqual(response.status_code, 401)
            self.assertEqual(len(login_checks), 1)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM sessions').fetchone()['n'], 0)
            with self.assertRaises(HTTPException) as error:
                bridge.management_actor(request)
            self.assertEqual(error.exception.status_code, 503)
            key = 'a' * 64
            Path(folder, 'management.key').write_text(key)
            request.headers = {'authorization': 'Bearer store-read-key'}
            with self.assertRaises(HTTPException) as error:
                bridge.management_actor(request)
            self.assertEqual(error.exception.status_code, 401)
            request.headers = {'authorization': 'Bearer ' + key, 'x-hdc-actor': 'dc-admin'}
            self.assertEqual(bridge.management_actor(request), 'dc-admin')

            central_id = str(uuid4())
            with conn.db:
                link_account(conn, conn.original, {'central_id': central_id, 'username': 'original'}, 'dc-admin')
            identity = {'mode': 'shared', 'id': central_id, 'username': 'original', 'token': 'x' * 43,
                        'expires': int(datetime.now(timezone.utc).timestamp() * 1000) + 28800000}
            bridge.identity_request = lambda endpoint, payload: identity
            async def must_not_use_local_password(_):
                self.fail('Shared account fell back to local password checking')
            response = asyncio.run(bridge.centrally_managed_stores(request, must_not_use_local_password))
            self.assertEqual(response.status_code, 200)
            request.cookies = {bridge.cookie_name: response.cookies[bridge.cookie_name]}
            self.assertEqual(security.admin(request)['id'], conn.original)
            bridge.identity_request = lambda endpoint, payload: {'mode': 'local'}
            response = asyncio.run(bridge.centrally_managed_stores(request, must_not_use_local_password))
            self.assertEqual(response.status_code, 401)
            def unavailable(endpoint, payload):
                raise IdentityFailure(503, 'Identity unavailable')
            bridge.identity_request = unavailable
            with self.assertRaises(HTTPException) as error:
                security.admin(request)
            self.assertEqual(error.exception.status_code, 503)
            response = asyncio.run(bridge.centrally_managed_stores(request, must_not_use_local_password))
            self.assertEqual(response.status_code, 503)


if __name__ == '__main__':
    unittest.main()
