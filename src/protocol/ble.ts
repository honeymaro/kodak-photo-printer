/**
 * Codec for the BLE GATT framing.
 *
 * **This package does not implement a BLE transport.** These printers are
 * reachable over Bluetooth Classic SPP, which is what the library speaks. The
 * codec is kept so that captured GATT traffic can be decoded, and because the
 * framing is documented knowledge worth not losing. See PROTOCOL.md for the
 * job flow it would carry.
 *
 * The framing differs from the stream protocol: BLE writes are small, so every
 * data frame carries an explicit offset and the printer reassembles from a
 * series of short characteristic writes.
 *
 * Recovered from `b3.b.j(UUID, UUID, int offset, int chunkLen, int opcode, long arg)`.
 *
 * Command frame, always 10 bytes (chunkLen == 0):
 * ```
 * offset 0  totalLength  3 bytes, big endian
 * offset 3  0x00 0x00    2 bytes, the zero chunk length
 * offset 5  opcode       1 byte
 * offset 6  argument     4 bytes big endian, or 1 byte for JOB_PARAMS
 * ```
 *
 * Data frame, 5 + chunkLen bytes:
 * ```
 * offset 0  offset       3 bytes, big endian, position within the payload
 * offset 3  chunkLength  2 bytes, big endian
 * offset 5  payload      chunkLength bytes
 * ```
 */

import { ProtocolError } from '../errors.js';
import { Ble, BleOpcode, type BleOpcodeValue } from './constants.js';

export type { BleOpcodeValue };

const MAX_UINT24 = 0xffffff;
const MAX_UINT16 = 0xffff;

/** Encodes a BLE command frame. */
export function encodeBleCommand(options: {
  /** Value placed in the 24-bit field. Carries the total length for most opcodes. */
  totalLength: number;
  opcode: BleOpcodeValue;
  /** Argument. Truncated to one byte for JOB_PARAMS, as the app does. */
  argument?: number;
}): Uint8Array {
  const { totalLength, opcode } = options;
  const argument = options.argument ?? 0;

  if (totalLength < 0 || totalLength > MAX_UINT24) {
    throw new ProtocolError(`totalLength ${totalLength} does not fit in 24 bits`);
  }

  const out = new Uint8Array(Ble.COMMAND_FRAME_SIZE);
  out[0] = (totalLength >>> 16) & 0xff;
  out[1] = (totalLength >>> 8) & 0xff;
  out[2] = totalLength & 0xff;
  out[3] = 0;
  out[4] = 0;
  out[5] = opcode & 0xff;

  if (opcode === BleOpcode.JOB_PARAMS) {
    // The app writes only a single byte for this opcode and leaves 7..9 zero.
    out[6] = argument & 0xff;
  } else {
    out[6] = (argument >>> 24) & 0xff;
    out[7] = (argument >>> 16) & 0xff;
    out[8] = (argument >>> 8) & 0xff;
    out[9] = argument & 0xff;
  }

  return out;
}

/** Encodes a BLE data frame carrying `payload` positioned at `offset`. */
export function encodeBleData(offset: number, payload: Uint8Array): Uint8Array {
  if (offset < 0 || offset > MAX_UINT24) {
    throw new ProtocolError(`offset ${offset} does not fit in 24 bits`);
  }
  if (payload.length === 0) {
    throw new ProtocolError('A BLE data frame must carry at least one byte');
  }
  if (payload.length > MAX_UINT16) {
    throw new ProtocolError(`chunk of ${payload.length} bytes does not fit in 16 bits`);
  }

  const out = new Uint8Array(Ble.DATA_FRAME_HEADER_SIZE + payload.length);
  out[0] = (offset >>> 16) & 0xff;
  out[1] = (offset >>> 8) & 0xff;
  out[2] = offset & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, Ble.DATA_FRAME_HEADER_SIZE);
  return out;
}

/**
 * Splits `payload` into the sequence of data frames the app would emit.
 *
 * `b3.b.f()` advances a cursor by `Ble.CHUNK_SIZE` per characteristic write
 * and shortens only the final chunk.
 */
export function* bleDataFrames(
  payload: Uint8Array,
  chunkSize: number = Ble.CHUNK_SIZE,
): Generator<{ offset: number; frame: Uint8Array }> {
  if (chunkSize <= 0) {
    throw new ProtocolError(`chunkSize must be positive, received ${chunkSize}`);
  }
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, payload.length);
    yield { offset, frame: encodeBleData(offset, payload.subarray(offset, end)) };
  }
}

/**
 * Selector values accepted by `b3.b.h(arg, data, selector, extra)`.
 *
 * The selector is not the wire opcode. It picks which frame sequence goes out,
 * and an `ANNOUNCE_LENGTH` frame is always appended.
 */
export const BleSelector = {
  /** Start a photo job. `extra` is the copy count. */
  PHOTO_START: 0,
  /** Announce the length only. Used to close a photo job. */
  LENGTH_ONLY: 1,
  /** Announce a firmware data block. */
  FIRMWARE_BLOCK: 3,
  /** Finalize a firmware transfer. `arg` is the total length. */
  FIRMWARE_FINALIZE: 4,
} as const;

export type BleSelectorValue = (typeof BleSelector)[keyof typeof BleSelector];

/**
 * Builds the frame sequence `b3.b.h()` emits for a given selector.
 *
 * Every branch ends with an `ANNOUNCE_LENGTH` frame, so one logical operation
 * puts two writes on the wire. Reproduced rather than simplified, because the
 * printer's state machine depends on the pair.
 */
export function bleCommandSequence(options: {
  selector: BleSelectorValue;
  /** Length of the buffer about to be transferred. */
  payloadLength: number;
  /** 32-bit argument for the trailing ANNOUNCE_LENGTH and for FIRMWARE_FINALIZE. */
  argument?: number;
  /** Single-byte argument, the copy count, used only by PHOTO_START. */
  copies?: number;
}): Uint8Array[] {
  const { selector, payloadLength } = options;
  const argument = options.argument ?? 0;
  const frames: Uint8Array[] = [];

  switch (selector) {
    case BleSelector.PHOTO_START:
      frames.push(
        encodeBleCommand({
          totalLength: payloadLength,
          opcode: BleOpcode.JOB_PARAMS,
          argument: options.copies ?? 1,
        }),
      );
      break;
    case BleSelector.LENGTH_ONLY:
      // Nothing but the trailing frame.
      break;
    case BleSelector.FIRMWARE_BLOCK:
      frames.push(
        encodeBleCommand({
          totalLength: payloadLength,
          opcode: BleOpcode.DATA_BLOCK,
          argument: 0,
        }),
      );
      break;
    case BleSelector.FIRMWARE_FINALIZE:
      frames.push(
        encodeBleCommand({ totalLength: 0, opcode: BleOpcode.FINALIZE, argument }),
      );
      break;
    default: {
      const exhaustive: never = selector;
      throw new ProtocolError(`Unhandled BLE selector ${String(exhaustive)}`);
    }
  }

  frames.push(
    encodeBleCommand({
      totalLength: payloadLength,
      opcode: BleOpcode.ANNOUNCE_LENGTH,
      argument,
    }),
  );
  return frames;
}

/** Frames that cancel a running job. `b3.b.g()` zeroes every field. */
export function bleCancelFrames(): Uint8Array[] {
  return [encodeBleCommand({ totalLength: 0, opcode: BleOpcode.CANCEL, argument: 0 })];
}

/** A decoded BLE frame, used by tests and by the capture inspection tooling. */
export type DecodedBleFrame =
  | { kind: 'command'; totalLength: number; opcode: number; argument: number }
  | { kind: 'data'; offset: number; payload: Uint8Array };

/** Decodes a BLE frame. Useful for interpreting sniffed GATT writes. */
export function decodeBleFrame(frame: Uint8Array): DecodedBleFrame {
  if (frame.length < Ble.DATA_FRAME_HEADER_SIZE) {
    throw new ProtocolError(`BLE frame of ${frame.length} bytes is too short`);
  }

  const first =
    (((frame[0] as number) << 16) | ((frame[1] as number) << 8) | (frame[2] as number)) >>> 0;
  const chunkLength = ((frame[3] as number) << 8) | (frame[4] as number);

  if (chunkLength === 0) {
    if (frame.length < Ble.COMMAND_FRAME_SIZE) {
      throw new ProtocolError(
        `BLE command frame must be ${Ble.COMMAND_FRAME_SIZE} bytes, received ${frame.length}`,
      );
    }
    const opcode = frame[5] as number;
    const argument =
      opcode === BleOpcode.JOB_PARAMS
        ? (frame[6] as number)
        : ((((frame[6] as number) << 24) >>> 0) +
            ((frame[7] as number) << 16) +
            ((frame[8] as number) << 8) +
            (frame[9] as number));
    return { kind: 'command', totalLength: first, opcode, argument };
  }

  const end = Ble.DATA_FRAME_HEADER_SIZE + chunkLength;
  if (frame.length < end) {
    throw new ProtocolError(
      `BLE data frame declares ${chunkLength} bytes but only ${
        frame.length - Ble.DATA_FRAME_HEADER_SIZE
      } are present`,
    );
  }
  return { kind: 'data', offset: first, payload: frame.slice(Ble.DATA_FRAME_HEADER_SIZE, end) };
}
