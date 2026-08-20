/**
 * USB transport.
 *
 * The printer exposes an ADB interface over USB. This claims that interface,
 * runs the ADB handshake, and surfaces the print stream as a plain byte
 * channel.
 *
 * Written against the WebUSB API rather than the legacy libusb binding: the
 * `usb` package removed the legacy API in v3, and WebUSB is present in both
 * v2 and v3. It is also promise based, which suits the async flow here.
 *
 * The `usb` package is loaded on demand so the library stays installable on
 * machines with no native toolchain.
 */

import { TransportError } from '../errors.js';
import { importOptional } from '../optional.js';
import { ADB_INTERFACE, USB_PRODUCT_ID, USB_VENDOR_ID } from '../protocol/constants.js';
import { AdbHost, type AdbLink, type AdbStream } from './adb/host.js';
import { ADB_HEADER_SIZE } from './adb/message.js';
import {
  TypedEmitter,
  type DiscoveredDevice,
  type Transport,
  type TransportEvents,
  type TransportFraming,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type WebUsb = any;
type UsbDevice = any;
type UsbAlternate = any;
type UsbEndpointInfo = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Sanity bound on a declared ADB payload, to catch a desynchronised stream. */
const MAX_REASONABLE_PAYLOAD = 1024 * 1024;

let webusbInstance: WebUsb | null = null;

/** Loads the `usb` package and returns its WebUSB instance. */
async function loadUsb(): Promise<WebUsb> {
  if (webusbInstance !== null) {
    return webusbInstance;
  }
  const module = await importOptional<Record<string, unknown>>('usb', 'USB transport support');
  // v2 and v3 both export a ready-made `usb` WebUSB object.
  const instance = module['usb'] ?? module['webusb'] ?? module;
  if (instance === undefined || typeof (instance as WebUsb).getDevices !== 'function') {
    throw new TransportError(
      'The installed "usb" package does not expose a WebUSB interface. Install usb@^2.14.0 or usb@^3.0.0.',
    );
  }
  webusbInstance = instance;
  return webusbInstance;
}

export interface UsbTransportOptions {
  /** Serial number to select when more than one printer is attached. */
  readonly serial?: string;
  readonly vendorId?: number;
  readonly productId?: number;
  /** Milliseconds to wait for the device to open the print stream. */
  readonly streamTimeoutMs?: number;
  /**
   * Service to request when the device does not open a stream on its own.
   * Left undefined by default because this device opens the stream itself.
   */
  readonly service?: string;
  /** Consecutive endpoint stalls tolerated before giving up. */
  readonly maxStallRetries?: number;
  /** Issue a USB reset before claiming. Helps when a previous owner left state behind. */
  readonly resetBeforeClaim?: boolean;
  /**
   * Pause between bulk IN attempts while the printer has nothing to send.
   *
   * Without this the read loop reissues transfers as fast as the backend
   * returns them, which destabilises this device's USB stack and makes it
   * drop the link after a second or two.
   */
  readonly idlePollIntervalMs?: number;
}

/** Suspends for `ms` without holding the event loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
  });
}

/** True when an error raised by a bulk transfer indicates an endpoint stall. */
function isStallError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stall|LIBUSB_TRANSFER_STALL|LIBUSB_ERROR_PIPE/i.test(message);
}

/**
 * True when a read failed simply because nothing was pending.
 *
 * The backend surfaces an expired bulk IN as "Cancelled" or "Timeout". The
 * printer is idle for long stretches while it decides to open the print
 * stream, so these must not end the read loop.
 */
function isIdleReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancell?ed|timeout|LIBUSB_TRANSFER_TIMED_OUT/i.test(message);
}

/** True when the device has gone away and no retry can help. */
function isDisconnectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|no such device|NoDevice|LIBUSB_ERROR_NO_DEVICE/i.test(message);
}

/** Finds the ADB alternate setting on a device, or null when it has none. */
function findAdbInterface(
  device: UsbDevice,
): { interfaceNumber: number; alternate: UsbAlternate } | null {
  const interfaces = device.configuration?.interfaces ?? [];
  for (const iface of interfaces) {
    for (const alternate of iface.alternates ?? [iface.alternate]) {
      if (
        alternate?.interfaceClass === ADB_INTERFACE.class &&
        alternate?.interfaceSubclass === ADB_INTERFACE.subclass &&
        alternate?.interfaceProtocol === ADB_INTERFACE.protocol
      ) {
        return { interfaceNumber: iface.interfaceNumber, alternate };
      }
    }
  }
  return null;
}

/** Picks the bulk endpoint pair out of an alternate setting. */
function findEndpoints(alternate: UsbAlternate): { inEndpoint: number; outEndpoint: number } | null {
  let inEndpoint: number | null = null;
  let outEndpoint: number | null = null;

  for (const endpoint of (alternate.endpoints ?? []) as UsbEndpointInfo[]) {
    if (endpoint.type !== 'bulk') {
      continue;
    }
    if (endpoint.direction === 'in' && inEndpoint === null) {
      inEndpoint = endpoint.endpointNumber;
    } else if (endpoint.direction === 'out' && outEndpoint === null) {
      outEndpoint = endpoint.endpointNumber;
    }
  }

  return inEndpoint !== null && outEndpoint !== null ? { inEndpoint, outEndpoint } : null;
}

/** Lists attached printers that expose an ADB interface. */
export async function listUsbDevices(
  options: { vendorId?: number; productId?: number } = {},
): Promise<DiscoveredDevice[]> {
  const usb = await loadUsb();
  const vendorId = options.vendorId ?? USB_VENDOR_ID;
  const productId = options.productId ?? USB_PRODUCT_ID;

  const devices: UsbDevice[] = await usb.getDevices();

  return devices
    .filter((device) => device.vendorId === vendorId && device.productId === productId)
    .map((device) => ({
      id: device.serialNumber ?? `${vendorId.toString(16)}:${productId.toString(16)}`,
      name: device.productName ?? 'Kodak photo printer',
      transport: 'usb' as const,
      details: {
        vendorId: device.vendorId,
        productId: device.productId,
        manufacturerName: device.manufacturerName,
        serialNumber: device.serialNumber,
        hasAdbInterface: findAdbInterface(device) !== null,
      },
    }));
}

export class UsbTransport extends TypedEmitter<TransportEvents> implements Transport {
  public readonly framing: TransportFraming = 'stream';

  private device: UsbDevice | null = null;
  private interfaceNumber: number | null = null;
  private inEndpoint: number | null = null;
  private outEndpoint: number | null = null;
  private host: AdbHost | null = null;
  private stream: AdbStream | null = null;
  private open_ = false;
  private reading = false;
  private serial: string | undefined;
  /** Resolves once the read loop has actually stopped, so close() can await it. */
  private readLoopDone: Promise<void> = Promise.resolve();

  public constructor(private readonly options: UsbTransportOptions = {}) {
    super();
  }

  public get isOpen(): boolean {
    return this.open_;
  }

  public get description(): string {
    return this.serial !== undefined
      ? `USB printer ${this.serial}`
      : 'USB printer (ADB interface)';
  }

  /** The ADB stream carrying the print protocol, once established. */
  public get adbStream(): AdbStream | null {
    return this.stream;
  }

  /** The banner the device reported during the handshake. */
  public get deviceBanner(): string {
    return this.host?.deviceBanner ?? '';
  }

  public async open(): Promise<void> {
    const usb = await loadUsb();
    const vendorId = this.options.vendorId ?? USB_VENDOR_ID;
    const productId = this.options.productId ?? USB_PRODUCT_ID;

    const device = await this.selectDevice(usb, vendorId, productId);
    this.device = device;
    this.serial = device.serialNumber;

    await device.open();

    if (this.options.resetBeforeClaim === true && typeof device.reset === 'function') {
      try {
        await device.reset();
      } catch {
        // A reset is best effort; carry on and let the claim report problems.
      }
    }

    if (device.configuration === null || device.configuration === undefined) {
      await device.selectConfiguration(1);
    }

    const adb = findAdbInterface(device);
    if (adb === null) {
      throw new TransportError(
        'The device does not expose an ADB interface. It may be powered off or in a different USB mode.',
      );
    }

    const endpoints = findEndpoints(adb.alternate);
    if (endpoints === null) {
      throw new TransportError('The ADB interface is missing a bulk endpoint pair');
    }

    this.interfaceNumber = adb.interfaceNumber;
    this.inEndpoint = endpoints.inEndpoint;
    this.outEndpoint = endpoints.outEndpoint;

    await device.claimInterface(adb.interfaceNumber);

    // A previous owner (typically the adb server) can leave the bulk pair
    // halted, which makes the first transfer stall. Clearing is harmless when
    // the endpoints are already healthy.
    await this.clearHalts(device, endpoints.inEndpoint, endpoints.outEndpoint);

    await this.startAdb();
    this.open_ = true;
  }

  /** Clears a halt condition on both bulk endpoints, ignoring failures. */
  private async clearHalts(
    device: UsbDevice,
    inEndpoint: number,
    outEndpoint: number,
  ): Promise<void> {
    for (const [direction, endpoint] of [
      ['in', inEndpoint],
      ['out', outEndpoint],
    ] as const) {
      try {
        await device.clearHalt(direction, endpoint);
      } catch {
        // Not all backends support this on a healthy endpoint.
      }
    }
  }

  private async selectDevice(
    usb: WebUsb,
    vendorId: number,
    productId: number,
  ): Promise<UsbDevice> {
    const devices: UsbDevice[] = await usb.getDevices();
    const candidates = devices.filter(
      (device) => device.vendorId === vendorId && device.productId === productId,
    );

    if (candidates.length === 0) {
      throw new TransportError(
        `No USB device found with vendor 0x${vendorId.toString(16)} product 0x${productId.toString(
          16,
        )}. Check that the printer is powered on; it sleeps after a period of inactivity.`,
      );
    }

    const wanted = this.options.serial;
    if (wanted === undefined) {
      return candidates[0] as UsbDevice;
    }

    const matched = candidates.find((device) => device.serialNumber === wanted);
    if (matched === undefined) {
      throw new TransportError(`No USB device matched serial ${wanted}`);
    }
    return matched;
  }

  /** Runs the ADB handshake and waits for the print stream to appear. */
  private async startAdb(): Promise<void> {
    const device = this.device;
    const inEndpoint = this.inEndpoint;
    const outEndpoint = this.outEndpoint;
    if (device === null || inEndpoint === null || outEndpoint === null) {
      throw new TransportError('USB endpoints are not ready');
    }

    let onData: ((chunk: Uint8Array) => void) | null = null;

    const link: AdbLink = {
      write: async (data) => {
        const result = await device.transferOut(outEndpoint, data);
        if (result?.status !== undefined && result.status !== 'ok') {
          throw new TransportError(`Bulk write failed with status ${String(result.status)}`);
        }
      },
      onData: (listener) => {
        onData = listener;
      },
      close: async () => {
        this.reading = false;
      },
    };

    const host = new AdbHost(link);
    this.host = host;

    host.on('error', (error) => this.emit('error', error));
    host.on('authRequired', () => {
      this.emit(
        'error',
        new TransportError(
          'The device requested ADB authentication. Authorise this host once with the standard adb client, then retry.',
        ),
      );
    });

    const streamPromise = new Promise<AdbStream>((resolve) => {
      host.on('stream', (stream) => resolve(stream));
    });

    // Send the handshake before starting the read loop. Overlapping a bulk IN
    // with the bulk OUT makes this device tear the link down a second or two
    // after the handshake; keeping the first exchange sequential avoids it.
    // The reply is buffered by the USB stack until the loop picks it up.
    await host.connect();

    // Start the bulk IN read loop. The promise is retained so close() can
    // wait for it to unwind; otherwise a transfer in flight keeps the Node
    // event loop alive and the process never exits.
    this.reading = true;
    this.readLoopDone = this.readLoop(device, inEndpoint, (chunk) => onData?.(chunk));

    host.on('data', (_stream, payload) => this.emit('data', payload));
    host.on('streamClose', () => {
      this.open_ = false;
      this.emit('close', undefined);
    });

    const timeoutMs = this.options.streamTimeoutMs ?? 10_000;
    const service = this.options.service;

    if (service !== undefined) {
      await host.open(service);
    }

    this.stream = await Promise.race([
      streamPromise,
      new Promise<never>((_resolve, reject) => {
        const handle = setTimeout(() => {
          reject(
            new TransportError(
              `The printer did not open a print stream within ${timeoutMs}ms. ` +
                'See PROTOCOL.md, "Open question: the USB stream destination".',
            ),
          );
        }, timeoutMs);
        if (typeof handle.unref === 'function') {
          handle.unref();
        }
      }),
    ]);
  }

  /**
   * Continuously reads the bulk IN endpoint.
   *
   * Reads follow the ADB convention rather than asking for an oversized
   * buffer: a 24 byte header first, then exactly the payload length the
   * header declares. adbd writes those as separate bulk transfers, and this
   * firmware does not tolerate a single large read.
   */
  private async readLoop(
    device: UsbDevice,
    endpoint: number,
    deliver: (chunk: Uint8Array) => void,
  ): Promise<void> {
    const maxStalls = this.options.maxStallRetries ?? 5;
    const idleInterval = this.options.idlePollIntervalMs ?? 20;
    let stalls = 0;

    while (this.reading) {
      try {
        const header = await this.readExactly(device, endpoint, ADB_HEADER_SIZE);
        if (header === null) {
          // Nothing pending. The printer may stay idle for a long time, so
          // back off rather than spinning on the endpoint.
          await delay(idleInterval);
          continue;
        }
        stalls = 0;

        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const payloadLength = view.getUint32(12, true);

        if (payloadLength === 0) {
          deliver(header);
          continue;
        }
        if (payloadLength > MAX_REASONABLE_PAYLOAD) {
          this.emit(
            'error',
            new TransportError(
              `Received an ADB header declaring ${payloadLength} bytes, which is out of range. ` +
                'The link is out of sync.',
            ),
          );
          return;
        }

        const payload = await this.readExactly(device, endpoint, payloadLength);
        const message = new Uint8Array(ADB_HEADER_SIZE + (payload?.length ?? 0));
        message.set(header, 0);
        if (payload !== null) {
          message.set(payload, ADB_HEADER_SIZE);
        }
        deliver(message);
      } catch (error) {
        if (!this.reading) {
          // Expected when close() interrupts a pending transfer.
          return;
        }
        if (isDisconnectError(error)) {
          this.emit('close', new TransportError('The printer disconnected'));
          return;
        }
        if (isStallError(error)) {
          if (!(await this.recoverFromStall(device, endpoint, ++stalls, maxStalls))) {
            return;
          }
          continue;
        }

        this.emit('error', error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  /**
   * Reads exactly `length` bytes, or returns null when the endpoint is idle.
   *
   * A short transfer is retried until the requested count is satisfied, since
   * a bulk read can return less than asked for.
   */
  private async readExactly(
    device: UsbDevice,
    endpoint: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const out = new Uint8Array(length);
    let filled = 0;

    while (filled < length && this.reading) {
      let result;
      try {
        result = await device.transferIn(endpoint, length - filled);
      } catch (error) {
        if (isIdleReadError(error)) {
          // Nothing arrived. Report idle only when no bytes were collected;
          // mid-message we must keep waiting or the stream desynchronises.
          if (filled === 0) {
            return null;
          }
          continue;
        }
        throw error;
      }

      if (result?.status === 'stall') {
        throw new TransportError('stall');
      }

      const data: DataView | undefined = result?.data;
      if (data === undefined || data.byteLength === 0) {
        if (filled === 0) {
          return null;
        }
        continue;
      }

      out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), filled);
      filled += data.byteLength;
    }

    return filled === length ? out : null;
  }

  /**
   * Clears a stalled IN endpoint.
   *
   * Returns false when the retry budget is spent, in which case the caller
   * should stop reading.
   */
  private async recoverFromStall(
    device: UsbDevice,
    endpoint: number,
    attempt: number,
    limit: number,
  ): Promise<boolean> {
    if (attempt > limit) {
      this.emit(
        'error',
        new TransportError(
          `Bulk IN endpoint ${endpoint} stalled ${limit} times in a row. ` +
            'Another process may still hold the interface; try "adb kill-server" and replug the printer.',
        ),
      );
      return false;
    }

    try {
      await device.clearHalt('in', endpoint);
    } catch (error) {
      this.emit(
        'error',
        new TransportError(`Could not clear the halt on endpoint ${endpoint}`, { cause: error }),
      );
      return false;
    }
    return true;
  }

  public async write(data: Uint8Array): Promise<void> {
    const host = this.host;
    const stream = this.stream;
    if (host === null || stream === null || !this.open_) {
      throw new TransportError('USB transport is not open');
    }
    await host.write(stream.localId, data);
  }

  public async close(): Promise<void> {
    if (!this.open_ && this.device === null) {
      return;
    }
    this.open_ = false;
    this.reading = false;

    // Wait for the read loop to unwind before releasing the device. A pending
    // bulk transfer keeps the process alive, so this is bounded rather than
    // awaited indefinitely.
    await Promise.race([
      this.readLoopDone.catch(() => undefined),
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, 2000);
        if (typeof handle.unref === 'function') {
          handle.unref();
        }
      }),
    ]);

    try {
      await this.host?.close();
    } catch {
      // Best effort.
    }

    const device = this.device;
    if (device !== null && this.interfaceNumber !== null) {
      try {
        await device.releaseInterface(this.interfaceNumber);
      } catch {
        // Best effort.
      }
    }

    try {
      await device?.close();
    } catch {
      // Best effort.
    }

    this.device = null;
    this.interfaceNumber = null;
    this.inEndpoint = null;
    this.outEndpoint = null;
    this.host = null;
    this.stream = null;

    this.emit('close', undefined);
  }
}
