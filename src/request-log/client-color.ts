// Stable per-client colors so the same IP always looks the same in logs and /stats.
// Each entry: [ANSI 256-color code for terminals, CSS hue for the stats page].
const PALETTE: [number, number][] = [
  [39, 205], // blue
  [208, 30], // orange
  [171, 290], // purple
  [45, 185], // cyan
  [205, 330], // pink
  [148, 75], // lime
  [99, 255], // indigo
  [215, 20], // salmon
  [79, 160], // teal
  [220, 50], // gold
  [141, 270], // lavender
  [36, 170], // sea green
];

function pick(client: string): [number, number] {
  // FNV-1a: cheap, well-spread hash.
  let hash = 0x811c9dc5;
  for (let i = 0; i < client.length; i++) {
    hash = Math.imul(hash ^ client.charCodeAt(i), 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length];
}

/** Wraps text in the client's terminal color, then switches to `resumeAnsi`. */
export function ansiClient(client: string, resumeAnsi: string): string {
  // Same opt-out Nest's logger honours.
  if (process.env.NO_COLOR) return client;
  return `\x1b[1;38;5;${pick(client)[0]}m${client}\x1b[22m${resumeAnsi}`;
}

/** CSS background for the client's badge on the stats page. */
export function cssClient(client: string): string {
  return `hsl(${pick(client)[1]} 75% 82%)`;
}
