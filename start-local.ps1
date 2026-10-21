param(
    [switch]$Fixture,
    [ValidateRange(1, 65535)][int]$Port = 8003,
    [ValidateRange(1, 65535)][int]$RpcPort = 8545,
    [ValidateRange(1, 2147483647)][int]$ChainId = 31337,
    [ValidatePattern('^[a-z0-9-]+$')][string]$DataGroup = 'local-real'
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
    & $python -c "import sys; sys.path.insert(0, sys.argv[1]); from server.patent_api import PatentAPI; sys.exit(0 if PatentAPI().configured else 1)" $projectRoot
    if ($LASTEXITCODE -ne 0) { throw 'Set IPLOAN_PATENT_API_URL and IPLOAN_PATENT_API_TOKEN in server/.env before real-provider mode.' }
}
$previousPort = $env:IPLOAN_QA_PORT
$previousPython = $env:IPLOAN_TEST_PYTHON
$previousLocalPort = $env:IPLOAN_LOCAL_PORT
$previousRpcPort = $env:IPLOAN_LOCAL_RPC_PORT
$previousChainId = $env:IPLOAN_LOCAL_CHAIN_ID
$previousDataGroup = $env:IPLOAN_LOCAL_DATA_GROUP
Push-Location (Join-Path $projectRoot 'blockchain')
try {
    $env:IPLOAN_QA_PORT = [string]$Port
    $env:IPLOAN_TEST_PYTHON = $python
    Write-Host "Starting http://127.0.0.1:$Port/#apply (Ctrl+C to stop)."
    $env:IPLOAN_LOCAL_PORT = [string]$Port
    $env:IPLOAN_LOCAL_RPC_PORT = [string]$RpcPort
    $env:IPLOAN_LOCAL_CHAIN_ID = [string]$ChainId
    $env:IPLOAN_LOCAL_DATA_GROUP = $DataGroup
    Write-Host $(if ($Fixture) { 'QA ONLY: automatic test wallet, fixture IPFS and report service.' } else { 'REAL MetaMask + REAL IPFS + REAL evaluation service. Local development chain only.' })
    Write-Host 'Each restart creates a new local chain and database. Previous real-mode database files are preserved.'
    $runnerArgs = @($(if ($Fixture) { 'scripts/workflow-qa.mjs' } else { 'scripts/local-real.mjs' }))
    & $nodePath @runnerArgs
    if ($LASTEXITCODE -ne 0) { throw "Local runner exited with code $LASTEXITCODE" }
} finally {
    $env:IPLOAN_QA_PORT = $previousPort
    $env:IPLOAN_TEST_PYTHON = $previousPython
    $env:IPLOAN_LOCAL_PORT = $previousLocalPort
    $env:IPLOAN_LOCAL_RPC_PORT = $previousRpcPort
    $env:IPLOAN_LOCAL_CHAIN_ID = $previousChainId
    $env:IPLOAN_LOCAL_DATA_GROUP = $previousDataGroup
    Pop-Location
}
