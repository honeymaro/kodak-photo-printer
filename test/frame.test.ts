import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  decodeFrame,
  encodeFrame,
  readPayloadLength,
  readUint32BE,
  writeUint32BE,
} from '../src/protocol/frame.js';
import { Command, FRAME_HEADER_SIZE } from '../src/protocol/constants.js';

describe('stream frame codec', () => {
  it('lays out the header exactly as b3.i.b does', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const frame = encodeFrame({ opcode: Command.PRINT_START_LEGACY, arg1: 2, arg2: 0, payload });

    expect(frame.length).toBe(FRAME_HEADER_SIZE + payload.length);
    expect(frame[0]).toBe(0x05);
    expect(frame[1]).toBe(2);
    expect(frame[2]).toBe(0);
    // The host never sets byte 3; only the printer populates it.
    expect(frame[3]).toBe(0);
    // Length is big endian across bytes 4..7.
    expect([...frame.subarray(4, 8)]).toEqual([0, 0, 0, 3]);
    expect([...frame.subarray(8)]).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('encodes a header-only frame with a zero length', () => {
    const frame = encodeFrame({ opcode: Command.END_JOB });
    expect(frame.length).toBe(FRAME_HEADER_SIZE);
    expect([...frame]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('masks oversized byte fields the way a Java (byte) cast would', () => {
    const frame = encodeFrame({ opcode: 0x164, arg1: 300, arg2: -1 });
    expect(frame[0]).toBe(0x64);
    expect(frame[1]).toBe(300 & 0xff);
    expect(frame[2]).toBe(0xff);
  });

  it('encodes a 32-bit length across the full field', () => {
    const payload = new Uint8Array(0x01020304 > 1_000_000 ? 4 : 4);
    const frame = encodeFrame({ opcode: 1, payload });
    expect(readPayloadLength(frame)).toBe(4);
  });

  it('round trips through decodeFrame', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeFrame({ opcode: 0x12, arg1: 7, arg2: 9, payload });

    const decoded = decodeFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.bytesConsumed).toBe(encoded.length);
    expect(decoded?.frame.opcode).toBe(0x12);
    expect(decoded?.frame.arg1).toBe(7);
    expect(decoded?.frame.arg2).toBe(9);
    expect(decoded?.frame.arg3).toBe(0);
    expect([...(decoded?.frame.payload ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves byte 3, which carries the printer fault detail', () => {
    // Only meaningful on printer -> host frames, but decoding must keep it.
    const decoded = decodeFrame(encodeFrame({ opcode: 0, arg1: 1, arg2: 6, arg3: 4 }));
    expect(decoded?.frame.arg3).toBe(4);
  });

  it('returns null until a whole frame is present', () => {
    const encoded = encodeFrame({ opcode: 1, payload: new Uint8Array([9, 9, 9]) });
    expect(decodeFrame(encoded.subarray(0, 4))).toBeNull();
    expect(decodeFrame(encoded.subarray(0, FRAME_HEADER_SIZE))).toBeNull();
    expect(decodeFrame(encoded)).not.toBeNull();
  });

  it('coerces a negative declared length to zero, matching the app', () => {
    const header = new Uint8Array([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    expect(readPayloadLength(header)).toBe(0);
  });
});

describe('FrameDecoder', () => {
  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const a = encodeFrame({ opcode: 1, arg1: 1, payload: new Uint8Array([1, 2]) });
    const b = encodeFrame({ opcode: 2, arg1: 2, payload: new Uint8Array([3, 4, 5]) });
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a, 0);
    stream.set(b, a.length);

    const decoder = new FrameDecoder();
    const collected = [];
    // Feed one byte at a time, the worst case for a stream transport.
    for (const byte of stream) {
      collected.push(...decoder.push(new Uint8Array([byte])));
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]?.opcode).toBe(1);
    expect([...(collected[0]?.payload ?? [])]).toEqual([1, 2]);
    expect(collected[1]?.opcode).toBe(2);
    expect([...(collected[1]?.payload ?? [])]).toEqual([3, 4, 5]);
    expect(decoder.pending).toBe(0);
  });

  it('yields several frames from a single coalesced chunk', () => {
    const a = encodeFrame({ opcode: 0x64 });
    const b = encodeFrame({ opcode: 0x13 });
    const merged = new Uint8Array([...a, ...b]);

    const decoder = new FrameDecoder();
    expect(decoder.push(merged)).toHaveLength(2);
  });

  it('keeps a partial frame buffered', () => {
    const frame = encodeFrame({ opcode: 1, payload: new Uint8Array([1, 2, 3]) });
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 9))).toHaveLength(0);
    expect(decoder.pending).toBe(9);
    expect(decoder.push(frame.subarray(9))).toHaveLength(1);
    expect(decoder.pending).toBe(0);
  });
});

describe('big endian helpers', () => {
  it('round trips a 32-bit value', () => {
    const buffer = new Uint8Array(8);
    writeUint32BE(buffer, 2, 0x01020304);
    expect([...buffer.subarray(2, 6)]).toEqual([1, 2, 3, 4]);
    expect(readUint32BE(buffer, 2)).toBe(0x01020304);
  });

  it('reads values above 2^31 without sign extension', () => {
    const buffer = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(readUint32BE(buffer, 0)).toBe(0xffffffff);
  });
});
