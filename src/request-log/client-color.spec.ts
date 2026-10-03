import { ansiClient, cssClient } from './client-color.js';

describe('client colors', () => {
  it('gives the same client the same color and different clients varied colors', () => {
    expect(cssClient('83.0.0.1')).toBe(cssClient('83.0.0.1'));
    const colors = new Set(
      Array.from({ length: 50 }, (_, i) => cssClient(`10.0.0.${i}`)),
    );
    expect(colors.size).toBeGreaterThan(5);
  });

  it('colors the client and resumes the given color, unless NO_COLOR', () => {
    expect(ansiClient('1.2.3.4', '\x1b[32m')).toMatch(
      /^\x1b\[1;38;5;\d+m1\.2\.3\.4\x1b\[22m\x1b\[32m$/,
    );
    process.env.NO_COLOR = '1';
    expect(ansiClient('1.2.3.4', '\x1b[32m')).toBe('1.2.3.4');
    delete process.env.NO_COLOR;
  });
});
