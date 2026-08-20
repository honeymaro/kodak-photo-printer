import type { Command } from 'commander';
import { listUsbDevices } from '../../transport/usb.js';
import { listSerialDevices } from '../../transport/serial.js';
import { MissingDependencyError } from '../../errors.js';
import type { DiscoveredDevice } from '../../transport/types.js';

function render(devices: DiscoveredDevice[], verbose: boolean): string {
  if (devices.length === 0) {
    return '  none found';
  }
  return devices
    .map((device) => {
      const parts = [`  ${device.transport.toUpperCase()}  ${device.id}`];
      if (device.name !== undefined) {
        parts.push(`  ${device.name}`);
      }
      if (device.rssi !== undefined) {
        parts.push(`  rssi ${device.rssi}`);
      }
      let line = parts.join('');
      if (verbose && device.details !== undefined) {
        line += `\n      ${JSON.stringify(device.details)}`;
      }
      return line;
    })
    .join('\n');
}

export function registerDevicesCommand(program: Command): void {
  program
    .command('devices')
    .description('list reachable printers')
    .option('--serial-only', 'skip the USB enumeration', false)
    .option('--usb-only', 'skip the serial port enumeration', false)
    .action(async (options: { serialOnly: boolean; usbOnly: boolean }) => {
      const verbose = program.opts<{ verbose: boolean }>().verbose;

      if (!options.usbOnly) {
        process.stdout.write('Bluetooth SPP (the print path):\n');
        try {
          process.stdout.write(`${render(await listSerialDevices(), verbose)}\n\n`);
        } catch (error) {
          if (error instanceof MissingDependencyError) {
            process.stdout.write(`  unavailable: ${error.message}\n\n`);
          } else {
            throw error;
          }
        }
      }

      if (!options.serialOnly) {
        process.stdout.write('USB (diagnostics only, not a print path):\n');
        try {
          process.stdout.write(`${render(await listUsbDevices(), verbose)}\n`);
        } catch (error) {
          if (error instanceof MissingDependencyError) {
            process.stdout.write(`  unavailable: ${error.message}\n`);
          } else {
            throw error;
          }
        }
      }
    });
}
