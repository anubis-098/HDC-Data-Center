param(
    [string]$ContainerProject = 'D:\Code\HDC-Container-loading',
    [string]$ToteProject = 'D:\Code\HDC-Tote-tracker',
    [switch]$PromptForApiKeys
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI not found. Run this script on the Docker host.' }
foreach ($project in @($ContainerProject, $ToteProject)) {
    if (-not (Test-Path -LiteralPath (Join-Path $project 'compose.yaml'))) { throw "Missing compose.yaml: $project" }
    if (-not (Test-Path -LiteralPath (Join-Path $project '.env'))) { throw "Missing .env: $project" }
}
function Run-Compose([string]$Project, [string[]]$Options) {
    & docker compose --project-directory $Project @Options
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed: $Project" }
}
$oldPath = $env:HDC_DATA_CENTER_PATH
$oldKey = $env:HDC_DATA_CENTER_API_KEY
$oldFrontend = $env:HDC_CONSUMER_FRONTEND
$oldType = $env:HDC_CONSUMER_TYPE
$oldAccountKeyFile = $env:HDC_ACCOUNT_KEY_FILE
try {
    $env:HDC_DATA_CENTER_PATH = $root.Replace('\','/')
    $secretDirectory = Join-Path $root '.secrets'
    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    foreach ($clientId in @('container-loading','tote-tracker')) {
        $keyPath = Join-Path $secretDirectory ($clientId + '.key')
        if (-not (Test-Path -LiteralPath $keyPath)) {
            $bytes = New-Object byte[] 32
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            $key = [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
            [IO.File]::WriteAllText($keyPath, $key, [Text.UTF8Encoding]::new($false))
            $key = $null
        }
        if (([IO.File]::ReadAllText($keyPath).Trim()) -notmatch '^[a-f0-9]{64}$') { throw "Invalid management key file: $clientId" }
    }
    Run-Compose $root @('-f', (Join-Path $root 'compose.yaml'), 'up', '-d', '--build', '--wait')
    foreach ($entry in @(@{Path=$ContainerProject;Name='Container Loading';Type='container-loading'}, @{Path=$ToteProject;Name='Tote Tracker';Type='tote-tracker'})) {
        $env:HDC_CONSUMER_FRONTEND = (Join-Path $entry.Path 'frontend').Replace('\','/')
        $env:HDC_CONSUMER_TYPE = $entry.Type
        $env:HDC_ACCOUNT_KEY_FILE = (Join-Path $secretDirectory ($entry.Type + '.key')).Replace('\','/')
        $env:HDC_DATA_CENTER_API_KEY = $null
        if (-not $PromptForApiKeys) {
            # Capture Docker output in memory only; do not print environment values.
            $existingContainers = @(& docker compose --project-directory $entry.Path -f (Join-Path $entry.Path 'compose.yaml') ps -q api)
            if ($LASTEXITCODE -ne 0) { throw "Cannot inspect deployment: $($entry.Name)" }
            if ($existingContainers.Count -gt 0 -and $existingContainers[0]) {
                $containerEnvironment = & docker inspect --format '{{json .Config.Env}}' $existingContainers[0]
                if ($LASTEXITCODE -ne 0) { throw "Cannot read integration configuration: $($entry.Name)" }
                $values = $containerEnvironment | ConvertFrom-Json
                $storedKey = @($values | Where-Object { $_.StartsWith('HDC_DATA_CENTER_API_KEY=') } | Select-Object -First 1)
                if ($storedKey.Count -gt 0) { $env:HDC_DATA_CENTER_API_KEY = $storedKey[0].Substring('HDC_DATA_CENTER_API_KEY='.Length) }
                $containerEnvironment = $null; $values = $null; $storedKey = $null
            }
        }
        if (-not $env:HDC_DATA_CENTER_API_KEY) {
            $secret = Read-Host "Paste API Key for $($entry.Name) (hidden)" -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            try { $env:HDC_DATA_CENTER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        }
        if (-not $env:HDC_DATA_CENTER_API_KEY.StartsWith('hdc_')) { throw 'Invalid API Key format' }
        # Verify inside the Data Center container; no credential in command arguments or output.
        $verify = @'
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',async()=>{try{const c=JSON.parse(raw);const r=await fetch('http://localhost:8082/api/v1/client',{headers:{Authorization:'Bearer '+c.key},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Invalid API Key; run Start-Integration.ps1 -PromptForApiKeys to enter a new key');const info=await r.json();if(info.id!==c.client)throw Error('API Key belongs to another project');if(info.version<1||info.store_count<1)console.log('No Store dataset yet; existing Store cache will be retained');console.log('API verified: '+info.id)}catch(e){console.error(e.message);process.exitCode=1}});
'@
        @{key=$env:HDC_DATA_CENTER_API_KEY;client=$entry.Type} | ConvertTo-Json -Compress | docker compose --project-directory $root -f (Join-Path $root 'compose.yaml') exec -T data-center node -e $verify
        if ($LASTEXITCODE -ne 0) { throw "API verification failed: $($entry.Name)" }
        $options = @('-f', (Join-Path $entry.Path 'compose.yaml'), '-f', (Join-Path $root 'integration/compose.consumer.yaml'))
        Run-Compose $entry.Path ($options + @('config','--quiet'))
        Run-Compose $entry.Path ($options + @('up','-d','--build','--wait'))
        # Python adapters are mounted files: force a fresh API process even if its image is unchanged.
        Run-Compose $entry.Path ($options + @('up','-d','--force-recreate','--no-deps','--wait','api'))
        $verifyAccounts = @'
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',async()=>{try{const c=JSON.parse(raw);if(!['container-loading','tote-tracker'].includes(c.client))throw Error('Unknown project');const key=require('node:fs').readFileSync('/run/hdc-secrets/'+c.client+'.key','utf8').trim();const r=await fetch('http://hdc-'+c.client+'-api:8000/api/hdc/accounts',{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Account management verification failed: HTTP '+r.status);const rows=await r.json();if(!Array.isArray(rows))throw Error('Invalid account response');console.log('Account management ready: '+c.client+' ('+rows.length+' administrators)')}catch(e){console.error(e.message);process.exitCode=1}});
'@
        @{client=$entry.Type} | ConvertTo-Json -Compress | docker compose --project-directory $root -f (Join-Path $root 'compose.yaml') exec -T data-center node -e $verifyAccounts
        if ($LASTEXITCODE -ne 0) { throw "Account management verification failed: $($entry.Name)" }
    }
    Write-Host 'Integration ready. Manage project Administrators in HDC Data Center > User accounts. Store sync runs every 60 seconds.'
} finally {
    $env:HDC_DATA_CENTER_PATH = $oldPath
    $env:HDC_DATA_CENTER_API_KEY = $oldKey
    $env:HDC_CONSUMER_FRONTEND = $oldFrontend
    $env:HDC_CONSUMER_TYPE = $oldType
    $env:HDC_ACCOUNT_KEY_FILE = $oldAccountKeyFile
}
