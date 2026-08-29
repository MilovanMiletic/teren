import { formatDuration } from './duration.pipe';

describe('formatDuration', () => {
  it('formats a typical site recording', () => {
    expect(formatDuration(41_000)).toBe('0:41');
  });

  it('zero-pads seconds but not minutes', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('rounds down rather than showing a second that has not passed', () => {
    expect(formatDuration(1_999)).toBe('0:01');
  });

  it('never renders a negative or missing duration', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(0)).toBe('0:00');
  });
});
