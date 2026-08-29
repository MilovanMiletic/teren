import { Pipe, PipeTransform } from '@angular/core';

/** `95_000` → `1:35`. Minutes are never zero-padded; seconds always are. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = `${totalSeconds % 60}`.padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * A recording length. Not localised on purpose: `m:ss` is a number, not prose, and reads the same
 * in every language — but it is still rendered with `tabular-nums` so it does not jitter while
 * the timer runs.
 */
@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(milliseconds: number | null | undefined): string {
    return formatDuration(milliseconds ?? 0);
  }
}
