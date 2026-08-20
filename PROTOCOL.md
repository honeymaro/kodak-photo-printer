# Prinics photo printer protocol reference

Covers the printers sold as Kodak Mini Shot, Kodak Dock, PICKIT SNAPS and SI.
Everything here was recovered by decompiling the official Android application
`com.prinics.kodak.photoprinter` 5.1.2 (manufacturer: Prinics) and by probing a
Kodak Mini Shot 3 Retro over Bluetooth and USB. `ANALYSIS.md` covers how the
analysis was done; this document is the protocol specification the TypeScript
implementation follows.

Each section states its provenance. Anything not directly observed is marked
**inferred** or **open**, so that a later capture can confirm or correct it
without having to re-derive the rest.

---

## 1. Device

| Property | Value |
|---|---|
| USB vendor / product | `0x2207` / `0x0006` (Rockchip) |
| USB interface | class `0xFF`, subclass `0x42`, protocol `0x01` (ADB) |
| Bus-reported name | `rk3xxx` |
| Internal platform | Rockchip SoC running Android |
| `adb` identity | `product:occam model:Nexus_4 device:mako` (a spoofed build.prop, not a real Nexus 4) |

The printer sleeps after a period of inactivity and disappears from USB
entirely. Power it back on before any USB work.

### adbd surface

Probed on hardware with `tools/probe_adb_services.py`:

| Service | Result |
|---|---|
| `root:` | `adbd is already running as root` |
| `remount:` | responds |
| `jdwp`, `track-jdwp`, `localabstract:jdwp-control` | open |
| `restore:`, `backup:all` | open |
| `shell:`, `exec:`, `sync:`, `framebuffer:`, `reverse:` | refused with `closed` |
| `tcp:<port>` scan over 1024-9200 and 56000-56100 | only `5037` responds |

This is a vendor-stripped adbd. It runs as root but has no shell and no file
sync, which rules out the obvious "push a file and run it" approach.

---

## 2. Transports

The app implements four transports. They share one application-layer print
protocol; only the framing differs.

| Transport | Implementation | Framing |
|---|---|---|
| Bluetooth Classic SPP | `b3.d` | stream, UUID `00001101-0000-1000-8000-00805F9B34FB` |
| BLE GATT | `b3.b` | BLE (section 4) |
| Wi-Fi Direct / P2P | `b3.i` + `P2PService` | stream, ports `12231` / `56065` |
| USB Accessory | `AccessoryHandler`, `c3.C0506a`, `F0.RunnableC0047c` | stream, tunnelled inside ADB |

`b3.j.f7025o` discriminates them, but only two values are ever assigned, and not
by model: `3` for a printer found by Bluetooth Classic scan, `4` for one found by
BLE advertisement scan. See "Which transport a printer gets" in section 4.

**The print path implemented here is Bluetooth Classic SPP.** Wi-Fi targets the
larger Dock models; USB is not a print path on the model tested.

---

## 3. Stream framing

Used by USB, Wi-Fi and SPP. From `b3.i.b(byte, int, int, int, byte[])`.

```
offset 0   opcode        1 byte
offset 1   arg1          1 byte
offset 2   arg2          1 byte
offset 3   arg3          1 byte   host always sends 0
offset 4   length        4 bytes  big endian, payload only
offset 8   payload       length bytes
```

The same layout applies in both directions. On printer -> host frames the
three argument bytes are meaningful, and `PrintService.e` reads them as:

| Byte | Meaning |
|---|---|
| 1 | print state during a job, and the status code. **Dispatch on this byte, not the opcode.** |
| 2 | job state (`f7020j[7]`, values 3, 6, 7, -1) |
| 3 | fault detail, **but only in some states** |

> Two traps here, both confirmed on hardware.
>
> Byte 1 is `0` for both "request data" and "no error", so a fault cannot be read
> from byte 1 alone.
>
> Byte 3 is a fault code only when byte 1 is `0` (any non-zero detail) or `1`
> (only the value 10). Elsewhere it carries unrelated data: a frame asking for
> acknowledgement arrives as `arg1=5 arg3=53`, where 53 is the value to echo
> back, and normal media reporting during a print arrives as `arg1=3 arg3=1`.
> Treating byte 3 as a universal fault flag aborts healthy jobs.

Payload offsets used by the app (`bArr[10]`, `bArr[11]`, `bArr[14]`, which are
payload bytes 2, 3 and 6):

| Payload offset | Meaning |
|---|---|
| 0..3 | requested read offset, on a `REQUEST_DATA` frame (big endian) |
| 2 | page index |
| 3 | total copies |
| 6 | media / ribbon type |

### Host -> printer opcodes

Observed as literal `b((byte) N, ...)` call sites in `b3.i.run()`.

| Opcode | Name | Notes |
|---|---|---|
| `0x01` | `END_JOB` | sent after the printer reports state 6 |
| `0x02` | `SESSION_START` | sent as `b(2, 1, 37, 0, null)`; 37 is the protocol revision |
| `0x03` | `STATUS_POLL` | sent on read timeout, up to 3 retries |
| `0x05` | `PRINT_START_LEGACY` | `b(5, copies, 0, 12, payload)`, payload[0..3] = image length |
| `0x07` | `ACK` | answers a printer status-5 notification |
| `0x09` | `DATA_LEGACY` | image data chunk |
| `0x10` | `PRINT_START` | `b(16, jobId>>8, jobId, 8, payload)`, used when peer level > 100 |
| `0x12` | `DATA` | image data chunk, modern pairing |
| `0x51`..`0x54` | `'Q'`,`'R'`,`'S'`,`'T'` | on-device file listing and read, filters for `.jpg`/`.jpeg` |
| `0x64` | `HEARTBEAT` | **must be echoed** or the printer drops the session |
| `0x70` | `DEVICE_INFO` | requests the information block; see section 6b |

### Printer -> host opcodes (byte 0)

Only these are dispatched on the opcode. **Everything else routes on byte 1**
through the print state machine, which is why hardware signalling READY with
`0x04` and requesting data with `0x08` still works.

| Opcode | Meaning |
|---|---|
| `0x13` | job complete (never seen on hardware; see section 6a) |
| `0x14` | session teardown |
| `0x40`, `0x41` | idle acknowledgement |
| `0x51`, `0x53`, `0x54` | file protocol responses |
| `0x64` | heartbeat |
| `0x70` | device information block |

### Print states (byte 1, on any other opcode)

| Value | Meaning | Host response |
|---|---|---|
| 0 | `REQUEST_DATA`, wanted offset in payload[0..3] | `DATA` with that slice |
| 1 | `READY` | `PRINT_START` carrying the image length |
| 3 | `MEDIA_INFO`, media type in payload[6] | none |
| 5 | `NEEDS_ACK` | `ACK` echoing byte 3 back as its argument |
| 6 | `FINISHED` | `END_JOB`, which is terminal |

### Job flow

**The transfer is printer-driven.** The printer names the offset it wants; the
host serves it. This is a pull model, not a push.

```
printer -> HEARTBEAT
host    -> HEARTBEAT echo
host    -> SESSION_START(arg1=1, arg2=37)
printer -> state=NEEDS_ACK
host    -> ACK(arg1 = the frame's byte 3)
printer -> state=READY
host    -> PRINT_START           payload[0..3] = image length
printer -> state=REQUEST_DATA, payload[0..3] = offset
host    -> DATA                  image[offset ..]
            (repeats)
printer -> state=MEDIA_INFO       repeats while printing
printer -> state=FINISHED
host    -> END_JOB                nothing follows
```

Heartbeats interleave at any point and must be echoed immediately.

The printer does not specify how many bytes it wants, only the offset. It accepts
the entire remainder in a single DATA frame, which is what the library sends;
`maxChunkSize` caps it if a transport needs smaller writes.

Section 6a has the byte-level trace of a real successful print.

### Fault details (byte 3)

Each value corresponds to a distinct branch in `PrintService.e`. The app maps
them to UI message ids rather than strings, so the wording below is
**inferred** from surrounding behaviour.

| Detail | Description |
|---|---|
| 1 | general fault |
| 2 | cover open or cartridge not seated |
| 3 | paper jam |
| 4 | out of paper |
| 5 | ribbon or cartridge fault |
| 6 | busy with another job |
| 7 | ribbon exhausted or media mismatch |
| 8 | media mismatch |
| 9 | cooling down |
| 10 | unrecoverable error |

### Media types

`f6981P` is compared against 104 and 114 (cartridge state must be valid before
a job may start) and against 12 (extends the job timeout from 30 s to 300 s).
The app never names these; the labels are **inferred**.

---

## 4. BLE framing

From `b3.b.j(UUID, UUID, int offset, int chunkLen, int opcode, long arg)`.
A frame is a command frame when the 16-bit chunk length is zero.

**Command frame, always 10 bytes:**

```
offset 0   totalLength   3 bytes  big endian
offset 3   0x00 0x00     2 bytes  the zero chunk length
offset 5   opcode        1 byte
offset 6   argument      4 bytes big endian
                         ... or 1 byte when opcode is JOB_PARAMS
```

**Data frame, 5 + N bytes:**

```
offset 0   offset        3 bytes  big endian, position within the payload
offset 3   chunkLength   2 bytes  big endian
offset 5   payload       chunkLength bytes
```

### BLE opcodes (byte 5)

These are corrected further down, in "BLE job flow"; the selector passed to
`b3.b.h()` is not the same number as the wire opcode.

| Opcode | Name | Notes |
|---|---|---|
| 0 | `JOB_PARAMS` | takes a single argument byte, the copy count |
| 1 | `CANCEL` | sent by `b3.b.g()` with every field zeroed |
| 2 | `ANNOUNCE_LENGTH` | announces the transfer length; **always sent last** |
| 3 | `DATA_BLOCK` | announces a block; used by the firmware path |
| 4 | `FINALIZE` | firmware only; argument is the total length |

`b3.b.h()` always appends an `ANNOUNCE_LENGTH` frame after the selector-specific
one, so one logical operation puts two writes on the wire. The codec reproduces
this rather than simplifying it, because the printer's state machine depends on
the pair.

### BLE constants

| Constant | Value | Source |
|---|---|---|
| GATT write chunk | 200 bytes | `i6 + 200` in `b3.b.f()` |
| Block size | 524288 bytes | `PrintService.d` |
| Poll interval | 100 ms | `Thread.sleep(100)` |
| Block timeout | 30 s (300 s for media type 12) | `f6984S` |

### Which transport a printer gets

Not a per-model property. The app decides from how the printer was found, and
there are exactly two places that assign it:

| Site | Discovery | Kind |
|---|---|---|
| `P2PService:496` | Bluetooth Classic name scan matching "Prinics" | 3 |
| `P2PService:560` | BLE advertisement scan, parsing the advertising record | 4 |

Kind 3 is the Classic/SPP path this package implements. Kind 4 is BLE. The same
printer may be reachable either way; the app takes whichever discovery saw it.
The BLE advertising record carries model and media bytes at offsets 0, 12, 13
and 14, which is how the app identifies a printer before connecting.

### BLE job flow, host-driven and NOT implemented here

`b3.b.h(long arg, byte[] data, int selector, int extra)` emits one or two
frames depending on its selector, and always appends an opcode `2` frame:

| Selector | Frames emitted |
|---|---|
| 0 | opcode `0` with `extra` as its single-byte argument, then opcode `2` |
| 1 | opcode `2` only, argument = `arg` |
| 3 | opcode `3` announcing `data.length`, then opcode `2` |
| 4 | opcode `4` with argument = `arg`, then opcode `2` |

`b3.b.g()` sends opcode `1` with every field zeroed, which is the cancel.

The queue processor then splits by job type (`PrintService.c()`):

```java
if (job.isFirmware) {
    PrintService.d(job.crc, bytes);        // 512 KiB blocks: h(0, block, 3, 0)
                                           // then h(length, [], 4, 0)
} else {
    f9016w.h(0L, bytes, 0, job.copies);   // photo: opcode 0 carrying the copy count
    f9016w.h(length, bytes, 1, 0);        // then opcode 2 carrying the length
}
```

So a **photo over BLE** uses opcodes `0` then `2`, with the image pushed as
200 byte data frames in between; a **firmware image** uses `3` per block and a
final `4`. Both then rely on polling the status characteristic.

Wire opcode meanings, corrected against the above:

| Opcode | Meaning |
|---|---|
| 0 | job parameters; the single argument byte is the copy count |
| 1 | cancel |
| 2 | announce length and trigger the transfer; sent after every other command |
| 3 | announce a data block (firmware) |
| 4 | finalize (firmware), argument is the total length |

**Not implemented.** This package speaks SPP only. The framing codec is kept in
`src/protocol/ble.ts` so captures can be decoded, but there is no BLE transport:
it cannot be tested without a BLE-only printer, and on Windows `noble` requires
replacing the Bluetooth adapter driver. The service and characteristic UUIDs are
also still unknown, since `b3.b` discovers them positionally rather than
hardcoding them.

---

## 5. USB path: an ADB tunnel

This is the least obvious part of the system and the most important finding.

`c3.C0506a`, `F0.RunnableC0047c.c()` and `c3.RunnableC0512g` show the app
implementing **its own ADB host** over the USB accessory endpoints. The command
words appear as decimal literals:

| Literal | Hex | ASCII |
|---|---|---|
| 1314410051 | `0x4E584E43` | `CNXN` |
| 1313165391 | `0x4E45504F` | `OPEN` |
| 1497451343 | `0x59414B4F` | `OKAY` |
| 1163154007 | `0x45545257` | `WRTE` |
| 1163086915 | `0x45534C43` | `CLSE` |

The 24-byte header is written field by field at offsets 0, 4, 8, 12, 16 and 20,
which is exactly the ADB message layout:

```
offset 0   command       4 bytes  little endian
offset 4   arg0          4 bytes
offset 8   arg1          4 bytes
offset 12  data length   4 bytes
offset 16  data checksum 4 bytes  sum of payload bytes
offset 20  magic         4 bytes  command XOR 0xFFFFFFFF
offset 24  payload
```

The app zeroes arg0, arg1, checksum and magic on the accessory link, so the
device's accessory-side implementation is lenient. Over the PC-facing USB
interface it is stock adbd and the fields must be correct.

### Direction matters

On the accessory link **the printer initiates**. `RunnableC0512g.a()` answers an
inbound `OPEN` with `OKAY` and forwards `WRTE` payloads to a local socket
(`localhost:56065`), where `b3.i`'s `ServerSocket` is listening. It never
inspects the OPEN destination string.

A stock `adb` client cannot be reused for that: the adb server rejects
device-initiated streams unless a matching reverse forward exists, and
`reverse:` is not implemented by this adbd. The host is therefore implemented
directly over libusb in `src/transport/adb/host.ts`, and accepts any inbound
`OPEN` permissively, exactly as the app does.

### Two rules the transport must follow

Both were established on hardware, and both produce the same misleading
symptom when broken: the device stalls its bulk IN endpoint and then
re-enumerates, which looks like a driver or permission fault.

**1. The header and the payload are separate bulk transfers.**

adbd reads exactly 24 bytes, then reads the declared payload length as a
second transfer. Sending a combined buffer desynchronises it. This is why
every message with a payload failed while empty ones succeeded: a CNXN with a
banner, and every `OPEN`, carry a payload.

```
transferOut(epOut, header24)      then      transferOut(epOut, payload)
```

Reads must follow the same convention: `transferIn(epIn, 24)`, then
`transferIn(epIn, declaredLength)`. Asking for one oversized buffer does not
work.

**2. Do not overlap the handshake with a pending read, and back off when idle.**

Issuing bulk IN transfers in a tight loop while the device is idle makes it
drop the link after a second or two. The transport sends CNXN before starting
its read loop and pauses `idlePollIntervalMs` (default 20 ms) between empty
reads.

### Negotiated values, confirmed on hardware

The device answers CNXN with:

```
CNXN arg0=0x01000000 arg1=4096
"device::ro.product.name=occam;ro.product.model=Nexus 4;ro.product.device=mako;"
```

So the protocol version is the legacy `0x01000000` and **the maximum payload is
4096 bytes, not the modern 256 KiB**. `AdbHost` advertises the same and adopts
whatever the device reports, splitting WRTE frames accordingly.

### Which services this adbd accepts

Probed over libusb with `tools/enumerate-services-usb.mjs`, 31 candidate names
including every plausible print-related one:

| Accepted | Refused with CLSE |
|---|---|
| `jdwp`, `track-jdwp` | `shell:`, `sync:`, `framebuffer:`, and all vendor guesses (`print:`, `printer:`, `prinics:`, `ppvp:`, `kodak:`, `photo:`, `spool:`, `accessory:`, ...), all `localabstract:` names, and all device loopback ports |

`track-jdwp` returns `0000`: **no debuggable process is running on the
printer**. And across a 30 second session the device never opened a stream of
its own.

### Conclusion: USB is not a print path on this model

Three independent observations point the same way:

1. No service name resembling a print channel is accepted.
2. The printer never initiates a stream when a PC is the host.
3. No app process is running that could serve one.

On top of that, the manufacturer strings the app accepts in accessory mode are
`PD460`, `PD-480`, `D600`, `PD400`, `VuPoint`, `SharperImage` and friends,
which are other Prinics-built printers that act as USB hosts. The Mini Shot 3
Retro is a Bluetooth printer; its USB port provides charging plus a stripped
adbd for service and firmware work.

**Print over BLE on this model.** The USB transport in this package is
therefore useful for diagnostics and firmware exploration, and is kept because
the stream protocol above is the same one a USB-host sibling model would use.

---

## 6. Image preparation

The payload is a JPEG. `libprinics_ip.so` exports a single JNI entry point:

```
Java_com_prinics_ip_Prepare_prepare(String inPath, String outPath,
                                    int width, int height,
                                    boolean flag, int mode)
```

Its symbol table contains `rgb_to_ycc`, `ycc_to_rgb` and `stbi_write_jpg`
(stb_image_write), so it applies a colour transform and then encodes a JPEG.

**Verified:** the payload is JPEG; a colour transform runs before encoding.

**Open:** the exact transform coefficients, the meaning of the `flag` and
`mode` parameters, and the exact raster geometry.

The library therefore produces a correctly sized baseline JPEG and exposes
`colorTransform` as an injection point. To close the gap, call the native
library with a known input and compare its output byte for byte against
`kodak print --dry-run`.

### Media geometry

| Profile | Geometry | Status |
|---|---|---|
| `mini-shot-3-retro` | 873 x 873 at 291 dpi (3 x 3 in) | **inferred** from the published specification |
| `mini-shot-2-retro` | 611 x 989 at 291 dpi (2.1 x 3.4 in) | **inferred** |

Both are marked unverified in code, and the CLI prints a note. Override with
`--width` and `--height` until confirmed.

---

## 6a. The print path, confirmed end to end

**The Mini Shot 3 Retro prints over Bluetooth Classic SPP, not BLE.** It pairs
as a BR/EDR device (`Kodak Instant - XXXX`) advertising the SPP profile
`00001101-0000-1000-8000-00805F9B34FB`, which every desktop OS exposes as a
serial port. The bytes on that port are the stream framing from section 3.

The following is a real trace of a successful print:

```
<- 64 00 00 00  len=0            HEARTBEAT
-> 64 01 00 00  len=0            echo, required
-> 02 01 25 00  len=0            SESSION_START, revision 37
<- 02 05 49 35  len=32           arg1=5, needs acknowledgement
-> 07 35 00 00  len=0            ACK, byte 3 echoed back
<- 04 01 03 1c  len=1            arg1=1, READY
-> 05 01 00 00  len=12           PRINT_START, payload[0..3] = image length
<- 08 00 00 00  len=8            arg1=0, REQUEST_DATA at offset 0
-> 09 00 00 00  len=72784        DATA, the whole raster
<- 01 05 01 00  len=0            arg1=5, needs acknowledgement
-> 07 00 00 00  len=0            ACK
<- 04 03 01 01  len=8            arg1=3, MEDIA_INFO, repeats while printing
<- 04 06 00 00  len=0            arg1=6, FINISHED
-> 01 00 00 00  len=0            END_JOB
                                 (printer goes silent, sheet comes out)
```

Four things this settles, each of which had been guessed wrong beforehand:

**Dispatch is on byte 1, not on the opcode.** The printer signals READY with
opcode `0x04`, requests data with `0x08`, and reports media state with `0x04`
again. Only a few opcodes are special (`0x64` heartbeat, `0x13`/`0x14`,
`0x40`/`0x41`, the file-browser range); everything else is routed by byte 1.
This mirrors `b3.i.run()`, whose `b10` chain sits underneath the opcode checks.

**Byte 1 value 5 means "acknowledge me".** The host replies with opcode `0x07`
carrying byte 3 back as its argument. The handshake does not progress without
it. This is the `if (b10 == 5) b((byte) 7, b13, 0, 0, null)` branch.

**Byte 3 is a fault code only in some states.** Under byte 1 of `0`, any
non-zero value is a fault. Under `1`, only `10` is. Elsewhere it carries
unrelated data: a `NEEDS_ACK` frame arrives as `arg1=5 arg3=53`, and normal
`MEDIA_INFO` during printing arrives as `arg1=3 arg3=1`. Treating byte 3 as a
universal fault flag aborts healthy jobs.

**There is no JOB_COMPLETE.** The printer reports `FINISHED` and then goes
quiet. A host that waits for opcode `0x13` hangs until its job timeout.

The printer also answers `SESSION_START` with a 32 byte payload beginning
`01 03 1c 01`, and sends `04 01 03 1c` with a single payload byte that
increments between sessions. Those look like a firmware version and a counter,
but neither is decoded here.

### Note on serial libraries

On Windows, `node-serialport` opens the Bluetooth virtual COM port and writes
successfully but never delivers received bytes. `System.IO.Ports.SerialPort`
on the same port works. `tools/spp-print.ps1` exists because of this. On Linux
(`/dev/rfcomm0`) and macOS the Node path is expected to work normally.

## 7. Status of each finding

### Confirmed on hardware

- **The full print flow over SPP**, end to end, producing a sheet: framing,
  every opcode in section 3, the heartbeat echo, the acknowledgement rule, the
  printer-driven pull model, and job completion.
- That the transfer is printer driven, and that the printer accepts the whole
  raster in a single DATA frame.
- That an 873 x 873 baseline JPEG is accepted and prints.
- USB identity, ADB interface and bulk endpoint pair.
- The ADB handshake, including the split-transfer requirement and the idle
  backoff, both of which are needed for a stable link.
- Negotiated ADB protocol version `0x01000000` and maximum payload `4096`.
- The accepted ADB service list, and that no print service exists over USB.

### Derived from the app, not exercised

- The BLE frame layout and opcodes in section 4. This model uses SPP, so that
  path is untested; it is retained for sibling models that advertise GATT.
- The modern opcode pair (`PRINT_START` / `DATA`) used above protocol level
  100. This printer negotiated the legacy pair.
- The file browser sub-protocol (`0x51` to `0x54`).

### Still open

1. The colour transform in `libprinics_ip.so`, and its `flag` and `mode`
   parameters. Output is currently a standard JPEG, so colour is approximate.
2. Whether 873 x 873 is the firmware's native raster size or merely an
   accepted one. The printer did not reject it, which does not prove it is
   optimal.
3. The meaning of the 32 byte `SESSION_START` reply and the incrementing
   counter in the `04 01 03 1c` frame.
4. Whether the printer can name a chunk length on `REQUEST_DATA`. It only ever
   sent an offset, and accepted the entire remainder in one frame.

None of these gate printing. They affect output fidelity and diagnostics.
