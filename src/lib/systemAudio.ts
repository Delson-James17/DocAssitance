import { startAudioStream, type MicHandlers, type MicSession } from "./mic";

/** Opens Windows' desktop-output (loopback) track, never the microphone. */
export async function startSystemAudio(handlers: MicHandlers): Promise<MicSession> {
  if (!(window as unknown as { desktop?: unknown }).desktop) {
    throw new Error("Meeting audio transcription needs the Windows desktop app.");
  }

  // The main process authorizes this user-initiated request with Electron's
  // setDisplayMediaRequestHandler and grants audio: "loopback". No microphone
  // constraint is present here.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: { width: 1, height: 1, frameRate: 1 },
  });

  // No screen video is processed or retained. This leaves only the loopback
  // audio track, which the shared processor resamples to PCM16 mono/16 kHz.
  for (const track of stream.getVideoTracks()) track.stop();
  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      "Windows did not provide system audio. Check that the meeting is playing through an active output device.",
    );
  }

  return startAudioStream(stream, handlers);
}
