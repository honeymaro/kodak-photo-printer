# How far can this go

An assessment of everything the official app can do with these printers, and
what an independent library can realistically match. Derived from the
decompiled app, its bundled assets, and its native image library, with the
print path confirmed against real hardware.

Each item is graded:

- **Done**: implemented here and exercised.
- **Easy**: no unknowns, just work.
- **Needs work**: the mechanism is understood but something must be recovered
  or measured first.
- **Hard**: significant reverse engineering left.
- **Won't**: possible but deliberately out of scope.

---

## 1. The short answer

The printer is far simpler than the app suggests. It accepts **a JPEG and a
length**, and does the panel separation, dithering and lamination itself.
Almost everything the app appears to "do" is client-side image editing that
never reaches the printer.

That means the ceiling is high. The parts that genuinely need the wire
protocol are printing, status, device info, firmware update and a latent file
browser. Everything else is an image library problem.

The one real quality gap is colour: the app runs a thermal compensation
pipeline before encoding, and this library does not.

---

## 2. Printer models

The app's model table gives exact raster geometry for 23 products across four
paper sizes. All of it is now in `MEDIA_PROFILES`.

| Paper | Raster | Models |
|---|---|---|
| 3 x 3 in | 896 x 896 | C300R (Mini Shot 3 Retro), MS300, M300, P300R, P330, C330, SI_C300, SI_P300 |
| 2.1 x 3.4 in | 640 x 1024 | C210R (Mini Shot 2 Retro), MS200, M200, P210R, P230, C230, SI_C210, SI_P210 |
| 4 x 4 in | 1280 x 1280 | MS400 (Mini Shot 4 Era), C440 |
| 4 x 6 in | 1240 x 1864 | PD460 (Dock Plus Retro), D600 (Dock Era), P640, SI_PD460, SI_P450W |

**Status: Done.** Paper size is a property of the printer, not a job option:
the app picks it from the connected model and never sends it.

Since all of these speak the same framing, **the library should already work
on the other models** over SPP. Untested, but there is no model-specific
branching in the print path beyond timeouts.

---

## 3. Printing

| Capability | Grade | Notes |
|---|---|---|
| Print one photo | **Done** | Confirmed end to end on a Mini Shot 3 Retro. |
| Copies | **Easy** | The app offers 1 to 5 and passes the count in the job start frame's `arg1`. Implemented, untested above 1. |
| Multiple photos | **Easy** | The app does not batch. It serialises N single-photo jobs through a semaphore, one at a time. Reproducing that is a loop. |
| Cancel a job | **Easy** | `END_JOB` mid-transfer. Implemented, untested. |
| Progress reporting | **Done** | The printer emits `MEDIA_INFO` frames while printing; the job reports byte progress. |
| Fault reporting | **Done** | Ten fault codes decoded. Only the healthy path has been seen on hardware. |

### Print quality

The printer accepts a plain baseline JPEG. What the app sends instead is the
output of `libprinics_ip.so`, whose pipeline is:

```
resize/crop -> optional border -> LUT -> sharpening -> RGB to YCC -> THC -> JPEG
```

The native library's built-in defaults are embedded as a text block and are
fully readable:

```
[thc_sac]      enabled = 1   shortWindow = 1   longWindow = 20
               inkDropThreshold = 40   gainCharge = 0.3   gainCorrect = 1.0
               releaseRate = 0.4   gamma = 0.5   applyThreshold = 192
               maxCorrection = 20   lateralSmooth = 0.25
[sharpening]   sharpen2 = 0.6   threshold = 15
[bilateral]    sharpen1 = 0.5   sigma_spatial = 1.0   sigma_range = 0.08
[output]       contrast = 50   compression = 100
```

`thc_heat_accum`, `thc_csb`, `thc_short`, `thc_long` and `reverse_thc` all
ship disabled, so only **smear-adaptive compensation, unsharp masking and a
bilateral filter** are active by default.

THC is thermal head compensation. The library carries per-panel lookup tables
(`thc_table_c`, `thc_table_m`, `thc_table_y`) and models heat accumulation
across scan lines so a dark region does not smear into what follows.

| Capability | Grade | Notes |
|---|---|---|
| Correct geometry | **Done** | Now taken from the model table. |
| JPEG at quality 100 | **Easy** | The app uses `compression = 100`; this library defaults to 95. |
| Contrast, sharpening, bilateral | **Needs work** | Parameters known exactly. Reimplementing unsharp mask and a bilateral filter is ordinary image processing. |
| RGB to YCC transform | **Needs work** | Function exists; coefficients need extraction or matching by comparison. |
| Thermal compensation (THC) | **Hard** | Tuning constants are known but the algorithm and the three panel LUTs are compiled in. Realistically needs either extracting the tables from the binary or running the `.so` under an ARM emulator. |

**The pragmatic route** is to call the native library once on a known input and
diff its output against ours, rather than reimplementing blind. It is a normal
`.so` and takes file paths in and out.

---

## 4. Image editing

Every one of these is client-side. The printer receives one flattened bitmap
and knows nothing about layers, filters or frames. Any image library can do all
of it.

| Feature | Grade | Evidence |
|---|---|---|
| Collages, 2 to 15 photos | **Easy** | Dedicated widgets for 1x2, 2x4, 3x3, 3x5 grids plus a 15-cell general layout. |
| ID-photo grids | **Easy** | A four-slot passport-photo layout. |
| Decorative frames | **Easy** | 8 frames per paper size shipped as WebP in the app's assets, for 2, 3, 4 and 6 inch, plus separate colour and "pickit" branded sets. |
| White border | **Easy** | Per-size ratios are hardcoded in the app's photo model. |
| Polaroid layout | **Easy** | The native library exposes `PRINT_POLAROID_TOP/LEFT/WIDTH/HEIGHT`, so an instant-photo layout with a wide lower margin is a first-class mode. |
| Colour filters | **Easy** | Five LUT filters (peach, pineapple, santorini, vogue, yuja) shipped as PNG lookup images. Standard LUT application. |
| Text stickers | **Easy** | Drag, scale, rotate, colour picker; composited to a bitmap. |
| Sticker packs | **Easy** | Roughly 230 sticker assets across six categories. |
| Crop and rotate | **Easy** | The app uses uCrop; free rotation and 90 degree steps. |
| Brightness | **Easy** | A colour matrix. |

**Status: none implemented.** All are straightforward with `sharp` or any
canvas library. The frame and sticker artwork is inside the APK, so a
compatible look is achievable, though redistributing those assets is a
licensing question rather than a technical one.

---

## 5. Device information

| Capability | Grade | Notes |
|---|---|---|
| Model identifier | **Done** | Byte 3 of the session reply. The Mini Shot 3 Retro reports **53**. |
| Session flag and revision | **Done** | Payload byte 0 as a flag, bytes 1 and 2 as a 16-bit value; this printer reports 796. Meaning unconfirmed. |
| Device info block | **Easy, untested** | Opcode `0x70` returns thirteen 32-bit counters at payload offsets 1 through 49, then two 32-byte ASCII strings at 53 and 85. Implemented as `requestDeviceInfo()`. |
| Media type | **Done** | Reported in `MEDIA_INFO` payload byte 6. |
| Remaining prints, battery, temperature | **Needs work** | No named field exists in the app. The likeliest home is those thirteen counters, which the app reads and then discards. One `requestDeviceInfo()` call against hardware would probably identify several by inspection. |

The two ASCII strings are the most promising unknown: 32 bytes each is the
right shape for a serial number and a firmware version.

---

## 6. Firmware update

The app can flash these printers, and ships the images to do it.

Bundled in the APK: `SPCA_55.BRN` (7.0 MB), `SPCA_55C_532b900c.BRN` (2.2 MB),
`3308_5.44`, `3308_5.73`, `3308_5.98`, `es3_3.95`, and references to `6110_9.5`,
`1109_1.82` and per-size `2inch`/`3inch`/`4inch` images.

Selection is by the model id byte. **Model 53 maps to `3308_5.98_update_61979.bin`**,
so that is the image intended for the Mini Shot 3 Retro.

Mechanism: the file is enqueued into the *same* job queue as a photo, then
pushed in 512 KiB blocks with a per-block acknowledgement and a final commit.
Job states 7 to 10 report transferring, updating, success and failed.

| Capability | Grade | Notes |
|---|---|---|
| Reading which firmware applies | **Done** | Model id is parsed. |
| Pushing firmware | **Won't** | The mechanism is understood and the images are in hand, but a bad flash bricks the device, there is no recovery path, and there is no way to verify an image is correct for a given unit. Out of scope. |

The block-transfer code in `BlePrintSession` is that firmware path, not the
photo path. It is retained and documented as such.

---

## 7. Latent and dead ends

**File browser (opcodes 0x51 to 0x54).** The printer stores photos and can list
them. The listing format is decoded: per record, a 2-byte big endian name
length, a UTF-16LE filename, 8 unused bytes, then a flag byte, where bits
`0x02`, `0x04` and `0x08` exclude an entry and bit `0x10` marks it listable.
The app filters for `.jpg`/`.jpeg`.

But the app never sends `0x51` or `0x53`, only the continuations `0x52` and
`0x54`, and the list it builds is never read by any screen. No opcode uploads
or deletes. **Grade: needs work** for listing, **hard** for actually
downloading a file, since no code path extracts image bytes from a response.
It looks like vestigial support rather than a shipped feature.

**Wi-Fi Direct.** `P2PService` requests a Wi-Fi transport and connects by TCP
to ports 56065 and 56067 on the printer's own access point, carrying the same
stream framing. Targets the larger Dock models. **Grade: easy** to add given a
model that offers it; the Mini Shot 3 Retro does not.

**USB.** Not a print path on this model. Confirmed by probing: only `jdwp` and
`track-jdwp` are accepted, no debuggable process runs, and the printer never
opens a stream. Useful for diagnostics only.

**BLE GATT.** Implemented from the app but untested, and on this model it is
the firmware channel rather than the photo channel.

---

## 8. What to do next, in order of value

1. **Call `requestDeviceInfo()` once** against the printer. It does not print.
   Those thirteen counters and two strings are the cheapest large unknown left,
   and would likely yield serial number, firmware version and remaining prints.
2. **Diff against the native pipeline.** Run `libprinics_ip.so` on a known
   input and compare byte for byte with `kodak print --dry-run`. Settles the
   colour transform, the exact JPEG parameters and whether any header is
   expected, without reimplementing anything.
3. **Raise JPEG quality to 100** to match the app. One line.
4. **Add the layout features**: white border, polaroid layout, collage. Pure
   image work, immediate visible payoff.
5. **Test copies above 1 and a multi-photo queue.** Both are believed correct
   but only the single-copy path has run.
6. **Try a second model.** A 2 inch or 4x6 printer would confirm the framing is
   genuinely model independent.

## 9. What this cannot become

The printer does not expose per-panel control, dithering choice, print density
or head temperature. It takes an image and prints it its own way. So the
quality ceiling is set by how well the image is pre-compensated before it is
handed over, and matching the app there means matching its thermal model.
Everything else in the app is decoration that any image library can reproduce.
