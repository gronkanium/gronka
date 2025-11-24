$ErrorActionPreference = "Continue"

# Colors for output
function Write-Info-Message {
    param([string]$message)
    Write-Host "Info: $message" -ForegroundColor Green
}

function Write-Warn-Message {
    param([string]$message)
    Write-Host "Warning: $message" -ForegroundColor Yellow
}

function Write-Error-Message {
    param([string]$message)
    Write-Host "Error: $message" -ForegroundColor Red
}

function Write-Section {
    param([string]$message)
    Write-Host "=== $message ===" -ForegroundColor Cyan
}

# Check if docker daemon is available
try {
    docker info | Out-Null
} catch {
    Write-Error-Message "Docker daemon is not running or not accessible"
    exit 1
}

Write-Section "Checking Docker Containers Status"

# Get current git commit hash
try {
    $currentCommit = git rev-parse HEAD 2>$null
    $currentCommitShort = git rev-parse --short HEAD 2>$null
    if (-not $currentCommit) {
        $currentCommit = "unknown"
        $currentCommitShort = "unknown"
    }
} catch {
    $currentCommit = "unknown"
    $currentCommitShort = "unknown"
}

Write-Info-Message "Current repository commit: $currentCommitShort"

# Check if containers are running
$containers = @("gronka")
$allUpToDate = $true

foreach ($container in $containers) {
    Write-Host ""
    Write-Section "Checking $container"
    
    $isRunning = docker ps --format "{{.Names}}" 2>$null | Select-String -Pattern "^$container$"
    
    if (-not $isRunning) {
        Write-Warn-Message "$container is not running"
        $allUpToDate = $false
        continue
    }
    
    Write-Info-Message "$container is running"
    
    # Try to get commit hash from container environment
    $containerCommit = "unknown"
    try {
        $result = docker exec $container sh -c 'echo $GIT_COMMIT' 2>&1
        if ($result -and $result -ne "" -and -not ($result -match "Error")) {
            $trimmed = $result.ToString().Trim()
            if ($trimmed -and $trimmed -ne "" -and $trimmed -ne "unknown" -and $trimmed.Length -gt 10) {
                $containerCommit = $trimmed
            }
        }
        if ($containerCommit -eq "unknown") {
            # Try alternative: check if GIT_COMMIT env var exists via inspect
            $envResult = docker inspect $container --format='{{range .Config.Env}}{{println .}}{{end}}' 2>&1 | Select-String -Pattern "GIT_COMMIT="
            if ($envResult) {
                $containerCommit = ($envResult -split "=")[1]
            }
        }
    } catch {
        $containerCommit = "unknown"
    }
    
    # Try to get build timestamp
    $buildTimestamp = "unknown"
    try {
        $result = docker exec $container sh -c 'echo $BUILD_TIMESTAMP 2>/dev/null' 2>&1
        if ($result -and $result -ne "") {
            $buildTimestamp = $result.ToString().Trim()
        }
        if (-not $buildTimestamp -or $buildTimestamp -eq "") {
            $buildTimestamp = "unknown"
        }
    } catch {
        $buildTimestamp = "unknown"
    }
    
    if ($containerCommit -ne "unknown" -and $containerCommit -ne "") {
        if ($containerCommit.Length -gt 7) {
            $containerCommitShort = $containerCommit.Substring(0, 7)
        } else {
            $containerCommitShort = $containerCommit
        }
        Write-Info-Message "Container commit: $containerCommitShort"
        
        if ($containerCommit -eq $currentCommit) {
            Write-Info-Message "$container is running the latest code (up to date)"
        } else {
            $diffMsg = "$container is running different code - container: $containerCommitShort, repo: $currentCommitShort"
            Write-Warn-Message $diffMsg
            $allUpToDate = $false
        }
    } else {
        Write-Warn-Message "Could not determine commit hash for $container"
        if ($buildTimestamp -ne "unknown" -and $buildTimestamp -ne "") {
            Write-Info-Message "Build timestamp: $buildTimestamp"
        }
        $allUpToDate = $false
    }
    
    # Show container image info
    try {
        $imageResult = docker inspect $container --format='{{.Config.Image}}' 2>&1
        $createdResult = docker inspect $container --format='{{.Created}}' 2>&1
        if ($imageResult -and -not ($imageResult -match "Error")) {
            Write-Info-Message "Image: $imageResult"
        }
        if ($createdResult -and -not ($createdResult -match "Error") -and $createdResult -ne "unknown") {
            Write-Info-Message "Container created: $createdResult"
        }
    } catch {
        # Ignore errors
    }
}

Write-Host ""
Write-Section "Summary"

if ($allUpToDate) {
    Write-Info-Message 'All containers are running and appear to be up to date'
    exit 0
} else {
    Write-Warn-Message 'Some containers may not be running the latest code'
    $updateMsg = 'To update, run: npm run docker:reload'
    Write-Info-Message $updateMsg
    exit 1
}

