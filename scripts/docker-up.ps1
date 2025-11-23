$ErrorActionPreference = "Stop"

$PROFILES = @("--profile", "webui")
$TIMEOUT = 120

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

function Get-ContainerStatus {
    $psOutput = docker compose ps 2>$null
    if (-not $psOutput) {
        return "0:0:0"
    }
    
    $running = 0
    $exited = 0
    $restarting = 0
    
    foreach ($line in $psOutput) {
        if ($line -match "running") {
            $running++
        } elseif ($line -match "Exited") {
            $exited++
        } elseif ($line -match "restarting") {
            $restarting++
        }
    }
    
    return "$running:$exited:$restarting"
}

# Check if docker daemon is available
try {
    docker info | Out-Null
} catch {
    Write-Error-Message "Docker daemon is not running or not accessible"
}

Write-Info-Message "Starting docker compose services with profiles: webui"

# Start containers
& docker compose @PROFILES up -d
if ($LASTEXITCODE -ne 0) {
    Write-Error-Message "Failed to start docker compose services"
}

# Wait a moment for containers to initialize
Start-Sleep -Seconds 2

# Verify containers started successfully
Write-Info-Message "Verifying container status..."

$MAX_WAIT = $TIMEOUT
$ELAPSED = 0

while ($ELAPSED -lt $MAX_WAIT) {
    $STATUS = Get-ContainerStatus
    $parts = $STATUS -split ":"
    $RUNNING = [int]$parts[0]
    $EXITED = [int]$parts[1]
    $RESTARTING = [int]$parts[2]
    
    # Check for exited containers (failed)
    if ($EXITED -gt 0) {
        $exitedContainers = docker compose ps --format "{{.Name}}: {{.Status}}" 2>$null | Select-String "Exited"
        if ($exitedContainers) {
            Write-Error-Message "Some containers exited: $exitedContainers"
        }
    }
    
    # Count total services
    $totalServicesOutput = docker compose ps --format "{{.Name}}" 2>$null
    $TOTAL_SERVICES = ($totalServicesOutput | Where-Object { $_ -ne "" }).Count
    if (-not $TOTAL_SERVICES) {
        $TOTAL_SERVICES = 0
    }
    
    # If all running and none restarting/exited, we're good
    if ($TOTAL_SERVICES -gt 0 -and $RUNNING -ge $TOTAL_SERVICES -and $RESTARTING -eq 0 -and $EXITED -eq 0) {
        Write-Info-Message "All containers are running"
        
        # Check for health checks and wait for them
        $HAS_HEALTHCHECK = $false
        $containerNames = docker compose ps --format "{{.Name}}" 2>$null
        foreach ($name in $containerNames) {
            if ($name) {
                $healthOutput = docker inspect $name --format '{{.State.Health}}' 2>$null
                if ($healthOutput -match "Status") {
                    $HAS_HEALTHCHECK = $true
                    break
                }
            }
        }
        
        if ($HAS_HEALTHCHECK) {
            Write-Info-Message "Waiting for health checks to pass..."
            Start-Sleep -Seconds 10
            
            # Check final health status
            $UNHEALTHY = 0
            foreach ($name in $containerNames) {
                if ($name) {
                    $health = docker inspect $name --format '{{.State.Health.Status}}' 2>$null
                    if ($health -eq "unhealthy") {
                        $UNHEALTHY++
                    }
                }
            }
            
            if ($UNHEALTHY -gt 0) {
                Write-Warn-Message "Some containers are unhealthy. Check logs with: npm run docker:logs"
            } else {
                Write-Info-Message "All health checks passed"
            }
        }
        
        exit 0
    }
    
    Start-Sleep -Seconds 2
    $ELAPSED += 2
}

# Timeout - show status
Write-Warn-Message "Timeout waiting for containers. Current status:"
docker compose ps

# Check if any failed
$STATUS = Get-ContainerStatus
$parts = $STATUS -split ":"
$EXITED = [int]$parts[1]
if ($EXITED -gt 0) {
    Write-Error-Message "Some containers failed to start. Check logs with: npm run docker:logs"
}

Write-Warn-Message "Containers may still be starting. Check status with: docker compose ps"

