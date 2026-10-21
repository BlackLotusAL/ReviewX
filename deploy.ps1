param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $DeployArguments
)

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$probe = 'import sys; sys.exit(0 if sys.version_info[:3] == (3, 9, 11) else 1)'

function Test-ReviewXPython([string] $Executable, [string[]] $Prefix = @()) {
    try {
        & $Executable @Prefix -c $probe 2>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

$pythonCommand = $null
$pythonPrefix = @()
if ($env:REVIEWX_PYTHON) {
    if (Test-ReviewXPython $env:REVIEWX_PYTHON) {
        $pythonCommand = $env:REVIEWX_PYTHON
    }
} else {
    foreach ($candidate in @((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'), 'python', 'python3')) {
        if (Test-ReviewXPython $candidate) {
            $pythonCommand = $candidate
            break
        }
    }
    if (-not $pythonCommand -and (Test-ReviewXPython 'py' @('-3.9'))) {
        $pythonCommand = 'py'
        $pythonPrefix = @('-3.9')
    }
}

if (-not $pythonCommand) {
    Write-Host 'Python 3.9.11 is required. Install it or set REVIEWX_PYTHON to its executable path.' -ForegroundColor Red
    exit 1
}

& $pythonCommand @pythonPrefix (Join-Path $PSScriptRoot 'scripts\deploy.py') @DeployArguments
exit $LASTEXITCODE
