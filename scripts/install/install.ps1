# Installs the `whiphand` CLI and terminal UI from a GitHub release:
#
#   irm https://raw.githubusercontent.com/PlainBytes/whip-hand/main/scripts/install/install.ps1 | iex
#
# It downloads whiphand.exe and the release's SHA256SUMS, refuses a binary
# whose checksum does not match, puts it in %LOCALAPPDATA%\Programs\whiphand
# and adds that folder to the user's PATH.
#
#   WHIPHAND_VERSION       a release such as 0.5.1 (default: the latest)
#   WHIPHAND_INSTALL_DIR   where to put whiphand.exe
#   WHIPHAND_RELEASES_URL  the releases' download base (tests point it elsewhere)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$asset = 'whiphand-windows-x86_64.exe'

# `throw`, not `exit`: under `irm | iex` this runs in the user's own session,
# and `exit` would close it.
function Fail($message) {
  throw "whiphand install: $message"
}

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'only x86_64 Windows is built' }
# Windows PowerShell 5.1 on an older Windows may not offer TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$base = if ($env:WHIPHAND_RELEASES_URL) { $env:WHIPHAND_RELEASES_URL } else { 'https://github.com/PlainBytes/whip-hand/releases' }
$url = if ($env:WHIPHAND_VERSION) { "$base/download/v$($env:WHIPHAND_VERSION.TrimStart('v'))" } else { "$base/latest/download" }
$dir = if ($env:WHIPHAND_INSTALL_DIR) { $env:WHIPHAND_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\whiphand' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "downloading $url/$asset"
  $exe = Join-Path $tmp $asset
  $sums = Join-Path $tmp 'SHA256SUMS'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $exe
    Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile $sums
  } catch {
    Fail "could not download from ${url}: $($_.Exception.Message)"
  }

  $pattern = "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset))$"
  $line = Get-Content $sums | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line -or $line -notmatch $pattern) { Fail "SHA256SUMS lists no $asset" }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "checksum mismatch for $asset; nothing installed" }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir 'whiphand.exe'
  # A running exe cannot be overwritten, but it can be renamed out of the way.
  $old = "$target.old"
  Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old -Force }
  Move-Item -LiteralPath $exe -Destination $target
  Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  Write-Host "installed $target ($(& $target --version))"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# The user PATH, read unexpanded so entries like %USERPROFILE%\bin stay as
# they are.
$key = 'HKCU:\Environment'
$path = (Get-Item -LiteralPath $key).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$entries = @($path -split ';' | Where-Object { $_ -ne '' })
if ($entries -notcontains $dir) {
  Set-ItemProperty -LiteralPath $key -Name Path -Type ExpandString -Value (($entries + $dir) -join ';')
  # Setting a variable through .NET broadcasts the change, so terminals opened
  # from now on see the new PATH.
  [Environment]::SetEnvironmentVariable('WHIPHAND_INSTALL_BROADCAST', '1', 'User')
  [Environment]::SetEnvironmentVariable('WHIPHAND_INSTALL_BROADCAST', $null, 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "added $dir to your PATH; open a new terminal to use it there"
}
Write-Host "run 'whiphand' for the terminal UI, 'whiphand --help' for the commands"
