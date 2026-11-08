/** One JSON line per event on stderr (stdout is reserved for the stdio transport). */
export function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}
