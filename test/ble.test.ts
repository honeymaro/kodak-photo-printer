import { describe, expect, it } from 'vitest';
import {
  BleSelector,
  bleCancelFrames,
  bleCommandSequence,
  bleDataFrames,
  decodeBleFrame,
  encodeBleCommand,
  encodeBleData,
} from '../src/protocol/ble.js';
import { Ble, BleOpcode } from '../src/protocol/constants.js';

describe('BLE command frames', () => {
  it('is always ten bytes with the length in the first three', () => {
    const frame = encodeBleCommand({
      totalLength: 0x010203,
      opcode: BleOpcode.ANNOUNCE_LENGTH,
      argument: 0x0a0b0c0d,
    });

    expect(frame.length).toBe(Ble.COMMAND_FRAME_SIZE);
    expect([...frame.subarray(0, 3)]).toEqual([0x01, 0x02, 0x03]);
    // Bytes 3 and 4 are the zero chunk length that marks a command frame.
    expect([...frame.subarray(3, 5)]).toEqual([0, 0]);
    expect(frame[5]).toBe(BleOpcode.ANNOUNCE_LENGTH);
    expect([...frame.subarray(6, 10)]).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
  });

  it('writes only one argument byte for JOB_PARAMS', () => {
    // b3.b.j takes the `bArr[6] = (byte) j5` branch when the opcode is zero.
    const frame = encodeBleCommand({
      totalLength: 100,
      opcode: BleOpcode.JOB_PARAMS,
      argument: 0xabcd,
    });
    expect(frame[5]).toBe(BleOpcode.JOB_PARAMS);
    expect(frame[6]).toBe(0xcd);
    expect([...frame.subarray(7, 10)]).toEqual([0, 0, 0]);
  });

  it('rejects a length that does not fit in 24 bits', () => {
    expect(() =>
      encodeBleCommand({ totalLength: 0x1000000, opcode: BleOpcode.ANNOUNCE_LENGTH }),
    ).toThrow(/24 bits/);
  });
});

describe('BLE data frames', () => {
  it('carries the offset in three bytes and the length in two', () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    const frame = encodeBleData(0x0100ff, payload);

    expect(frame.length).toBe(Ble.DATA_FRAME_HEADER_SIZE + 3);
    expect([...frame.subarray(0, 3)]).toEqual([0x01, 0x00, 0xff]);
    expect([...frame.subarray(3, 5)]).toEqual([0, 3]);
    expect([...frame.subarray(5)]).toEqual([0x11, 0x22, 0x33]);
  });

  it('splits a payload into 200 byte chunks with a short tail', () => {
    const payload = new Uint8Array(450).fill(7);
    const frames = [...bleDataFrames(payload)];

    expect(frames).toHaveLength(3);
    expect(frames[0]?.offset).toBe(0);
    expect(frames[1]?.offset).toBe(200);
    expect(frames[2]?.offset).toBe(400);
    expect(frames[0]?.frame.length).toBe(Ble.DATA_FRAME_HEADER_SIZE + 200);
    // The final chunk is only the remainder.
    expect(frames[2]?.frame.length).toBe(Ble.DATA_FRAME_HEADER_SIZE + 50);
  });

  it('refuses an empty chunk, which would be read as a command frame', () => {
    expect(() => encodeBleData(0, new Uint8Array(0))).toThrow(/at least one byte/);
  });
});

describe('bleCommandSequence', () => {
  it('starts a photo job with JOB_PARAMS carrying the copy count', () => {
    // PrintService.c() sends h(0, data, 0, copies) for a photo.
    const frames = bleCommandSequence({
      selector: BleSelector.PHOTO_START,
      payloadLength: 1024,
      copies: 3,
    });

    expect(frames).toHaveLength(2);
    expect(frames[0]?.[5]).toBe(BleOpcode.JOB_PARAMS);
    expect(frames[0]?.[6]).toBe(3);
    expect(frames[1]?.[5]).toBe(BleOpcode.ANNOUNCE_LENGTH);
  });

  it('emits only the trailing frame for LENGTH_ONLY', () => {
    const frames = bleCommandSequence({
      selector: BleSelector.LENGTH_ONLY,
      payloadLength: 42,
      argument: 42,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.[5]).toBe(BleOpcode.ANNOUNCE_LENGTH);
  });

  it('announces a firmware block then the length', () => {
    const frames = bleCommandSequence({
      selector: BleSelector.FIRMWARE_BLOCK,
      payloadLength: 1024,
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]?.[5]).toBe(BleOpcode.DATA_BLOCK);
    expect(frames[1]?.[5]).toBe(BleOpcode.ANNOUNCE_LENGTH);
  });

  it('puts the total length in the FINALIZE argument', () => {
    const frames = bleCommandSequence({
      selector: BleSelector.FIRMWARE_FINALIZE,
      payloadLength: 0,
      argument: 0x00beef,
    });
    const finalize = frames[0] as Uint8Array;
    expect(finalize[5]).toBe(BleOpcode.FINALIZE);
    expect([...finalize.subarray(6, 10)]).toEqual([0x00, 0x00, 0xbe, 0xef]);
  });

  it('builds a cancel frame with every field zeroed', () => {
    // b3.b.g() sends this on its own, with no trailing frame.
    const frames = bleCancelFrames();
    expect(frames).toHaveLength(1);
    expect([...(frames[0] as Uint8Array)]).toEqual([0, 0, 0, 0, 0, BleOpcode.CANCEL, 0, 0, 0, 0]);
  });
});

describe('decodeBleFrame', () => {
  it('round trips a command frame', () => {
    const encoded = encodeBleCommand({
      totalLength: 5000,
      opcode: BleOpcode.FINALIZE,
      argument: 123456,
    });
    const decoded = decodeBleFrame(encoded);

    expect(decoded.kind).toBe('command');
    if (decoded.kind === 'command') {
      expect(decoded.totalLength).toBe(5000);
      expect(decoded.opcode).toBe(BleOpcode.FINALIZE);
      expect(decoded.argument).toBe(123456);
    }
  });

  it('round trips a data frame', () => {
    const payload = new Uint8Array([9, 8, 7, 6]);
    const decoded = decodeBleFrame(encodeBleData(1234, payload));

    expect(decoded.kind).toBe('data');
    if (decoded.kind === 'data') {
      expect(decoded.offset).toBe(1234);
      expect([...decoded.payload]).toEqual([9, 8, 7, 6]);
    }
  });

  it('reads a single argument byte back for JOB_PARAMS', () => {
    const decoded = decodeBleFrame(
      encodeBleCommand({ totalLength: 0, opcode: BleOpcode.JOB_PARAMS, argument: 0x2a }),
    );
    if (decoded.kind === 'command') {
      expect(decoded.argument).toBe(0x2a);
    }
  });
});
