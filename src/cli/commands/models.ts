import type { Command } from 'commander';
import { MEDIA_PROFILES } from '../../image/raster.js';

/**
 * Lists the printer models the library knows the geometry for.
 *
 * `print` requires a model because raster geometry differs between them and
 * guessing wrong wastes a sheet.
 */
export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('list known printer models and their raster geometry')
    .option('--tested-only', 'show only models exercised against real hardware', false)
    .action((options: { testedOnly: boolean }) => {
      const rows = Object.values(MEDIA_PROFILES).filter(
        (profile) => !options.testedOnly || profile.hardwareTested,
      );

      const width = Math.max(...rows.map((r) => r.id.length));
      process.stdout.write(
        `${'MODEL'.padEnd(width)}  ${'RASTER'.padEnd(11)}  ${'PAPER'.padEnd(9)}  NAME\n`,
      );

      for (const profile of rows.sort((a, b) =>
        a.paperClass === b.paperClass
          ? a.id.localeCompare(b.id)
          : a.paperClass.localeCompare(b.paperClass),
      )) {
        const raster = `${profile.widthPx}x${profile.heightPx}`;
        const mark = profile.hardwareTested ? ' *' : '';
        process.stdout.write(
          `${profile.id.padEnd(width)}  ${raster.padEnd(11)}  ` +
            `${profile.paperSize.padEnd(9)}  ${profile.label}${mark}\n`,
        );
      }

      process.stdout.write(
        '\nGeometry comes from the official app\'s model table.\n' +
          '  * exercised against real hardware; the rest are untested.\n',
      );
    });
}
