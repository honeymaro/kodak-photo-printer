/**
 * High level printer API.
 *
 * Wraps a `Transport` with the framing and state machine appropriate to it,
 * so callers do not have to know whether they are on BLE or USB.
 */

import { TransportError, TimeoutError } from './errors.js';
import { FrameDecoder, encodeFrame, type Frame } from './protocol/frame.js';
import { Command, Notification } from './protocol/constants.js';
import {
  deviceInfoRequest,
  parseDeviceInfo,
  type DeviceInfo,
} from './protocol/device-info.js';
import { PrintSession, type PrintProgress, type PrintSessionOptions } from './protocol/session.js';
import { type PrinterStatus } from './protocol/status.js';
import { UsbTransport, listUsbDevices, type UsbTransportOptions } from './transport/usb.js';
import {
  SerialTransport,
  listSerialDevices,
  type SerialTransportOptions,
} from './transport/serial.js';
import type { DiscoveredDevice, Transport } from './transport/types.js';
import { prepareImage, type PrepareOptions } from './image/raster.js';

export interface PrintOptions {
  readonly copies?: number;
  readonly jobId?: number;
  readonly protocolLevel?: number;
  /** Overall job timeout. Defaults to 180000, matching the app's slow media case. */
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: PrintProgress) => void;
  readonly onStatus?: (status: PrinterStatus) => void;
}

/** Discovers printers on every transport that has its optional dependency installed. */
export async function discover(
  options: { usb?: boolean; serial?: boolean } = {},
): Promise<DiscoveredDevice[]> {
  const wantUsb = options.usb ?? true;
  const wantSerial = options.serial ?? true;

  const results = await Promise.allSettled([
    wantUsb ? listUsbDevices() : Promise.resolve([]),
    wantSerial ? listSerialDevices() : Promise.resolve([]),
  ]);

  const devices: DiscoveredDevice[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      devices.push(...result.value);
    }
  }
  return devices;
}

/**
 * A connected printer.
 *
 * Construct with a transport, or use the `connectSerial` / `connectUsb` helpers.
 */
export class Printer {
  private readonly decoder = new FrameDecoder();
  private readonly frameListeners = new Set<(frame: Frame) => void>();
  private lastError: Error | null = null;

  public constructor(public readonly transport: Transport) {
    this.transport.on('data', (chunk) => this.onData(chunk));
    this.transport.on('error', (error) => {
      this.lastError = error;
    });
  }

  /** Opens the underlying transport. */
  public async connect(): Promise<void> {
    await this.transport.open();
    this.decoder.reset();
  }

  /** Closes the underlying transport. */
  public async disconnect(): Promise<void> {
    await this.transport.close();
  }

  public get description(): string {
    return this.transport.description;
  }

  private onData(chunk: Uint8Array): void {
    if (this.transport.framing !== 'stream') {
      // BLE status notifications are handled by the BLE session directly.
      return;
    }
    for (const frame of this.decoder.push(chunk)) {
      for (const listener of [...this.frameListeners]) {
        listener(frame);
      }
    }
  }

  /**
   * Prints an already prepared raster.
   *
   * `data` must be in the format the firmware expects. Use `printImage` to
   * run a source image through the preparation pipeline first.
   */
  public async printRaw(data: Uint8Array, options: PrintOptions = {}): Promise<void> {
    if (!this.transport.isOpen) {
      throw new TransportError('Printer is not connected. Call connect() first.');
    }

    await this.printOverStream(data, options);
  }

  /** Prepares a source image and prints it. */
  public async printImage(
    input: string | Uint8Array,
    options: PrintOptions & { prepare?: PrepareOptions } = {},
  ): Promise<void> {
    const prepared = await prepareImage(input, options.prepare ?? {});
    await this.printRaw(prepared.data, options);
  }

  /** Runs a job on the stream protocol, where the printer pulls data. */
  private async printOverStream(data: Uint8Array, options: PrintOptions): Promise<void> {
    const sessionOptions: PrintSessionOptions = {
      image: data,
      copies: options.copies ?? 1,
      jobId: options.jobId,
      protocolLevel: options.protocolLevel,
      onProgress: options.onProgress,
      onStatus: options.onStatus,
    };
    const session = new PrintSession(sessionOptions);
    const timeoutMs = options.timeoutMs ?? 180_000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.frameListeners.delete(onFrame);
        this.transport.off('close', onClose);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      const timer = setTimeout(() => {
        finish(new TimeoutError(`Print job did not complete within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const onClose = (reason?: Error): void => {
        finish(reason ?? new TransportError('Transport closed during the job'));
      };

      const onFrame = (frame: Frame): void => {
        let action;
        try {
          action = session.handleFrame(frame);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        if (action.type === 'done') {
          finish();
          return;
        }
        if (action.type === 'send') {
          this.transport
            .write(action.data)
            .then(() => {
              // A final frame ends the job; the printer sends nothing after it.
              if (action.final === true) {
                finish();
              }
            })
            .catch((error: unknown) => {
              finish(error instanceof Error ? error : new Error(String(error)));
            });
        }
      };

      this.frameListeners.add(onFrame);
      this.transport.on('close', onClose);

      this.transport.write(session.start()).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Cancels the running job. */
  public async cancel(): Promise<void> {
    await this.transport.write(PrintSession.cancel());
  }

  /** Sends a status poll. Replies arrive through the `onStatus` callback of a job. */
  public async pollStatus(): Promise<void> {
    await this.transport.write(PrintSession.statusPoll());
  }

  /**
   * Asks the printer for its information block.
   *
   * Sends `DEVICE_INFO` and waits for the reply. The block's field semantics
   * are unconfirmed: the app reads thirteen counters and two strings out of it
   * and then discards them, so this returns the raw values.
   *
   * Returns null when the printer does not answer within `timeoutMs`.
   */
  public async requestDeviceInfo(timeoutMs = 5000): Promise<DeviceInfo | null> {
    if (this.transport.framing !== 'stream') {
      throw new TransportError('Device info is only available on stream transports');
    }

    return await new Promise<DeviceInfo | null>((resolve) => {
      const timer = setTimeout(() => {
        this.frameListeners.delete(onFrame);
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const onFrame = (frame: Frame): void => {
        // Heartbeats interleave with everything and must still be echoed.
        if (frame.opcode === Notification.HEARTBEAT) {
          void this.transport.write(encodeFrame({ opcode: Command.HEARTBEAT, arg1: 1 }));
          return;
        }
        const info = parseDeviceInfo(frame);
        if (info !== null) {
          clearTimeout(timer);
          this.frameListeners.delete(onFrame);
          resolve(info);
        }
      };

      this.frameListeners.add(onFrame);
      void this.transport.write(deviceInfoRequest()).catch(() => {
        clearTimeout(timer);
        this.frameListeners.delete(onFrame);
        resolve(null);
      });
    });
  }

  /** The most recent transport level error, if any. */
  public get error(): Error | null {
    return this.lastError;
  }

  /** Registers a raw frame listener, for diagnostics and protocol work. */
  public onFrame(listener: (frame: Frame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
}

/** Connects over USB. */
export async function connectUsb(options: UsbTransportOptions = {}): Promise<Printer> {
  const printer = new Printer(new UsbTransport(options));
  await printer.connect();
  return printer;
}

/**
 * Connects over a Bluetooth Classic SPP serial port.
 *
 * This is the print path on these printers.
 */
export async function connectSerial(options: SerialTransportOptions = {}): Promise<Printer> {
  const printer = new Printer(new SerialTransport(options));
  await printer.connect();
  return printer;
}
