/**
 * Codec for the ADB transport protocol.
 *
 * The printer's USB interface is a real ADB interface (class 0xff, subclass
 * 0x42, protocol 0x01) and the print stream rides on it. The official Android
 * app reimplements this same framing over USB accessory endpoints, which is
 * how the command set was recovered: the magic values appear as decimal
 * literals in `c3.C0506a` and `c3.RunnableC0512g`.
 *
 * Message layout, six little endian 32-bit words followed by the payload:
 * ```
 * offset 0   command
 * offset 4   arg0
 * offset 8   arg1
 * offset 12  data length
 * offset 16  data checksum
 * offset 20  magic, which is command XOR 0xffffffff
 * offset 24  payload
 * ```
 */

import { ProtocolError } from '../../errors.js';

export const ADB_HEADER_SIZE = 24;

/** ADB command words. Verified against the literals found in the app. */
export const AdbCommand = {
  /** 0x4e584e43, "CNXN". Opens the connection. */
  CNXN: 0x4e584e43,
  /** 0x48545541, "AUTH". Sent by the device when it wants a signed token. */
  AUTH: 0x48545541,
  /** 0x4e45504f, "OPEN". Opens a stream. */
  OPEN: 0x4e45504f,
  /** 0x59414b4f, "OKAY". Acknowledges an OPEN or a WRTE. */
  OKAY: 0x59414b4f,
  /** 0x45545257, "WRTE". Carries stream payload. */
  WRTE: 0x45545257,
  /** 0x45534c43, "CLSE". Closes a stream. */
  CLSE: 0x45534c43,
} as const;

export type AdbCommandValue = (typeof AdbCommand)[keyof typeof AdbCommand];

/** ADB protocol version advertised in CNXN. */
export const ADB_VERSION = 0x0100_0000;

/**
 * Maximum payload a modern adbd accepts.
 *
 * Not what this printer uses. Kept for hosts that negotiate a larger value.
 */
export const ADB_MAX_PAYLOAD = 256 * 1024;

/**
 * Maximum payload this printer advertises.
 *
 * Confirmed on hardware: the device answers CNXN with arg0 `0x01000000` and
 * arg1 `4096`. Writes must be split at this size.
 */
export const ADB_LEGACY_MAX_PAYLOAD = 4096;

/** AUTH subtypes. */
export const AdbAuth = {
  TOKEN: 1,
  SIGNATURE: 2,
  RSAPUBLICKEY: 3,
} as const;

export interface AdbMessage {
  readonly command: number;
  readonly arg0: number;
  readonly arg1: number;
  readonly payload: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/** Sums payload bytes, which is the checksum ADB uses. */
export function checksum(payload: Uint8Array): number {
  let sum = 0;
  for (const byte of payload) {
    sum = (sum + byte) >>> 0;
  }
  return sum;
}

/** Encodes a message, computing the checksum and magic. */
export function encodeAdbMessage(message: {
  command: number;
  arg0?: number;
  arg1?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = message.payload ?? EMPTY;
  const out = new Uint8Array(ADB_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  view.setUint32(0, message.command >>> 0, true);
  view.setUint32(4, (message.arg0 ?? 0) >>> 0, true);
  view.setUint32(8, (message.arg1 ?? 0) >>> 0, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, checksum(payload), true);
  view.setUint32(20, (message.command ^ 0xffffffff) >>> 0, true);

  out.set(payload, ADB_HEADER_SIZE);
  return out;
}

/**
 * Encodes just the 24 byte header for a message.
 *
 * adbd reads exactly 24 bytes and then reads the declared payload length as a
 * separate transfer, so a USB transport must send the two parts as two bulk
 * transfers. Confirmed on hardware: combining them makes this printer stall
 * its endpoint and drop the link, and it is why any message with a payload
 * (a CNXN with a banner, or any OPEN) failed while empty ones succeeded.
 */
export function encodeAdbHeader(message: {
  command: number;
  arg0?: number;
  arg1?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = message.payload ?? EMPTY;
  const out = new Uint8Array(ADB_HEADER_SIZE);
  const view = new DataView(out.buffer);

  view.setUint32(0, message.command >>> 0, true);
  view.setUint32(4, (message.arg0 ?? 0) >>> 0, true);
  view.setUint32(8, (message.arg1 ?? 0) >>> 0, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, checksum(payload), true);
  view.setUint32(20, (message.command ^ 0xffffffff) >>> 0, true);

  return out;
}

/** Decodes a header. Returns the declared payload length for the caller to read. */
export function decodeAdbHeader(header: Uint8Array): {
  command: number;
  arg0: number;
  arg1: number;
  length: number;
  checksum: number;
  magic: number;
} {
  if (header.length < ADB_HEADER_SIZE) {
    throw new ProtocolError(
      `ADB header must be ${ADB_HEADER_SIZE} bytes, received ${header.length}`,
    );
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return {
    command: view.getUint32(0, true),
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    length: view.getUint32(12, true),
    checksum: view.getUint32(16, true),
    magic: view.getUint32(20, true),
  };
}

/**
 * Validates a header's magic word.
 *
 * The app writes zero for magic on its accessory link, so this is tolerant by
 * default and only enforced when talking to a stock adbd over USB.
 */
export function isValidMagic(command: number, magic: number): boolean {
  return ((command ^ 0xffffffff) >>> 0) === magic >>> 0;
}

/** Renders a command word as its four character mnemonic, for logs. */
export function commandName(command: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, command >>> 0, true);
  let name = '';
  for (const byte of bytes) {
    name += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
  }
  return name;
}

/** Incremental reader that turns a byte stream into ADB messages. */
export class AdbMessageDecoder {
  private buffer: Uint8Array = EMPTY;

  public push(chunk: Uint8Array): AdbMessage[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    const messages: AdbMessage[] = [];
    for (;;) {
      if (this.buffer.length < ADB_HEADER_SIZE) {
        break;
      }
      const header = decodeAdbHeader(this.buffer);
      const total = ADB_HEADER_SIZE + header.length;
      if (this.buffer.length < total) {
        break;
      }
      messages.push({
        command: header.command,
        arg0: header.arg0,
        arg1: header.arg1,
        payload: this.buffer.slice(ADB_HEADER_SIZE, total),
      });
      this.buffer = this.buffer.slice(total);
    }
    return messages;
  }

  public reset(): void {
    this.buffer = EMPTY;
  }

  public get pending(): number {
    return this.buffer.length;
  }
}

/** Default host identification string sent in CNXN. */
export const DEFAULT_HOST_BANNER = 'host::\0';

/**
 * Builds the CNXN message that opens the link.
 *
 * Advertises the legacy protocol version and a 4096 byte maximum payload,
 * which is what this printer reports back and what its firmware generation
 * expects. Confirmed on hardware, provided the header and payload go out as
 * separate bulk transfers.
 */
export function connectMessage(banner: string = DEFAULT_HOST_BANNER): Uint8Array {
  return encodeAdbMessage({
    command: AdbCommand.CNXN,
    arg0: ADB_VERSION,
    arg1: ADB_LEGACY_MAX_PAYLOAD,
    payload: new TextEncoder().encode(banner),
  });
}
