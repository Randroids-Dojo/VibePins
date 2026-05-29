// The mechanical material palette (GDD 04-look-and-feel#palette-lighting,
// REQ-041). MATERIALS is the single source of truth for every scene-surface
// look (the visual sibling of LANE's single-source geometry). jsdom cannot
// drive WebGL to verify the rendered look, so the meaningful headless coverage
// is the palette's invariants: every surface is a warm tone, the GDD-named
// surfaces are all present, the machine accents (brass glint, amber lamp) are
// realised, and the lane is glossy enough to catch a warm highlight.

import { describe, it, expect } from 'vitest';
import { MATERIALS, type SurfaceMaterial } from '../src/config.js';

// Split a hex int colour into 0..255 channels.
function rgb(hex: number): { r: number; g: number; b: number } {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

const entries = Object.entries(MATERIALS) as [string, SurfaceMaterial][];

describe('mechanical material palette (REQ-041)', () => {
  it('exposes every GDD-named scene surface', () => {
    const keys = Object.keys(MATERIALS);
    // Material-led warm-metal palette: oiled wood, brushed/blackened steel,
    // aged brass, cast iron, plus the machine accent (amber indicator lamp).
    for (const expected of [
      'oiledWoodLane',
      'approachWood',
      'inlayWood',
      'foulLine',
      'brushedSteel',
      'blackenedSteel',
      'castIron',
      'agedBrass',
      'amberLamp',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('keeps every surface warm: red channel at least the blue channel', () => {
    for (const [name, mat] of entries) {
      const { r, b } = rgb(mat.color);
      expect(r, `${name} color must be warm (red >= blue)`).toBeGreaterThanOrEqual(b);
    }
  });

  it('keeps emissive accents warm too', () => {
    for (const [name, mat] of entries) {
      if (mat.emissive === undefined) continue;
      const { r, b } = rgb(mat.emissive);
      expect(r, `${name} emissive must be warm (red >= blue)`).toBeGreaterThanOrEqual(b);
    }
  });

  it('uses valid roughness and metalness in 0..1 for every surface', () => {
    for (const [name, mat] of entries) {
      expect(mat.roughness, `${name} roughness`).toBeGreaterThanOrEqual(0);
      expect(mat.roughness, `${name} roughness`).toBeLessThanOrEqual(1);
      expect(mat.metalness, `${name} metalness`).toBeGreaterThanOrEqual(0);
      expect(mat.metalness, `${name} metalness`).toBeLessThanOrEqual(1);
    }
  });

  it('renders the lane bed glossy so it catches a warm highlight', () => {
    // GDD: "glossy lane reflecting warm highlights." Low roughness = sharper,
    // brighter specular pool from the work-light.
    expect(MATERIALS.oiledWoodLane.roughness).toBeLessThan(0.4);
  });

  it('makes the aged brass read as a polished metal glint', () => {
    // GDD "the glint of polished brass": high metalness, low roughness.
    expect(MATERIALS.agedBrass.metalness).toBeGreaterThan(0.7);
    expect(MATERIALS.agedBrass.roughness).toBeLessThan(0.4);
  });

  it('lights the amber indicator lamp with an emissive glow', () => {
    // GDD "amber indicator lamps": the accent light glows in the dark room.
    expect(MATERIALS.amberLamp.emissive).toBeDefined();
    expect(MATERIALS.amberLamp.emissiveIntensity ?? 0).toBeGreaterThan(0);
  });

  it('favours warm metals over cool plastics: the steels are metallic', () => {
    // GDD "warm metals over cool plastics": steel surfaces carry real metalness.
    expect(MATERIALS.brushedSteel.metalness).toBeGreaterThan(0.4);
    expect(MATERIALS.blackenedSteel.metalness).toBeGreaterThan(0.4);
  });
});
