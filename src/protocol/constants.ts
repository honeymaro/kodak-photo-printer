/**
 * Protocol constants recovered from the official KODAK Photo Printer app
 * (com.prinics.kodak.photoprinter 5.1.2).
 *
 * Provenance is noted per constant so that values which were observed
 * directly in the decompiled bytecode can be told apart from values that
 * are inferred and still need confirmation against real hardware.
 * See PROTOCOL.md for the full derivation.
 */

/** Size of the fixed header on every stream (USB/Wi-Fi/SPP) frame. */
export const FRAME_HEADER_SIZE = 8;

/**
 * Commands sent host -> printer on the stream protocol.
 *
 * Observed as literal `b((byte) N, ...)` call sites in `b3.i.run()`.
 */
export const Command = {
  /** Ends the current job. Sent after the printer reports status 6. */
  END_JOB: 0x01,
  /** Opens a session. Sent as `b(2, 1, 37, 0, null)` after the banner. */
  SESSION_START: 0x02,
  /** Status poll / retry probe, sent on read timeout. */
  STATUS_POLL: 0x03,
  /** Legacy job start. Payload is 12 bytes, first 4 = image byte length. */
  PRINT_START_LEGACY: 0x05,
  /** Acknowledges a printer status 5 notification. */
  ACK: 0x07,
  /** Legacy image data chunk. */
  DATA_LEGACY: 0x09,
  /** Job start used when the peer reports protocol level > 100. */
  PRINT_START: 0x10,
  /** Image data chunk. */
  DATA: 0x12,
  /** Requests the on-device file listing ('Q'). */
  FILE_LIST: 0x51,
  /** Requests the next file listing page ('R'). */
  FILE_LIST_NEXT: 0x52,
  /** Requests a file read ('S'). */
  FILE_READ: 0x53,
  /** Requests the next file read chunk ('T'). */
  FILE_READ_NEXT: 0x54,
  /** Requests the device information block. See `parseDeviceInfo`. */
  DEVICE_INFO: 0x70,
  /** Heartbeat. Echoed back whenever the printer sends one. */
  HEARTBEAT: 0x64,
} as const;

export type CommandCode = (typeof Command)[keyof typeof Command];

/**
 * Opcodes seen in the first header byte of printer -> host frames.
 *
 * Observed as the `b9 == N` comparison chain in `b3.i.run()`.
 */
export const Notification = {
  /** Main print state machine channel. The second byte carries the state. */
  PRINT_STATE: 0x00,
  /** Job finished. */
  JOB_COMPLETE: 0x13,
  /** Session teardown request. */
  SESSION_END: 0x14,
  /** File listing response ('Q'). */
  FILE_LIST: 0x51,
  /** File read response ('S'). */
  FILE_READ: 0x53,
  /** File read continuation ('T'). */
  FILE_READ_NEXT: 0x54,
  /** Acknowledged, no data pending. */
  IDLE_A: 0x40,
  /** Acknowledged, no data pending. */
  IDLE_B: 0x41,
  /**
   * Device information block: thirteen 32-bit counters followed by two
   * NUL-terminated ASCII strings. See `parseDeviceInfo`.
   */
  DEVICE_INFO: 0x70,
  /** Heartbeat, must be echoed. */
  HEARTBEAT: 0x64,
} as const;

/**
 * Job states the app reports while a firmware image is being pushed.
 *
 * Taken from the state strings in `b3.f`. Firmware transfer reuses the print
 * queue: `PrintService.a()` enqueues a firmware file, and the same chunking
 * loop that carries a photo carries the image.
 */
export const FirmwareState = {
  TRANSFERRING: 7,
  UPDATING: 8,
  SUCCESS: 9,
  FAILED: 10,
} as const;

/**
 * Values of the second header byte when the printer is driving a print job.
 *
 * Observed as the `b10 == N` comparison chain in `b3.i.run()`.
 */
export const PrintState = {
  /** The printer is requesting a slice of image data. */
  REQUEST_DATA: 0,
  /** The printer is ready to accept a job. Host replies with PRINT_START. */
  READY: 1,
  /** Carries media information. Payload byte 6 is the media type. */
  MEDIA_INFO: 3,
  /**
   * The frame must be acknowledged with `ACK`, carrying byte 3 back as its
   * argument. Observed as `if (b10 == 5) b((byte) 7, b13, 0, 0, null)`, and
   * confirmed on hardware: the printer sends this right after SESSION_START
   * and will not progress until it is answered.
   */
  NEEDS_ACK: 5,
  /** The job is done. Host replies with END_JOB. */
  FINISHED: 6,
} as const;

/**
 * Protocol revision advertised by the host in SESSION_START.
 *
 * Observed literally as `b((byte) 2, 1, 37, 0, null)`.
 */
export const SESSION_PROTOCOL_REVISION = 37;

/**
 * Default job identifier. The app keeps this in a mutable static that is
 * only reassigned from a server response, so 12231 is the effective default.
 *
 * Observed as `public static long f6977L = 12231` in `b3.i`.
 */
export const DEFAULT_JOB_ID = 12231;

/**
 * Peer protocol level above which the app switches from PRINT_START_LEGACY
 * to PRINT_START and from DATA_LEGACY to DATA.
 *
 * Observed as `if (P2PService.f8992o > 100)`.
 */
export const MODERN_PROTOCOL_LEVEL = 100;

/** Bluetooth Classic SPP service UUID used by the RFCOMM transport. */
export const SPP_SERVICE_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/**
 * Loopback port the app's USB accessory bridge connects to. Only meaningful
 * inside the Android app; kept here because it identifies the bridged stream.
 */
export const ANDROID_BRIDGE_PORT = 56065;

/** Vendor id of the printer's USB interface (Rockchip). */
export const USB_VENDOR_ID = 0x2207;

/** Product id observed on the Mini Shot 3 Retro. */
export const USB_PRODUCT_ID = 0x0006;

/**
 * USB interface triplet that identifies the ADB interface, which is the one
 * carrying the print stream.
 */
export const ADB_INTERFACE = {
  class: 0xff,
  subclass: 0x42,
  protocol: 0x01,
} as const;

/**
 * Manufacturer strings the app accepts when running as a USB accessory.
 * Useful for identifying sibling models that speak the same protocol.
 */
export const ACCESSORY_MANUFACTURERS = [
  'Prinics',
  'VuPoint',
  'SharperImage',
  'Kodak',
  'Kodak ',
  'Koda',
  'PD460',
  'PD-480',
  'D600',
  'PD400',
] as const;

/** BLE framing constants, from `b3.b`. */
export const Ble = {
  /** Bytes per GATT write of image payload. Observed as `i6 + 200`. */
  CHUNK_SIZE: 200,
  /** Bytes per outer block before waiting for an ack. Observed as 524288. */
  BLOCK_SIZE: 524288,
  /** Length of a command (non-data) frame. */
  COMMAND_FRAME_SIZE: 10,
  /** Header length of a data frame; payload follows. */
  DATA_FRAME_HEADER_SIZE: 5,
} as const;

/**
 * BLE wire opcodes, carried in byte 5 of a command frame.
 *
 * These are the values `b3.b.j()` writes. Note that `b3.b.h()` takes a
 * *selector* which is not the same number: selector 1 emits an opcode 2 frame,
 * for instance. The mapping is set out in PROTOCOL.md.
 */
export const BleOpcode = {
  /**
   * Job parameters. Its single argument byte is the copy count.
   *
   * Sent as the first frame of a photo job: `h(0, data, 0, copies)`.
   */
  JOB_PARAMS: 0,
  /** Cancels the running job. Sent by `b3.b.g()` with every field zeroed. */
  CANCEL: 1,
  /**
   * Announces the transfer length and triggers it. Emitted after every other
   * command, so it always terminates a command sequence.
   */
  ANNOUNCE_LENGTH: 2,
  /** Announces a data block. Used by the firmware transfer path. */
  DATA_BLOCK: 3,
  /** Finalizes a firmware transfer. Argument is the total length. */
  FINALIZE: 4,
} as const;

export type BleOpcodeValue = (typeof BleOpcode)[keyof typeof BleOpcode];

/**
 * Transport discriminator used by the app's job records (`b3.j.f7025o`).
 *
 * Only two values are ever assigned, and not by model: the app sets them from
 * how the printer was discovered. `P2PService:496` assigns 3 for a device found
 * by Bluetooth Classic name scan, `P2PService:560` assigns 4 for one found by
 * BLE advertisement scan.
 */
export const TransportKind = {
  /** Bluetooth Classic, reached over SPP. What this package implements. */
  CLASSIC: 3,
  /** BLE GATT. Not implemented here; see PROTOCOL.md. */
  BLE: 4,
} as const;
