/**
 * Minimal ADB host, enough to carry the print stream.
 *
 * A stock `adb` client cannot be reused here. The printer opens the print
 * stream itself: on the accessory link the app never sends OPEN, it only
 * answers an inbound OPEN with OKAY and then bridges WRTE payloads
 * (`c3.RunnableC0512g.a()`). The adb server rejects device-initiated streams
 * unless a matching reverse forward exists, and `reverse:` is not implemented
 * by this device's adbd, so the host side is implemented directly.
 *
 * This class is transport agnostic. `UsbTransport` supplies the bulk endpoint
 * plumbing; tests supply an in-memory duplex.
 */

import { TransportError } from '../../errors.js';
import {
  AdbCommand,
  AdbMessageDecoder,
  ADB_HEADER_SIZE,
  ADB_LEGACY_MAX_PAYLOAD,
  commandName,
  connectMessage,
  encodeAdbHeader,
  isValidMagic,
  type AdbMessage,
} from './message.js';

/** Byte channel the ADB host runs over. */
export interface AdbLink {
  write(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): void;
  close(): Promise<void>;
}

export interface AdbStream {
  /** Local stream id chosen by this host. */
  readonly localId: number;
  /** Remote stream id chosen by the device. */
  readonly remoteId: number;
  /** Destination string from the OPEN message, empty for host-opened streams. */
  readonly destination: string;
}

export interface AdbHostEvents {
  /** A stream was established, from either side. */
  stream: (stream: AdbStream) => void;
  /** Payload arrived on a stream. */
  data: (stream: AdbStream, payload: Uint8Array) => void;
  /** A stream closed. */
  streamClose: (stream: AdbStream) => void;
  /** The device completed the CNXN handshake. */
  connect: (banner: string) => void;
  /** The device asked for authentication, which this host cannot satisfy. */
  authRequired: () => void;
  error: (error: Error) => void;
}

interface MutableStream {
  localId: number;
  remoteId: number;
  destination: string;
  open: boolean;
}

export class AdbHost {
  private readonly decoder = new AdbMessageDecoder();
  private readonly streams = new Map<number, MutableStream>();
  private readonly listeners: {
    [K in keyof AdbHostEvents]: Set<AdbHostEvents[K]>;
  } = {
    stream: new Set(),
    data: new Set(),
    streamClose: new Set(),
    connect: new Set(),
    authRequired: new Set(),
    error: new Set(),
  };

  private nextLocalId = 1;
  private connected = false;
  private banner = '';
  private maxPayload: number;

  public constructor(
    private readonly link: AdbLink,
    private readonly options: { strictMagic?: boolean; maxPayload?: number } = {},
  ) {
    this.maxPayload = options.maxPayload ?? ADB_LEGACY_MAX_PAYLOAD;
    this.link.onData((chunk) => {
      try {
        for (const message of this.decoder.push(chunk)) {
          this.dispatch(message);
        }
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public on<K extends keyof AdbHostEvents>(event: K, listener: AdbHostEvents[K]): void {
    this.listeners[event].add(listener);
  }

  public off<K extends keyof AdbHostEvents>(event: K, listener: AdbHostEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  private emit<K extends keyof AdbHostEvents>(
    event: K,
    ...args: Parameters<AdbHostEvents[K]>
  ): void {
    for (const listener of [...this.listeners[event]]) {
      (listener as (...a: Parameters<AdbHostEvents[K]>) => void)(...args);
    }
  }

  /** True once the device answered CNXN. */
  public get isConnected(): boolean {
    return this.connected;
  }

  /** Banner string the device sent, for example `device::ro.product.name=...`. */
  public get deviceBanner(): string {
    return this.banner;
  }

  /**
   * Largest payload one WRTE may carry.
   *
   * Starts at the legacy 4096 and is replaced by whatever the device
   * advertises in its CNXN reply.
   */
  public get negotiatedMaxPayload(): number {
    return this.maxPayload;
  }

  /**
   * Sends one message as two writes: the 24 byte header, then the payload.
   *
   * adbd reads the header and the body as separate transfers. On a USB link a
   * combined write desynchronises it, which this printer answers by stalling
   * its endpoint and dropping the link. Splitting here keeps every transport
   * correct; an in-memory link simply sees two chunks the decoder reassembles.
   */
  private async send(
    command: number,
    arg0: number,
    arg1: number,
    payload?: Uint8Array,
  ): Promise<void> {
    await this.link.write(encodeAdbHeader({ command, arg0, arg1, payload }));
    if (payload !== undefined && payload.length > 0) {
      await this.link.write(payload);
    }
  }

  /** Sends the CNXN handshake. */
  public async connect(banner?: string): Promise<void> {
    const message = connectMessage(banner);
    await this.link.write(message.subarray(0, ADB_HEADER_SIZE));
    if (message.length > ADB_HEADER_SIZE) {
      await this.link.write(message.subarray(ADB_HEADER_SIZE));
    }
  }

  /** Opens a stream to a named service, for example `shell:` or `sync:`. */
  public async open(destination: string): Promise<number> {
    const localId = this.nextLocalId;
    this.nextLocalId += 1;

    this.streams.set(localId, { localId, remoteId: 0, destination, open: false });

    const payload = new TextEncoder().encode(`${destination}\0`);
    await this.send(AdbCommand.OPEN, localId, 0, payload);
    return localId;
  }

  /** Sends payload on an established stream. Splits oversized writes. */
  public async write(localId: number, payload: Uint8Array): Promise<void> {
    const stream = this.streams.get(localId);
    if (stream === undefined || !stream.open) {
      throw new TransportError(`Stream ${localId} is not open`);
    }

    for (let offset = 0; offset < payload.length; offset += this.maxPayload) {
      const slice = payload.subarray(offset, Math.min(offset + this.maxPayload, payload.length));
      await this.send(AdbCommand.WRTE, stream.localId, stream.remoteId, slice);
    }
  }

  /** Closes a stream. */
  public async closeStream(localId: number): Promise<void> {
    const stream = this.streams.get(localId);
    if (stream === undefined) {
      return;
    }
    this.streams.delete(localId);
    await this.send(AdbCommand.CLSE, stream.localId, stream.remoteId);
  }

  /** Tears down the link. */
  public async close(): Promise<void> {
    for (const localId of [...this.streams.keys()]) {
      await this.closeStream(localId).catch(() => undefined);
    }
    await this.link.close();
  }

  private dispatch(message: AdbMessage): void {
    if (this.options.strictMagic === true) {
      // The device's magic is checked only when asked, because the accessory
      // variant of this protocol zeroes the field.
      const magic = (message.command ^ 0xffffffff) >>> 0;
      if (!isValidMagic(message.command, magic)) {
        this.emit('error', new TransportError(`Bad magic on ${commandName(message.command)}`));
        return;
      }
    }

    switch (message.command) {
      case AdbCommand.CNXN: {
        this.connected = true;
        this.banner = new TextDecoder().decode(message.payload).replace(/\0+$/, '');
        // The device advertises its maximum payload in arg1. This printer
        // reports 4096; writing larger frames would overrun it.
        if (message.arg1 > 0) {
          this.maxPayload = message.arg1;
        }
        this.emit('connect', this.banner);
        return;
      }

      case AdbCommand.AUTH: {
        this.emit('authRequired');
        return;
      }

      case AdbCommand.OPEN: {
        // Device-initiated stream. This is how the print channel arrives.
        void this.acceptStream(message);
        return;
      }

      case AdbCommand.OKAY: {
        const stream = this.streams.get(message.arg1);
        if (stream !== undefined && !stream.open) {
          stream.remoteId = message.arg0;
          stream.open = true;
          this.emit('stream', { ...stream });
        }
        return;
      }

      case AdbCommand.WRTE: {
        const stream = this.streams.get(message.arg1);
        if (stream === undefined) {
          return;
        }
        this.emit('data', { ...stream }, message.payload);
        // Every WRTE must be acknowledged or the device stalls.
        void this.send(AdbCommand.OKAY, stream.localId, stream.remoteId).catch(
          (error: unknown) => {
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
          },
        );
        return;
      }

      case AdbCommand.CLSE: {
        const stream = this.streams.get(message.arg1);
        if (stream === undefined) {
          return;
        }
        this.streams.delete(stream.localId);
        this.emit('streamClose', { ...stream });
        return;
      }

      default:
        // Unknown commands are ignored rather than treated as fatal.
        return;
    }
  }

  /**
   * Accepts a stream the device opened.
   *
   * The app answers any inbound OPEN with OKAY without inspecting the
   * destination, so the same permissive behaviour is reproduced here.
   */
  private async acceptStream(message: AdbMessage): Promise<void> {
    const localId = this.nextLocalId;
    this.nextLocalId += 1;

    const destination = new TextDecoder().decode(message.payload).replace(/\0+$/, '');
    const stream: MutableStream = {
      localId,
      remoteId: message.arg0,
      destination,
      open: true,
    };
    this.streams.set(localId, stream);

    try {
      await this.send(AdbCommand.OKAY, localId, message.arg0);
      this.emit('stream', { ...stream });
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Streams currently established, for diagnostics. */
  public activeStreams(): AdbStream[] {
    return [...this.streams.values()].filter((s) => s.open).map((s) => ({ ...s }));
  }
}
