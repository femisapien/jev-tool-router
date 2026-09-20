param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

$ErrorActionPreference = 'Stop'

& codex @CodexArgs
exit $LASTEXITCODE
