/**
 * Step by step USB/ADB handshake diagnostic.
 *
 * Each stage is logged separately so a failure can be attributed precisely.
 * This only performs the ADB link handshake. It never sends print commands,
 * so it cannot start a print.
 *
 * Reads follow the ADB convention: a 24 byte header first, then exactly the
 * payload length the header declares. adbd writes those as separate bulk
 * transfers, so asking for an oversized buffer is not equivalent.
 *
 * Run with the adb server stopped so libusb can claim the interface:
 *   adb kill-server && node tools/usb-handshake-probe.mjs
 *
 * Options (environment variables):
 *   SESSIONS=2      how many connect attempts to make
 *   SEND_CNXN=1     send CNXN in the first session (0 to only listen)
 *   READS=6         reads per session
 */

import { usb } from 'usb';

const VENDOR_ID = 0x2207;
const PRODUCT_ID = 0x0006;
const ADB = { class: 0xff, subclass: 0x42, protocol: 0x01 };

const SESSIONS = Number(process.env['SESSIONS'] ?? 2);
const SEND_CNXN = process.env['SEND_CNXN'] !== '0';
const READS = Number(process.env['READS'] ?? 6);

const CMD = {
  CNXN: 0x4e584e43,
  AUTH: 0x48545541,
  OPEN: 0x4e45504f,
  OKAY: 0x59414b4f,
  WRTE: 0x45545257,
  CLSE: 0x45534c43,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function name(command) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, command >>> 0, true);
  return [...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
}

function encode(command, arg0, arg1, payload = new Uint8Array(0)) {
  const out = new Uint8Array(24 + payload.length);
  const view = new DataView(out.buffer);
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  view.setUint32(0, command >>> 0, true);
  view.setUint32(4, arg0 >>> 0, true);
  view.setUint32(8, arg1 >>> 0, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, sum, true);
  view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
  out.set(payload, 24);
  return out;
}

async function findDevice() {
  const devices = await usb.getDevices();
  return devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID) ?? null;
}

function findInterface(device) {
  const iface = device.configuration?.interfaces.find((i) => {
    const a = i.alternate;
    return (
      a.interfaceClass === ADB.class &&
      a.interfaceSubclass === ADB.subclass &&
      a.interfaceProtocol === ADB.protocol
    );
  });
  if (!iface) return null;
  const endpoints = iface.alternate.endpoints;
  return {
    interfaceNumber: iface.interfaceNumber,
    epIn: endpoints.find((e) => e.direction === 'in' && e.type === 'bulk').endpointNumber,
    epOut: endpoints.find((e) => e.direction === 'out' && e.type === 'bulk').endpointNumber,
  };
}

/** Reads one ADB message: 24 byte header, then the declared payload. */
async function readMessage(device, epIn) {
  const head = await device.transferIn(epIn, 24);
  if (!head.data || head.data.byteLength < 24) {
    return { short: true, status: head.status, length: head.data?.byteLength ?? 0 };
  }
  const view = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
  const message = {
    command: view.getUint32(0, true),
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    length: view.getUint32(12, true),
    magic: view.getUint32(20, true),
    payload: new Uint8Array(0),
  };
  if (message.length > 0 && message.length < 1024 * 1024) {
    const body = await device.transferIn(epIn, message.length);
    if (body.data) {
      message.payload = new Uint8Array(body.data.buffer, body.data.byteOffset, body.data.byteLength);
    }
  }
  return message;
}

async function runSession(index) {
  console.log(`\n================ session ${index} ================`);

  const device = await findDevice();
  if (!device) {
    console.log('  printer not visible on USB');
    return 'gone';
  }
  console.log(`  found ${device.productName} serial=${device.serialNumber}`);

  try {
    await device.open();
  } catch (error) {
    console.log(`  open failed: ${error.message}`);
    return 'error';
  }

  try {
    if (!device.configuration) {
      await device.selectConfiguration(1);
    }
    const info = findInterface(device);
    if (!info) {
      console.log('  no ADB interface present');
      return 'error';
    }
    console.log(`  interface ${info.interfaceNumber}, in=ep${info.epIn} out=ep${info.epOut}`);

    await device.claimInterface(info.interfaceNumber);
    console.log('  claimed');

    for (const [dir, ep] of [
      ['in', info.epIn],
      ['out', info.epOut],
    ]) {
      try {
        await device.clearHalt(dir, ep);
      } catch {
        /* healthy endpoints may refuse this */
      }
    }

    // Give adbd a moment to settle after the claim.
    await sleep(300);

    if (SEND_CNXN && index === 1) {
      const banner = new TextEncoder().encode('host::\0');
      const cnxn = encode(CMD.CNXN, 0x01000000, 256 * 1024, banner);
      const result = await device.transferOut(info.epOut, cnxn);
      console.log(`  sent CNXN: ${result.bytesWritten} bytes, status=${result.status}`);
    } else {
      console.log('  listening only, no CNXN sent');
    }

    for (let i = 0; i < READS; i += 1) {
      try {
        const message = await readMessage(device, info.epIn);
        if (message.short) {
          console.log(`  read ${i + 1}: short, status=${message.status} len=${message.length}`);
          continue;
        }
        const magicOk = ((message.command ^ 0xffffffff) >>> 0) === message.magic;
        console.log(
          `  read ${i + 1}: ${name(message.command)} arg0=${message.arg0} arg1=${message.arg1} ` +
            `len=${message.length} magic=${magicOk ? 'ok' : 'BAD'}`,
        );
        if (message.payload.length > 0) {
          const text = new TextDecoder().decode(message.payload).replace(/\0/g, '');
          console.log(`      payload: ${JSON.stringify(text.slice(0, 220))}`);
        }
        if (message.command === CMD.AUTH) {
          console.log('      -> device demands RSA authentication');
        }
        if (message.command === CMD.OPEN) {
          console.log('      -> DEVICE OPENED A STREAM (this is the print channel)');
        }
      } catch (error) {
        console.log(`  read ${i + 1}: FAILED ${error.message}`);
        if (/Disconnected|NoDevice/i.test(error.message)) {
          return 'disconnected';
        }
        try {
          await device.clearHalt('in', info.epIn);
        } catch {
          return 'stalled';
        }
      }
    }

    await device.releaseInterface(info.interfaceNumber);
    return 'ok';
  } catch (error) {
    console.log(`  session error: ${error.message}`);
    return 'error';
  } finally {
    try {
      await device.close();
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  for (let index = 1; index <= SESSIONS; index += 1) {
    const outcome = await runSession(index);
    console.log(`  outcome: ${outcome}`);
    if (index < SESSIONS) {
      console.log('  waiting 3s for the device to settle...');
      await sleep(3000);
    }
  }
  console.log('\ndone. No print commands were sent.');
}

main().catch((error) => {
  console.error('unexpected:', error);
  process.exitCode = 1;
});
