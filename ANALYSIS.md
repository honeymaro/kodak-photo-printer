# How the protocol was reverse engineered

This is the methodology record. `PROTOCOL.md` is the resulting specification;
read that first if you only want to know how the printer works.

Target: **Kodak Mini Shot 3 Retro**, built by Prinics.
Sources: the official Android app `com.prinics.kodak.photoprinter` 5.1.2, and
the physical printer over USB.

---

## 1. Identifying the device

The printer was already attached over USB and enumerated as:

```
USB\VID_2207&PID_0006   serial <16 hex digits>   rev 0404
BusReportedDeviceDesc : rk3xxx
Interface             : class 0xFF / subclass 0x42 / protocol 0x01
Driver                : WinUSB, "ADB Device"
```

Vendor `0x2207` is Rockchip, and the `0xFF/0x42/0x01` triplet is the standard
ADB interface descriptor. So the printer runs Android on a Rockchip SoC and
exposes ADB.

`adb devices` reports `product:occam model:Nexus_4 device:mako`. That is a
spoofed build.prop, not a real Nexus 4, and a common trick on RK-generation
firmware. The device also sleeps after a period of inactivity and disappears
from USB entirely, which produced several false "device not found" results
before it was recognised as a power state rather than a fault.

## 2. Decompiling the app

The XAPK was unpacked and the base APK decompiled with jadx 1.5.1:

```
jadx -d out --no-res --show-bad-code --comments-level debug base.apk
```

`--show-bad-code` mattered. The interesting methods (`b3.i.run`,
`b3.b.j`, `F0.RunnableC0047c.c`) all failed clean decompilation, and without
that flag jadx emits only `throw new UnsupportedOperationException`. With it,
the partially reconstructed bodies were readable enough to recover the framing.

Classes that carry the protocol, after deobfuscating by inspection:

| Class | Role |
|---|---|
| `com.prinics.ppvp.PrintService` | job queue and status interpretation |
| `b3.i` | stream print state machine (USB, Wi-Fi, SPP) |
| `b3.b` | BLE GATT transport and framing |
| `b3.d` | Bluetooth Classic SPP transport |
| `c3.C0506a`, `F0.RunnableC0047c`, `c3.RunnableC0512g` | USB accessory ADB tunnel |
| `com.prinics.ip.Prepare` | JNI entry point into `libprinics_ip.so` |

## 3. Recovering the framing

The stream frame came from `b3.i.b(byte, int, int, int, byte[])`, which builds
its header byte by byte, so the layout is directly readable. Command opcodes
were recovered by collecting every `b((byte) N, ...)` call site and reading the
surrounding control flow to work out what each one responds to.

The BLE frame came from `b3.b.j(...)`, which similarly packs its header by
hand.

Two details were initially got wrong and later corrected:

- **The fault byte.** It was first mapped to header byte 2. Re-reading
  `PrintService.e` shows every error branch reads `bArr[3]`, while `bArr[2]`
  holds a job state. This matters because byte 1 is `0` both for "request
  data" and for "no error", so keying faults off byte 1 misfires on every data
  request. A unit test caught this.
- **A chunk size hint.** An early implementation treated header byte 2 of a
  data request as a length hint. There is no evidence for that in the
  bytecode; the printer names only an offset. It was removed rather than left
  as an invented behaviour.

## 4. The pull model

The most consequential structural finding: on the stream protocol the
**printer drives the transfer**. It emits a state frame carrying the byte
offset it wants in the payload, and the host answers with that slice. The
relevant line is `f6 = f(0, bArr3)`, reading a big endian offset out of the
request payload, immediately before the host builds its data frame.

BLE is the opposite: the host pushes 512 KiB blocks as runs of 200 byte GATT
writes and polls a status characteristic between them.

## 5. The USB path is ADB

`c3.C0506a` queues messages with magic numbers stored as decimal literals.
Decoding them as little endian ASCII gives `CNXN`, `OPEN`, `OKAY`, `WRTE` and
`CLSE`. `F0.RunnableC0047c.c()` writes a 24 byte header with fields at offsets
0, 4, 8, 12, 16 and 20. That is the ADB message layout exactly.

So the app implements its own ADB host over the USB accessory endpoints. It
answers any inbound `OPEN` with `OKAY` without inspecting the destination, and
bridges `WRTE` payloads to `localhost:56065`, where `b3.i` is listening.

## 6. Driving the hardware

The library's USB transport was then tested against the printer. Four problems
surfaced, each of which produced the same misleading symptom: the bulk IN
endpoint stalls, then the device re-enumerates, which reads like a driver or
permission fault.

**The `usb` package changed API.** v3 removed the legacy libusb binding
entirely and ships only WebUSB. `device.handle` looked like a way back to the
old API but is just a string. The transport was rewritten against WebUSB,
which works on both v2 and v3.

**Header and payload must be separate bulk transfers.** This was the root
cause of most of the trouble. adbd reads exactly 24 bytes, then reads the
declared payload length as a second transfer. Sending a combined buffer
desynchronises it. The signature of the bug was that every message with a
payload failed while every empty one succeeded, which is why a bare CNXN
appeared to be "the only form the printer accepts" for a while. Once the write
was split, a normal CNXN with a banner worked, and `OPEN` started returning a
clean `CLSE` instead of killing the link.

**Reads must follow the same convention.** `transferIn(ep, 24)` then
`transferIn(ep, declaredLength)`. A single oversized read does not work.

**Idle polling destabilises the link.** Reissuing bulk IN transfers as fast as
the backend returns them makes the device drop the connection after a second
or two. The transport now sends CNXN before starting its read loop and pauses
20 ms between empty reads.

A separate bug was found along the way: the read loop kept the Node event loop
alive, so the CLI never exited and held the USB interface against the next run.

### What the hardware confirmed

```
CNXN arg0=0x01000000 arg1=4096
"device::ro.product.name=occam;ro.product.model=Nexus 4;ro.product.device=mako;"
```

Protocol version is the legacy `0x01000000` and the maximum payload is **4096
bytes**, not the modern 256 KiB.

Probing 31 service names, only `jdwp` and `track-jdwp` are accepted.
`track-jdwp` returns `0000`, meaning no debuggable process is running.

## 7. The conclusion about USB

Three independent observations agree:

1. No service name resembling a print channel is accepted.
2. The printer never initiates a stream when a PC is the host.
3. No app process is running that could serve one.

And the manufacturer strings the app accepts in accessory mode (`PD460`,
`PD-480`, `D600`, `PD400`, `VuPoint`, `SharperImage`) are other Prinics
printers that act as USB hosts.

**The Mini Shot 3 Retro prints over Bluetooth.** Its USB port provides charging
plus a stripped adbd for service work. The USB accessory code in the app
targets sibling models, not this one.

## 7a. It is SPP, not BLE

The Bluetooth assumption then needed correcting too. The printer was expected
to be a GATT peripheral, because `b3.b` is the most elaborate transport in the
app. It is not. Once paired, Windows enumerated it as:

```
BTHENUM\DEV_<bt-address>                        Kodak Instant - XXXX
BTHENUM\{00001101-...}_LOCALMFG&0002\...<bt-address>   Standard Serial over Bluetooth link (COM5)
```

`BTHENUM` rather than `BTHLE`, and the service UUID is `00001101`, plain SPP.
So the device is Bluetooth Classic and uses `b3.d`, the RFCOMM transport, which
carries the same stream framing as USB and Wi-Fi. That made the already
implemented `PrintSession` the right code path, and printing became a matter of
opening a serial port.

Two general lessons, both of which cost time here:

- The most elaborate code path in an app is not necessarily the one a given
  model uses. `b3.b` exists for sibling products.
- `BTHENUM` versus `BTHLE` in a Windows instance id settles Classic versus LE
  immediately, and would have short-circuited a long detour through BLE
  scanning approaches that Windows makes awkward.

## 7b. What the live protocol corrected

Driving a real job exposed three mistakes in the reading of the decompiled
code. All three are the kind that unit tests cannot catch, because the tests
encoded the same wrong assumption.

**Dispatch is on header byte 1, not the opcode.** The implementation only ran
the print state machine for opcode `0x00`. Hardware signals READY with `0x04`
and requests data with `0x08`, so the session sat idle until it timed out. In
`b3.i.run()` the `b10` chain sits underneath the opcode checks rather than
beside them; that structure was misread.

**Byte 1 value 5 means "acknowledge me".** The `if (b10 == 5)` branch had been
noted but not implemented. Without the reply the handshake stops before READY.

**Byte 3 is a fault code only in some states.** It had been treated as a
universal fault flag. The very first frame after `SESSION_START` arrives as
`arg1=5 arg3=53`, where 53 is the value to echo back, so every job aborted
immediately. `PrintService.e` reads byte 3 as a fault only under byte 1 of 0,
and only for the value 10 under byte 1 of 1.

And one behaviour simply absent from the app reading: **the printer never sends
`JOB_COMPLETE`**. It reports `FINISHED` and goes quiet, so `END_JOB` has to be
treated as terminal.

## 7c. node-serialport does not receive on Windows Bluetooth ports

With the protocol correct, the Node path still produced nothing. Isolating it
with a minimal script showed the fault is below the library: `node-serialport`
opens the Bluetooth virtual COM port, reports it open and flowing, writes
successfully, and never delivers a received byte. Asserting DTR and RTS and
calling `resume()` made no difference. `System.IO.Ports.SerialPort` on the
identical port receives immediately and repeatably.

`tools/spp-print.ps1` therefore drives the link from PowerShell, using a raster
the library prepares. The first successful print came from that path.

## 8. Image preparation

`libprinics_ip.so` exports one JNI symbol:

```
Java_com_prinics_ip_Prepare_prepare(String in, String out,
                                    int width, int height,
                                    boolean flag, int mode)
```

Its symbol table contains `rgb_to_ycc`, `ycc_to_rgb` and `stbi_write_jpg`. So
the payload is a JPEG, produced after a colour transform. The transform
coefficients and the meaning of `flag` and `mode` were not recovered; the
library emits a standard JPEG and exposes a `colorTransform` hook instead of
guessing.

## 9. Tooling produced

Everything under `tools/` is reusable and sends no print commands:

| Tool | Purpose |
|---|---|
| `spp-print.ps1` | drives a print over SPP; `-DryRun` stops at READY |
| `spp-handshake.ps1` | observes the handshake, never starts a job |
| `spp-trace.mjs` | same trace through the library's SerialTransport |
| `spp-raw-test.mjs` | minimal serialport read test, used to isolate the receive fault |
| `make-test-image.mjs` | square test target with a colour bar and a border |
| `usb-handshake-probe.mjs` | step by step ADB link diagnostic, one stage per line |
| `usb-cnxn-variants.mjs` | compares CNXN handshake variants and whether the link holds |
| `enumerate-services-usb.mjs` | lists which services adbd accepts, over the library's own AdbHost |
| `probe_adb_services.py` | same idea via the adb server rather than libusb |
| `enumerate-adb-services.py` | broader service sweep via the adb server |
| `ble-winrt-scan.ps1` | WinRT BLE scan; kept although this model turned out to be Classic |
| `libprinics_ip.so` | the extracted native image pipeline, kept for comparison work |

Only `spp-print.ps1` without `-DryRun` produces a sheet.

The decompiled sources are not checked in. Regenerate them with the jadx
command in section 2 if needed.

## 10. What would close the remaining gaps

Printing works, so none of these gate output; they affect fidelity and reach.

1. Calling `prepare()` on a known input, either on an Android device or under
   an ARM emulator, and comparing its output byte for byte against
   `kodak print --dry-run`. That settles both the colour transform and
   whether 873 x 873 is the native raster size.
2. Finding why `node-serialport` does not receive on Windows Bluetooth virtual
   COM ports, so the Node path works there as it should elsewhere.
3. Decoding the 32 byte `SESSION_START` reply and the incrementing counter in
   the `04 01 03 1c` frame, which look like firmware version and a print or
   temperature counter.
4. An SPP capture of the official app printing, to see whether it chunks DATA
   differently or negotiates the modern opcode pair.
