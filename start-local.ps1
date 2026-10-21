param(
    [switch]$Fixture,
    [ValidateRange(1, 65535)][int]$Port = 8002
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$python = Join-Path $projectRoot 'server/venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Create server/venv and install server/requirements.txt first.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'blockchain/node_modules/hardhat'))) { throw 'Install blockchain dependencies with npm ci first.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js and add it to PATH.' }
if (-not $Fixture) {
    & $python -c "import sys; sys.path.insert(0, r'$projectRoot'); from server.patent_api import PatentAPI; sys.exit(0 if PatentAPI().configured else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Set IPLOAN_PATENT_API_URL and IPLOAN_PATENT_API_TOKEN in server/.env before real-provider mode.' }
}
$previousPort = $env:IPLOAN_QA_PORT
$previousPython = $env:IPLOAN_TEST_PYTHON
Push-Location (Join-Path $projectRoot 'blockchain')
try {
    $env:IPLOAN_QA_PORT = [string]$Port
    $env:IPLOAN_TEST_PYTHON = $python
    Write-Host "Starting http://127.0.0.1:$Port/#apply (Ctrl+C to stop)."
    Write-Host 'Local test wallets, temporary DB, ephemeral chain and IPFS fixture. Data resets after restart.'
    $runnerArgs = @('scripts/workflow-qa.mjs')
    if (-not $Fixture) { $runnerArgs += '--real-provider' }
    & $nodePath @runnerArgs
    if ($LASTEXITCODE -ne 0) { throw "Local runner exited with code $LASTEXITCODE" }
} finally {
    $env:IPLOAN_QA_PORT = $previousPort
    $env:IPLOAN_TEST_PYTHON = $previousPython
    Pop-Location
}
