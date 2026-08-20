import { describe, expect, it } from 'vitest';
import {
  MEDIA_PROFILES,
  findMediaProfile,
  isJpeg,
  prepareImage,
  readJpegSize,
} from '../src/image/raster.js';
import type { MediaProfile } from '../src/image/raster.js';

const C300R = MEDIA_PROFILES['C300R'] as MediaProfile;

/** Builds a small solid-colour PNG to feed the pipeline. */
async function testImage(width: number, height: number): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe('media profiles', () => {
  it('has the Mini Shot 3 Retro at its documented geometry', () => {
    // Taken from the app's own model table, not inferred from the paper size.
    expect(C300R.widthPx).toBe(896);
    expect(C300R.heightPx).toBe(896);
    expect(C300R.paperSize).toBe('3 x 3');
  });

  it('exposes no default, so callers must name a model', () => {
    // Guessing the geometry wastes a sheet, so there is deliberately no default.
    const exported = Object.keys(
      MEDIA_PROFILES as unknown as Record<string, unknown>,
    );
    expect(exported).not.toContain('DEFAULT_MEDIA_PROFILE');
  });

  it('carries every model the official app knows about', () => {
    // 23 entries in the app's model table.
    expect(Object.keys(MEDIA_PROFILES)).toHaveLength(23);
    for (const profile of Object.values(MEDIA_PROFILES)) {
      expect(profile.geometrySource).toBe('app-model-table');
      expect(profile.widthPx).toBeGreaterThan(0);
      expect(profile.heightPx).toBeGreaterThan(0);
    }
  });

  it('marks only the model that has actually printed as tested', () => {
    const tested = Object.values(MEDIA_PROFILES).filter((p) => p.hardwareTested);
    expect(tested.map((p) => p.id)).toEqual(['C300R']);
  });

  it('groups models onto the four paper classes', () => {
    const classes = new Set(Object.values(MEDIA_PROFILES).map((p) => p.paperClass));
    expect([...classes].sort()).toEqual(['inch2', 'inch3', 'inch4', 'inch6']);
  });

  it('keeps the stored aspect consistent with the pixel geometry', () => {
    for (const profile of Object.values(MEDIA_PROFILES)) {
      const actual = profile.heightPx / profile.widthPx;
      expect(actual).toBeCloseTo(profile.aspect, 1);
    }
  });

  it('looks a model up case insensitively', () => {
    expect(findMediaProfile('c300r')?.id).toBe('C300R');
    expect(findMediaProfile('si-p300')?.id).toBe('SI_P300');
    expect(findMediaProfile('nope')).toBeUndefined();
  });
});

describe('isJpeg', () => {
  it('detects the start-of-image marker', () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isJpeg(new Uint8Array([0xff]))).toBe(false);
  });
});

describe('prepareImage', () => {
  it('produces a JPEG at the profile geometry', async () => {
    const source = await testImage(1200, 800);
    const prepared = await prepareImage(source, { profile: C300R });

    expect(isJpeg(prepared.data)).toBe(true);
    expect(prepared.width).toBe(896);
    expect(prepared.height).toBe(896);
    expect(readJpegSize(prepared.data)).toEqual({ width: 896, height: 896 });
  });

  it('refuses to guess a size when no profile is given', async () => {
    const source = await testImage(64, 64);
    await expect(prepareImage(source)).rejects.toThrow(/needs a target size/);
  });

  it('honours explicit width and height overrides', async () => {
    const source = await testImage(400, 400);
    const prepared = await prepareImage(source, { width: 320, height: 480 });

    expect(prepared.width).toBe(320);
    expect(readJpegSize(prepared.data)).toEqual({ width: 320, height: 480 });
  });

  it('applies a caller supplied colour transform', async () => {
    const source = await testImage(64, 64);

    let sawPixels = 0;
    const prepared = await prepareImage(source, {
      width: 64,
      height: 64,
      colorTransform: (rgb, width, height) => {
        sawPixels = width * height;
        // Zero the green channel so the effect is observable.
        for (let i = 1; i < rgb.length; i += 3) {
          rgb[i] = 0;
        }
      },
    });

    expect(sawPixels).toBe(64 * 64);
    expect(isJpeg(prepared.data)).toBe(true);
  });

  it('rejects an invalid geometry', async () => {
    const source = await testImage(64, 64);
    await expect(prepareImage(source, { width: 0, height: 10 })).rejects.toThrow(
      /Invalid target geometry/,
    );
  });
});

describe('readJpegSize', () => {
  it('returns null for input that is not a JPEG', () => {
    expect(readJpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('reads the frame header of a real JPEG', async () => {
    const source = await testImage(200, 100);
    const prepared = await prepareImage(source, { width: 200, height: 100 });
    expect(readJpegSize(prepared.data)).toEqual({ width: 200, height: 100 });
  });
});
