/**
 * Tries several ADB CNXN handshake variants against the printer.
 *
 * The device stalls its bulk IN endpoint after a modern CNXN. This firmware
 * is Android 4.x era, where the ADB protocol used a 4096 byte maximum payload
 * rather than the 256 KiB modern hosts advertise, so the negotiated values
 * are the most likely cause. Each variant is tried in its own session with a
 * settle period in between.
 *
 * Only link-level handshake traffic is sent. No print commands, so this
 * cannot start a print.
 *
 *   adb kill-server && node tools/usb-cnxn-variants.mjs
 */

import { usb } from 'usb';

const VENDOR_ID = 0x2207;
const PRODUCT_ID = 0x0006;
const ADB = { class: 0xff, subclass: 0x42, protocol: 0x01 };

const CMD = {
  CNXN: 0x4e584e43,
  AUTH: 0x48545541,
  OPEN: 0x4e45504f,
  OKAY: 0x59414b4f,
  WRTE: 0x45545257,
  CLSE: 0x45534c43,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_VARIANTS = [
  {
    key: 'legacy',
    label: 'legacy: version 0x01000000, maxdata 4096, banner "host::"',
    version: 0x01000000,
    maxData: 4096,
    banner: 'host::\0',
  },
  {
    key: 'bare',
    label: 'bare: all fields zero, no banner (what the Android app sends)',
    version: 0,
    maxData: 0,
    banner: null,
  },
  {
    key: 'versioned-nobanner',
    label: 'versioned but no banner: version 0x01000000, maxdata 4096, empty payload',
    version: 0x01000000,
    maxData: 4096,
    banner: null,
  },
  {
    key: 'modern',
    label: 'modern: version 0x01000001, maxdata 256 KiB, with features',
    version: 0x01000001,
    maxData: 256 * 1024,
    banner: 'host::features=cmd,shell_v2\0',
  },
];

const selected = process.argv.slice(2);
const VARIANTS =
  selected.length > 0 ? ALL_VARIANTS.filter((v) => selected.includes(v.key)) : ALL_VARIANTS;

/** Seconds to keep reading after a successful handshake, to see if it holds. */
const HOLD_SECONDS = Number(process.env['HOLD_SECONDS'] ?? 6);

function name(command) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, command >>> 0, true);
  return [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
}

/**
 * Sends one ADB message as adbd expects to receive it: the 24 byte header in
 * its own bulk transfer, then the payload in a second one. adbd reads exactly
 * 24 bytes and then reads the declared length separately, so combining them
 * into a single transfer desynchronises it.
 */
async function sendMessage(device, epOut, command, arg0, arg1, payload = new Uint8Array(0)) {
  const header = new Uint8Array(24);
  const v = new DataView(header.buffer);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  v.setUint32(0, command >>> 0, true);
  v.setUint32(4, arg0 >>> 0, true);
  v.setUint32(8, arg1 >>> 0, true);
  v.setUint32(12, payload.length, true);
  v.setUint32(16, sum, true);
  v.setUint32(20, (command ^ 0xffffffff) >>> 0, true);

  const head = await device.transferOut(epOut, header);
  let bodyWritten = 0;
  if (payload.length > 0) {
    const body = await device.transferOut(epOut, payload);
    bodyWritten = body.bytesWritten ?? 0;
  }
  return { bytesWritten: (head.bytesWritten ?? 0) + bodyWritten, status: head.status };
}

function encode(command, arg0, arg1, payload = new Uint8Array(0)) {
  const out = new Uint8Array(24 + payload.length);
  const v = new DataView(out.buffer);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  v.setUint32(0, command >>> 0, true);
  v.setUint32(4, arg0 >>> 0, true);
  v.setUint32(8, arg1 >>> 0, true);
  v.setUint32(12, payload.length, true);
  v.setUint32(16, sum, true);
  v.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
  out.set(payload, 24);
  return out;
}

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
  const info = {
    interfaceNumber: iface.interfaceNumber,
    epIn: eps.find((e) => e.direction === 'in' && e.type === 'bulk').endpointNumber,
    epOut: eps.find((e) => e.direction === 'out' && e.type === 'bulk').endpointNumber,
  };

  await device.claimInterface(info.interfaceNumber);
  return { device, info };
}

/**
 * Keeps reading after the handshake to see whether the device holds the link.
 *
 * Returns true if it survived the hold period. A disconnect here means the
 * handshake was accepted but adbd tore the session down afterwards.
 */
async function holdLink(device, info) {
  // Optionally exercise a stream open, which is the step that reveals whether
  // the negotiated CNXN values are actually usable.
  const service = process.env['OPEN_SERVICE'];
  if (service) {
    const payload = new TextEncoder().encode(`${service}\0`);
    await sendMessage(device, info.epOut, CMD.OPEN, 1, 0, payload);
    console.log(`      sent OPEN ${JSON.stringify(service)} (local id 1)`);
  }

  const deadline = Date.now() + HOLD_SECONDS * 1000;
  while (Date.now() < deadline) {
    try {
      const head = await device.transferIn(info.epIn, 24);
      if (head.data && head.data.byteLength >= 24) {
        const v = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
        const command = v.getUint32(0, true);
        const length = v.getUint32(12, true);
        console.log(`      unsolicited: ${name(command)} len=${length}`);
        if (length > 0 && length < 65536) {
          await device.transferIn(info.epIn, length);
        }
        if (command === CMD.OPEN) {
          console.log('      *** DEVICE OPENED A STREAM ***');
        }
      }
    } catch (error) {
      if (/Disconnected|NoDevice/i.test(error.message)) {
        return false;
      }
      // Idle timeouts are expected while nothing is happening.
    }
  }
  return true;
}

async function tryVariant(variant) {
  console.log(`\n--- ${variant.label} ---`);

  let handle;
  try {
    handle = await openDevice();
  } catch (error) {
    console.log(`  could not open: ${error.message}`);
    return false;
  }
  if (!handle) {
    console.log('  printer not visible');
    return false;
  }

  const { device, info } = handle;

  try {
    for (const [dir, ep] of [
      ['in', info.epIn],
      ['out', info.epOut],
    ]) {
      try {
        await device.clearHalt(dir, ep);
      } catch {
        /* fine */
      }
    }
    await sleep(200);

    const payload =
      variant.banner === null ? new Uint8Array(0) : new TextEncoder().encode(variant.banner);
    const sent = await sendMessage(
      device,
      info.epOut,
      CMD.CNXN,
      variant.version,
      variant.maxData,
      payload,
    );
    console.log(`  sent CNXN (${sent.bytesWritten} bytes, status=${sent.status})`);

    for (let i = 0; i < 3; i += 1) {
      try {
        const head = await device.transferIn(info.epIn, 24);
        if (!head.data || head.data.byteLength === 0) {
          console.log(`  read ${i + 1}: empty (status=${head.status})`);
          continue;
        }
        const v = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
        const command = v.getUint32(0, true);
        const length = v.getUint32(12, true);
        console.log(
          `  read ${i + 1}: ${name(command)} arg0=0x${v.getUint32(4, true).toString(16)} ` +
            `arg1=${v.getUint32(8, true)} len=${length}`,
        );

        if (length > 0 && length < 65536) {
          const body = await device.transferIn(info.epIn, length);
          if (body.data) {
            const text = new TextDecoder()
              .decode(new Uint8Array(body.data.buffer, body.data.byteOffset, body.data.byteLength))
              .replace(/\0/g, '');
            console.log(`      payload: ${JSON.stringify(text.slice(0, 240))}`);
          }
        }

        if (command === CMD.CNXN) {
          console.log('      *** HANDSHAKE ACCEPTED ***');
          const held = await holdLink(device, info);
          console.log(
            held
              ? `      link stayed up for ${HOLD_SECONDS}s`
              : `      link DROPPED within ${HOLD_SECONDS}s`,
          );
          return held;
        }
        if (command === CMD.AUTH) {
          console.log('      device wants RSA auth (link is healthy, just unauthorised)');
          return true;
        }
      } catch (error) {
        console.log(`  read ${i + 1}: ${error.message}`);
        if (/Disconnected|NoDevice/i.test(error.message)) return false;
      }
    }
    return false;
  } finally {
    try {
      await device.releaseInterface(info.interfaceNumber);
    } catch {
      /* ignore */
    }
    try {
      await device.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  for (const variant of VARIANTS) {
    const ok = await tryVariant(variant);
    if (ok) {
      console.log('\nThis variant works. Use these CNXN parameters.');
      return;
    }
    console.log('  waiting 4s for the device to settle...');
    await sleep(4000);
  }
  console.log('\nNo variant completed the handshake. No print commands were sent.');
}

main().catch((e) => {
  console.error('unexpected:', e);
  process.exitCode = 1;
});
