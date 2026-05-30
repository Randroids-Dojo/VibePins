// Small HTML rendering-boundary helpers shared by the overlay renderers
// (src/leaderboard.ts board rows, src/matchClient.ts standings rows). Player
// names arrive from other devices, so every place that drops one into innerHTML
// escapes it here rather than re-deriving the rule, which kept drifting between
// two copies.

// Escape the five HTML-significant characters so a player-supplied string cannot
// inject markup when dropped into innerHTML. The leaderboard/match servers already
// strip most punctuation, but this is the rendering boundary so it escapes
// regardless.
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
