"""Project Administrator management. Call inside the project's DB transaction."""
import hashlib
import secrets
import re
from datetime import datetime, timezone
from uuid import UUID, uuid4


class AccountError(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def initialize_accounts(conn):
    conn.execute('SELECT pg_advisory_xact_lock(724016222)')
    conn.execute('ALTER TABLE admins ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true')
    conn.execute('ALTER TABLE admins ADD COLUMN IF NOT EXISTS central_id text')
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS hdc_admin_identity ON admins(central_id)')
    conn.execute('''CREATE TABLE IF NOT EXISTS hdc_shared_sessions (
        token_hash text PRIMARY KEY, central_id text NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS hdc_account_audit (
        id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
        target_id uuid NOT NULL, detail text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())''')


def username_value(value):
    if not isinstance(value, str):
        raise AccountError(422, 'กรุณาระบุชื่อบัญชี')
    value = value.strip().lower()
    if not value or len(value) > 60 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AccountError(422, 'ชื่อบัญชีต้องยาว 1–60 ตัว และไม่มีอักขระควบคุม')
    return value


def password_value(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 200:
        raise AccountError(422, 'รหัสผ่านต้องยาว 12–200 ตัว')
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(value.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def account_list(conn):
    return conn.execute('SELECT id,username,active,central_id FROM admins ORDER BY username').fetchall()


def record(conn, actor, action, target, username):
    conn.execute('INSERT INTO hdc_account_audit(id,actor,action,target_id,detail) VALUES(%s,%s,%s,%s,%s)',
                 (str(uuid4()), actor[:80], action, target, username))


def create_account(conn, data, actor):
    if not isinstance(data, dict):
        raise AccountError(422, 'ข้อมูลบัญชีไม่ถูกต้อง')
    username = username_value(data.get('username'))
    password = password_value(data.get('password'))
    conn.execute('SELECT pg_advisory_xact_lock(724016222)')
    if conn.execute('SELECT 1 FROM admins WHERE lower(username)=%s', (username,)).fetchone():
        raise AccountError(409, 'ชื่อบัญชีนี้มีอยู่แล้ว')
    target = str(uuid4())
    conn.execute('INSERT INTO admins(id,username,password_hash,active) VALUES(%s,%s,%s,true)', (target, username, password))
    record(conn, actor, 'account.create', target, username)
    return {'id': target, 'username': username, 'active': True}


def update_account(conn, target, data, actor, reset_password=False):
    try:
        target = str(UUID(target))
    except (ValueError, TypeError):
        raise AccountError(422, 'รหัสบัญชีไม่ถูกต้อง') from None
    if not isinstance(data, dict):
        raise AccountError(422, 'ข้อมูลบัญชีไม่ถูกต้อง')
    password = password_value(data.get('password')) if reset_password else None
    conn.execute('SELECT pg_advisory_xact_lock(724016222)')
    row = conn.execute('SELECT id,username,active,central_id FROM admins WHERE id=%s FOR UPDATE', (target,)).fetchone()
    if not row:
        raise AccountError(404, 'ไม่พบบัญชี')
    if row['central_id']:
        raise AccountError(409, 'บัญชีนี้ใช้บัญชีกลาง กรุณาแก้ไขที่บัญชีกลาง')
    if reset_password:
        conn.execute('UPDATE admins SET password_hash=%s WHERE id=%s', (password, target))
        record(conn, actor, 'account.password', target, row['username'])
        result = dict(row)
    else:
        username = username_value(data['username']) if 'username' in data else row['username']
        active = data.get('active', row['active'])
        if type(active) is not bool:
            raise AccountError(422, 'สถานะบัญชีไม่ถูกต้อง')
        if row['active'] and not active:
            remaining = conn.execute('SELECT count(*) AS n FROM admins WHERE active=true').fetchone()['n']
            if remaining <= 1:
                raise AccountError(409, 'ไม่สามารถปิด Administrator คนสุดท้ายของโปรเจค')
        if conn.execute('SELECT 1 FROM admins WHERE lower(username)=%s AND id<>%s', (username.lower(), target)).fetchone():
            raise AccountError(409, 'ชื่อบัญชีนี้มีอยู่แล้ว')
        conn.execute('UPDATE admins SET username=%s,active=%s WHERE id=%s', (username, active, target))
        record(conn, actor, 'account.update', target, username + (' · enabled' if active else ' · disabled'))
        result = {'id': target, 'username': username, 'active': active}
    # Revoke old sessions after password, username or status changes.
    conn.execute("DELETE FROM sessions WHERE actor_id=%s AND role='admin'", (target,))
    return result


def link_account(conn, target, data, actor):
    try:
        target, central_id = str(UUID(target)), str(UUID(data['central_id']))
    except (ValueError, TypeError, KeyError):
        raise AccountError(422, 'รหัสบัญชีไม่ถูกต้อง') from None
    username = username_value(data.get('username'))
    conn.execute('SELECT pg_advisory_xact_lock(724016222)')
    row = conn.execute('SELECT id,central_id FROM admins WHERE id=%s FOR UPDATE', (target,)).fetchone()
    if not row:
        raise AccountError(404, 'ไม่พบบัญชีเดิม')
    if row['central_id'] and row['central_id'] != central_id:
        raise AccountError(409, 'บัญชีเดิมเชื่อมกับบัญชีกลางอื่นแล้ว')
    if conn.execute('SELECT 1 FROM admins WHERE (central_id=%s OR lower(username)=%s) AND id<>%s', (central_id, username, target)).fetchone():
        raise AccountError(409, 'ชื่อบัญชีหรือบัญชีกลางนี้ถูกใช้งานในโปรเจคแล้ว')
    # Preserve local UUID: historical work/audit relationships remain unchanged.
    conn.execute('UPDATE admins SET central_id=%s,username=%s,active=true,password_hash=%s WHERE id=%s',
                 (central_id, username, password_value(secrets.token_urlsafe(32)), target))
    conn.execute("DELETE FROM sessions WHERE actor_id=%s AND role='admin'", (target,))
    record(conn, actor, 'account.link', target, username)
    return {'id': target, 'username': username, 'active': True, 'central_id': central_id}


def provision_shared_session(conn, identity, response, cookie_name, secure=False):
    try:
        central_id = str(UUID(identity['id']))
        username = username_value(identity['username'])
        token = identity['token']
        expires = datetime.fromtimestamp(identity['expires'] / 1000, timezone.utc)
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,100}', token):
            raise ValueError('Invalid token')
    except (ValueError, KeyError, TypeError, OverflowError):
        raise AccountError(503, 'ข้อมูล Session กลางไม่ถูกต้อง') from None
    conn.execute('SELECT pg_advisory_xact_lock(724016222)')
    row = conn.execute('SELECT id FROM admins WHERE central_id=%s FOR UPDATE', (central_id,)).fetchone()
    collision = conn.execute('SELECT id FROM admins WHERE lower(username)=%s', (username,)).fetchone()
    if collision and (not row or collision['id'] != row['id']):
        raise AccountError(409, 'ชื่อบัญชีซ้ำกับบัญชีเดิม กรุณาเชื่อมบัญชีเดิมจาก Data Center ก่อน')
    if row:
        target = str(row['id'])
        conn.execute('UPDATE admins SET username=%s,active=true WHERE id=%s', (username, target))
    else:
        target = str(uuid4())
        conn.execute('INSERT INTO admins(id,username,password_hash,active,central_id) VALUES(%s,%s,%s,true,%s)',
                     (target, username, password_value(secrets.token_urlsafe(32)), central_id))
        record(conn, 'HDC Data Center', 'account.provision', target, username)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    conn.execute('INSERT INTO sessions(token_hash,actor_id,role,expires_at) VALUES(%s,%s,%s,%s)', (token_hash, target, 'admin', expires))
    conn.execute('DELETE FROM hdc_shared_sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions)')
    conn.execute('INSERT INTO hdc_shared_sessions(token_hash,central_id) VALUES(%s,%s)', (token_hash, central_id))
    max_age = max(1, min(28800, int((expires - datetime.now(timezone.utc)).total_seconds())))
    response.set_cookie(cookie_name, token, max_age=max_age, httponly=True, secure=secure, samesite='strict', path='/')
    return {'id': target, 'name': username, 'role': 'admin'}
