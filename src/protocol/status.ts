/**
 * Interpretation of printer -> host status frames.
 *
 * The byte mapping comes from `PrintService.e(b3.j)`:
 *
 * - `bArr[1]` is the status code. The method switches on it first.
 * - `bArr[2]` is the job state, stored as `f7020j[7]`, with values such as
 *   3, 6, 7 and -1.
 * - `bArr[3]` is the fault detail. Every error branch reads it, both under
 *   `code == 0` and under `code == 1`.
 * - `bArr[10]`, `bArr[11]` and `bArr[14]` are payload bytes 2, 3 and 6, and
 *   hold the page index, the copy count and the media type.
 *
 * The human readable strings below are this package's naming of the observed
 * branches, not text lifted from the app, so treat the wording as descriptive.
 */

import type { Frame } from './frame.js';

/** Broad classification of a status frame. */
export type StatusKind = 'ok' | 'progress' | 'job-state' | 'error' | 'disconnected' | 'unknown';

export interface PrinterStatus {
  readonly kind: StatusKind;
  /** Byte 1, the status code. */
  readonly code: number;
  /** Byte 2, the job state. */
  readonly state: number;
  /** Byte 3, the fault detail. Non-zero means a fault. */
  readonly detail: number;
  /** Present when the frame describes a fault. */
  readonly message?: string;
  /** Zero-based index of the sheet being produced, when reported. */
  readonly pageIndex?: number;
  /** Total number of copies in the job, when reported. */
  readonly totalCopies?: number;
  /** Raw media/ribbon identifier, when reported. */
  readonly mediaType?: number;
}

/**
 * Fault descriptions keyed by the detail byte.
 *
 * Each entry corresponds to a distinct branch in `PrintService.e`. The app
 * maps them to UI message ids rather than strings, so the specific wording
 * here is inferred from the surrounding behaviour.
 */
const FAULTS: ReadonlyMap<number, string> = new Map([
  [1, 'Printer reported a general fault'],
  [2, 'Cover is open or the cartridge is not seated'],
  [3, 'Paper jam'],
  [4, 'Out of paper'],
  [5, 'Ribbon or cartridge fault'],
  [6, 'Printer is busy with another job'],
  [7, 'Ribbon exhausted or a media mismatch'],
  [8, 'Media mismatch'],
  [9, 'Printer is cooling down'],
  [10, 'Printer is in an unrecoverable error state'],
]);

/** Payload offsets used by the app when reading job metadata. */
const PAYLOAD = {
  /** `bArr[10]` in the app, which is payload byte 2. */
  PAGE_INDEX: 2,
  /** `bArr[11]`. */
  TOTAL_COPIES: 3,
  /** `bArr[14]`. */
  MEDIA_TYPE: 6,
} as const;

/**
 * True when the frame signals a fault.
 *
 * Byte 3 is only a fault code in the states where `PrintService.e` reads it as
 * one. Elsewhere the byte carries unrelated data, and treating it as a fault
 * misfires: on hardware a `NEEDS_ACK` frame arrives as `arg1=5 arg3=53`, where
 * 53 is the value to echo back, and a `MEDIA_INFO` frame arrives as
 * `arg1=3 arg3=1` during normal printing.
 */
export function isFault(frame: Frame): boolean {
  switch (frame.arg1) {
    case 0:
      // The idle and data-request channel; any non-zero detail is a fault.
      return frame.arg3 !== 0;
    case 1:
      // Only the unrecoverable code is a fault here.
      return frame.arg3 === 10;
    default:
      return false;
  }
}

/** Returns the description for a fault detail byte. */
export function faultMessage(detail: number): string {
  return FAULTS.get(detail) ?? `Unrecognised fault code ${detail}`;
}

/** Interprets a received frame as a printer status. */
export function parseStatus(frame: Frame): PrinterStatus {
  const code = frame.arg1;
  const state = frame.arg2;
  const detail = frame.arg3;
  const payload = frame.payload;

  const pageIndex =
    payload.length > PAYLOAD.PAGE_INDEX ? (payload[PAYLOAD.PAGE_INDEX] as number) : undefined;
  const totalCopies =
    payload.length > PAYLOAD.TOTAL_COPIES ? (payload[PAYLOAD.TOTAL_COPIES] as number) : undefined;
  const mediaType =
    payload.length > PAYLOAD.MEDIA_TYPE ? (payload[PAYLOAD.MEDIA_TYPE] as number) : undefined;

  const base = { code, state, detail, pageIndex, totalCopies, mediaType };

  if (isFault(frame)) {
    return { ...base, kind: 'error', message: faultMessage(detail) };
  }

  switch (code) {
    case 0:
      return { ...base, kind: 'ok' };
    case 1:
      return { ...base, kind: 'job-state' };
    case 2:
      return { ...base, kind: 'progress' };
    case 3:
      return { ...base, kind: 'disconnected', message: 'Printer dropped the session' };
    case 4:
    case 5:
    case 6:
      // The app deliberately ignores these.
      return { ...base, kind: 'unknown' };
    default:
      return { ...base, kind: 'error', message: `Unrecognised status code ${code}` };
  }
}

/**
 * Reads the media type reported alongside a MEDIA_INFO frame.
 *
 * Observed as `jVar.f7023m = bArr3[6]` on the `b10 == 3` branch, where
 * `bArr3` is the payload rather than the whole frame.
 */
export function parseMediaType(payload: Uint8Array): number | undefined {
  return payload.length > PAYLOAD.MEDIA_TYPE ? (payload[PAYLOAD.MEDIA_TYPE] as number) : undefined;
}

/**
 * Media identifiers the app treats specially.
 *
 * `f6981P` is compared against 104 and 114, and against 12 to extend a
 * timeout. The app never names them, so these labels are inferred.
 */
export const MediaType = {
  /** Requires a valid cartridge state before a job may start. */
  CARTRIDGE_CHECKED_A: 104,
  /** Requires a valid cartridge state before a job may start. */
  CARTRIDGE_CHECKED_B: 114,
  /** Uses an extended 300 second job timeout instead of 30 seconds. */
  SLOW_MEDIA: 12,
} as const;
