# Can another Windows account take over tor's loopback SOCKS port while tor
# holds it? (docs/design/TOR.md, Windows, Residual risks.) Manual security
# check; needs an elevated PowerShell and a build with the bundled tor
# (tools/tor/fetch-bundle.sh).
#
#   powershell -ExecutionPolicy Bypass -File tests\security\tor\port-takeover\run.ps1
#
# Starts tor.exe as this user the way a Tor window runs it, runs attacker.ps1
# once as NT AUTHORITY\LOCAL SERVICE through a temporary scheduled task (no
# account is created), and connects to 127.0.0.1:<port> for every bind the
# attacker gets. Removes the task, the shared directory, and tor afterwards.
param(
  [string]$Tor = (Join-Path $PSScriptRoot "..\..\..\..\obj\firefox\artifact\dist\bin\tor\tor.exe"),
  [string]$Log = (Join-Path $env:TEMP "aequera-port-takeover.log")
)
$ErrorActionPreference = "Stop"
$tor = (Resolve-Path $Tor).Path
$task = "AequeraTorTakeoverProbe"
$shared = "C:\ProgramData\aequera-takeover-probe"
$work = Join-Path $env:TEMP ("aequera-takeover-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$torProc = $null

function Log($text) { $text | Tee-Object -FilePath $Log -Append }
Remove-Item $Log -ErrorAction SilentlyContinue

try {
  # A free loopback port, then tor on it (as a Tor window runs it).
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
  New-Item -ItemType Directory "$work\data" -Force | Out-Null
  $dataEsc = "$work\data".Replace("\", "\\")
  Set-Content "$work\torrc" "DataDirectory `"$dataEsc`"`nSocksPort 127.0.0.1:$port IsolateSOCKSAuth`nControlPort 0`nClientOnly 1`nAvoidDiskWrites 1`nLog notice stdout`n"
  Set-Content "$work\torrc-defaults" ""
  $torProc = Start-Process -FilePath $tor -ArgumentList "-f `"$work\torrc`" --defaults-torrc `"$work\torrc-defaults`"" -RedirectStandardOutput "$work\tor.log" -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Select-String -Path "$work\tor.log" -Pattern "Opened Socks listener.*127\.0\.0\.1:$port" -Quiet -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $deadline -or $torProc.HasExited) { throw "tor did not report its listener" }
    Start-Sleep -Milliseconds 200
  }
  Log "tor.exe pid $($torProc.Id) as $([Security.Principal.WindowsIdentity]::GetCurrent().Name), listening on 127.0.0.1:$port (its own report)"

  # Shared directory: this user, SYSTEM, and LOCAL SERVICE only.
  Remove-Item $shared -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $shared | Out-Null
  icacls $shared /inheritance:r /grant:r "*S-1-5-19:(OI)(CI)M" "$($env:USERNAME):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
  Copy-Item (Join-Path $PSScriptRoot "attacker.ps1") (Join-Path $shared "attacker.ps1")

  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$shared\attacker.ps1`" -Dir `"$shared`" -Port $port"
  $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\LOCAL SERVICE" -LogonType ServiceAccount
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $task

  # For every bind the attacker gets, connect to tor's address and port.
  $deadline = (Get-Date).AddSeconds(90)
  $served = @{}
  while (-not (Test-Path "$shared\done")) {
    if ((Get-Date) -gt $deadline) { throw "the attacker did not finish" }
    foreach ($n in 1..4) {
      if (-not $served[$n] -and (Test-Path "$shared\ready-$n")) {
        $served[$n] = $true
        $c = New-Object System.Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $port); Start-Sleep -Milliseconds 300; $c.Close()
      }
    }
    Start-Sleep -Milliseconds 100
  }
  Get-Content "$shared\results.txt" | ForEach-Object { Log $_ }
  Log "tor still running: $(-not $torProc.HasExited)"
}
finally {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $shared -Recurse -Force -ErrorAction SilentlyContinue
  if ($torProc -and -not $torProc.HasExited) { Stop-Process -Id $torProc.Id -Force }
  Start-Sleep -Milliseconds 500
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Log "cleanup: task registered=$([bool](Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)), shared dir exists=$(Test-Path $shared)"
}
