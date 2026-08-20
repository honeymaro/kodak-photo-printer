/**
 * In-memory transport used by the test suite and by `retro3 print --dry-run`.
 *
 * It records everything written and lets a test inject inbound bytes, so the
 * print state machine can be exercised end to end with no hardware.
 */

import { TypedEmitter, type Transport, type TransportEvents, type TransportFraming } from './types.js';

export interface MockTransportOptions {
  framing?: TransportFraming;
  description?: string;
  /** Invoked for every write, so a fake printer can respond. */
  onWrite?: (data: Uint8Array, transport: MockTransport) => void | Promise<void>;
}

export class MockTransport extends TypedEmitter<TransportEvents> implements Transport {
  public readonly framing: TransportFraming;
  public readonly description: string;

  /** Every buffer passed to `write`, in order. */
  public readonly writes: Uint8Array[] = [];

  private open_ = false;
  private readonly onWrite: MockTransportOptions['onWrite'];

  public constructor(options: MockTransportOptions = {}) {
    super();
    this.framing = options.framing ?? 'stream';
    this.description = options.description ?? 'mock transport';
    this.onWrite = options.onWrite;
  }

  public get isOpen(): boolean {
    return this.open_;
  }

  public async open(): Promise<void> {
    this.open_ = true;
  }

  public async write(data: Uint8Array): Promise<void> {
    this.writes.push(data.slice());
    await this.onWrite?.(data, this);
  }

  public async close(): Promise<void> {
    if (!this.open_) {
      return;
    }
    this.open_ = false;
    this.emit('close', undefined);
  }

  /** Delivers bytes as if the printer had sent them. */
  public receive(data: Uint8Array): void {
    this.emit('data', data);
  }

  /** Raises an error on the channel. */
  public fail(error: Error): void {
    this.emit('error', error);
  }

  /** All writes concatenated, convenient for assertions. */
  public writtenBytes(): Uint8Array {
    const total = this.writes.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.writes) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
