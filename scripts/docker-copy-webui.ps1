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

# Check if docker daemon is available
try {
    docker info | Out-Null
} catch {
    Write-Error-Message "Docker daemon is not running or not accessible"
}

# Check if webui container is running
$containerName = "gronka-webui"
$containerExists = docker ps -a --filter "name=$containerName" --format "{{.Names}}" | Select-String -Pattern $containerName

if (-not $containerExists) {
    Write-Error-Message "Container $containerName is not running. Please start it first with: docker compose --profile webui up -d"
}

# Build webui locally
Write-Info-Message "Building webui locally..."
npm run build:webui
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to build webui locally"
}

# Copy built files to container
Write-Info-Message "Copying built files to container..."
docker cp src/public/. ${containerName}:/app/src/public/

Write-Info-Message "Files copied successfully. The webui should now reflect the latest changes."

