/**
 * Traces the SPP link through the library's own SerialTransport.
 *
 * Echoes heartbeats and sends SESSION_START, then logs every decoded frame.
 * It never sends PRINT_START, so it cannot start a job.
 *
 *   node tools/spp-trace.mjs COM5
 */

import { SerialTransport } from '../dist/transport/serial.js';
import { FrameDecoder, encodeFrame } from '../dist/protocol/frame.js';

const path = process.argv[2] ?? 'COM5';

console.log('--- module shape check ---');
const mod = await import('serialport');
console.log('  named keys:', Object.keys(mod).slice(0, 8));
console.log('  has SerialPort:', typeof mod.SerialPort);
console.log('  has default:', typeof mod.default);
if (mod.default) {
  console.log('  default.SerialPort:', typeof mod.default.SerialPort);
}

const transport = new SerialTransport({ path });
const decoder = new FrameDecoder();

transport.on('data', (chunk) => {
  console.log(
    '  raw <-',
    [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  );
  for (const frame of decoder.push(chunk)) {
    console.log(
      `  frame <- opcode=0x${frame.opcode.toString(16).padStart(2, '0')} ` +
        `arg1=${frame.arg1} arg2=${frame.arg2} arg3=${frame.arg3} len=${frame.payload.length}`,
    );
    if (frame.opcode === 0x64) {
      void transport.write(encodeFrame({ opcode: 0x64, arg1: 1 }));
      console.log('  -> HEARTBEAT echo');
    } else if (frame.arg1 === 5) {
      void transport.write(encodeFrame({ opcode: 0x07, arg1: frame.arg3 }));
      console.log(`  -> ACK ${frame.arg3}`);
    } else if (frame.arg1 === 1) {
      console.log('     (READY: a job could start here)');
    }
  }
});

transport.on('error', (error) => console.log('  error:', error.message));
transport.on('close', () => console.log('  closed'));

console.log(`\n--- opening ${path} ---`);
await transport.open();
console.log('  open:', transport.isOpen, '|', transport.description);

await new Promise((r) => setTimeout(r, 1200));
await transport.write(encodeFrame({ opcode: 0x02, arg1: 1, arg2: 37 }));
console.log('  -> SESSION_START');

await new Promise((r) => setTimeout(r, 10000));
await transport.close();
console.log('done. No print commands were sent.');
process.exit(0);
