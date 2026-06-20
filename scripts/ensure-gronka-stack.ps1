$ErrorActionPreference = 'Stop'

$projectRoot = 'C:\gronka'
$dockerDesktopPath = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$envFile = Join-Path $projectRoot '.env'

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing environment file: $Path"
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    if ($_ -match '^[\s]*([^#=][^=]*)=(.*)$') {
      $name = $matches[1].Trim()
      $value = $matches[2]
      Set-Item -Path ("Env:" + $name) -Value $value
    }
  }
}

function Wait-ForDockerEngine {
  param([int]$TimeoutSeconds = 180)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      docker info --format '{{.ServerVersion}}' | Out-Null
      return
    } catch {
      Start-Sleep -Seconds 5
    }
  }

  throw 'Docker engine did not become available in time.'
}

try {
  $dockerService = Get-Service -Name 'com.docker.service' -ErrorAction Stop
  if ($dockerService.Status -ne 'Running') {
    Start-Service -Name 'com.docker.service'
  }

  $dockerDesktopRunning = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
  if (-not $dockerDesktopRunning) {
    Start-Process -FilePath $dockerDesktopPath
  }

  Wait-ForDockerEngine

  Import-DotEnv -Path $envFile
  $env:DISCORD_TOKEN = $env:PROD_DISCORD_TOKEN
  $env:CLIENT_ID = $env:PROD_CLIENT_ID

  Push-Location $projectRoot
  try {
    docker compose up -d | Out-Null
  } finally {
    Pop-Location
  }
} catch {
  $logPath = Join-Path $projectRoot 'logs\ensure-gronka-stack-error.log'
  $timestamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
  Add-Content -LiteralPath $logPath -Value "[$timestamp] $($_.Exception.Message)"
  throw
}
