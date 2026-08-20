/**
 * Minimal serialport read test, used to isolate whether the library or the
 * serialport binding is at fault when no bytes arrive.
 *
 *   node tools/spp-raw-test.mjs COM5
 */

import { SerialPort } from 'serialport';

const path = process.argv[2] ?? 'COM5';

const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });

port.on('data', (chunk) => {
  console.log('  data:', [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' '));
});
port.on('error', (error) => console.log('  error:', error.message));
port.on('open', () => console.log('  event: open'));
port.on('close', () => console.log('  event: close'));

console.log(`opening ${path} ...`);
await new Promise((resolve, reject) => {
  port.open((error) => (error ? reject(error) : resolve()));
});
console.log('  isOpen:', port.isOpen, 'flowing:', port.readableFlowing);

// Virtual COM ports often stay silent until the host asserts DTR and RTS.
await new Promise((resolve) => port.set({ dtr: true, rts: true }, () => resolve()));
console.log('  asserted DTR and RTS');

// Make sure the stream is flowing even if the data listener alone did not.
port.resume();

await new Promise((r) => setTimeout(r, 3000));
console.log('  after 3s idle wait');

// SESSION_START is known to draw a reply from this printer.
const sessionStart = Buffer.from([0x02, 0x01, 0x25, 0x00, 0x00, 0x00, 0x00, 0x00]);
await new Promise((resolve, reject) => {
  port.write(sessionStart, (error) => (error ? reject(error) : resolve()));
});
console.log('  -> SESSION_START sent');

await new Promise((r) => setTimeout(r, 8000));
console.log('  bytesRead so far:', port.bytesRead ?? 'n/a');

await new Promise((resolve) => port.close(() => resolve()));
console.log('done');
process.exit(0);
