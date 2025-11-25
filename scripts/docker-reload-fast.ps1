$ErrorActionPreference = "Stop"


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

Write-Info-Message "Fast reloading docker compose services (using build cache)..."

# Step 1: Stop and remove containers, and remove associated images
Write-Info-Message "Stopping containers and removing images..."
docker compose down --rmi all --remove-orphans
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to stop containers and remove images"
}

# Step 2: Prune containers and networks
Write-Info-Message "Cleaning up unused containers and networks..."
$oldErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
docker container prune -f 2>$null | Out-Null
docker network prune -f 2>$null | Out-Null
$ErrorActionPreference = $oldErrorAction

# Step 3: Get git commit hash and build timestamp
try {
    $gitCommit = git rev-parse HEAD 2>$null
    if (-not $gitCommit) {
        $gitCommit = ""
    }
} catch {
    $gitCommit = ""
}

$buildTimestamp = [int][double]::Parse((Get-Date -UFormat %s))

# Set as environment variables for docker-compose.yml to use
$env:GIT_COMMIT = $gitCommit
$env:BUILD_TIMESTAMP = $buildTimestamp

# Step 4: Rebuild images with build args (using cache for speed)
Write-Info-Message "Rebuilding images with cache (this should be much faster)..."
docker compose build
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to build docker images"
}

# Step 5: Start containers
Write-Info-Message "Starting containers"
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to start docker compose services"
}

Write-Info-Message "Fast reload complete"



