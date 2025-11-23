$ErrorActionPreference = "Stop"

$PROFILES = @("--profile", "webui")

function Write-Error-Message {
    param([string]$message)
    Write-Host "Error: $message" -ForegroundColor Red
    exit 1
}

function Write-Info-Message {
    param([string]$message)
    Write-Host "Info: $message" -ForegroundColor Green
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

Write-Info-Message "Reloading docker compose services..."

# Step 1: Stop and remove containers
Write-Info-Message "Stopping containers..."
& docker compose @PROFILES down --remove-orphans
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to stop containers"
}

# Step 2: Remove images (ignore errors if they don't exist)
Write-Info-Message "Removing old images..."
$oldErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
docker rmi esm-app esm-webui 2>$null | Out-Null
$ErrorActionPreference = $oldErrorAction

# Step 3: Prune containers and networks
Write-Info-Message "Cleaning up unused containers and networks..."
$oldErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
docker container prune -f 2>$null | Out-Null
docker network prune -f 2>$null | Out-Null
$ErrorActionPreference = $oldErrorAction

# Step 4: Rebuild images
Write-Info-Message "Rebuilding images (this will take a while)..."
docker compose build --no-cache --pull
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to build docker images"
}

# Step 5: Start containers with profiles
Write-Info-Message "Starting containers with profiles: webui"
& docker compose @PROFILES up -d
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to start docker compose services"
}

Write-Info-Message "Reload complete"

