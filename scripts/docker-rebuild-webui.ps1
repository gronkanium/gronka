$ErrorActionPreference = "Stop"

function Write-Info-Message {
    param([string]$message)
    Write-Host "Info: $message" -ForegroundColor Green
}

function Write-Error-Message {
    param([string]$message)
    Write-Host "Error: $message" -ForegroundColor Red
    exit 1
}

function Write-Warn-Message {
    param([string]$message)
    Write-Host "Warning: $message" -ForegroundColor Yellow
}

# Check if docker daemon is available
try {
    docker info | Out-Null
} catch {
    Write-Error-Message "Docker daemon is not running or not accessible"
}

# Check if app container is running
$containerName = "gronka"
$containerExists = docker ps -a --filter "name=$containerName" --format "{{.Names}}" | Select-String -Pattern $containerName

if (-not $containerExists) {
    Write-Error-Message "Container $containerName is not running. Please start it first with: docker compose up -d"
}

# Install devDependencies inside the container (needed for building webui)
Write-Info-Message "Installing devDependencies in container..."
docker compose exec -T app npm install --include=dev
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to install devDependencies in container"
}

# Build webui inside the container
Write-Info-Message "Building webui inside container..."
docker compose exec -T app npm run build:webui
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to build webui inside container"
}

Write-Info-Message "WebUI rebuild complete. The webui should now reflect the latest changes."
Write-Info-Message "Note: Browser caching may require a hard refresh (Ctrl+F5) to see changes."

