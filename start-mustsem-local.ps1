param([ValidateRange(1,65535)][int]$Port=8008, [switch]$Bootstrap)
$ErrorActionPreference='Stop'
$projectRoot=$PSScriptRoot
$python=Join-Path $projectRoot 'server/venv/Scripts/python.exe'
if(-not(Test-Path -LiteralPath $python)){throw 'Create server/venv and install server/requirements.txt first.'}
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
if(-not(Test-Path -LiteralPath $nodePath)){throw 'Install Node.js first.'}
$previousPort=$env:IPLOAN_UI_PORT
$previousPython=$env:IPLOAN_TEST_PYTHON
Push-Location (Join-Path $projectRoot 'blockchain')
try {
    $env:IPLOAN_UI_PORT=[string]$Port
    $env:IPLOAN_TEST_PYTHON=$python
    $runnerArgs=@('scripts/mustsem-local.mjs')
    if($Bootstrap){$runnerArgs+='--bootstrap'}
    & $nodePath @runnerArgs
    if($LASTEXITCODE -ne 0){throw "Mustsem local runner exited with code $LASTEXITCODE"}
} finally {
    $env:IPLOAN_UI_PORT=$previousPort
    $env:IPLOAN_TEST_PYTHON=$previousPython
    Pop-Location
}
