# Observes the SPP print protocol handshake without starting a job.
#
# The printer speaks the stream framing over a Bluetooth Classic SPP link,
# which Windows exposes as an outgoing COM port. It sends a heartbeat as soon
# as the port opens and expects the host to echo it, otherwise it drops the
# session.
#
# Only SESSION_START, heartbeat echoes and status polls are sent. No job is
# started, so this cannot produce a print.
#
#   powershell -ExecutionPolicy Bypass -File tools/spp-handshake.ps1 -Port COM5

param(
    [string]$Port = 'COM5',
    [int]$Seconds = 15
)

$OPCODE = @{
    0x01 = 'END_JOB'
    0x02 = 'SESSION_START'
    0x03 = 'STATUS_POLL'
    0x05 = 'PRINT_START_LEGACY'
    0x07 = 'ACK'
    0x09 = 'DATA_LEGACY'
    0x10 = 'PRINT_START'
    0x12 = 'DATA'
    0x13 = 'JOB_COMPLETE'
    0x14 = 'SESSION_END'
    0x40 = 'IDLE_A'
    0x41 = 'IDLE_B'
    0x64 = 'HEARTBEAT'
}

$STATE = @{ 0 = 'REQUEST_DATA'; 1 = 'READY'; 3 = 'MEDIA_INFO'; 6 = 'FINISHED' }

function Describe([byte[]]$header, [byte[]]$payload) {
    $op = $header[0]
    $label = $OPCODE[[int]$op]
    if (-not $label) { $label = ('0x{0:x2}' -f $op) }

    $line = "  <- {0,-18} arg1={1} arg2={2} arg3={3} len={4}" -f $label, $header[1], $header[2], $header[3], $payload.Length
    if ($op -eq 0x00) {
        $s = $STATE[[int]$header[1]]
        if (-not $s) { $s = 'unknown' }
        $line = $line + ("  state={0}" -f $s)
        if ($header[3] -ne 0) { $line = $line + ("  FAULT detail={0}" -f $header[3]) }
    }
    Write-Host $line
    if ($payload.Length -gt 0) {
        Write-Host ("     payload: " + (($payload | ForEach-Object { $_.ToString('x2') }) -join ' '))
    }
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
$sp.ReadTimeout = 1500
$sp.WriteTimeout = 3000

try {
    $sp.Open()
    Write-Host ("{0} open" -f $Port)

    $deadline = (Get-Date).AddSeconds($Seconds)
    $sentSessionStart = $false

    while ((Get-Date) -lt $deadline) {
        $header = $null
        try {
            $header = ReadExactly $sp 8
        } catch [TimeoutException] {
            # Nothing pending. Send SESSION_START once the link is quiet.
            if (-not $sentSessionStart) {
                $frame = [byte[]](0x02, 0x01, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00)
                $sp.Write($frame, 0, $frame.Length)
                Write-Host "  -> SESSION_START (arg1=1 arg2=37)"
                $sentSessionStart = $true
            }
            continue
        }
        if ($null -eq $header) { continue }

        $length = ([int]$header[4] -shl 24) -bor ([int]$header[5] -shl 16) -bor ([int]$header[6] -shl 8) -bor [int]$header[7]
        if ($length -lt 0 -or $length -gt 65536) { $length = 0 }

        $payload = New-Object byte[] 0
        if ($length -gt 0) {
            $payload = ReadExactly $sp $length
            if ($null -eq $payload) { $payload = New-Object byte[] 0 }
        }

        Describe $header $payload

        # The heartbeat must be echoed or the printer tears the session down.
        if ($header[0] -eq 0x64) {
            $echo = [byte[]](0x64, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
            $sp.Write($echo, 0, $echo.Length)
            Write-Host "  -> HEARTBEAT echo"

            if (-not $sentSessionStart) {
                Start-Sleep -Milliseconds 200
                $frame = [byte[]](0x02, 0x01, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00)
                $sp.Write($frame, 0, $frame.Length)
                Write-Host "  -> SESSION_START (arg1=1 arg2=37)"
                $sentSessionStart = $true
            }
            continue
        }

        # b3.i.run: when the second header byte is 5 the host acknowledges with
        # opcode 7, carrying the frame's fourth byte back as its argument.
        if ($header[1] -eq 5) {
            $ack = [byte[]](0x07, $header[3], 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
            $sp.Write($ack, 0, $ack.Length)
            Write-Host ("  -> ACK (arg1={0})" -f $header[3])
            continue
        }

        # Report but do not answer a print state frame; answering READY would
        # start a job, and this tool never does that.
        if ($header[0] -eq 0x00 -and $header[1] -eq 1) {
            Write-Host "     (printer is READY for a job; not answering)"
        }
    }
    Write-Host "done observing"
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message)
} finally {
    if ($sp.IsOpen) { $sp.Close() }
    $sp.Dispose()
}
