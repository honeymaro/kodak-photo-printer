import type { Command } from 'commander';
import { UsbTransport } from '../../transport/usb.js';
import { commandName } from '../../transport/adb/message.js';
import { KodakError } from '../../errors.js';

/**
 * Diagnostic command for the one part of the USB path that is still open:
 * which stream the printer opens, and what it sends first.
 *
 * It performs the ADB handshake, then reports every stream and every byte the
 * device volunteers, without sending any print commands.
 */
export function registerProbeCommand(program: Command): void {
  program
    .command('probe')
    .description('connect over USB and report what the printer opens and sends')
    .option('-s, --serial <serial>', 'USB serial number to target')
    .option('--service <name>', 'also request this ADB service, for example "shell:"')
    .option('-t, --timeout <ms>', 'how long to listen', '15000')
    .option('--reset', 'issue a USB reset before claiming the interface', false)
    .action(
      async (options: {
        serial?: string;
        service?: string;
        timeout: string;
        reset: boolean;
      }) => {
      const timeoutMs = Number.parseInt(options.timeout, 10);

      const transport = new UsbTransport({
        serial: options.serial,
        service: options.service,
        streamTimeoutMs: timeoutMs,
        resetBeforeClaim: options.reset,
      });

      transport.on('data', (chunk) => {
        const preview = [...chunk.subarray(0, 32)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        process.stdout.write(
          `[data] ${chunk.length} bytes  ${preview}${chunk.length > 32 ? ' ...' : ''}\n`,
        );
      });

      transport.on('error', (error) => {
        process.stderr.write(`[error] ${error.message}\n`);
      });

      transport.on('close', () => {
        process.stdout.write('[close] transport closed\n');
      });

      process.stdout.write('Opening USB transport and running the ADB handshake...\n');

      try {
        await transport.open();
      } catch (error) {
        if (error instanceof KodakError) {
          process.stderr.write(`\n${error.message}\n`);
          process.stderr.write(
            '\nIf the adb server is holding the device, stop it first: adb kill-server\n',
          );
          process.exitCode = 1;
          return;
        }
        throw error;
      }

      const stream = transport.adbStream;
      process.stdout.write(`Banner: ${transport.deviceBanner || '(none)'}\n`);
      if (stream !== null) {
        process.stdout.write(
          `Stream established: local=${stream.localId} remote=${stream.remoteId} ` +
            `destination=${JSON.stringify(stream.destination)}\n`,
        );
      }

      process.stdout.write(`Listening for ${timeoutMs}ms...\n`);
      await new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, timeoutMs);
        if (typeof handle.unref === 'function') {
          handle.unref();
        }
      });

      await transport.close();
      process.stdout.write(`\nCommand word reference: ${['CNXN', 'OPEN', 'OKAY', 'WRTE', 'CLSE'].join(' ')}\n`);
      process.stdout.write(`(example decode of 0x4e584e43 -> ${commandName(0x4e584e43)})\n`);

      // A bulk transfer can still be in flight inside the native layer, which
      // would keep the process alive and hold the interface against the next
      // run. Everything is closed by now, so exiting here is safe.
      process.exit(process.exitCode ?? 0);
      },
    );
}
