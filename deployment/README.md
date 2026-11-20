# HTTPS on the existing IP and ports

The Compose configuration publishes HTTPS using the existing host ports:

| Project | URL |
| --- | --- |
| Container Loading | `https://10.84.185.1:8080` |
| Tote Tracker | `https://10.84.185.1:8081` |
| Data Center | `https://10.84.185.1:8082` |

## Before starting

On the Docker server, create or obtain a server certificate with an IP Subject
Alternative Name of `10.84.185.1`. Put these files in `D:/HDC-Certificates`:

- `hdc-server.crt`: PEM server certificate (include intermediate certificates
  after the server certificate if your CA uses intermediates).
- `hdc-server.key`: matching, unencrypted PEM private key, restricted to the
  server administrators and Docker runtime.

Mounts are read-only and fail if either file is absent. Private CA keys are not
mounted. A single server certificate can serve all three ports on the same IP.
To use another location, set `HDC_TLS_DIRECTORY` in each project's `.env`.

Edit the existing `.env` entries yourself; preserve passwords and storage paths:

```dotenv
# Data Center
PUBLIC_ORIGIN=https://10.84.185.1:8082
COOKIE_SECURE=true
BIND_ADDRESS=0.0.0.0
PORT=8082

# Container Loading and Tote Tracker: set this in each project's own .env
COOKIE_SECURE=true
```

The Data Center bind address defaults to loopback until explicitly configured
for LAN access. Allow the published ports from the handheld network in the
server firewall. Internal API traffic and existing health checks still use HTTP
inside Docker; keep `HDC_DATA_CENTER_URL=http://hdc-data-center:8082` unchanged.

## Start the integrated applications

Run on the server after updating all three repositories and supplying the
certificate files:

```powershell
Set-Location D:\Code\HDC-Data-Center
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Integration.ps1
```

Use the integration script rather than launching consumers with only their base
Compose files, so shared accounts and Store synchronization stay configured.
Do not remove or replace database volumes when enabling HTTPS.

The Data Center `https` service uses this directory's tracked `nginx.conf`.
There is no need to create a second Data Center Nginx configuration beside the
certificates. Each consumer uses its existing `frontend/nginx.conf`.

## Verify and distribute trust

```powershell
docker compose --project-directory D:\Code\HDC-Data-Center exec https nginx -t
docker compose --project-directory D:\Code\HDC-Container-loading exec frontend nginx -t
docker compose --project-directory D:\Code\HDC-Tote-tracker exec frontend nginx -t

curl.exe --cacert D:\HDC-Certificates\hdc-root-ca.crt https://10.84.185.1:8080/api/ready
curl.exe --cacert D:\HDC-Certificates\hdc-root-ca.crt https://10.84.185.1:8081/api/ready
curl.exe --cacert D:\HDC-Certificates\hdc-root-ca.crt https://10.84.185.1:8082/api/ready
```

For an internal CA, import its public `hdc-root-ca.cer` into a SOTI Certificates
profile and assign the profile to the handhelds. Do not upload either private
key. Confirm installation in the same device/work profile as the browser, then
open the actual HTTPS URLs without certificate warnings. Sign in again and
allow camera permissions in the browser and Android. Test in the intended
Chrome, SOTI Surf, or kiosk WebView, since trust handling can differ by app.

Renew the server certificate before expiry. After replacing the files,
recreate the three frontend/proxy containers so file mounts use the new files.
If the CA is unchanged, handhelds normally retain their existing CA trust.
