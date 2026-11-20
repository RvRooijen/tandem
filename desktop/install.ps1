# Installs tandem on Windows, or updates it: what it needs (Git, Node.js, Claude Code) when that is not there
# yet, and tandem itself from its latest release, in %LOCALAPPDATA%\tandem, with a shortcut in the Start menu and
# on the desktop. It shows a small window; -Unattended does everything without one.
param([switch]$Unattended)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Release = 'https://github.com/RvRooijen/tandem/releases/latest/download/tandem.zip'
$App = Join-Path $env:LOCALAPPDATA 'tandem\app'
$Electron = Join-Path $App 'desktop\node_modules\electron\dist\electron.exe'

$script:log = $null
function Log([string]$text) {
  if ($script:log) {
    $script:log.AppendText($text + "`r`n")
    [System.Windows.Forms.Application]::DoEvents()
  } else { Write-Host $text }
}

# What winget installs is on the PATH of the next session; this one reads it again.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Has([string]$command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }

# Node runs tandem's TypeScript as it is, which it does by itself from 22.18 and 23.6 on.
function Node-Ok {
  if (-not (Has 'node')) { return $false }
  $v = ((& node --version) -replace '^v', '').Split('.')
  $major = [int]$v[0]; $minor = [int]$v[1]
  return ($major -ge 24) -or ($major -eq 23 -and $minor -ge 6) -or ($major -eq 22 -and $minor -ge 18)
}

# A command whose output goes to the log. (What it writes to stderr is output too, not an error of ours.)
function Run([string]$exe, [string[]]$arguments) {
  Log "> $exe $($arguments -join ' ')"
  $ErrorActionPreference = 'Continue'
  & $exe @arguments 2>&1 | ForEach-Object { Log "$_" }
  if ($LASTEXITCODE -ne 0) { throw "$exe stopped with $LASTEXITCODE" }
}

function Winget([string]$id) {
  if (-not (Has 'winget')) { throw "winget is not there to install $id with; install it from the Microsoft Store (App Installer)" }
  Run 'winget' @('install', '--id', $id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
}

$needs = @(
  @{ Name = 'Git'; Ok = { Has 'git' }; Install = { Winget 'Git.Git' } },
  @{ Name = 'Node.js 22.18 or newer'; Ok = { Node-Ok }; Install = { Winget 'OpenJS.NodeJS.LTS' } },
  @{ Name = 'Claude Code'; Ok = { Has 'claude' }; Install = { Run 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex') } }
)

function Install-Tandem {
  New-Item -ItemType Directory -Force $App | Out-Null
  $zip = Join-Path $env:TEMP 'tandem.zip'
  Log "downloading $Release"
  Invoke-WebRequest $Release -OutFile $zip -UseBasicParsing
  # Everything is the release's, but for the dependencies that were installed before: npm brings those up to date.
  Get-ChildItem $App -Force | Where-Object { $_.Name -notin @('node_modules', 'desktop') } | Remove-Item -Recurse -Force
  if (Test-Path (Join-Path $App 'desktop')) { Get-ChildItem (Join-Path $App 'desktop') -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force }
  Expand-Archive $zip -DestinationPath $App -Force
  Remove-Item $zip
  foreach ($dir in @($App, (Join-Path $App 'desktop'))) {
    Push-Location $dir
    try { Run 'npm.cmd' @('install', '--no-audit', '--no-fund') } finally { Pop-Location }
  }
  # Electron's package fetches Electron itself only when it is first asked for it; the shortcut asks for the file.
  Run 'node' @((Join-Path $App 'desktop\node_modules\electron\install.js'))
  $shell = New-Object -ComObject WScript.Shell
  foreach ($place in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $link = $shell.CreateShortcut((Join-Path $place 'tandem.lnk'))
    $link.TargetPath = $Electron
    $link.Arguments = '"' + (Join-Path $App 'desktop') + '"'
    $link.WorkingDirectory = $App
    $link.Save()
  }
  Log "tandem is in $App, with a shortcut in the Start menu and on the desktop"
}

function Install-All {
  foreach ($need in $needs) {
    if (& $need.Ok) { Log "$($need.Name): there"; continue }
    Log "$($need.Name): installing"
    & $need.Install
    Refresh-Path
    if (-not (& $need.Ok)) { throw "$($need.Name) is still not there after installing it" }
  }
  Install-Tandem
}

function Start-Tandem { Start-Process $Electron -ArgumentList ('"' + (Join-Path $App 'desktop') + '"') -WorkingDirectory $App }

if ($Unattended) { Install-All; return }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form -Property @{
  Text = 'tandem'; ClientSize = New-Object System.Drawing.Size(640, 440); StartPosition = 'CenterScreen'
  FormBorderStyle = 'FixedDialog'; MaximizeBox = $false
}
$about = New-Object System.Windows.Forms.Label -Property @{ Location = New-Object System.Drawing.Point(12, 12); Size = New-Object System.Drawing.Size(616, 96) }
$lines = @("Installs or updates tandem in $App.", '')
foreach ($need in $needs) { $lines += "$($need.Name): " + $(if (& $need.Ok) { 'there' } else { 'will be installed' }) }
$lines += 'tandem: ' + $(if (Test-Path $Electron) { 'there, will be updated' } else { 'will be installed' })
$about.Text = $lines -join "`r`n"
$script:log = New-Object System.Windows.Forms.TextBox -Property @{
  Location = New-Object System.Drawing.Point(12, 112); Size = New-Object System.Drawing.Size(616, 276)
  Multiline = $true; ScrollBars = 'Vertical'; ReadOnly = $true; Font = New-Object System.Drawing.Font('Consolas', 9)
}
$install = New-Object System.Windows.Forms.Button -Property @{ Text = 'Install'; Location = New-Object System.Drawing.Point(372, 400); Size = New-Object System.Drawing.Size(80, 28) }
$start = New-Object System.Windows.Forms.Button -Property @{ Text = 'Start tandem'; Location = New-Object System.Drawing.Point(460, 400); Size = New-Object System.Drawing.Size(80, 28); Enabled = (Test-Path $Electron) }
$close = New-Object System.Windows.Forms.Button -Property @{ Text = 'Close'; Location = New-Object System.Drawing.Point(548, 400); Size = New-Object System.Drawing.Size(80, 28) }
$install.Add_Click({
  $install.Enabled = $false; $start.Enabled = $false
  try {
    Install-All
    Log ''
    Log 'Done. The first time, run claude once in a terminal to log in.'
    $start.Enabled = $true
  } catch { Log "Stopped: $_" } finally { $install.Enabled = $true }
})
$start.Add_Click({ Start-Tandem; $form.Close() })
$close.Add_Click({ $form.Close() })
$form.Controls.AddRange(@($about, $script:log, $install, $start, $close))
[void]$form.ShowDialog()
