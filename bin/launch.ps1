$ErrorActionPreference = 'Stop'

if (-not $env:AI_GATEWAY_API_KEY) {
    $env:AI_GATEWAY_API_KEY = [Environment]::GetEnvironmentVariable(
        'AI_GATEWAY_API_KEY',
        'User'
    )
}

if (-not $env:AI_GATEWAY_API_KEY) {
    [Console]::Error.WriteLine(
        'AI_GATEWAY_API_KEY is missing. Set it in the environment; do not store it in router config.'
    )
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
& node.exe (Join-Path $repoRoot 'src\server.mjs')
exit $LASTEXITCODE
