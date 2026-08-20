import { describe, expect, it, vi } from 'vitest';
import {
  ADB_HEADER_SIZE,
  AdbCommand,
  AdbMessageDecoder,
  checksum,
  commandName,
  connectMessage,
  decodeAdbHeader,
  encodeAdbHeader,
  encodeAdbMessage,
  isValidMagic,
} from '../src/transport/adb/message.js';
import { AdbHost, type AdbLink } from '../src/transport/adb/host.js';

describe('ADB command words', () => {
  it('matches the literals found in the decompiled app', () => {
    // c3.C0506a queues 1314410051 and 1163086915; c3.RunnableC0512g compares
    // against 1313165391, 1497451343 and 1163154007.
    expect(AdbCommand.CNXN).toBe(1314410051);
    expect(AdbCommand.CLSE).toBe(1163086915);
    expect(AdbCommand.OPEN).toBe(1313165391);
    expect(AdbCommand.OKAY).toBe(1497451343);
    expect(AdbCommand.WRTE).toBe(1163154007);
  });

  it('renders as the four character mnemonic', () => {
    expect(commandName(AdbCommand.CNXN)).toBe('CNXN');
    expect(commandName(AdbCommand.WRTE)).toBe('WRTE');
    expect(commandName(AdbCommand.CLSE)).toBe('CLSE');
  });
});

describe('ADB message codec', () => {
  it('writes six little endian words followed by the payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const message = encodeAdbMessage({
      command: AdbCommand.WRTE,
      arg0: 7,
      arg1: 9,
      payload,
    });

    expect(message.length).toBe(ADB_HEADER_SIZE + 3);
    const header = decodeAdbHeader(message);
    expect(header.command).toBe(AdbCommand.WRTE);
    expect(header.arg0).toBe(7);
    expect(header.arg1).toBe(9);
    expect(header.length).toBe(3);
    expect(header.checksum).toBe(6);
    expect(isValidMagic(header.command, header.magic)).toBe(true);
  });

  it('sums payload bytes for the checksum', () => {
    expect(checksum(new Uint8Array([0xff, 0x01]))).toBe(256);
    expect(checksum(new Uint8Array(0))).toBe(0);
  });

  it('advertises the legacy version and payload size the printer expects', () => {
    // Confirmed on hardware: the device answers with arg0 0x01000000 and
    // arg1 4096, so the host advertises the same rather than a modern 256 KiB.
    const header = decodeAdbHeader(connectMessage());
    expect(header.command).toBe(AdbCommand.CNXN);
    expect(header.arg0).toBe(0x01000000);
    expect(header.arg1).toBe(4096);
    expect(header.length).toBeGreaterThan(0);
  });

  it('accepts a custom banner', () => {
    const header = decodeAdbHeader(connectMessage('host::features=cmd\0'));
    expect(header.command).toBe(AdbCommand.CNXN);
    expect(header.length).toBeGreaterThan(0);
  });
});

describe('encodeAdbHeader', () => {
  it('produces only the 24 byte header but declares the payload length', () => {
    // adbd reads the header and the body as separate transfers; combining
    // them desynchronises this printer and drops the link.
    const payload = new Uint8Array([1, 2, 3, 4]);
    const header = encodeAdbHeader({ command: AdbCommand.OPEN, arg0: 7, arg1: 0, payload });

    expect(header.length).toBe(ADB_HEADER_SIZE);
    const decoded = decodeAdbHeader(header);
    expect(decoded.command).toBe(AdbCommand.OPEN);
    expect(decoded.arg0).toBe(7);
    expect(decoded.length).toBe(4);
    expect(decoded.checksum).toBe(10);
    expect(isValidMagic(decoded.command, decoded.magic)).toBe(true);
  });

  it('matches the header that encodeAdbMessage would produce', () => {
    const payload = new TextEncoder().encode('shell:\0');
    const split = encodeAdbHeader({ command: AdbCommand.OPEN, arg0: 1, payload });
    const combined = encodeAdbMessage({ command: AdbCommand.OPEN, arg0: 1, payload });
    expect([...split]).toEqual([...combined.subarray(0, ADB_HEADER_SIZE)]);
  });
});

describe('AdbMessageDecoder', () => {
  it('reassembles messages split across chunks', () => {
    const a = encodeAdbMessage({ command: AdbCommand.OKAY, arg0: 1, arg1: 2 });
    const b = encodeAdbMessage({
      command: AdbCommand.WRTE,
      arg0: 1,
      arg1: 2,
      payload: new Uint8Array([9, 9]),
    });
    const stream = new Uint8Array([...a, ...b]);

    const decoder = new AdbMessageDecoder();
    const messages = [];
    for (const byte of stream) {
      messages.push(...decoder.push(new Uint8Array([byte])));
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]?.command).toBe(AdbCommand.OKAY);
    expect(messages[1]?.command).toBe(AdbCommand.WRTE);
    expect([...(messages[1]?.payload ?? [])]).toEqual([9, 9]);
  });
});

/** In-memory link so the host can be driven without USB. */
function makeLink(): {
  link: AdbLink;
  written: Uint8Array[];
  deliver: (data: Uint8Array) => void;
} {
  const written: Uint8Array[] = [];
  let listener: ((chunk: Uint8Array) => void) | null = null;

  return {
    written,
    link: {
      write: async (data) => {
        written.push(data.slice());
      },
      onData: (fn) => {
        listener = fn;
      },
      close: async () => undefined,
    },
    deliver: (data) => listener?.(data),
  };
}

describe('AdbHost', () => {
  it('completes the CNXN handshake and exposes the banner', async () => {
    const { link, written, deliver } = makeLink();
    const host = new AdbHost(link);

    const connected = vi.fn();
    host.on('connect', connected);

    await host.connect();
    expect(decodeAdbHeader(written[0] as Uint8Array).command).toBe(AdbCommand.CNXN);

    deliver(
      encodeAdbMessage({
        command: AdbCommand.CNXN,
        payload: new TextEncoder().encode('device::ro.product.name=rk3xxx\0'),
      }),
    );

    expect(connected).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(true);
    expect(host.deviceBanner).toContain('rk3xxx');
  });

  it('adopts the maximum payload the device advertises', async () => {
    const { link, deliver } = makeLink();
    const host = new AdbHost(link);

    // Defaults to the legacy size this printer uses.
    expect(host.negotiatedMaxPayload).toBe(4096);

    deliver(encodeAdbMessage({ command: AdbCommand.CNXN, arg0: 0x01000000, arg1: 262144 }));
    expect(host.negotiatedMaxPayload).toBe(262144);
  });

  it('accepts a device-initiated OPEN and answers OKAY', async () => {
    // This is the case that matters: the printer opens the print stream, and
    // the app answers any inbound OPEN without inspecting the destination.
    const { link, written, deliver } = makeLink();
    const host = new AdbHost(link);

    const streams: string[] = [];
    host.on('stream', (stream) => streams.push(stream.destination));

    deliver(
      encodeAdbMessage({
        command: AdbCommand.OPEN,
        arg0: 42,
        payload: new TextEncoder().encode('printer:\0'),
      }),
    );
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    expect(streams[0]).toBe('printer:');
    const reply = decodeAdbHeader(written.at(-1) as Uint8Array);
    expect(reply.command).toBe(AdbCommand.OKAY);
    // The device's stream id is echoed back as arg1.
    expect(reply.arg1).toBe(42);
  });

  it('acknowledges every WRTE and surfaces its payload', async () => {
    const { link, written, deliver } = makeLink();
    const host = new AdbHost(link);

    const received: Uint8Array[] = [];
    host.on('data', (_stream, payload) => received.push(payload));

    deliver(
      encodeAdbMessage({
        command: AdbCommand.OPEN,
        arg0: 5,
        payload: new TextEncoder().encode('x:\0'),
      }),
    );
    await vi.waitFor(() => expect(host.activeStreams()).toHaveLength(1));

    const local = host.activeStreams()[0]?.localId as number;
    deliver(
      encodeAdbMessage({
        command: AdbCommand.WRTE,
        arg0: 5,
        arg1: local,
        payload: new Uint8Array([0xde, 0xad]),
      }),
    );

    expect(received).toHaveLength(1);
    expect([...(received[0] as Uint8Array)]).toEqual([0xde, 0xad]);

    await vi.waitFor(() => {
      const last = decodeAdbHeader(written.at(-1) as Uint8Array);
      expect(last.command).toBe(AdbCommand.OKAY);
    });
  });

  it('splits an oversized write at the negotiated payload size', async () => {
    const { link, written, deliver } = makeLink();
    const host = new AdbHost(link, { maxPayload: 4096 });

    deliver(
      encodeAdbMessage({
        command: AdbCommand.OPEN,
        arg0: 1,
        payload: new TextEncoder().encode('x:\0'),
      }),
    );
    await vi.waitFor(() => expect(host.activeStreams()).toHaveLength(1));

    const local = host.activeStreams()[0]?.localId as number;
    written.length = 0;

    await host.write(local, new Uint8Array(10_000));

    // 10000 bytes against a 4096 byte cap is three messages, and each message
    // goes out as a header write followed by a body write.
    const headers = written.filter((chunk) => chunk.length === ADB_HEADER_SIZE);
    const bodies = written.filter((chunk) => chunk.length !== ADB_HEADER_SIZE);

    expect(headers).toHaveLength(3);
    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => b.length)).toEqual([4096, 4096, 1808]);

    for (const header of headers) {
      const decoded = decodeAdbHeader(header);
      expect(decoded.command).toBe(AdbCommand.WRTE);
      expect(decoded.length).toBeLessThanOrEqual(4096);
    }
  });

  it('sends a header and its payload as two separate writes', async () => {
    // The split is the whole point: adbd reads them as separate transfers.
    const { link, written, deliver } = makeLink();
    const host = new AdbHost(link);

    await host.open('shell:');
    expect(written).toHaveLength(2);
    expect((written[0] as Uint8Array).length).toBe(ADB_HEADER_SIZE);
    expect(new TextDecoder().decode(written[1] as Uint8Array)).toBe('shell:\0');

    // A message with no payload is a single write.
    written.length = 0;
    deliver(encodeAdbMessage({ command: AdbCommand.OKAY, arg0: 9, arg1: 1 }));
    await host.closeStream(1);
    expect(written).toHaveLength(1);
    expect((written[0] as Uint8Array).length).toBe(ADB_HEADER_SIZE);
  });

  it('reports when the device demands authentication', async () => {
    const { link, deliver } = makeLink();
    const host = new AdbHost(link);

    const authRequired = vi.fn();
    host.on('authRequired', authRequired);

    deliver(encodeAdbMessage({ command: AdbCommand.AUTH, arg0: 1 }));
    expect(authRequired).toHaveBeenCalledOnce();
  });

  it('emits streamClose when the device closes the stream', async () => {
    const { link, deliver } = makeLink();
    const host = new AdbHost(link);

    deliver(
      encodeAdbMessage({
        command: AdbCommand.OPEN,
        arg0: 3,
        payload: new TextEncoder().encode('x:\0'),
      }),
    );
    await vi.waitFor(() => expect(host.activeStreams()).toHaveLength(1));
    const local = host.activeStreams()[0]?.localId as number;

    const closed = vi.fn();
    host.on('streamClose', closed);
    deliver(encodeAdbMessage({ command: AdbCommand.CLSE, arg0: 3, arg1: local }));

    expect(closed).toHaveBeenCalledOnce();
    expect(host.activeStreams()).toHaveLength(0);
  });

  it('refuses to write on a stream that is not open', async () => {
    const { link } = makeLink();
    const host = new AdbHost(link);
    await expect(host.write(999, new Uint8Array([1]))).rejects.toThrow(/not open/);
  });
});
