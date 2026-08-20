/**
 * Print state machine for the stream transports (USB, Wi-Fi, Bluetooth SPP).
 *
 * The transfer is printer driven. After the host opens a session the printer
 * emits PRINT_STATE frames and the host reacts:
 *
 * ```
 * host -> SESSION_START(arg1=1, arg2=37)
 * printer -> PRINT_STATE state=READY
 * host -> PRINT_START   payload carries the image byte length
 * printer -> PRINT_STATE state=REQUEST_DATA, payload[0..3] = wanted offset
 * host -> DATA          the requested slice
 *   ... repeats until the printer stops asking ...
 * printer -> PRINT_STATE state=FINISHED
 * host -> END_JOB
 * printer -> JOB_COMPLETE
 * ```
 *
 * Two details are reproduced deliberately because the printer depends on
 * them: HEARTBEAT frames must be echoed, and the opcode pair used for job
 * start and data depends on the peer's protocol level.
 */

import { ProtocolError, PrinterError, TimeoutError } from '../errors.js';
import {
  Command,
  DEFAULT_JOB_ID,
  MODERN_PROTOCOL_LEVEL,
  Notification,
  PrintState,
  SESSION_PROTOCOL_REVISION,
} from './constants.js';
import { encodeFrame, readUint32BE, writeUint32BE, type Frame } from './frame.js';
import { isFault, parseStatus, type PrinterStatus } from './status.js';

/** Progress callback payload. */
export interface PrintProgress {
  /** Bytes handed to the printer so far. */
  readonly bytesSent: number;
  /** Total bytes in the image. */
  readonly totalBytes: number;
  /** 0 to 100. */
  readonly percent: number;
}

export interface PrintSessionOptions {
  /** Image bytes to print, already in the printer's expected raster format. */
  readonly image: Uint8Array;
  /** Number of copies. Placed in the job start frame's arg1. */
  readonly copies?: number;
  /** Job identifier used by the modern job start frame. */
  readonly jobId?: number;
  /**
   * Peer protocol level. Above `MODERN_PROTOCOL_LEVEL` the session uses
   * PRINT_START/DATA instead of the legacy opcodes.
   */
  readonly protocolLevel?: number;
  /** Milliseconds to wait for any single printer response. */
  readonly responseTimeoutMs?: number;
  /**
   * Largest slice sent in one DATA frame.
   *
   * The printer names the offset it wants but not a length, so the host
   * chooses. Defaults to the whole remainder, which is what the app does for
   * a socket transport. Lower it if a transport needs smaller writes.
   */
  readonly maxChunkSize?: number;
  /** Invoked as data is transferred. */
  readonly onProgress?: (progress: PrintProgress) => void;
  /** Invoked for every status frame, including ones the session handles. */
  readonly onStatus?: (status: PrinterStatus) => void;
}

/** What the session wants the caller to do next. */
export type SessionAction =
  /**
   * Write `data`. When `final` is set the job is complete once the write
   * lands; the printer does not acknowledge it further.
   */
  | { readonly type: 'send'; readonly data: Uint8Array; readonly final?: boolean }
  | { readonly type: 'done' }
  | { readonly type: 'wait' };

/**
 * Drives one print job.
 *
 * The class is transport agnostic: feed it inbound frames with `handleFrame`
 * and send whatever it returns. `PrinterConnection` wires this to a
 * `Transport`, but keeping it pure makes the whole flow unit testable.
 */
export class PrintSession {
  private readonly image: Uint8Array;
  private readonly copies: number;
  private readonly jobId: number;
  private readonly protocolLevel: number;
  private readonly maxChunkSize: number;
  private readonly onProgress: PrintSessionOptions['onProgress'];
  private readonly onStatus: PrintSessionOptions['onStatus'];

  private bytesSent = 0;
  private finished = false;
  private failure: Error | null = null;

  public constructor(options: PrintSessionOptions) {
    if (options.image.length === 0) {
      throw new ProtocolError('Cannot print an empty image');
    }
    this.image = options.image;
    this.copies = options.copies ?? 1;
    this.jobId = options.jobId ?? DEFAULT_JOB_ID;
    this.protocolLevel = options.protocolLevel ?? 0;
    this.maxChunkSize = options.maxChunkSize ?? Number.POSITIVE_INFINITY;
    this.onProgress = options.onProgress;
    this.onStatus = options.onStatus;
  }

  /** True once the printer has acknowledged the end of the job. */
  public get isFinished(): boolean {
    return this.finished;
  }

  /** Set when the printer reported a fault. */
  public get error(): Error | null {
    return this.failure;
  }

  /** True when the modern opcode pair is in use. */
  public get usesModernOpcodes(): boolean {
    return this.protocolLevel > MODERN_PROTOCOL_LEVEL;
  }

  /** The first frame the host sends after the transport opens. */
  public start(): Uint8Array {
    return encodeFrame({
      opcode: Command.SESSION_START,
      arg1: 1,
      arg2: SESSION_PROTOCOL_REVISION,
    });
  }

  /**
   * Processes one inbound frame and returns what to do next.
   *
   * Throws `PrinterError` when the printer reports an unrecoverable fault.
   */
  /**
   * Processes one inbound frame.
   *
   * Dispatch is on the opcode only for the frames the app treats specially.
   * Everything else falls through to the print state machine, which keys off
   * byte 1. That mirrors `b3.i.run()`, whose `b10` chain sits underneath the
   * opcode checks rather than beside them, and it matters in practice: on
   * hardware the printer signals READY with opcode `0x04`, not `0x00`.
   */
  public handleFrame(frame: Frame): SessionAction {
    switch (frame.opcode) {
      case Notification.HEARTBEAT:
        // Must be echoed or the printer tears the session down.
        return { type: 'send', data: encodeFrame({ opcode: Command.HEARTBEAT, arg1: 1 }) };

      case Notification.JOB_COMPLETE:
      case Notification.SESSION_END:
        this.finished = true;
        return { type: 'done' };

      case Notification.IDLE_A:
      case Notification.IDLE_B:
        return { type: 'wait' };

      case Command.FILE_LIST:
      case Command.FILE_READ:
      case Command.FILE_READ_NEXT:
        // The on-device file browser, unrelated to printing.
        return { type: 'wait' };

      default:
        return this.handlePrintState(frame);
    }
  }

  private handlePrintState(frame: Frame): SessionAction {
    const status = parseStatus(frame);
    this.onStatus?.(status);

    // The fault indicator is byte 3. Byte 1 is the flow-control state and
    // must not be read as a fault, since REQUEST_DATA and "no error" are
    // both zero there.
    if (isFault(frame)) {
      const error = new PrinterError(
        status.message ?? 'Printer reported an error',
        status.code,
        status.detail,
      );
      this.failure = error;
      throw error;
    }

    switch (frame.arg1) {
      case PrintState.READY:
        return { type: 'send', data: this.buildJobStart() };

      case PrintState.REQUEST_DATA:
        return this.buildDataResponse(frame);

      case PrintState.MEDIA_INFO:
        // Informational; the caller receives it through onStatus.
        return { type: 'wait' };

      case PrintState.NEEDS_ACK:
        // The frame's fourth byte is echoed back as the acknowledgement's
        // argument. The printer stalls the handshake without this.
        return {
          type: 'send',
          data: encodeFrame({ opcode: Command.ACK, arg1: frame.arg3 }),
        };

      case PrintState.FINISHED:
        // Confirmed on hardware: the printer signals completion with this
        // state and then goes quiet. It never sends JOB_COMPLETE, so waiting
        // for one would hang until the job timeout.
        this.finished = true;
        return {
          type: 'send',
          data: encodeFrame({ opcode: Command.END_JOB }),
          final: true,
        };

      default:
        return { type: 'wait' };
    }
  }

  /**
   * Builds the job start frame.
   *
   * Legacy form is `b(5, copies, 0, 12, payload)` with a 12-byte payload whose
   * first four bytes are the image length. The modern form is
   * `b(16, jobId >> 8, jobId, 8, payload)` where the payload additionally
   * carries the job id at offset 4.
   */
  private buildJobStart(): Uint8Array {
    const payload = new Uint8Array(12);
    writeUint32BE(payload, 0, this.image.length);

    if (this.usesModernOpcodes) {
      writeUint32BE(payload, 4, this.jobId);
      return encodeFrame({
        opcode: Command.PRINT_START,
        arg1: (this.jobId >>> 8) & 0xff,
        arg2: this.jobId & 0xff,
        payload: payload.subarray(0, 8),
      });
    }

    return encodeFrame({
      opcode: Command.PRINT_START_LEGACY,
      arg1: this.copies,
      arg2: 0,
      payload,
    });
  }

  /**
   * Answers a data request.
   *
   * The printer places the offset it wants in the first four payload bytes
   * (`f6 = f(0, bArr3)`). It does not name a length, so the host sends the
   * remainder, capped by `maxChunkSize`. The app echoes the request's arg1
   * and arg2 back on the data frame, which is reproduced here.
   */
  private buildDataResponse(frame: Frame): SessionAction {
    const offset = frame.payload.length >= 4 ? readUint32BE(frame.payload, 0) : this.bytesSent;

    if (offset >= this.image.length) {
      // Nothing left; wait for the printer to move to FINISHED.
      return { type: 'wait' };
    }

    const end = Math.min(offset + this.maxChunkSize, this.image.length);
    const slice = this.image.subarray(offset, end);

    this.bytesSent = end;
    this.onProgress?.({
      bytesSent: this.bytesSent,
      totalBytes: this.image.length,
      percent: Math.round((this.bytesSent / this.image.length) * 100),
    });

    return {
      type: 'send',
      data: encodeFrame({
        opcode: this.usesModernOpcodes ? Command.DATA : Command.DATA_LEGACY,
        arg1: frame.arg1,
        arg2: frame.arg2,
        payload: slice,
      }),
    };
  }

  /** Frame that cancels the job. */
  public static cancel(): Uint8Array {
    return encodeFrame({ opcode: Command.END_JOB });
  }

  /** Frame that polls for status, sent by the app when a read times out. */
  public static statusPoll(): Uint8Array {
    return encodeFrame({ opcode: Command.STATUS_POLL });
  }
}

/** Rejects after `ms`, used to bound waits on printer responses. */
export function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new TimeoutError(`Timed out after ${ms}ms waiting for ${what}`));
    }, ms);
    // Do not hold the event loop open for a timer that is racing a real task.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
  });
}
