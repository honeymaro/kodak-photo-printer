# kodak-photo-printer

TypeScript library and CLI for **Prinics-built instant photo printers**, sold as
Kodak Mini Shot, Kodak Dock, PICKIT SNAPS and SI.

The protocol is not published. It was recovered by decompiling the official
Android app and probing the hardware.

- [`PROTOCOL.md`](./PROTOCOL.md) is the wire specification.
- [`CAPABILITIES.md`](./CAPABILITIES.md) assesses what these printers can do and
  how much of it this library could reach.
- [`ANALYSIS.md`](./ANALYSIS.md) records how it was all derived, mistakes included.

> **Status: it prints.** The full protocol has been driven against a Kodak Mini
> Shot 3 Retro and produced a photo. 108 tests cover the codecs and state
> machines with no hardware required.
>
> Printing goes over **Bluetooth Classic SPP**. Not BLE, and not USB.

---

## Supported printers

23 models across four paper sizes, with exact raster geometry taken from the
app's own model table. Run `kodak models` to list them.

| Paper | Raster | Models |
|---|---|---|
| 3 x 3 in | 896 x 896 | C300R, MS300, M300, P300R, P330, C330, SI_C300, SI_P300 |
| 2.1 x 3.4 in | 640 x 1024 | C210R, MS200, M200, P210R, P230, C230, SI_C210, SI_P210 |
| 4 x 4 in | 1280 x 1280 | MS400, C440 |
| 4 x 6 in | 1240 x 1864 | PD460, D600, P640, SI_PD460, SI_P450W |

Only **C300R** (Mini Shot 3 Retro) has been printed on. The protocol contains no
model-specific branching beyond timeouts, so the rest are expected to work, but
that is an expectation and not a result. `MEDIA_PROFILES` records this per model
as `hardwareTested`.

---

## Install

```bash
pnpm add kodak-photo-printer
```

The core library has one dependency (`commander`, for the CLI). Everything that
needs a native module is an optional peer, so install only what you use:

```bash
pnpm add serialport   # Bluetooth SPP, the print path
pnpm add sharp        # image preparation
pnpm add usb          # USB, diagnostics only
```

On pnpm 10 the native packages need their build scripts approved once:

```bash
pnpm approve-builds
```

Missing a package is not a crash. The CLI reports what to install and exits with
code 3.

---

## CLI

```bash
kodak --help
kodak models              # printer models and their raster sizes
kodak devices             # reachable printers
```

### Print

Pair the printer over Bluetooth first, then point the CLI at its serial port.
`--profile` is required, because geometry differs per model and a wrong value
wastes a sheet.

```bash
kodak print photo.jpg --profile C300R --port COM5           # Windows
kodak print photo.jpg --profile C300R --port /dev/rfcomm0   # Linux
kodak print photo.jpg --profile MS400 --port COM5 --copies 2
kodak print photo.jpg --profile PD460 --port COM5 --fit contain
```

`kodak devices` lists the candidate ports. On Windows a paired SPP device
produces two, an incoming and an outgoing one; the outgoing port carries the
printer's Bluetooth address in its hardware id.

Check the prepared raster without touching the printer:

```bash
kodak print photo.jpg --profile C300R --dry-run out.jpg
```

### Diagnose

```bash
adb kill-server           # release the USB interface for libusb
kodak probe --timeout 30000
```

Runs the ADB handshake and reports every stream the printer opens and every byte
it sends, without transmitting print commands.

```bash
kodak inspect "02 01 25 00 00 00 00 00"
kodak inspect --kind ble "00 00 00 00 00 04 00 01 00 00"
kodak inspect --kind adb --file capture.hex
```

Decodes captured bytes with the same codecs the library uses:

```
frame opcode=0x02 (host:SESSION_START / printer:0x02)  arg1=1 arg2=37 len=0
  status  kind=job-state
```

---

## Library

```ts
import { connectSerial, MEDIA_PROFILES } from 'kodak-photo-printer';

const printer = await connectSerial({ path: 'COM5' });

await printer.printImage('photo.jpg', {
  copies: 1,
  prepare: { profile: MEDIA_PROFILES['C300R'] },
  onProgress: ({ percent }) => process.stdout.write(`\r${percent}%`),
  onStatus: (status) => {
    if (status.kind === 'error') console.error(status.message);
  },
});

await printer.disconnect();
```

### Prepare without printing

```ts
import { prepareImage, findMediaProfile } from 'kodak-photo-printer';

const { data, width, height } = await prepareImage('photo.jpg', {
  profile: findMediaProfile('C300R'),
  fit: 'cover',
});
```

There is no default profile. Callers must name a model, or pass both `width` and
`height`.

### Query the printer

```ts
const info = await printer.requestDeviceInfo();
// { counters: number[13], stringA: string, stringB: string }
```

The block's field semantics are unconfirmed; the app reads these values and then
discards them. The two strings are the right shape for a serial number and a
firmware version.

### Work with the protocol directly

Every codec is pure and dependency free, which is what makes the whole flow
testable without hardware:

```ts
import { encodeFrame, Command } from 'kodak-photo-printer';

encodeFrame({ opcode: Command.SESSION_START, arg1: 1, arg2: 37 });
// -> 02 01 25 00 00 00 00 00
```

`MockTransport` drives a whole job in memory:

```ts
import { Printer, MockTransport, encodeFrame, PrintState } from 'kodak-photo-printer';

const transport = new MockTransport();
const printer = new Printer(transport);
await printer.connect();

transport.receive(encodeFrame({ opcode: 0x04, arg1: PrintState.READY }));
```

---

## How it works

The printer accepts **a JPEG and a length** and does the panel separation,
dithering and lamination itself. Frames are an 8-byte header plus a payload, and
the transfer is **printer-driven**: the printer asks for a byte offset, the host
serves that slice.

```
printer -> HEARTBEAT          must be echoed, or the session drops
host    -> SESSION_START
printer -> needs ACK          byte 1 = 5; echo byte 3 back
host    -> ACK
printer -> READY              byte 1 = 1
host    -> PRINT_START        payload carries the image length
printer -> REQUEST_DATA       byte 1 = 0, offset in the payload
host    -> DATA               the requested slice
printer -> MEDIA_INFO         byte 1 = 3, repeats while printing
printer -> FINISHED           byte 1 = 6
host    -> END_JOB            no reply follows; the sheet comes out
```

Three things about that flow are easy to get wrong, and each cost time here:

- **Dispatch is on header byte 1, not the opcode.** The printer signals READY
  with opcode `0x04` and requests data with `0x08`.
- **Byte 3 is a fault code only in some states.** A healthy job carries non-zero
  values there routinely.
- **There is no JOB_COMPLETE.** The printer reports FINISHED and goes quiet, so
  `END_JOB` is terminal.

### Why not BLE

The app's BLE code is its most elaborate transport, which made it look like the
print path. It is not. The printer pairs as Bluetooth Classic (`BTHENUM`, service
UUID `00001101`) and the app picks a transport from **how the printer was
discovered**, not from its model.

BLE does carry photos on devices found by a BLE advertisement scan, so the path
is real, but this package does not implement it: there is no BLE-only printer
here to test against, and on Windows `noble` requires replacing the Bluetooth
adapter driver, which disables every other Bluetooth peripheral. The framing
codec is kept so captures can be decoded; see `PROTOCOL.md`.

### Why not USB

The USB port exposes a stripped adbd. Probing 31 candidate service names, only
`jdwp` and `track-jdwp` are accepted, no debuggable process runs, and the printer
never opens a stream. Useful for diagnostics, not for printing.

The app's USB accessory code is real, but the manufacturer strings it accepts
(`PD460`, `PD-480`, `D600`, `PD400`, `VuPoint`, `SharperImage`) belong to sibling
models that act as USB hosts.

---

## Windows and node-serialport

On Windows, `node-serialport` opens the Bluetooth virtual COM port and writes to
it successfully, but never delivers received bytes. `System.IO.Ports.SerialPort`
on the identical port works. Until that is resolved, print on Windows with:

```powershell
node dist/cli/main.js print photo.jpg --profile C300R --dry-run raster.jpg
powershell -ExecutionPolicy Bypass -File tools/spp-print.ps1 -Port COM5 -Raster raster.jpg
```

Add `-DryRun` to stop at READY without producing a sheet. On Linux
(`/dev/rfcomm0`) and macOS the Node path is expected to work normally.

---

## Limitations

1. **Colour is approximate.** The app runs a thermal compensation pipeline
   (`libprinics_ip.so`) before encoding: an LUT, unsharp masking, a bilateral
   filter, an RGB to YCC transform and per-panel heat-accumulation correction.
   This library emits a standard JPEG and exposes a `colorTransform` hook.
   `CAPABILITIES.md` lists the exact tuning constants.
2. **Only one model tested.** See the table above.
3. **`node-serialport` receive on Windows**, described above.
4. **Firmware update is out of scope.** The mechanism is understood and the
   images ship inside the app, but a bad flash bricks the printer with no
   recovery path.

The printer **sleeps after a period of inactivity**. Power it on before
connecting.

---

## Development

```bash
pnpm install
pnpm run build
pnpm test          # 108 tests, no hardware required
pnpm run typecheck
```

Hardware tools live in `tools/` and are plain scripts. Only `spp-print.ps1`
without `-DryRun` produces a sheet; everything else is read-only.

```bash
node tools/make-test-image.mjs test.png 896            # square test target
powershell -File tools/spp-handshake.ps1 -Port COM5    # observe the handshake
node tools/enumerate-services-usb.mjs                  # what adbd accepts
node tools/usb-cnxn-variants.mjs                       # ADB handshake variants
```

```
src/
  protocol/     framing, print state machine, status, device info  (pure, tested)
  transport/    serial (SPP), usb (ADB), mock
  image/        raster preparation and the model table
  cli/          commander entry points
```

---

## Legal

An independent, interoperability-driven implementation. Not affiliated with or
endorsed by Kodak, Prinics, or any of their licensees. Trademarks belong to their
respective owners.

MIT licensed.
