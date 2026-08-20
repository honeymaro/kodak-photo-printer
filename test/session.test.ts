import { describe, expect, it, vi } from 'vitest';
import { PrintSession } from '../src/protocol/session.js';
import { decodeFrame, encodeFrame, readUint32BE, type Frame } from '../src/protocol/frame.js';
import {
  Command,
  MODERN_PROTOCOL_LEVEL,
  Notification,
  PrintState,
  SESSION_PROTOCOL_REVISION,
} from '../src/protocol/constants.js';
import { PrinterError } from '../src/errors.js';

/**
 * Builds a printer -> host frame.
 *
 * `arg1` is the state or status code, `arg2` the job state and `arg3` the
 * fault detail, matching how PrintService.e reads bytes 1, 2 and 3.
 */
function printerFrame(
  opcode: number,
  arg1: number,
  arg3 = 0,
  payload = new Uint8Array(0),
  arg2 = 0,
): Frame {
  return { opcode, arg1, arg2, arg3, payload };
}

/** Decodes a frame the session told us to send. */
function sent(data: Uint8Array): Frame {
  const decoded = decodeFrame(data);
  if (decoded === null) {
    throw new Error('session produced an incomplete frame');
  }
  return decoded.frame;
}

const IMAGE = new Uint8Array(1000).map((_, index) => index & 0xff);

describe('PrintSession handshake', () => {
  it('opens with SESSION_START carrying the protocol revision', () => {
    const session = new PrintSession({ image: IMAGE });
    const frame = sent(session.start());

    expect(frame.opcode).toBe(Command.SESSION_START);
    expect(frame.arg1).toBe(1);
    expect(frame.arg2).toBe(SESSION_PROTOCOL_REVISION);
  });

  it('rejects an empty image', () => {
    expect(() => new PrintSession({ image: new Uint8Array(0) })).toThrow(/empty image/);
  });
});

describe('PrintSession heartbeat', () => {
  it('echoes a heartbeat, which the printer requires to keep the session', () => {
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(printerFrame(Notification.HEARTBEAT, 0));

    expect(action.type).toBe('send');
    if (action.type === 'send') {
      const frame = sent(action.data);
      expect(frame.opcode).toBe(Command.HEARTBEAT);
      expect(frame.arg1).toBe(1);
    }
  });
});

describe('PrintSession job start', () => {
  it('answers READY with the legacy opcode and a 12 byte payload', () => {
    const session = new PrintSession({ image: IMAGE, copies: 3 });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.READY),
    );

    expect(action.type).toBe('send');
    if (action.type !== 'send') {
      return;
    }
    const frame = sent(action.data);
    expect(frame.opcode).toBe(Command.PRINT_START_LEGACY);
    expect(frame.arg1).toBe(3);
    expect(frame.payload.length).toBe(12);
    // First four payload bytes are the image length, big endian.
    expect(readUint32BE(frame.payload, 0)).toBe(IMAGE.length);
  });

  it('switches to the modern opcode above the protocol level threshold', () => {
    const session = new PrintSession({
      image: IMAGE,
      protocolLevel: MODERN_PROTOCOL_LEVEL + 1,
      jobId: 0x3039,
    });
    expect(session.usesModernOpcodes).toBe(true);

    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.READY),
    );
    if (action.type !== 'send') {
      throw new Error('expected a send action');
    }
    const frame = sent(action.data);

    expect(frame.opcode).toBe(Command.PRINT_START);
    // The job id is split across arg1 and arg2.
    expect(frame.arg1).toBe(0x30);
    expect(frame.arg2).toBe(0x39);
    expect(frame.payload.length).toBe(8);
    expect(readUint32BE(frame.payload, 0)).toBe(IMAGE.length);
    expect(readUint32BE(frame.payload, 4)).toBe(0x3039);
  });
});

describe('PrintSession data transfer', () => {
  it('serves the offset the printer asks for', () => {
    const session = new PrintSession({ image: IMAGE });
    const request = new Uint8Array(4);
    // Printer requests offset 256.
    request.set([0, 0, 1, 0]);

    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, request),
    );

    expect(action.type).toBe('send');
    if (action.type !== 'send') {
      return;
    }
    const frame = sent(action.data);
    expect(frame.opcode).toBe(Command.DATA_LEGACY);
    expect(frame.payload.length).toBe(IMAGE.length - 256);
    expect(frame.payload[0]).toBe(IMAGE[256]);
  });

  it('caps a slice at maxChunkSize when one is configured', () => {
    const session = new PrintSession({ image: IMAGE, maxChunkSize: 256 });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
    );
    if (action.type !== 'send') {
      throw new Error('expected a send action');
    }
    expect(sent(action.data).payload.length).toBe(256);
  });

  it('sends the whole remainder when no cap is configured', () => {
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
    );
    if (action.type !== 'send') {
      throw new Error('expected a send action');
    }
    expect(sent(action.data).payload.length).toBe(IMAGE.length);
  });

  it('echoes the request arguments back on the data frame', () => {
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
    );
    if (action.type !== 'send') {
      throw new Error('expected a send action');
    }
    expect(sent(action.data).arg1).toBe(PrintState.REQUEST_DATA);
  });

  it('does not mistake the REQUEST_DATA state for a status-zero fault', () => {
    // Byte 1 is zero for both "request data" and "no error"; only byte 3
    // distinguishes a fault, so this must not throw.
    const session = new PrintSession({ image: IMAGE });
    expect(() =>
      session.handleFrame(
        printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
      ),
    ).not.toThrow();
  });

  it('reports progress as bytes go out', () => {
    const onProgress = vi.fn();
    const session = new PrintSession({ image: IMAGE, onProgress });

    session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
    );

    expect(onProgress).toHaveBeenCalledWith({
      bytesSent: IMAGE.length,
      totalBytes: IMAGE.length,
      percent: 100,
    });
  });

  it('waits instead of sending when the requested offset is past the end', () => {
    const session = new PrintSession({ image: IMAGE });
    const request = new Uint8Array(4);
    request.set([0, 0, 0xff, 0xff]);

    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, request),
    );
    expect(action.type).toBe('wait');
  });
});

describe('PrintSession completion', () => {
  it('sends END_JOB when the printer reports FINISHED, and treats it as final', () => {
    // Hardware never sends JOB_COMPLETE, so END_JOB has to end the job.
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.FINISHED),
    );

    expect(action.type).toBe('send');
    if (action.type === 'send') {
      expect(sent(action.data).opcode).toBe(Command.END_JOB);
      expect(action.final).toBe(true);
    }
    expect(session.isFinished).toBe(true);
  });

  it('acknowledges a frame that asks for one', () => {
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(
      printerFrame(Notification.PRINT_STATE, PrintState.NEEDS_ACK, 53),
    );

    expect(action.type).toBe('send');
    if (action.type === 'send') {
      const frame = sent(action.data);
      expect(frame.opcode).toBe(Command.ACK);
      // The fourth header byte is echoed back as the argument.
      expect(frame.arg1).toBe(53);
    }
  });

  it('drives the print state machine regardless of the frame opcode', () => {
    // Hardware signals READY with opcode 0x04, not 0x00.
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(printerFrame(0x04, PrintState.READY));

    expect(action.type).toBe('send');
    if (action.type === 'send') {
      expect(sent(action.data).opcode).toBe(Command.PRINT_START_LEGACY);
    }
  });

  it('finishes on JOB_COMPLETE', () => {
    const session = new PrintSession({ image: IMAGE });
    const action = session.handleFrame(printerFrame(Notification.JOB_COMPLETE, 0));

    expect(action.type).toBe('done');
    expect(session.isFinished).toBe(true);
  });
});

describe('PrintSession faults', () => {
  it('throws a PrinterError when the printer reports a fault', () => {
    const session = new PrintSession({ image: IMAGE });

    // code 0 with detail 4 is the out-of-paper branch.
    expect(() =>
      session.handleFrame(printerFrame(Notification.PRINT_STATE, 0, 4)),
    ).toThrow(PrinterError);

    expect(session.error).toBeInstanceOf(PrinterError);
  });

  it('carries the raw code and detail on the error', () => {
    const session = new PrintSession({ image: IMAGE });
    try {
      session.handleFrame(printerFrame(Notification.PRINT_STATE, 0, 3));
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PrinterError);
      expect((error as PrinterError).code).toBe(0);
      expect((error as PrinterError).detail).toBe(3);
    }
  });
});

describe('PrintSession end to end', () => {
  it('walks a full job driven by a scripted printer', () => {
    const session = new PrintSession({ image: IMAGE });
    const outbound: Frame[] = [];

    const drive = (frame: Frame): void => {
      const action = session.handleFrame(frame);
      if (action.type === 'send') {
        outbound.push(sent(action.data));
      }
    };

    outbound.push(sent(session.start()));
    drive(printerFrame(Notification.PRINT_STATE, PrintState.READY));
    drive(printerFrame(Notification.HEARTBEAT, 0));
    drive(
      printerFrame(Notification.PRINT_STATE, PrintState.REQUEST_DATA, 0, new Uint8Array(4)),
    );
    drive(printerFrame(Notification.PRINT_STATE, PrintState.FINISHED));
    drive(printerFrame(Notification.JOB_COMPLETE, 0));

    expect(outbound.map((f) => f.opcode)).toEqual([
      Command.SESSION_START,
      Command.PRINT_START_LEGACY,
      Command.HEARTBEAT,
      Command.DATA_LEGACY,
      Command.END_JOB,
    ]);
    expect(session.isFinished).toBe(true);
  });
});

describe('PrintSession control frames', () => {
  it('builds a cancel frame', () => {
    expect(sent(PrintSession.cancel()).opcode).toBe(Command.END_JOB);
  });

  it('builds a status poll frame', () => {
    expect(sent(PrintSession.statusPoll()).opcode).toBe(Command.STATUS_POLL);
  });
});

describe('encodeFrame is stable for known good bytes', () => {
  it('reproduces the SESSION_START bytes seen in the app', () => {
    // b((byte) 2, 1, 37, 0, null)
    const frame = encodeFrame({ opcode: 2, arg1: 1, arg2: 37 });
    expect([...frame]).toEqual([0x02, 0x01, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });
});
