"""Store snapshot replication; HTTP uses only the Python standard library."""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler

# A valid 10,000-Store dataset with names and all 15 memberships can exceed 5 MB.
MAX_STORE_SNAPSHOT_BYTES = 25_000_000


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the service credential to another host.


STORE_GROUPS = {
    '1PX': ['Combine HLE Direct', 'Transfer CDC', 'Transfer CDC-FS', 'Transfer MKB', 'Transfer MKD3'],
    'HLE': ['Direct', 'Hub Chiangmai', 'Hub Hatyai', 'Hub Kamphaeng', 'Hub Khonkaen', 'Hub Korat', 'Hub Rayong', 'Hub Surat', 'Hub Ubon', 'Hub Udon'],
}


class CenterClient:
    def __init__(self, url, key):
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Invalid HDC_DATA_CENTER_URL')
        if not key or '\n' in key or '\r' in key:
            raise ValueError('HDC_DATA_CENTER_API_KEY is required')
        self.url, self.key = url.rstrip('/'), key
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, path, body=None):
        payload = None if body is None else json.dumps(body).encode()
        request = Request(self.url + path, data=payload, headers={
            'Authorization': 'Bearer ' + self.key,
            'Content-Type': 'application/json',
        }, method='GET' if payload is None else 'POST')
        try:
            with self.opener.open(request, timeout=10) as response:
                raw = response.read(MAX_STORE_SNAPSHOT_BYTES + 1)
                if len(raw) > MAX_STORE_SNAPSHOT_BYTES:
                    raise ValueError('Data Center response is too large')
                return json.loads(raw)
        except HTTPError as error:
            raise RuntimeError(f'Data Center HTTP {error.code}') from None
        except URLError:
            raise RuntimeError('Cannot reach Data Center') from None
        except TimeoutError:
            raise RuntimeError('Data Center request timed out') from None


def validate_snapshot(payload):
    if not isinstance(payload, dict) or type(payload.get('version')) is not int or payload['version'] < 1:
        raise ValueError('Data Center has no published Store dataset')
    records = payload.get('stores')
    if not isinstance(records, list) or len(records) > 10000:
        raise ValueError('Invalid Store snapshot')
    seen = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Invalid Store record')
        code, name, active = record.get('code'), record.get('name'), record.get('active')
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,30}', code) or code in seen:
            raise ValueError('Invalid or duplicate Store code')
        if not isinstance(name, str) or not name.strip() or len(name) > 160 or type(active) is not bool:
            raise ValueError('Invalid Store name/status')
        links = record.get('memberships', [])
        if not isinstance(links, list) or len(links) > 15:
            raise ValueError('Invalid Store categories')
        pairs = set()
        for link in links:
            if not isinstance(link, dict) or not isinstance(link.get('group'), str) or link['group'] not in STORE_GROUPS or link.get('category') not in STORE_GROUPS[link['group']]:
                raise ValueError('Invalid Store Group / Category')
            pair = (link['group'], link['category'])
            if pair in pairs:
                raise ValueError('Duplicate Store category')
            pairs.add(pair)
        seen.add(code)
    if not records and payload.get('allow_empty') is not True:
        raise ValueError('Empty snapshot rejected; existing Store cache retained')
    return payload['version'], records


def initialize(conn):
    conn.execute('SELECT pg_advisory_xact_lock(724016221)')
    conn.execute('''CREATE TABLE IF NOT EXISTS hdc_store_sync (
        id integer PRIMARY KEY CHECK(id=1), source text NOT NULL, version bigint NOT NULL DEFAULT -1,
        last_success timestamptz, last_error text, store_count integer NOT NULL DEFAULT 0)''')


def apply_snapshot(conn, source, payload):
    version, records = validate_snapshot(payload)
    # Serialize across manual sync, multiple processes and the scheduled loop.
    conn.execute('SELECT pg_advisory_xact_lock(724016221)')
    current = conn.execute('SELECT source,version FROM hdc_store_sync WHERE id=1 FOR UPDATE').fetchone()
    if current and current['source'] == source and current['version'] > version:
        raise ValueError('Older Store snapshot rejected')
    if not current or current['source'] != source or current['version'] != version:
        # Retain rows and historical foreign keys; missing Stores become inactive.
        conn.execute('UPDATE stores SET active=false WHERE active=true')
        for record in records:
            conn.execute('''INSERT INTO stores(code,name,active,memberships) VALUES (%s,%s,%s,%s)
                ON CONFLICT(code) DO UPDATE SET name=excluded.name,
                active=excluded.active,memberships=excluded.memberships,deleted_at=NULL''',
                (record['code'], record['name'], record['active'], json.dumps(record.get('memberships', []))))
    # Keep foreign-key rows for history, but hide Stores removed from the master.
    # Reconcile even when the version is unchanged (including upgraded caches).
    codes = tuple(record['code'] for record in records)
    missing = 'code NOT IN (' + ','.join(['%s'] * len(codes)) + ') AND ' if codes else ''
    conn.execute('UPDATE stores SET active=false,deleted_at=coalesce(deleted_at,now()) WHERE ' + missing + '(active=true OR deleted_at IS NULL)', codes)
    conn.execute('''INSERT INTO hdc_store_sync(id,source,version,last_success,last_error,store_count)
        VALUES(1,%s,%s,now(),NULL,%s) ON CONFLICT(id) DO UPDATE SET source=excluded.source,
        version=excluded.version,last_success=now(),last_error=NULL,store_count=excluded.store_count''',
        (source, version, len(records)))
    return {'version': version, 'store_count': len(records)}
