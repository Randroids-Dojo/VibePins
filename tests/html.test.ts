// Unit tests for the shared HTML rendering-boundary helper (src/html.ts), the
// single escape used by the leaderboard and match-standings row renderers.

import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<img src="x" onerror=\'y\'>&')).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;',
    );
  });

  it('leaves a plain name untouched', () => {
    expect(escapeHtml('Ann Bo-7')).toBe('Ann Bo-7');
  });

  it('coerces a non-string to its string form before escaping', () => {
    expect(escapeHtml(42 as unknown as string)).toBe('42');
  });
});
