# Uni-Fab Post-Mortem: opens a job's drawings folder in File Explorer.
# Windows runs this when someone clicks "Open Drawings" on a job page (the link looks like
#   unifab-folder:open?job=092115-1-1&root=G%3A%5C&sub=003%20-%20PDF%20PRINTS ).
#
# It is safe by design: it checks every part of the link against strict rules, builds the path itself, and the ONLY thing it
# ever does is open an existing FOLDER in File Explorer. It never runs a file and never uses the link as a command.
# (The same rules are in src/drawings.js: keep the two in step. Keep this file plain ASCII: the setup file packs it as ASCII.)
#
# -DryRun prints what it would open instead of opening it (for testing).
param([string]$Url, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$title = 'Uni-Fab Post-Mortem'

function Show-Note([string]$text, [int]$seconds) {
  if ($DryRun) { Write-Output ('NOTE: ' + $text); return }
  [void](New-Object -ComObject WScript.Shell).Popup($text, $seconds, $title, 64)
}
function Stop-With([string]$text) {
  if ($DryRun) { Write-Output ('REFUSED: ' + $text); exit 1 }
  [void](New-Object -ComObject WScript.Shell).Popup($text, 0, $title, 48)
  exit 1
}

if ($Url -notmatch '^unifab-folder:open\?') { Stop-With 'That is not a folder link from Uni-Fab Post-Mortem.' }

$p = @{}
foreach ($pair in $Url.Substring($Url.IndexOf('?') + 1).Split('&')) {
  $kv = $pair.Split('=', 2)
  if ($kv.Count -eq 2 -and @('job', 'root', 'sub') -contains $kv[0]) {
    try { $p[$kv[0]] = [Uri]::UnescapeDataString($kv[1]) } catch { Stop-With 'The folder link is damaged.' }
  }
}

$job = [string]$p['job']
$root = [string]$p['root']
$sub = [string]$p['sub']

# the job number: letters, digits and . _ - only, and not just dots
if ($job -notmatch '^[A-Za-z0-9._-]{1,30}$' -or $job -match '^\.+$') { Stop-With 'The job number in that link is not valid.' }
# the drive or share: G:\ or \\server\share
if ($root -notmatch '^[A-Za-z]:\\?$' -and $root -notmatch '^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+\\?$') { Stop-With 'The drive in that link is not valid.' }
if (-not $root.EndsWith('\')) { $root = $root + '\' }
# the subfolder: nothing, or one plain folder name
if ($sub -ne '' -and ($sub -notmatch '^[^\\/:*?"<>|]{1,80}$' -or $sub -match '^\.+$' -or $sub -match '[. ]$')) { Stop-With 'The folder name in that link is not valid.' }

$jobFolder = $root + $job
$full = if ($sub -ne '') { $jobFolder + '\' + $sub } else { $jobFolder }

# the drawings folder if it is there; if not, the job's own folder; if not, the drive
$target = $null
foreach ($c in @($full, $jobFolder, $root)) {
  if (Test-Path -LiteralPath $c -PathType Container) { $target = $c; break }
}
if (-not $target) { Stop-With ("Could not find " + $full + "`n`nIs the drive connected? (Open the drive in File Explorer once, then try again.)") }

if ($DryRun) { Write-Output ('OPEN: ' + $target) }
else { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target + '"') }

if ($target -ne $full) {
  if ($target -eq $jobFolder) { Show-Note ("There is no '" + $sub + "' folder for job " + $job + " yet, so its job folder was opened instead.") 6 }
  else { Show-Note ("There is no folder for job " + $job + " on that drive, so the drive was opened instead.") 6 }
}
