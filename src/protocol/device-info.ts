/**
 * Device information, from the session handshake and the `DEVICE_INFO` block.
 *
 * Two sources exist:
 *
 * - The reply the printer sends to `SESSION_START`. Its header and the first
 *   three payload bytes carry a model identifier and a 16-bit value. Verified
 *   against hardware.
 * - The `DEVICE_INFO` (`0x70`) block, which carries thirteen 32-bit counters
 *   followed by two 32-byte ASCII strings. The app reads all of them but the
 *   decompiled code discards the values, so the field names below are
 *   positional and the semantics are unconfirmed.
 */

import { Command } from './constants.js';
import { encodeFrame, readUint32BE, type Frame } from './frame.js';
import { MediaType } from './status.js';

/** Model identifiers the app special-cases. */
export const ModelBehaviour = {
  /**
   * Models that keep the session alive across a `JOB_COMPLETE` notification
   * rather than tearing it down. Observed as `if (b25 != 104 && b25 != 114)`.
   */
  KEEPS_SESSION: [MediaType.CARTRIDGE_CHECKED_A, MediaType.CARTRIDGE_CHECKED_B] as const,
  /**
   * Model that uses a 300 second transfer timeout instead of 30 seconds.
   * Observed as `if (f6981P == 12) f6984S = 300000`.
   */
  SLOW_TRANSFER: MediaType.SLOW_MEDIA,
} as const;

/** What the printer reveals about itself in its `SESSION_START` reply. */
export interface SessionIdentity {
  /**
   * Model identifier. Taken from header byte 3, which the app stores as its
   * device id and uses to pick a firmware image. The Mini Shot 3 Retro
   * reports 53.
   */
  readonly modelId: number;
  /** Header byte 1 of the reply. The app exposes it as a status value. */
  readonly statusA: number;
  /** Header byte 2 of the reply. */
  readonly statusB: number;
  /**
   * Payload byte 0 read as a boolean. The app stores it as a capability or
   * session-valid flag; its exact meaning is unconfirmed.
   */
  readonly flag: boolean;
  /**
   * Payload bytes 1 and 2 as a 16-bit big endian value. The Mini Shot 3 Retro
   * reports 796. Unconfirmed; plausibly a firmware or protocol revision.
   */
  readonly revision: number;
  /** True when this model keeps the session alive after a completed job. */
  readonly keepsSession: boolean;
  /** True when this model needs the extended transfer timeout. */
  readonly slowTransfer: boolean;
}

/** Interprets the printer's reply to `SESSION_START`. */
export function parseSessionIdentity(frame: Frame): SessionIdentity {
  const payload = frame.payload;
  const modelId = frame.arg3;

  return {
    modelId,
    statusA: frame.arg1,
    statusB: frame.arg2,
    flag: payload.length > 0 && payload[0] === 1,
    revision:
      payload.length > 2 ? ((payload[1] as number) << 8) + (payload[2] as number) : 0,
    keepsSession: (ModelBehaviour.KEEPS_SESSION as readonly number[]).includes(modelId),
    slowTransfer: modelId === ModelBehaviour.SLOW_TRANSFER,
  };
}

/** Number of 32-bit counters in the `DEVICE_INFO` block. */
export const DEVICE_INFO_COUNTERS = 13;

/** Offsets the app reads inside a `DEVICE_INFO` payload. */
const DEVICE_INFO_LAYOUT = {
  /** The first counter starts here; the rest follow every 4 bytes. */
  FIRST_COUNTER: 1,
  /** First NUL-terminated ASCII string, up to 32 bytes. */
  STRING_A: 53,
  /** Second NUL-terminated ASCII string, up to 32 bytes. */
  STRING_B: 85,
  STRING_LENGTH: 32,
} as const;

export interface DeviceInfo {
  /**
   * Thirteen 32-bit values read at payload offsets 1, 5, 9 ... 49.
   *
   * The app reads them and throws them away, so none of them is named here.
   * Likely candidates are print counters, media remaining and error tallies.
   */
  readonly counters: readonly number[];
  /** ASCII string at offset 53. Likely a serial number or model string. */
  readonly stringA: string;
  /** ASCII string at offset 85. Likely a firmware version. */
  readonly stringB: string;
}

/** Reads a NUL-terminated ASCII string of at most `max` bytes. */
function readAscii(payload: Uint8Array, offset: number, max: number): string {
  if (offset >= payload.length) {
    return '';
  }
  const end = Math.min(offset + max, payload.length);
  let stop = end;
  for (let i = offset; i < end; i += 1) {
    if (payload[i] === 0) {
      stop = i;
      break;
    }
  }
  return new TextDecoder('ascii').decode(payload.subarray(offset, stop)).trim();
}

/** Frame that asks the printer for its information block. */
export function deviceInfoRequest(): Uint8Array {
  return encodeFrame({ opcode: Command.DEVICE_INFO });
}

/**
 * Parses a `DEVICE_INFO` reply.
 *
 * Returns null when the frame is not a device info block or is too short to
 * contain one.
 */
export function parseDeviceInfo(frame: Frame): DeviceInfo | null {
  if (frame.opcode !== Command.DEVICE_INFO) {
    return null;
  }
  const payload = frame.payload;
  if (payload.length < DEVICE_INFO_LAYOUT.FIRST_COUNTER + DEVICE_INFO_COUNTERS * 4) {
    return null;
  }

  const counters: number[] = [];
  for (let i = 0; i < DEVICE_INFO_COUNTERS; i += 1) {
    counters.push(readUint32BE(payload, DEVICE_INFO_LAYOUT.FIRST_COUNTER + i * 4));
  }

  return {
    counters,
    stringA: readAscii(payload, DEVICE_INFO_LAYOUT.STRING_A, DEVICE_INFO_LAYOUT.STRING_LENGTH),
    stringB: readAscii(payload, DEVICE_INFO_LAYOUT.STRING_B, DEVICE_INFO_LAYOUT.STRING_LENGTH),
  };
}
