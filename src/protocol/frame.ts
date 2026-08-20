/**
 * Codec for the stream framing shared by the USB, Wi-Fi and Bluetooth SPP
 * transports.
 *
 * Layout, from `b3.i.b(byte, int, int, int, byte[])`:
 *
 * ```
 * offset 0  opcode      1 byte
 * offset 1  arg1        1 byte
 * offset 2  arg2        1 byte
 * offset 3  arg3        1 byte, always zero on host -> printer frames
 * offset 4  length      4 bytes, big endian, length of payload only
 * offset 8  payload     `length` bytes
 * ```
 *
 * The same layout is used in both directions. The host never sets byte 3, but
 * the printer does: `PrintService.e` reads the fault detail from `bArr[3]`,
 * the status code from `bArr[1]` and the job state from `bArr[2]`. All four
 * bytes are therefore preserved on decode and interpreted by `parseStatus`.
 */

import { ProtocolError } from '../errors.js';
import { FRAME_HEADER_SIZE } from './constants.js';

export interface Frame {
  /** First header byte. A `Command` when sending, a `Notification` when receiving. */
  readonly opcode: number;
  /**
   * Second header byte. Carries the print state on printer -> host frames
   * (`PrintState`) and the status code as read by `PrintService.e`.
   */
  readonly arg1: number;
  /** Third header byte. Carries the job state on printer -> host frames. */
  readonly arg2: number;
  /**
   * Fourth header byte. Zero on host -> printer frames. On printer -> host
   * frames it is the fault detail; any non-zero value indicates a fault.
   */
  readonly arg3: number;
  /** Payload, empty when the frame carries no body. */
  readonly payload: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Encodes a frame.
 *
 * The single-byte fields are masked to 8 bits to mirror the Java `(byte)`
 * casts in the original implementation, so callers may pass signed values.
 */
export function encodeFrame(frame: {
  opcode: number;
  arg1?: number;
  arg2?: number;
  /** Only set when replaying a captured printer frame; the host sends zero. */
  arg3?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = frame.payload ?? EMPTY;
  if (payload.length > 0xffffffff) {
    throw new ProtocolError(`Payload of ${payload.length} bytes exceeds the 32-bit length field`);
  }

  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  out[0] = frame.opcode & 0xff;
  out[1] = (frame.arg1 ?? 0) & 0xff;
  out[2] = (frame.arg2 ?? 0) & 0xff;
  out[3] = (frame.arg3 ?? 0) & 0xff;

  const length = payload.length;
  out[4] = (length >>> 24) & 0xff;
  out[5] = (length >>> 16) & 0xff;
  out[6] = (length >>> 8) & 0xff;
  out[7] = length & 0xff;

  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

/** Reads the payload length out of a header without copying the payload. */
export function readPayloadLength(header: Uint8Array): number {
  if (header.length < FRAME_HEADER_SIZE) {
    throw new ProtocolError(
      `Header must be at least ${FRAME_HEADER_SIZE} bytes, received ${header.length}`,
    );
  }
  const length =
    ((header[4] as number) << 24) |
    ((header[5] as number) << 16) |
    ((header[6] as number) << 8) |
    (header[7] as number);

  // The original code coerces a negative length to zero rather than failing.
  return length < 0 ? 0 : length;
}

/**
 * Decodes a single frame from the front of `buffer`.
 *
 * Returns `null` when `buffer` does not yet hold a complete frame, which lets
 * callers feed it a growing stream buffer without pre-checking lengths.
 */
export function decodeFrame(buffer: Uint8Array): { frame: Frame; bytesConsumed: number } | null {
  if (buffer.length < FRAME_HEADER_SIZE) {
    return null;
  }

  const length = readPayloadLength(buffer);
  const total = FRAME_HEADER_SIZE + length;
  if (buffer.length < total) {
    return null;
  }

  const frame: Frame = {
    opcode: buffer[0] as number,
    arg1: buffer[1] as number,
    arg2: buffer[2] as number,
    arg3: buffer[3] as number,
    payload: buffer.slice(FRAME_HEADER_SIZE, total),
  };

  return { frame, bytesConsumed: total };
}

/**
 * Incremental frame reader.
 *
 * Transports deliver arbitrary byte runs; this accumulates them and yields
 * whole frames as they become available.
 */
export class FrameDecoder {
  private buffer: Uint8Array = EMPTY;

  /** Appends received bytes and returns every frame that is now complete. */
  public push(chunk: Uint8Array): Frame[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    const frames: Frame[] = [];
    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (decoded === null) {
        break;
      }
      frames.push(decoded.frame);
      this.buffer = this.buffer.slice(decoded.bytesConsumed);
    }
    return frames;
  }

  /** Number of buffered bytes that do not yet form a complete frame. */
  public get pending(): number {
    return this.buffer.length;
  }

  /** Drops any partial frame. Call when a transport reconnects. */
  public reset(): void {
    this.buffer = EMPTY;
  }
}

/** Writes a 32-bit big endian integer, matching the app's manual byte packing. */
export function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** Reads a 32-bit big endian integer. Mirrors `b3.i.f(int, byte[])`. */
export function readUint32BE(source: Uint8Array, offset: number): number {
  if (source.length < offset + 4) {
    throw new ProtocolError(
      `Cannot read a 32-bit value at offset ${offset} from ${source.length} bytes`,
    );
  }
  return (
    (((source[offset] as number) << 24) >>> 0) +
    ((source[offset + 1] as number) << 16) +
    ((source[offset + 2] as number) << 8) +
    (source[offset + 3] as number)
  );
}
