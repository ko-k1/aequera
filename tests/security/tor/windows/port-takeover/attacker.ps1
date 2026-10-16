# Runs as another Windows account (the probe's scheduled task): tries to take
# over tor's loopback SOCKS port. Writes results to $Dir; for a bind that
# succeeds, signals ready-<n> and reports whether it received the
# orchestrator's connection to 127.0.0.1:<port>.
param([string]$Dir, [int]$Port)
$ErrorActionPreference = "Continue"
$out = Join-Path $Dir "results.txt"
"account: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)" | Out-File $out -Encoding utf8
$cases = @(
  @{ n = 1; name = "plain bind 127.0.0.1"; addr = "127.0.0.1"; reuse = $false },
  @{ n = 2; name = "SO_REUSEADDR 127.0.0.1"; addr = "127.0.0.1"; reuse = $true },
  @{ n = 3; name = "plain bind 0.0.0.0"; addr = "0.0.0.0"; reuse = $false },
  @{ n = 4; name = "SO_REUSEADDR 0.0.0.0"; addr = "0.0.0.0"; reuse = $true }
)
foreach ($c in $cases) {
  $s = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp)
  try {
    if ($c.reuse) {
      $s.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
    }
    $s.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($c.addr), $Port)))
    $s.Listen(5)
    New-Item -ItemType File (Join-Path $Dir "ready-$($c.n)") -Force | Out-Null
    $got = $s.Poll(8000000, [System.Net.Sockets.SelectMode]::SelectRead)
    if ($got) { $s.Accept().Close() }
    "$($c.name): BOUND; the connection to 127.0.0.1:$Port went to $(if ($got) { 'THE SQUATTER' } else { 'tor' })" | Out-File $out -Append -Encoding utf8
  }
  catch {
    $code = if ($_.Exception.InnerException -is [System.Net.Sockets.SocketException]) { $_.Exception.InnerException.ErrorCode } elseif ($_.Exception -is [System.Net.Sockets.SocketException]) { $_.Exception.ErrorCode } else { "?" }
    "$($c.name): refused (WinError $code)" | Out-File $out -Append -Encoding utf8
  }
  finally { $s.Close() }
}
New-Item -ItemType File (Join-Path $Dir "done") -Force | Out-Null
