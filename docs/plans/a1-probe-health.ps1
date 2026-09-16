# Probe the live llama-server health endpoint and report the wall-clock time.
#   powershell -ExecutionPolicy Bypass -File a1-probe-health.ps1
# Prints: <HH:mm:ss.fff>  <HTTP status or ERR: message>
$ts = (Get-Date).ToString('HH:mm:ss.fff')
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5 -UseBasicParsing
  Write-Host "$ts  $($r.StatusCode)"
} catch {
  Write-Host "$ts  ERR: $($_.Exception.Message)"
}
