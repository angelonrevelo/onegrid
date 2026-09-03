import { describe, expect, it } from 'vitest';
import {
  NATIVE_FRAME_VERSION,
  decodeFrame,
  encodeFrame,
  hitTest,
  type NativeFrame,
} from '../index';

function frame(extra: Partial<NativeFrame> = {}): NativeFrame {
  return {
    version: NATIVE_FRAME_VERSION,
    viewport: {
      scrollTop: 0,
      scrollLeft: 0,
      width: 800,
      height: 400,
      rowStart: 0,
      rowEnd: 10,
      colStart: 0,
      colEnd: 4,
    },
    theme: {
      background: '#0b0d10',
      text: '#e7e9ec',
      headerBackground: '#1b1f26',
      border: '#1c2027',
      selection: '#1d4ed8',
    },
    cell: [
      {
        row: 0,
        col: 0,
        x: 0,
        y: 0,
        width: 100,
        height: 32,
        text: 'id',
        fill: '#1b1f26',
        color: '#e7e9ec',
      },
      {
        row: 1,
        col: 0,
        x: 0,
        y: 32,
        width: 100,
        height: 32,
        text: '42',
        fill: '#0b0d10',
        color: '#e7e9ec',
      },
    ],
    ...extra,
  };
}

describe('encodeFrame / decodeFrame', () => {
  it('round-trips a frame', () => {
    const original = frame();
    expect(decodeFrame(encodeFrame(original))).toEqual(original);
  });

  it('rejects a future version', () => {
    expect(() => decodeFrame(JSON.stringify({ version: 99 }))).toThrow(/OG_NATIVE_VERSION/);
  });

  it('emits a stable key order the rust crate can match', () => {
    const text = encodeFrame(frame());
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"viewport"'));
    expect(text.indexOf('"viewport"')).toBeLessThan(text.indexOf('"theme"'));
    expect(text.indexOf('"theme"')).toBeLessThan(text.indexOf('"cell"'));
  });
});

describe('hitTest', () => {
  it('returns the cell containing the point', () => {
    const hit = hitTest(frame(), 10, 40);
    expect(hit?.text).toBe('42');
  });

  it('returns null outside every quad', () => {
    expect(hitTest(frame(), 900, 900)).toBeNull();
  });
});
