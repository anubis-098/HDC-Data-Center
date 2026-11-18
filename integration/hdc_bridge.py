"""Compose-mounted adapter. Keeps the original app and lifespan intact."""
import asyncio
import logging
import os
import threading
import hmac
import hashlib
from pathlib import Path
from urllib.parse import unquote
from contextlib import asynccontextmanager, suppress

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from app.main import app
from app.core.security import admin
from app.db.connection import connect
from app.core import security
from sync_core import CenterClient, initialize, apply_snapshot
from accounts_core import initialize_accounts, account_list, create_account, update_account, AccountError, link_account, provision_shared_session
from shared_identity import identity_request, IdentityFailure

client = CenterClient(os.environ['HDC_DATA_CENTER_URL'], os.environ['HDC_DATA_CENTER_API_KEY'])
interval = max(15, min(3600, int(os.environ.get('HDC_DATA_CENTER_SYNC_SECONDS', '60'))))
lock = threading.Lock()
original_identity = security.identity
cookie_name = 'hdc_tote_admin_session' if os.environ.get('HDC_PROJECT_ID') == 'tote-tracker' else 'hdc_container_admin_session'


def enabled_identity(request, role):
    who = original_identity(request, role)
    if role == 'admin':
        with connect() as conn:
            account = conn.execute('SELECT active,central_id FROM admins WHERE id=%s', (who['id'],)).fetchone()
            token = getattr(request, 'cookies', {}).get(cookie_name, '')
            shared_session = conn.execute('SELECT central_id FROM hdc_shared_sessions WHERE token_hash=%s', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone() if token else None
        if not account or not account['active']:
            raise HTTPException(401, 'บัญชีถูกปิดใช้งาน')
        if account['central_id']:
            if not shared_session or shared_session['central_id'] != account['central_id']:
                raise HTTPException(401, 'กรุณาเข้าสู่ระบบด้วยบัญชีกลาง')
            try:
                identity = identity_request('check', {'token': token})
            except IdentityFailure as error:
                raise HTTPException(error.status, error.detail) from None
            if identity.get('id') != account['central_id']:
                raise HTTPException(401, 'กรุณาเข้าสู่ระบบใหม่')
    return who


# Existing admin/actor dependencies call identity through their module globals.
security.identity = enabled_identity


def initialize_account_schema():
    with connect() as conn:
        initialize_accounts(conn)


def management_actor(request: Request):
    try:
        expected = Path(os.environ.get('HDC_ACCOUNT_MANAGEMENT_KEY_FILE', '/run/hdc-account-management.key')).read_text().strip()
    except OSError:
        raise HTTPException(503, 'ยังไม่ได้ตั้งค่าการจัดการบัญชี') from None
    provided = request.headers.get('authorization', '')
    if not expected or not provided.startswith('Bearer ') or not hmac.compare_digest(expected.encode(), provided[7:].encode()):
        raise HTTPException(401, 'Management credential ไม่ถูกต้อง')
    return unquote(request.headers.get('x-hdc-actor', 'HDC Data Center'))[:80]


def sync_once():
    with lock:
        result = None
        try:
            payload = client.request('/api/v1/stores')
            with connect() as conn:
                initialize(conn)
                result = apply_snapshot(conn, client.url, payload)
        except Exception as error:
            logging.warning('HDC Store sync failed: %s', type(error).__name__)
            # No URL, credential, database error, or request content in user-visible diagnostics.
            message = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'Local Store database unavailable'
            try:
                with connect() as conn:
                    initialize(conn)
                    conn.execute('''INSERT INTO hdc_store_sync(id,source,last_error) VALUES(1,%s,%s)
                        ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error''', (client.url, message))
            except Exception:
                logging.warning('Cannot persist HDC Store sync status')
            raise RuntimeError(message) from None
        # Report success only after the local transaction has committed.
        try:
            client.request('/api/v1/sync-status', result)
        except Exception:
            logging.warning('HDC sync committed; acknowledgement will retry next cycle')
        return result


original_lifespan = app.router.lifespan_context


@asynccontextmanager
async def lifespan(application):
    await asyncio.to_thread(initialize_account_schema)
    async with original_lifespan(application):
        async def loop():
            while True:
                try:
                    await asyncio.to_thread(sync_once)
                except Exception:
                    pass  # Keep serving the last committed Store cache.
                await asyncio.sleep(interval)
        task = asyncio.create_task(loop())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app.router.lifespan_context = lifespan


@app.middleware('http')
async def centrally_managed_stores(request: Request, call_next):
    path = request.url.path.rstrip('/')
    if path == '/api/admin/login' and request.method == 'POST':
        try:
            body = await request.json()
            username = body.get('username') if isinstance(body, dict) else None
        except (ValueError, UnicodeDecodeError):
            username = None
            body = None
        if isinstance(username, str) and isinstance(body.get('password'), str) and 1 <= len(username) <= 60 and 1 <= len(body['password']) <= 200:
            try:
                identity = await asyncio.to_thread(identity_request, 'login', {'username': username, 'password': body['password']})
            except IdentityFailure as error:
                return JSONResponse({'detail': error.detail}, status_code=error.status)
            if identity.get('mode') == 'shared':
                response = JSONResponse({'name': identity['username'], 'role': 'admin'}, status_code=200)
                try:
                    def provision():
                        with connect() as conn:
                            provision_shared_session(conn, identity, response, cookie_name, security.settings().cookie_secure)
                    await asyncio.to_thread(provision)
                except AccountError as error:
                    try:
                        await asyncio.to_thread(identity_request, 'revoke', {'token': identity['token']})
                    except IdentityFailure:
                        pass
                    return JSONResponse({'detail': error.detail}, status_code=error.status)
                return response
            # A renamed/revoked shared identity must never fall back to its old local password.
            def managed_username():
                with connect() as conn:
                    row = conn.execute('SELECT central_id FROM admins WHERE lower(username)=%s', (username.strip().lower(),)).fetchone()
                return row and row['central_id']
            if await asyncio.to_thread(managed_username):
                return JSONResponse({'detail': 'กรุณาเข้าสู่ระบบด้วยบัญชีกลางที่มีสิทธิ์ใช้งาน'}, status_code=401)
        # Preserve the original password checks and login rate limiting.
        response = await call_next(request)
        if response.status_code == 200 and isinstance(username, str):
            def reject_disabled_login():
                with connect() as conn:
                    row = conn.execute('SELECT id,active FROM admins WHERE username=%s', (username.strip().lower(),)).fetchone()
                    if row and not row['active']:
                        conn.execute("DELETE FROM sessions WHERE actor_id=%s AND role='admin'", (row['id'],))
                        return True
                return False
            if await asyncio.to_thread(reject_disabled_login):
                # Discard the original Set-Cookie; no disabled session reaches the browser.
                return JSONResponse({'detail': 'ชื่อบัญชีหรือรหัสผ่านไม่ถูกต้อง'}, status_code=401)
        return response
    if path == '/api/admin/logout' and request.method == 'POST':
        response = await call_next(request)
        token = request.cookies.get(cookie_name, '')
        if token and response.status_code == 200:
            try:
                await asyncio.to_thread(identity_request, 'revoke', {'token': token})
            except IdentityFailure:
                pass
        return response
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and (path == '/api/admin/stores' or path.startswith('/api/admin/stores/')):
        try:
            await asyncio.to_thread(admin, request)
        except HTTPException as error:
            return JSONResponse({'detail': error.detail}, status_code=error.status_code)
        return JSONResponse({'detail': 'Store จัดการที่ HDC Data Center เท่านั้น'}, status_code=409)
    return await call_next(request)


@app.get('/api/admin/data-center/status')
def status(who=Depends(admin)):
    with connect() as conn:
        initialize(conn)
        row = conn.execute('SELECT version,last_success,last_error,store_count FROM hdc_store_sync WHERE id=1').fetchone()
    return {'managed': True, 'interval_seconds': interval, 'sync': row}


@app.post('/api/admin/data-center/sync')
def manual_sync(who=Depends(admin)):
    try:
        return sync_once()
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from None


@app.get('/api/hdc/accounts')
def accounts(who=Depends(management_actor)):
    with connect() as conn:
        return account_list(conn)


@app.post('/api/hdc/accounts', status_code=201)
def add_account(data: dict, who=Depends(management_actor)):
    try:
        with connect() as conn:
            return create_account(conn, data, who)
    except AccountError as error:
        raise HTTPException(error.status, error.detail) from None


@app.put('/api/hdc/accounts/{account_id}')
def edit_account(account_id: str, data: dict, who=Depends(management_actor)):
    try:
        with connect() as conn:
            return update_account(conn, account_id, data, who)
    except AccountError as error:
        raise HTTPException(error.status, error.detail) from None


@app.post('/api/hdc/accounts/{account_id}/password')
def reset_account_password(account_id: str, data: dict, who=Depends(management_actor)):
    try:
        with connect() as conn:
            return update_account(conn, account_id, data, who, reset_password=True)
    except AccountError as error:
        raise HTTPException(error.status, error.detail) from None


@app.post('/api/hdc/accounts/{account_id}/link')
def link_existing_account(account_id: str, data: dict, who=Depends(management_actor)):
    try:
        with connect() as conn:
            return link_account(conn, account_id, data, who)
    except AccountError as error:
        raise HTTPException(error.status, error.detail) from None
