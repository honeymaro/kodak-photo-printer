/** Transport abstraction shared by every connection method. */

/**
 * How a transport frames the bytes handed to it.
 *
 * Only the stream framing is implemented. BLE would need its own, but these
 * printers are reachable over Bluetooth Classic SPP; see PROTOCOL.md.
 */
export type TransportFraming = 'stream';

export interface TransportEvents {
  data: (chunk: Uint8Array) => void;
  close: (reason?: Error) => void;
  error: (error: Error) => void;
}

/**
 * A bidirectional byte channel to the printer.
 *
 * Implementations must deliver received bytes through `on('data')` in order.
 * Stream transports may split or coalesce chunks freely; the frame decoder
 * reassembles them. BLE transports deliver one notification per event.
 */
export interface Transport {
  /** Identifies the framing the protocol layer should apply. */
  readonly framing: TransportFraming;

  /** Human readable description of the peer, used in logs and CLI output. */
  readonly description: string;

  /** True between a successful `open()` and the channel closing. */
  readonly isOpen: boolean;

  /** Establishes the connection. Resolves once the channel can carry frames. */
  open(): Promise<void>;

  /** Sends bytes. Resolves once handed to the operating system. */
  write(data: Uint8Array): Promise<void>;

  /** Closes the connection. Safe to call more than once. */
  close(): Promise<void>;

  on<E extends keyof TransportEvents>(event: E, listener: TransportEvents[E]): void;
  off<E extends keyof TransportEvents>(event: E, listener: TransportEvents[E]): void;
}

/** A printer found by a discovery scan. */
export interface DiscoveredDevice {
  /** Stable identifier to reconnect with: a BLE peripheral id or USB serial. */
  readonly id: string;
  /** Advertised or descriptor-provided name, when available. */
  readonly name?: string;
  /** Which transport found it. */
  readonly transport: 'usb' | 'serial';
  /** Signal strength for BLE results. */
  readonly rssi?: number;
  /** Implementation specific extras, surfaced by the CLI in verbose mode. */
  readonly details?: Record<string, unknown>;
}

/**
 * Minimal event emitter used by transports, kept dependency free.
 *
 * The constraint is written as a mapped type rather than `Record<string, ...>`
 * so that plain interfaces such as `TransportEvents` satisfy it without
 * needing an index signature.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  public on<E extends keyof Events>(event: E, listener: Events[E]): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: never[]) => void);
  }

  public off<E extends keyof Events>(event: E, listener: Events[E]): void {
    this.listeners.get(event)?.delete(listener as (...args: never[]) => void);
  }

  protected emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const set = this.listeners.get(event);
    if (set === undefined) {
      return;
    }
    // Copy so a listener removing itself does not disturb iteration.
    for (const listener of [...set]) {
      (listener as (...a: Parameters<Events[E]>) => void)(...args);
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
