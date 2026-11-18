"""Online authentication for a single Administrator identity across projects."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request
from sync_core import CenterClient


class IdentityFailure(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def identity_request(endpoint, payload):
    try:
        key = Path(os.environ.get('HDC_ACCOUNT_MANAGEMENT_KEY_FILE', '/run/hdc-account-management.key')).read_text().strip()
        client = CenterClient(os.environ['HDC_DATA_CENTER_URL'], key)
        request = Request(client.url + '/api/identity/' + endpoint, data=json.dumps(payload).encode(),
                          headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
        with client.opener.open(request, timeout=10) as response:
            raw = response.read(16001)
            if len(raw) > 16000:
                raise ValueError('Oversized identity response')
            return json.loads(raw)
    except HTTPError as error:
        if error.code == 401:
            raise IdentityFailure(401, 'ชื่อบัญชีหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกยกเลิกสิทธิ์') from None
        if error.code == 429:
            raise IdentityFailure(429, 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 10 นาที') from None
        raise IdentityFailure(503, 'ระบบบัญชีกลางยังไม่พร้อม กรุณาอัปเดต Data Center') from None
    except (OSError, URLError, ValueError, KeyError):
        raise IdentityFailure(503, 'ติดต่อระบบบัญชีกลางไม่ได้ กรุณาลองใหม่') from None
