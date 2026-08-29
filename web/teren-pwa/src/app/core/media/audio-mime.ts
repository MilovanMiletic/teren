/**
 * MediaRecorder container negotiation.
 *
 * ARCHITECTURE.md §5: target Opus in OGG, but iOS Safari does not produce it — it yields
 * MP4/AAC. So the container is negotiated with `MediaRecorder.isTypeSupported()`, the *actual*
 * MIME type is stored alongside the file, and the server normalises if the STT provider is fussy.
 * Nothing downstream may assume one container.
 */
export const PREFERRED_AUDIO_MIME_TYPES: readonly string[] = [
  // Preferred: what the architecture asks for.
  'audio/ogg;codecs=opus',
  'audio/ogg',
  // Chrome/Android: Opus, different container. Cheap for the server to remux.
  'audio/webm;codecs=opus',
  'audio/webm',
  // iOS Safari.
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
];

/**
 * The first supported container from the preference list, or `null` to let the browser choose its
 * own default (the recorder then reads the type back off the produced blob).
 */
export function negotiateAudioMimeType(
  isTypeSupported: (type: string) => boolean = defaultIsTypeSupported,
): string | null {
  for (const candidate of PREFERRED_AUDIO_MIME_TYPES) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function defaultIsTypeSupported(type: string): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(type)
  );
}
