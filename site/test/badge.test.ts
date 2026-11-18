import { describe, expect, it } from 'vitest';
import { STATUSES } from '@pqc-deps/core';
import { BADGE_COLORS, badgeMarkdown, badgeSvg, badgeText, textWidth } from '../src/lib/badge';

const lum = (h: string) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};

describe('badges', () => {
  it('render a well-formed SVG for every status, with an accessible name', () => {
    for (const s of STATUSES) {
      const svg = badgeSvg(s, 'Demo <TLS> & co');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).toContain(`aria-label="PQC: ${badgeText(s)}"`);
      expect(svg).toContain(BADGE_COLORS[s]);
      expect(svg).toContain('Demo &lt;TLS&gt; &amp; co'); // escaped in <title>
      expect(svg).not.toMatch(/<script|on\w+=/i);
    }
  });

  it('size the value box to its text', () => {
    const w = (svg: string) => Number(/width="(\d+)" height="20"/.exec(svg)![1]);
    expect(w(badgeSvg('available', 'x'))).toBeGreaterThan(w(badgeSvg('ready', 'x')));
    expect(textWidth('ready')).toBeGreaterThan(25);
  });

  it('keep white text readable on every status colour (WCAG AA)', () => {
    for (const c of Object.values(BADGE_COLORS))
      expect(1.05 / (lum(c) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('give a Markdown snippet that links the badge to the library page', () => {
    expect(badgeMarkdown('https://pqcdeps.com', 'openssl')).toBe(
      '[![PQC status](https://pqcdeps.com/badge/openssl.svg)](https://pqcdeps.com/libraries/openssl)',
    );
  });
});
