import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { Printer } from '../../printer.js';
import { UsbTransport } from '../../transport/usb.js';
import { SerialTransport } from '../../transport/serial.js';
import {
  MEDIA_PROFILES,
  findMediaProfile,
  prepareImage,
  isJpeg,
  readJpegSize,
} from '../../image/raster.js';
import type { MediaProfile } from '../../image/raster.js';
import type { PrintProgress } from '../../protocol/session.js';
import type { PrinterStatus } from '../../protocol/status.js';
import { KodakError } from '../../errors.js';

interface PrintOptionsInput {
  transport: string;
  serial?: string;
  device?: string;
  name?: string;
  port?: string;
  copies: string;
  profile: string;
  width?: string;
  height?: string;
  fit: string;
  quality: string;
  raw: boolean;
  dryRun?: string;
  timeout: string;
}

function resolveProfile(id: string): MediaProfile {
  const profile = findMediaProfile(id);
  if (profile === undefined) {
    throw new KodakError(
      `Unknown printer model "${id}". Known models: ${Object.keys(MEDIA_PROFILES).join(', ')}`,
    );
  }
  return profile;
}

function progressBar(progress: PrintProgress): string {
  const width = 30;
  const filled = Math.round((progress.percent / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${progress.percent
    .toString()
    .padStart(3)}%  ${progress.bytesSent}/${progress.totalBytes} bytes`;
}

export function registerPrintCommand(program: Command): void {
  program
    .command('print <image>')
    .description('print a photo')
    .option('-t, --transport <kind>', 'spp or usb', 'spp')
    .option('--port <path>', 'SPP serial port, for example COM5 or /dev/rfcomm0')
    .option('-s, --serial <serial>', 'USB serial number to target')
    .option('-n, --name <substring>', 'device name to match')
    .option('-c, --copies <count>', 'number of copies, 1 to 5', '1')
    .requiredOption(
      '-p, --profile <model>',
      'printer model; run "kodak models" to list them. Geometry differs per model, ' +
        'so an incorrect value wastes a sheet',
    )
    .option('--width <px>', 'override the raster width')
    .option('--height <px>', 'override the raster height')
    .option('--fit <mode>', 'cover, contain or fill', 'cover')
    .option('-q, --quality <n>', 'JPEG quality, 1 to 100', '95')
    .option('--raw', 'send the file as-is without preparing it', false)
    .option('--dry-run <path>', 'write the prepared raster to a file instead of printing')
    .option('--timeout <ms>', 'job timeout in milliseconds', '180000')
    .action(async (imagePath: string, options: PrintOptionsInput) => {
      const verbose = program.opts<{ verbose: boolean }>().verbose;
      const profile = resolveProfile(options.profile);

      // Prepare the raster.
      let raster: Uint8Array;
      if (options.raw) {
        raster = new Uint8Array(await readFile(imagePath));
        if (!isJpeg(raster)) {
          process.stderr.write(
            'Warning: --raw was given but the file is not a JPEG. The printer may reject it.\n',
          );
        }
      } else {
        const prepared = await prepareImage(imagePath, {
          profile,
          width: options.width === undefined ? undefined : Number.parseInt(options.width, 10),
          height: options.height === undefined ? undefined : Number.parseInt(options.height, 10),
          fit: options.fit as 'cover' | 'contain' | 'fill',
          quality: Number.parseInt(options.quality, 10),
        });
        raster = prepared.data;
        if (verbose) {
          process.stdout.write(
            `Prepared ${prepared.width}x${prepared.height}, ${raster.length} bytes\n`,
          );
        }
      }

      if (verbose) {
        process.stdout.write(
          `Model ${profile.id} (${profile.label}), ${profile.paperSize} inch, ` +
            `${profile.widthPx}x${profile.heightPx}\n`,
        );
      }

      // Dry run stops here.
      if (options.dryRun !== undefined) {
        await writeFile(options.dryRun, raster);
        const size = readJpegSize(raster);
        process.stdout.write(
          `Wrote ${raster.length} bytes to ${options.dryRun}` +
            (size !== null ? ` (${size.width}x${size.height})` : '') +
            '\n',
        );
        return;
      }

      // Connect and print.
      let transport;
      switch (options.transport) {
        case 'usb':
          transport = new UsbTransport({ serial: options.serial });
          break;
        case 'spp':
        case 'serial':
          transport = new SerialTransport({ path: options.port, name: options.name });
          break;
        default:
          throw new KodakError(`Unknown transport "${options.transport}". Use spp or usb.`);
      }

      const printer = new Printer(transport);

      process.stdout.write(`Connecting over ${options.transport.toUpperCase()}...\n`);
      await printer.connect();
      process.stdout.write(`Connected: ${printer.description}\n`);

      let lastLine = '';
      const onProgress = (progress: PrintProgress): void => {
        const line = progressBar(progress);
        if (line !== lastLine) {
          lastLine = line;
          process.stdout.write(`\r${line}`);
        }
      };

      const onStatus = (status: PrinterStatus): void => {
        if (verbose) {
          process.stdout.write(
            `\n[status] ${status.kind} code=${status.code} detail=${status.detail}` +
              (status.message !== undefined ? ` ${status.message}` : '') +
              '\n',
          );
        }
      };

      try {
        await printer.printRaw(raster, {
          copies: Number.parseInt(options.copies, 10),
          timeoutMs: Number.parseInt(options.timeout, 10),
          onProgress,
          onStatus,
        });
        process.stdout.write('\nDone.\n');
      } finally {
        await printer.disconnect();
      }
    });
}
