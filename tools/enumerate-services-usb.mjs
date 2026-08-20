/**
 * Enumerates which ADB services the printer accepts, over libusb.
 *
 * Uses this package's own AdbHost, so it doubles as a hardware check of the
 * transport implementation. It does not go through the adb server, which on
 * Windows sometimes fails to re-detect the device after a libusb session.
 *
 * Every stream is opened and immediately closed. No print protocol bytes are
 * ever sent, so this cannot start a print.
 *
 *   adb kill-server && node tools/enumerate-services-usb.mjs
 */

import { usb } from 'usb';
import { AdbHost } from '../dist/transport/adb/host.js';

const VENDOR_ID = 0x2207;
const PRODUCT_ID = 0x0006;
const ADB = { class: 0xff, subclass: 0x42, protocol: 0x01 };
const HEADER = 24;

const OPEN_TIMEOUT_MS = 1200;

/**
 * State-changing services are deliberately excluded: tcpip:, usb:, root:,
 * unroot:, remount: and reboot: all reconfigure the device.
 */
const CANDIDATES = [
  // Standard adb services, for a baseline.
  'shell:',
  'sync:',
  'framebuffer:',
  'jdwp',
  'track-jdwp',
  // Names a print channel might use.
  'print:',
  'printer:',
  'printing:',
  'prinics:',
  'ppvp:',
  'kodak:',
  'photo:',
  'photoprinter:',
  'image:',
  'job:',
  'spool:',
  'accessory:',
  'aoa:',
  'usbprint:',
  'service:',
  // Abstract sockets an on-device app might listen on.
  'localabstract:printer',
  'localabstract:print',
  'localabstract:prinics',
  'localabstract:ppvp',
  'localabstract:kodak',
  'localabstract:photoprinter',
  'localabstract:spooler',
  // Loopback ports on the device.
  'tcp:56065',
  'tcp:12231',
  'tcp:9100',
  'tcp:8080',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Restrict the sweep to services named on the command line, when given. */
const ONLY = process.argv.slice(2);
const SERVICES = ONLY.length > 0 ? ONLY : CANDIDATES;

async function openDevice() {
  const devices = await usb.getDevices();
  const device = devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
  if (!device) return null;

  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  const iface = device.configuration.interfaces.find((i) => {
    const a = i.alternate;
    return (
      a.interfaceClass === ADB.class &&
      a.interfaceSubclass === ADB.subclass &&
      a.interfaceProtocol === ADB.protocol
    );
  });
  if (!iface) {
    await device.close();
    return null;
  }

  const eps = iface.alternate.endpoints;
  const epIn = eps.find((e) => e.direction === 'in' && e.type === 'bulk').endpointNumber;
  const epOut = eps.find((e) => e.direction === 'out' && e.type === 'bulk').endpointNumber;

  await device.claimInterface(iface.interfaceNumber);
  for (const [dir, ep] of [
    ['in', epIn],
    ['out', epOut],
  ]) {
    try {
      await device.clearHalt(dir, ep);
    } catch {
      /* fine */
    }
  }

  return { device, interfaceNumber: iface.interfaceNumber, epIn, epOut };
}

const isIdle = (e) => /cancell?ed|timeout/i.test(e.message ?? String(e));
const isGone = (e) => /disconnect|no such device|NoDevice/i.test(e.message ?? String(e));

/** Reads exactly n bytes, or null when the endpoint is idle. */
async function readExactly(device, ep, n, running) {
  const out = new Uint8Array(n);
  let filled = 0;
  while (filled < n && running()) {
    let result;
    try {
      result = await device.transferIn(ep, n - filled);
    } catch (error) {
      if (isIdle(error)) {
        if (filled === 0) return null;
        continue;
      }
      throw error;
    }
    const data = result?.data;
    if (!data || data.byteLength === 0) {
      if (filled === 0) return null;
      continue;
    }
    out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), filled);
    filled += data.byteLength;
  }
  return filled === n ? out : null;
}

async function main() {
  const handle = await openDevice();
  if (!handle) {
    console.log('Printer not found on USB. Is it powered on?');
    return;
  }
  const { device, interfaceNumber, epIn, epOut } = handle;

  let running = true;
  let deliver = null;

  const link = {
    write: async (data) => {
      await device.transferOut(epOut, data);
    },
    onData: (fn) => {
      deliver = fn;
    },
    close: async () => {
      running = false;
    },
  };

  const host = new AdbHost(link);

  const events = [];
  host.on('stream', (s) => events.push({ type: 'stream', ...s }));
  host.on('streamClose', (s) => events.push({ type: 'close', ...s }));
  host.on('error', (e) => events.push({ type: 'error', message: e.message }));
  host.on('data', (stream, payload) => {
    const text = new TextDecoder().decode(payload).replace(/[^\x20-\x7e\n]/g, '.');
    console.log(
      `      data on ${stream.destination} (${payload.length} bytes): ${JSON.stringify(
        text.slice(0, 200),
      )}`,
    );
  });

  const connected = new Promise((resolve) => host.on('connect', resolve));

  // Send the handshake before starting the read loop. Overlapping a bulk IN
  // with the bulk OUT makes this device drop the link shortly afterwards.
  await host.connect();

  // Read loop, canonical ADB framing.
  (async () => {
    while (running) {
      try {
        const head = await readExactly(device, epIn, HEADER, () => running);
        if (head === null) {
          // Back off while idle; hammering the endpoint destabilises the link.
          await sleep(20);
          continue;
        }
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const length = view.getUint32(12, true);
        if (length === 0) {
          deliver?.(head);
          continue;
        }
        const body = await readExactly(device, epIn, length, () => running);
        const merged = new Uint8Array(HEADER + (body?.length ?? 0));
        merged.set(head, 0);
        if (body) merged.set(body, HEADER);
        deliver?.(merged);
      } catch (error) {
        if (!running) return;
        if (isGone(error)) {
          console.log('  device disconnected');
          running = false;
          return;
        }
        // Ignore transient errors and keep reading.
      }
    }
  })();

  const banner = await Promise.race([connected, sleep(5000).then(() => null)]);
  if (banner === null) {
    console.log('Handshake did not complete.');
    running = false;
    await device.close();
    return;
  }
  console.log(`connected: ${banner}`);
  console.log(`negotiated max payload: ${host.negotiatedMaxPayload}`);
  console.log(`probing ${SERVICES.length} service name(s)\n`);

  // Let the link settle before driving it.
  await sleep(1500);

  const accepted = [];
  for (const service of SERVICES) {
    events.length = 0;
    let localId;
    try {
      localId = await host.open(service);
    } catch (error) {
      console.log(`  ${service.padEnd(30)} write failed: ${error.message}`);
      break;
    }

    await sleep(OPEN_TIMEOUT_MS);

    const opened = events.find((e) => e.type === 'stream' && e.localId === localId);
    const closed = events.find((e) => e.type === 'close' && e.localId === localId);

    if (opened) {
      accepted.push(service);
      console.log(`  ACCEPTED  ${service}`);
      await host.closeStream(localId).catch(() => {});
    } else if (closed) {
      // Refused, which is the normal answer for an unknown service.
    } else {
      console.log(`  ${service.padEnd(30)} no reply`);
    }

    if (!running) {
      console.log('  link dropped, stopping');
      break;
    }
  }

  console.log('\n== accepted services ==');
  if (accepted.length === 0) {
    console.log('  none');
  } else {
    for (const service of accepted) console.log(`  ${service}`);
  }

  running = false;
  try {
    await device.releaseInterface(interfaceNumber);
  } catch {
    /* ignore */
  }
  try {
    await device.close();
  } catch {
    /* ignore */
  }
  console.log('\nNo print commands were sent.');
}

main().catch((error) => {
  console.error('unexpected:', error);
  process.exitCode = 1;
});
