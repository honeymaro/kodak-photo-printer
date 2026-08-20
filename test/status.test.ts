import { describe, expect, it } from 'vitest';
import { parseStatus, parseMediaType, isFault, faultMessage } from '../src/protocol/status.js';
import type { Frame } from '../src/protocol/frame.js';

/**
 * `arg1` is the status code (byte 1) and `detail` the fault byte (byte 3),
 * which is where PrintService.e reads faults from.
 */
function frame(arg1: number, detail: number, payload = new Uint8Array(0), state = 0): Frame {
  return { opcode: 0, arg1, arg2: state, arg3: detail, payload };
}

describe('parseStatus', () => {
  it('treats code 0 detail 0 as healthy', () => {
    const status = parseStatus(frame(0, 0));
    expect(status.kind).toBe('ok');
    expect(status.message).toBeUndefined();
  });

  it('maps each known fault detail to a description', () => {
    for (const detail of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const status = parseStatus(frame(0, detail));
      expect(status.kind).toBe('error');
      expect(status.message).toBeTypeOf('string');
      expect(status.message).not.toMatch(/Unrecognised/);
    }
  });

  it('labels an unknown detail rather than dropping it', () => {
    const status = parseStatus(frame(0, 99));
    expect(status.kind).toBe('error');
    expect(status.message).toMatch(/Unrecognised fault code 99/);
    expect(status.detail).toBe(99);
  });

  it('classifies code 1 as a job state update', () => {
    expect(parseStatus(frame(1, 0)).kind).toBe('job-state');
  });

  it('exposes the job state from byte 2', () => {
    expect(parseStatus(frame(1, 0, new Uint8Array(0), 7)).state).toBe(7);
  });

  it('only reads byte 3 as a fault in the states where it is one', () => {
    // Confirmed on hardware: arg1=5 with byte 3 set is an acknowledgement
    // request, and arg1=3 with byte 3 set is normal media information.
    expect(parseStatus(frame(0, 5)).kind).toBe('error');
    expect(parseStatus(frame(5, 53)).kind).not.toBe('error');
    expect(parseStatus(frame(3, 1)).kind).not.toBe('error');
  });

  it('treats detail 10 under code 1 as the unrecoverable fault', () => {
    expect(parseStatus(frame(1, 10)).kind).toBe('error');
    // Any other detail under code 1 is not a fault; READY arrives as arg3=28.
    expect(parseStatus(frame(1, 28)).kind).toBe('job-state');
  });


  it('classifies code 2 as progress and code 3 as a dropped session', () => {
    expect(parseStatus(frame(2, 0)).kind).toBe('progress');
    expect(parseStatus(frame(3, 0)).kind).toBe('disconnected');
  });

  it('ignores codes 4 through 6, which the app also ignores', () => {
    for (const code of [4, 5, 6]) {
      expect(parseStatus(frame(code, 0)).kind).toBe('unknown');
    }
  });

  it('flags a status code outside the known set', () => {
    const status = parseStatus(frame(200, 0));
    expect(status.kind).toBe('error');
    expect(status.message).toMatch(/Unrecognised status code 200/);
  });

  it('reads job metadata out of the payload at the app offsets', () => {
    // The app reads bArr[10], bArr[11] and bArr[14] on the whole frame, which
    // are payload offsets 2, 3 and 6.
    const payload = new Uint8Array([0, 0, 1, 4, 0, 0, 104]);
    const status = parseStatus(frame(1, 0, payload));

    expect(status.pageIndex).toBe(1);
    expect(status.totalCopies).toBe(4);
    expect(status.mediaType).toBe(104);
  });

  it('leaves metadata undefined when the payload is short', () => {
    const status = parseStatus(frame(1, 0, new Uint8Array([0, 0])));
    expect(status.pageIndex).toBeUndefined();
    expect(status.totalCopies).toBeUndefined();
    expect(status.mediaType).toBeUndefined();
  });
});

describe('isFault and faultMessage', () => {
  it('is state aware rather than keying off byte 3 alone', () => {
    expect(isFault(frame(0, 0))).toBe(false);
    expect(isFault(frame(0, 1))).toBe(true);
    // A non-zero status code with a clean detail byte is not a fault.
    expect(isFault(frame(2, 0))).toBe(false);
    // These arrive during a healthy job and must not read as faults.
    expect(isFault(frame(5, 53))).toBe(false);
    expect(isFault(frame(3, 1))).toBe(false);
    expect(isFault(frame(1, 28))).toBe(false);
    expect(isFault(frame(1, 10))).toBe(true);
  });

  it('describes known details and labels unknown ones', () => {
    expect(faultMessage(4)).toBe('Out of paper');
    expect(faultMessage(77)).toMatch(/Unrecognised fault code 77/);
  });
});

describe('parseMediaType', () => {
  it('reads payload byte 6', () => {
    expect(parseMediaType(new Uint8Array([0, 1, 2, 3, 4, 5, 12]))).toBe(12);
  });

  it('returns undefined for a short payload', () => {
    expect(parseMediaType(new Uint8Array([1, 2]))).toBeUndefined();
  });
});
