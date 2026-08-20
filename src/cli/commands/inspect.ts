import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { FrameDecoder } from '../../protocol/frame.js';
import { decodeBleFrame } from '../../protocol/ble.js';
import { parseStatus } from '../../protocol/status.js';
import { AdbMessageDecoder, commandName } from '../../transport/adb/message.js';
import { Command as Opcode, Notification, BleOpcode } from '../../protocol/constants.js';

/** Reverse lookup so decoded frames can be labelled. */
function nameOf(table: Record<string, number>, value: number): string {
  for (const [key, candidate] of Object.entries(table)) {
    if (candidate === value) {
      return key;
    }
  }
  return `0x${value.toString(16).padStart(2, '0')}`;
}

function parseInput(text: string): Uint8Array {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Hex input must contain an even number of digits');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hex(data: Uint8Array, limit = 48): string {
  const shown = [...data.subarray(0, limit)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return data.length > limit ? `${shown} ... (${data.length} bytes)` : shown;
}

/**
 * Decodes captured bytes.
 *
 * Intended for working through BLE sniffer logs or USB captures: paste the
 * hex and see it interpreted with the same codecs the library uses.
 */
export function registerInspectCommand(program: Command): void {
  program
    .command('inspect [hex]')
    .description('decode captured protocol bytes')
    .option('-f, --file <path>', 'read hex or binary from a file instead of the argument')
    .option('--binary', 'treat the file as raw binary rather than hex text', false)
    .option(
      '-k, --kind <kind>',
      'framing to apply: stream, ble or adb',
      'stream',
    )
    .action(
      async (
        hexInput: string | undefined,
        options: { file?: string; binary: boolean; kind: string },
      ) => {
        let data: Uint8Array;
        if (options.file !== undefined) {
          const contents = await readFile(options.file);
          data = options.binary ? new Uint8Array(contents) : parseInput(contents.toString('utf8'));
        } else if (hexInput !== undefined) {
          data = parseInput(hexInput);
        } else {
          process.stderr.write('Provide hex bytes as an argument or use --file\n');
          process.exitCode = 2;
          return;
        }

        switch (options.kind) {
          case 'ble': {
            const decoded = decodeBleFrame(data);
            if (decoded.kind === 'command') {
              process.stdout.write(
                `BLE command  opcode=${nameOf(BleOpcode as unknown as Record<string, number>, decoded.opcode)}` +
                  `  totalLength=${decoded.totalLength}  argument=${decoded.argument}\n`,
              );
            } else {
              process.stdout.write(
                `BLE data     offset=${decoded.offset}  length=${decoded.payload.length}\n` +
                  `  ${hex(decoded.payload)}\n`,
              );
            }
            return;
          }

          case 'adb': {
            const decoder = new AdbMessageDecoder();
            const messages = decoder.push(data);
            if (messages.length === 0) {
              process.stdout.write(`No complete ADB message in ${data.length} bytes\n`);
            }
            for (const message of messages) {
              process.stdout.write(
                `ADB ${commandName(message.command)}  arg0=${message.arg0}  arg1=${message.arg1}` +
                  `  len=${message.payload.length}\n`,
              );
              if (message.payload.length > 0) {
                process.stdout.write(`  ${hex(message.payload)}\n`);
              }
            }
            if (decoder.pending > 0) {
              process.stdout.write(`  (${decoder.pending} trailing bytes buffered)\n`);
            }
            return;
          }

          case 'stream':
          default: {
            const decoder = new FrameDecoder();
            const frames = decoder.push(data);
            if (frames.length === 0) {
              process.stdout.write(`No complete frame in ${data.length} bytes\n`);
            }
            for (const frame of frames) {
              const asCommand = nameOf(Opcode as unknown as Record<string, number>, frame.opcode);
              const asNotification = nameOf(
                Notification as unknown as Record<string, number>,
                frame.opcode,
              );
              process.stdout.write(
                `frame opcode=0x${frame.opcode.toString(16).padStart(2, '0')} ` +
                  `(host:${asCommand} / printer:${asNotification})  ` +
                  `arg1=${frame.arg1} arg2=${frame.arg2} len=${frame.payload.length}\n`,
              );
              if (frame.payload.length > 0) {
                process.stdout.write(`  payload ${hex(frame.payload)}\n`);
              }
              const status = parseStatus(frame);
              process.stdout.write(
                `  status  kind=${status.kind}` +
                  (status.message !== undefined ? ` message="${status.message}"` : '') +
                  (status.pageIndex !== undefined ? ` page=${status.pageIndex}` : '') +
                  (status.mediaType !== undefined ? ` media=${status.mediaType}` : '') +
                  '\n',
              );
            }
            if (decoder.pending > 0) {
              process.stdout.write(`  (${decoder.pending} trailing bytes buffered)\n`);
            }
            return;
          }
        }
      },
    );
}
