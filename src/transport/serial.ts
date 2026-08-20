/**
 * Serial transport, used for Bluetooth Classic SPP.
 *
 * This is the print path on the Mini Shot 3 Retro. The printer pairs as a
 * Bluetooth Classic device exposing the SPP profile
 * (`00001101-0000-1000-8000-00805F9B34FB`), which every desktop OS surfaces as
 * a serial port:
 *
 * - Windows creates an outgoing "Standard Serial over Bluetooth link" COM port
 * - Linux gives you `/dev/rfcomm0` after `rfcomm bind`
 * - macOS creates `/dev/tty.KodakInstant-...`
 *
 * Opening the port establishes the Bluetooth connection, so no BLE stack and
 * no driver surgery is involved. The bytes on it are the stream framing from
 * `src/protocol/frame.ts`.
 *
 * `serialport` is loaded on demand so the library installs without it.
 */

import { TransportError } from '../errors.js';
import { importOptional } from '../optional.js';
import {
  TypedEmitter,
  type DiscoveredDevice,
  type Transport,
  type TransportEvents,
  type TransportFraming,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SerialPortModule = any;
type SerialPortInstance = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let serialModule: SerialPortModule | null = null;

async function loadSerialPort(): Promise<SerialPortModule> {
  if (serialModule !== null) {
    return serialModule;
  }
  const loaded = await importOptional<Record<string, unknown>>(
    'serialport',
    'Bluetooth SPP transport support',
  );
  serialModule = loaded;
  return serialModule;
}

/** Name fragments that identify a Bluetooth SPP port belonging to a printer. */
const PRINTER_PORT_HINTS = ['kodak', 'instant', 'prinics', 'mini shot', 'bluetooth'];

export interface SerialTransportOptions {
  /** Port path, for example `COM5` or `/dev/rfcomm0`. */
  readonly path?: string;
  /**
   * Substring matched against the port's friendly name when no path is given.
   * Defaults to picking the first port that looks like a Bluetooth link.
   */
  readonly name?: string;
  /** Irrelevant for a virtual Bluetooth port, but some drivers want a value. */
  readonly baudRate?: number;
  /** Milliseconds to wait for the port to open. */
  readonly openTimeoutMs?: number;
}

/**
 * Lists serial ports that look like a paired photo printer.
 *
 * On Windows a paired SPP device produces two ports, an incoming and an
 * outgoing one. Only the outgoing port carries a device address in its
 * hardware id, which is how the right one is picked.
 */
export async function listSerialDevices(): Promise<DiscoveredDevice[]> {
  const module = await loadSerialPort();
  const SerialPort = module['SerialPort'] as { list: () => Promise<Record<string, string>[]> };

  const ports = await SerialPort.list();
  return ports
    .filter((port) => {
      const haystack = [port['friendlyName'], port['pnpId'], port['manufacturer']]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return PRINTER_PORT_HINTS.some((hint) => haystack.includes(hint));
    })
    .map((port) => ({
      id: port['path'] as string,
      name: (port['friendlyName'] as string | undefined) ?? (port['path'] as string),
      transport: 'serial' as const,
      details: {
        pnpId: port['pnpId'],
        manufacturer: port['manufacturer'],
        serialNumber: port['serialNumber'],
      },
    }));
}

export class SerialTransport extends TypedEmitter<TransportEvents> implements Transport {
  public readonly framing: TransportFraming = 'stream';

  private port: SerialPortInstance | null = null;
  private open_ = false;
  private path_: string | undefined;

  public constructor(private readonly options: SerialTransportOptions = {}) {
    super();
  }

  public get isOpen(): boolean {
    return this.open_;
  }

  public get description(): string {
    return this.path_ !== undefined ? `SPP printer on ${this.path_}` : 'SPP printer';
  }

  /** The port that was opened. */
  public get path(): string | undefined {
    return this.path_;
  }

  private async resolvePath(module: SerialPortModule): Promise<string> {
    if (this.options.path !== undefined) {
      return this.options.path;
    }

    const SerialPort = module['SerialPort'] as { list: () => Promise<Record<string, string>[]> };
    const ports = await SerialPort.list();
    const wanted = this.options.name?.toLowerCase();

    const match = ports.find((port) => {
      const haystack = [port['friendlyName'], port['pnpId'], port['manufacturer']]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return wanted !== undefined
        ? haystack.includes(wanted)
        : PRINTER_PORT_HINTS.some((hint) => haystack.includes(hint));
    });

    if (match === undefined) {
      throw new TransportError(
        'No Bluetooth serial port found. Pair the printer first, then pass --port with the ' +
          'outgoing port (COM5 style on Windows, /dev/rfcomm0 on Linux).',
      );
    }
    return match['path'] as string;
  }

  public async open(): Promise<void> {
    const module = await loadSerialPort();
    const SerialPortClass = module['SerialPort'] as new (
      options: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => SerialPortInstance;

    const path = await this.resolvePath(module);
    this.path_ = path;

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.openTimeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        reject(
          new TransportError(
            `Opening ${path} timed out after ${timeoutMs}ms. The printer may be asleep or ` +
              'already connected to a phone.',
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const port = new SerialPortClass(
        {
          path,
          baudRate: this.options.baudRate ?? 115200,
          autoOpen: true,
        },
        (error: Error | null) => {
          clearTimeout(timer);
          if (error !== null) {
            reject(new TransportError(`Could not open ${path}: ${error.message}`, { cause: error }));
            return;
          }
          resolve();
        },
      );

      this.port = port;
      port.on('data', (chunk: Buffer) => this.emit('data', new Uint8Array(chunk)));
      port.on('error', (error: Error) => this.emit('error', error));
      port.on('close', () => {
        this.open_ = false;
        this.emit('close', undefined);
      });
    });

    this.open_ = true;
  }

  public async write(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (port === null || !this.open_) {
      throw new TransportError('Serial transport is not open');
    }
    await new Promise<void>((resolve, reject) => {
      port.write(Buffer.from(data), (error: Error | null | undefined) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        port.drain((drainError: Error | null | undefined) => {
          if (drainError !== null && drainError !== undefined) {
            reject(drainError);
          } else {
            resolve();
          }
        });
      });
    });
  }

  public async close(): Promise<void> {
    const port = this.port;
    if (port === null) {
      return;
    }
    this.open_ = false;
    await new Promise<void>((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
    this.port = null;
    this.emit('close', undefined);
  }
}
