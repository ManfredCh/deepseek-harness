/** Resolve the neighboring authored-message row or the live tail.
 * @param tops - rendered user/steering row tops in view order.
 * @param line - viewport reading line.
 * @param atBottom - whether the view currently follows the live tail.
 * @param direction - previous or next authored message.
 * @returns row index; -1 precedes the loaded window and length means live tail.
 */
export function neighboringMessage(tops: readonly number[], line: number, atBottom: boolean, direction: -1 | 1): number {
  let current = atBottom ? tops.length : -1
  if (!atBottom) for (let index = 0; index < tops.length; index++) { if (tops[index]! <= line + 1) current = index; else break }
  return Math.min(tops.length, current + direction)
}
