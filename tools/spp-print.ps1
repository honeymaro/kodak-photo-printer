# Prints a prepared raster over the Bluetooth SPP link.
#
# node-serialport does not receive on Windows Bluetooth virtual COM ports,
# while .NET's SerialPort does, so this drives the protocol directly. The
# raster is produced by the library: kodak print <image> --dry-run <file>.
#
# This DOES print. Pass -DryRun to stop right before the job starts.
#
#   powershell -ExecutionPolicy Bypass -File tools/spp-print.ps1 `
#       -Port COM5 -Raster test-print-raster.jpg

param(
    [string]$Port = 'COM5',
    [Parameter(Mandatory = $true)][string]$Raster,
    [int]$Copies = 1,
    [int]$TimeoutSeconds = 180,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$image = [System.IO.File]::ReadAllBytes((Resolve-Path $Raster))
Write-Host ("raster: {0} bytes" -f $image.Length)

function New-Frame([byte]$opcode, [byte]$arg1, [byte]$arg2, [byte[]]$payload) {
    if ($null -eq $payload) { $payload = New-Object byte[] 0 }
    $len = $payload.Length
    $frame = New-Object byte[] (8 + $len)
    $frame[0] = $opcode
    $frame[1] = $arg1
    $frame[2] = $arg2
    $frame[3] = 0
    $frame[4] = [byte](($len -shr 24) -band 0xFF)
    $frame[5] = [byte](($len -shr 16) -band 0xFF)
    $frame[6] = [byte](($len -shr 8) -band 0xFF)
    $frame[7] = [byte]($len -band 0xFF)
    if ($len -gt 0) { [Array]::Copy($payload, 0, $frame, 8, $len) }
    return $frame
}

function ReadExactly($sp, [int]$count) {
    $buffer = New-Object byte[] $count
    $filled = 0
    while ($filled -lt $count) {
        $read = $sp.Read($buffer, $filled, $count - $filled)
        if ($read -le 0) { return $null }
        $filled = $filled + $read
    }
    return $buffer
}

$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
$sp.ReadTimeout = 2000
$sp.WriteTimeout = 30000
$sp.ReadBufferSize = 65536
$sp.WriteBufferSize = 262144

$jobStarted = $false
$bytesSent = 0
$finished = $false

try {
    $sp.Open()
    Write-Host ("{0} open" -f $Port)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $sentSessionStart = $false

    while ((Get-Date) -lt $deadline -and -not $finished) {
        $header = $null
        try {
            $header = ReadExactly $sp 8
        } catch [TimeoutException] {
            if (-not $sentSessionStart) {
                $sp.Write((New-Frame 0x02 1 37 $null), 0, 8)
                Write-Host "  -> SESSION_START"
                $sentSessionStart = $true
            }
            continue
        }
        if ($null -eq $header) { continue }

        $length = ([int]$header[4] -shl 24) -bor ([int]$header[5] -shl 16) -bor ([int]$header[6] -shl 8) -bor [int]$header[7]
        if ($length -lt 0 -or $length -gt 1048576) { $length = 0 }

        $payload = New-Object byte[] 0
        if ($length -gt 0) {
            $payload = ReadExactly $sp $length
            if ($null -eq $payload) { $payload = New-Object byte[] 0 }
        }

        $op = $header[0]
        $state = $header[1]
        Write-Host ("  <- op=0x{0:x2} arg1={1} arg2={2} arg3={3} len={4}" -f $op, $state, $header[2], $header[3], $length)

        # A non-zero fourth byte is a fault.
        if ($header[3] -ne 0 -and $op -eq 0x00) {
            Write-Host ("  FAULT detail={0}" -f $header[3]) -ForegroundColor Red
        }

        # Heartbeat must be echoed or the session drops.
        if ($op -eq 0x64) {
            $sp.Write((New-Frame 0x64 1 0 $null), 0, 8)
            Write-Host "  -> HEARTBEAT echo"
            if (-not $sentSessionStart) {
                Start-Sleep -Milliseconds 150
                $sp.Write((New-Frame 0x02 1 37 $null), 0, 8)
                Write-Host "  -> SESSION_START"
                $sentSessionStart = $true
            }
            continue
        }

        # Job finished.
        if ($op -eq 0x13 -or $op -eq 0x14) {
            Write-Host "  job complete" -ForegroundColor Green
            $finished = $true
            continue
        }

        # Needs acknowledgement.
        if ($state -eq 5) {
            $sp.Write((New-Frame 0x07 $header[3] 0 $null), 0, 8)
            Write-Host ("  -> ACK {0}" -f $header[3])
            continue
        }

        # Ready for a job.
        if ($state -eq 1) {
            if ($DryRun) {
                Write-Host "  READY reached. -DryRun set, stopping before the job." -ForegroundColor Yellow
                break
            }
            if (-not $jobStarted) {
                $p = New-Object byte[] 12
                $p[0] = [byte](($image.Length -shr 24) -band 0xFF)
                $p[1] = [byte](($image.Length -shr 16) -band 0xFF)
                $p[2] = [byte](($image.Length -shr 8) -band 0xFF)
                $p[3] = [byte]($image.Length -band 0xFF)
                $frame = New-Frame 0x05 ([byte]$Copies) 0 $p
                $sp.Write($frame, 0, $frame.Length)
                Write-Host ("  -> PRINT_START copies={0} imageLen={1}" -f $Copies, $image.Length) -ForegroundColor Cyan
                $jobStarted = $true
            }
            continue
        }

        # Printer wants image data at the offset in the first four payload bytes.
        if ($state -eq 0 -and $jobStarted) {
            $offset = 0
            if ($payload.Length -ge 4) {
                $offset = ([int]$payload[0] -shl 24) -bor ([int]$payload[1] -shl 16) -bor ([int]$payload[2] -shl 8) -bor [int]$payload[3]
            }
            if ($offset -lt 0 -or $offset -ge $image.Length) {
                Write-Host ("  (offset {0} is past the end, waiting)" -f $offset)
                continue
            }
            $remaining = $image.Length - $offset
            $slice = New-Object byte[] $remaining
            [Array]::Copy($image, $offset, $slice, 0, $remaining)

            $frame = New-Frame 0x09 $header[1] $header[2] $slice
            $sp.Write($frame, 0, $frame.Length)
            $bytesSent = $offset + $remaining
            Write-Host ("  -> DATA offset={0} bytes={1} ({2}%)" -f $offset, $remaining, [int](100 * $bytesSent / $image.Length)) -ForegroundColor Cyan
            continue
        }

        # Job done from the printer's point of view.
        if ($state -eq 6) {
            $sp.Write((New-Frame 0x01 0 0 $null), 0, 8)
            Write-Host "  -> END_JOB" -ForegroundColor Green
            continue
        }
    }

    if (-not $finished -and -not $DryRun) {
        Write-Host "timed out before the printer reported completion"
    }
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($sp.IsOpen) { $sp.Close() }
    $sp.Dispose()
}
