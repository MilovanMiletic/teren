import { negotiateAudioMimeType } from './audio-mime';

describe('negotiateAudioMimeType', () => {
  it('prefers Opus in OGG when the device offers it', () => {
    expect(negotiateAudioMimeType((type) => type.startsWith('audio/'))).toBe(
      'audio/ogg;codecs=opus',
    );
  });

  it('accepts WebM/Opus on a browser without an OGG muxer (Chrome on Android)', () => {
    const supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
    expect(negotiateAudioMimeType((type) => supported.has(type))).toBe('audio/webm;codecs=opus');
  });

  it('falls back to MP4/AAC on iOS Safari, which never produces OGG', () => {
    const supported = new Set(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']);
    expect(negotiateAudioMimeType((type) => supported.has(type))).toBe(
      'audio/mp4;codecs=mp4a.40.2',
    );
  });

  it('lets the browser choose when it claims to support nothing we asked for', () => {
    expect(negotiateAudioMimeType(() => false)).toBeNull();
  });
});
