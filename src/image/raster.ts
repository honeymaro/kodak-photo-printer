/**
 * Image preparation.
 *
 * The official app hands the printer the output of a native routine:
 * `Java_com_prinics_ip_Prepare_prepare(inPath, outPath, width, height,
 * flag, mode)` in `libprinics_ip.so`. Its exported symbols include
 * `rgb_to_ycc`, `ycc_to_rgb` and `stbi_write_jpg`, so the routine performs a
 * colour transform and then writes a JPEG.
 *
 * What is verified: the payload is JPEG, and the native library applies a
 * colour transform before encoding.
 *
 * What is not verified: the exact transform coefficients and the exact raster
 * geometry the firmware expects. Until a byte comparison against the native
 * library is done, `prepareImage` produces a correctly sized baseline JPEG
 * and leaves the colour transform as an injectable step. See PROTOCOL.md.
 */

import { KodakError } from '../errors.js';
import { importOptional } from '../optional.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sharp = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let sharpModule: Sharp | null = null;

async function loadSharp(): Promise<Sharp> {
  if (sharpModule !== null) {
    return sharpModule;
  }
  sharpModule = await importOptional<Sharp>('sharp', 'image preparation');
  return sharpModule;
}

/** Paper size class a printer belongs to. Mirrors the app's `K2.a` enum. */
export type PaperClass = 'inch2' | 'inch3' | 'inch4' | 'inch6';

/** Physical media a printer model accepts. */
export interface MediaProfile {
  /** Model code, as the app names it. Also the profile key. */
  readonly id: string;
  /** Marketing name, verbatim from the app's model table. */
  readonly label: string;
  /** Printed size, verbatim from the app's model table, in inches. */
  readonly paperSize: string;
  /** Paper size class. */
  readonly paperClass: PaperClass;
  /** Raster width in pixels. */
  readonly widthPx: number;
  /** Raster height in pixels. */
  readonly heightPx: number;
  /** Height divided by width, as the app stores it. */
  readonly aspect: number;
  /**
   * Where the geometry came from. Every entry here is transcribed from the
   * official app's model table rather than inferred from the paper size.
   */
  readonly geometrySource: 'app-model-table';
  /**
   * True only for models this package has actually printed on.
   *
   * Deliberately separate from `geometrySource`: knowing the right raster size
   * is not the same as having confirmed the printer accepts it.
   */
  readonly hardwareTested: boolean;
}

function profile(
  id: string,
  label: string,
  widthPx: number,
  heightPx: number,
  aspect: number,
  paperSize: string,
  paperClass: PaperClass,
  hardwareTested = false,
): MediaProfile {
  return {
    id,
    label,
    widthPx,
    heightPx,
    aspect,
    paperSize,
    paperClass,
    geometrySource: 'app-model-table',
    hardwareTested,
  };
}

/**
 * Media profiles for every printer the official app knows about.
 *
 * Transcribed from the model table in the app (`K2.b`), which stores, per
 * model: marketing name, raster width, raster height, aspect ratio, printed
 * size and paper class. These are the geometries the app renders to before
 * sending, so they are authoritative rather than inferred.
 *
 * Knowing the geometry is not the same as having tested the printer. Only
 * `C300R` has `hardwareTested` set. The protocol contains no model-specific
 * branching beyond timeouts, so the others are expected to work, but that is
 * an expectation and not a result.
 */
export const MEDIA_PROFILES: Readonly<Record<string, MediaProfile>> = Object.freeze({
  // 3 x 3 inch square
  C300R: profile('C300R', 'Kodak Mini Shot 3 Retro', 896, 896, 1.0, '3 x 3', 'inch3', true),
  MS300: profile('MS300', 'Kodak Mini Shot 3 Era', 896, 896, 1.0, '3 x 3', 'inch3'),
  M300: profile('M300', 'Kodak Mini 3 Era', 896, 896, 1.0, '3 x 3', 'inch3'),
  P300R: profile('P300R', 'Kodak Mini 3 Retro', 896, 896, 1.0, '3 x 3', 'inch3'),
  P330: profile('P330', 'Pickit Snaps P3', 896, 896, 1.0, '3 x 3', 'inch3'),
  C330: profile('C330', 'Pickit Snaps C3', 896, 896, 1.0, '3 x 3', 'inch3'),
  SI_C300: profile('SI_C300', 'SI 3 inch printer', 896, 896, 1.0, '3 x 3', 'inch3'),
  SI_P300: profile('SI_P300', 'SI Portable Photo Printer', 896, 896, 1.0, '3 x 3', 'inch3'),

  // 2.1 x 3.4 inch
  C210R: profile('C210R', 'Kodak Mini Shot 2 Retro', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  MS200: profile('MS200', 'Kodak Mini Shot 2 Era', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  M200: profile('M200', 'Kodak Mini 2 Era', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  P210R: profile('P210R', 'Kodak Mini 2 Retro', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  P230: profile('P230', 'Pickit Snaps P2', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  C230: profile('C230', 'Pickit Snaps C2', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  SI_C210: profile('SI_C210', 'SI 2 inch printer', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),
  SI_P210: profile('SI_P210', 'SI 2 inch printer', 640, 1024, 1.6, '2.1 x 3.4', 'inch2'),

  // 4 x 4 inch square
  MS400: profile('MS400', 'Kodak Mini Shot 4 Era', 1280, 1280, 1.0, '4 x 4', 'inch4'),
  C440: profile('C440', 'Pickit Snaps C4', 1280, 1280, 1.0, '4 x 4', 'inch4'),

  // 4 x 6 inch
  PD460: profile('PD460', 'Kodak Dock Plus Retro', 1240, 1864, 1.5, '4 x 6', 'inch6'),
  D600: profile('D600', 'Kodak Dock Era', 1240, 1864, 1.5, '4 x 6', 'inch6'),
  P640: profile('P640', 'Pickit Snaps P6', 1240, 1864, 1.5, '4 x 6', 'inch6'),
  SI_PD460: profile('SI_PD460', 'SI Smartphone Photo Printer', 1240, 1864, 1.5, '4 x 6', 'inch6'),
  SI_P450W: profile('SI_P450W', 'SI 4x6 printer', 1240, 1864, 1.5, '4 x 6', 'inch6'),
});

/**
 * Looks up a profile by model code, case insensitively.
 *
 * There is deliberately no default. Raster geometry differs between models and
 * a wrong guess wastes a sheet, so callers must name the model.
 */
export function findMediaProfile(id: string): MediaProfile | undefined {
  const key = id.toUpperCase().replace(/-/g, '_');
  return MEDIA_PROFILES[key];
}

/** How to fit a source image into the media rectangle. */
export type FitMode = 'cover' | 'contain' | 'fill';

export interface PrepareOptions {
  /**
   * Target geometry. Required unless both `width` and `height` are given,
   * because it differs per model and a wrong size wastes a sheet.
   */
  readonly profile?: MediaProfile;
  /** Explicit width override, wins over the profile. */
  readonly width?: number;
  /** Explicit height override, wins over the profile. */
  readonly height?: number;
  /** Scaling behaviour. Defaults to `cover`, which crops rather than letterboxes. */
  readonly fit?: FitMode;
  /** JPEG quality, 1 to 100. */
  readonly quality?: number;
  /** Background used when `fit` is `contain`. */
  readonly background?: { r: number; g: number; b: number };
  /**
   * Optional colour transform applied to raw RGB before encoding.
   *
   * Supply this once the transform in `libprinics_ip.so` has been replicated.
   * The buffer is interleaved RGB, three bytes per pixel, mutated in place.
   */
  readonly colorTransform?: (rgb: Uint8Array, width: number, height: number) => void;
}

export interface PreparedImage {
  /** JPEG bytes ready to hand to a print session. */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Converts an arbitrary image into the raster the printer expects.
 *
 * Accepts a file path or an encoded image buffer.
 */
export async function prepareImage(
  input: string | Uint8Array,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  const sharp = await loadSharp();

  const width = options.width ?? options.profile?.widthPx;
  const height = options.height ?? options.profile?.heightPx;
  // The app encodes at compression 100; matching it costs nothing here.
  const quality = options.quality ?? 100;
  const fit = options.fit ?? 'cover';

  if (width === undefined || height === undefined) {
    throw new KodakError(
      'prepareImage needs a target size: pass a media profile, or both width and height. ' +
        'Geometry differs per printer model.',
    );
  }
  if (width <= 0 || height <= 0) {
    throw new KodakError(`Invalid target geometry ${width}x${height}`);
  }

  const source = typeof input === 'string' ? sharp(input) : sharp(Buffer.from(input));

  const resized = source.resize({
    width,
    height,
    fit,
    background: options.background ?? { r: 255, g: 255, b: 255 },
  });

  if (options.colorTransform === undefined) {
    const data: Buffer = await resized
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer();
    return { data: new Uint8Array(data), width, height };
  }

  // Apply the caller's transform on raw RGB, then re-encode.
  const raw = await resized.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(raw.data as Buffer);
  options.colorTransform(pixels, raw.info.width as number, raw.info.height as number);

  const encoded: Buffer = await sharp(Buffer.from(pixels), {
    raw: {
      width: raw.info.width as number,
      height: raw.info.height as number,
      channels: 3,
    },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return { data: new Uint8Array(encoded), width, height };
}

/** True when `data` starts with the JPEG start-of-image marker. */
export function isJpeg(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
}

/**
 * Reads the pixel geometry out of a JPEG without decoding it.
 *
 * Used to sanity check a pre-rendered raster passed straight to `printRaw`.
 */
export function readJpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(data)) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] as number;
    // Start-of-frame markers, excluding the non-frame ones at C4, C8 and CC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((data[offset + 5] as number) << 8) | (data[offset + 6] as number);
      const width = ((data[offset + 7] as number) << 8) | (data[offset + 8] as number);
      return { width, height };
    }
    const segmentLength = ((data[offset + 2] as number) << 8) | (data[offset + 3] as number);
    if (segmentLength <= 0) {
      return null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}
