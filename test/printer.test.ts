import { describe, expect, it, vi } from 'vitest';
import { Printer } from '../src/printer.js';
import { MockTransport } from '../src/transport/mock.js';
import { FrameDecoder, encodeFrame } from '../src/protocol/frame.js';
import { Command, Notification, PrintState } from '../src/protocol/constants.js';
import { PrinterError } from '../src/errors.js';

const IMAGE = new Uint8Array(512).fill(0x5a);

/**
 * A scripted printer that answers the host the way the real state machine
 * does, so a whole job can run over the mock transport.
 */
function fakePrinter(options: { faultAfterStart?: number } = {}): MockTransport {
  const decoder = new FrameDecoder();
  let served = false;

  const transport: MockTransport = new MockTransport({
    framing: 'stream',
    onWrite: (data) => {
      for (const frame of decoder.push(data)) {
        switch (frame.opcode) {
          case Command.SESSION_START:
            if (options.faultAfterStart !== undefined) {
              // The fault detail lives in byte 3, not byte 2.
              transport.receive(
                encodeFrame({
                  opcode: Notification.PRINT_STATE,
                  arg1: 0,
                  arg3: options.faultAfterStart,
                }),
              );
              return;
            }
            transport.receive(
              encodeFrame({ opcode: Notification.PRINT_STATE, arg1: PrintState.READY }),
            );
            return;

          case Command.PRINT_START_LEGACY:
          case Command.PRINT_START:
            // Ask for the whole image starting at offset zero.
            transport.receive(
              encodeFrame({
                opcode: Notification.PRINT_STATE,
                arg1: PrintState.REQUEST_DATA,
                payload: new Uint8Array(4),
              }),
            );
            return;

          case Command.DATA_LEGACY:
          case Command.DATA:
            if (!served) {
              served = true;
              // Real hardware reports completion with opcode 0x04, not 0x00.
              transport.receive(
                encodeFrame({ opcode: 0x04, arg1: PrintState.FINISHED }),
              );
            }
            return;

          case Command.END_JOB:
            // The printer stays silent after END_JOB; the session must not
            // depend on a further acknowledgement.
            return;

          default:
            return;
        }
      }
    },
  });

  return transport;
}

describe('Printer over a stream transport', () => {
  it('runs a job to completion', async () => {
    const transport = fakePrinter();
    const printer = new Printer(transport);
    await printer.connect();

    const progress = vi.fn();
    await printer.printRaw(IMAGE, { onProgress: progress, timeoutMs: 5000 });

    expect(progress).toHaveBeenCalled();
    const last = progress.mock.calls.at(-1)?.[0];
    expect(last.percent).toBe(100);
    expect(last.bytesSent).toBe(IMAGE.length);

    await printer.disconnect();
  });

  it('sends the expected opcode sequence', async () => {
    const transport = fakePrinter();
    const printer = new Printer(transport);
    await printer.connect();
    await printer.printRaw(IMAGE, { timeoutMs: 5000 });

    const decoder = new FrameDecoder();
    const opcodes = decoder.push(transport.writtenBytes()).map((f) => f.opcode);

    expect(opcodes).toEqual([
      Command.SESSION_START,
      Command.PRINT_START_LEGACY,
      Command.DATA_LEGACY,
      Command.END_JOB,
    ]);
  });

  it('surfaces a printer fault as a PrinterError', async () => {
    // detail 4 is the out-of-paper branch.
    const transport = fakePrinter({ faultAfterStart: 4 });
    const printer = new Printer(transport);
    await printer.connect();

    await expect(printer.printRaw(IMAGE, { timeoutMs: 5000 })).rejects.toThrow(PrinterError);
    await printer.disconnect();
  });

  it('rejects a print when the transport is not open', async () => {
    const printer = new Printer(new MockTransport());
    await expect(printer.printRaw(IMAGE)).rejects.toThrow(/not connected/);
  });

  it('fails the job when the transport closes mid-flight', async () => {
    const transport = new MockTransport({ framing: 'stream' });
    const printer = new Printer(transport);
    await printer.connect();

    const job = printer.printRaw(IMAGE, { timeoutMs: 5000 });
    await transport.close();

    await expect(job).rejects.toThrow(/closed/);
  });

  it('times out when the printer never answers', async () => {
    const transport = new MockTransport({ framing: 'stream' });
    const printer = new Printer(transport);
    await printer.connect();

    await expect(printer.printRaw(IMAGE, { timeoutMs: 50 })).rejects.toThrow(/did not complete/);
  });

  it('emits a cancel frame', async () => {
    const transport = new MockTransport({ framing: 'stream' });
    const printer = new Printer(transport);
    await printer.connect();
    await printer.cancel();

    const frames = new FrameDecoder().push(transport.writtenBytes());
    expect(frames[0]?.opcode).toBe(Command.END_JOB);
  });

  it('emits a status poll frame', async () => {
    const transport = new MockTransport({ framing: 'stream' });
    const printer = new Printer(transport);
    await printer.connect();
    await printer.pollStatus();

    const frames = new FrameDecoder().push(transport.writtenBytes());
    expect(frames[0]?.opcode).toBe(Command.STATUS_POLL);
  });

  it('exposes raw frames to a listener', async () => {
    const transport = fakePrinter();
    const printer = new Printer(transport);
    await printer.connect();

    const seen: number[] = [];
    const unsubscribe = printer.onFrame((frame) => seen.push(frame.opcode));

    await printer.printRaw(IMAGE, { timeoutMs: 5000 });
    unsubscribe();

    expect(seen).toContain(Notification.PRINT_STATE);
    expect(seen).toContain(0x04);
  });

  it('echoes a heartbeat, which the printer requires to keep the session', async () => {
    const transport = new MockTransport({ framing: 'stream' });
    const printer = new Printer(transport);
    await printer.connect();

    const job = printer.printRaw(IMAGE, { timeoutMs: 300 }).catch(() => undefined);
    transport.receive(encodeFrame({ opcode: Notification.HEARTBEAT }));
    await job;

    const opcodes = new FrameDecoder().push(transport.writtenBytes()).map((f) => f.opcode);
    expect(opcodes).toContain(Command.HEARTBEAT);
  });
});
