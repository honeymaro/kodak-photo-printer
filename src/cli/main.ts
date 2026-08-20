#!/usr/bin/env node
/**
 * kodak command line interface.
 *
 * Subcommands are kept thin: they parse arguments, call the library, and
 * format output. Anything protocol related belongs in src/protocol.
 */

import { Command } from 'commander';
import { registerDevicesCommand } from './commands/devices.js';
import { registerModelsCommand } from './commands/models.js';
import { registerPrintCommand } from './commands/print.js';
import { registerProbeCommand } from './commands/probe.js';
import { registerInspectCommand } from './commands/inspect.js';
import { KodakError, MissingDependencyError } from '../errors.js';

const program = new Command();

program
  .name('kodak')
  .description(
    'Print photos on Prinics-built instant printers: Kodak Mini Shot and Dock, ' +
      'PICKIT SNAPS, SI',
  )
  .version('0.1.0')
  .option('-v, --verbose', 'print protocol level diagnostics', false);

registerDevicesCommand(program);
registerModelsCommand(program);
registerPrintCommand(program);
registerProbeCommand(program);
registerInspectCommand(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof MissingDependencyError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 3;
    return;
  }
  if (error instanceof KodakError) {
    process.stderr.write(`\n${error.name}: ${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`\nUnexpected failure: ${String(error)}\n\n`);
  process.exitCode = 1;
});
