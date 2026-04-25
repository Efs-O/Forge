$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BridgePort = 9099
$LlamaPort = 8080
$Python = Join-Path $RepoRoot ".venv\Scripts\python.exe"

Set-Location $RepoRoot

function Get-PortListeners {
    param(
        [int[]]$Ports
    )

    $results = foreach ($port in $Ports) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $conns) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
            if ($null -ne $proc) {
                [pscustomobject]@{
                    Port = $port
                    PID = $proc.ProcessId
                    Name = $proc.Name
                    CommandLine = $proc.CommandLine
                }
            }
        }
    }

    $results | Sort-Object PID -Unique
}

$listeners = Get-PortListeners -Ports @($BridgePort, $LlamaPort)
if ($listeners) {
    Write-Host "Stopping existing listeners on ports $BridgePort/$LlamaPort..." -ForegroundColor Yellow
    $listeners | Format-List
    $listeners.PID | Sort-Object -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host "No listeners found on ports $BridgePort/$LlamaPort." -ForegroundColor DarkGray
}

$remaining = Get-PortListeners -Ports @($BridgePort, $LlamaPort)
if ($remaining) {
    Write-Error "Ports are still in use after stop attempt."
}

Write-Host "Starting bridge..." -ForegroundColor Green
Write-Host "Command: $Python -m continue_llamacpp_bridge --debug .\config\bridge.yaml" -ForegroundColor DarkGray
$ErrorActionPreference = "Continue"
& $Python -m continue_llamacpp_bridge --debug .\config\bridge.yaml
