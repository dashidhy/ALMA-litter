import type { WorkingEvent } from '../contract';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Same UTF-8 head/tail projection as TAH AppPresentationTracker.snapshot.
 * Keep this outside Working: the original component consumes a preview, while
 * WorkingLogPanel consumes the full public event details.
 */
export function workingPreview(event: WorkingEvent): WorkingEvent {
  if (event.titleCode === 'safety_guardian') return event;
  const bytes = encoder.encode(event.detail);
  if (bytes.length <= 256) return event;
  const half = Math.floor((256 - encoder.encode(' … ').length) / 2);
  let head = half, tail = bytes.length - half;
  while ((bytes[head]! & 0xc0) === 0x80) head--;
  while ((bytes[tail]! & 0xc0) === 0x80) tail++;
  return { ...event, detail: decoder.decode(bytes.subarray(0, head)) + ' … ' + decoder.decode(bytes.subarray(tail)), detailTruncated: true };
}
