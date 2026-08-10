// Microphone capture with voice-activity detection.
//
// Whisper transcribes a finished chunk of audio, not a live stream, so
// something has to decide where one utterance ends and the next begins. A
// cloud recognizer does that server-side; here we do it locally with a simple
// energy gate: collect audio while the level is above a noise floor, and flush
// a segment once it goes quiet for long enough.
//
// This is deliberately a plain energy threshold rather than a neural VAD —
// it's a few lines, has no model to load, and the failure mode (a stray
// segment from a door slam) is harmless because Whisper transcribes it to
// nothing and we drop empty results.

/** Whisper is trained on 16kHz audio; anything else is resampled anyway. */
const SAMPLE_RATE = 16_000;

// Getting this gate right matters more than it looks. Whisper never returns
// "nothing" for an audio clip — handed silence, it invents a plausible
// sentence, usually "Thank you." or "you" (it saw a lot of subtitled video in
// training). So anything that isn't really speech must be stopped *here*,
// before it reaches the model.

/** Absolute floor — audio quieter than this is never speech. */
const ABSOLUTE_RMS_FLOOR = 0.015;

/**
 * Speech has to be this much louder than the measured room tone to count.
 * A fixed threshold can't work for both a silent room and a noisy café; this
 * adapts to whatever the background happens to be.
 */
const NOISE_MULTIPLIER = 2.5;

/** How fast the noise floor tracks the room. Slow, so speech can't raise it. */
const NOISE_ADAPT = 0.05;

/**
 * Quiet for this long closes the current chunk of audio.
 *
 * This is NOT where a message ends — that decision belongs to
 * useSpeechRecognition (see MESSAGE_GAP_MS), which glues the transcribed
 * chunks back together. Cutting early is what lets Whisper start working
 * during the speaker's natural pause instead of after their last word, so by
 * the time they finish, everything but the final chunk is already text.
 */
const SILENCE_HOLD_MS = 450;

/**
 * Audio kept from *before* the gate opened.
 *
 * Speech ramps up rather than starting at full volume, so the first consonant
 * is usually still below the threshold when it's spoken — dropping those
 * frames chops the start of the first word ("what's your name" → "s your
 * name"), and Whisper then guesses at the fragment. Holding a short rolling
 * buffer and prepending it means the model always gets the true onset.
 */
const PREROLL_MS = 300;

/**
 * A segment needs at least this much *actually voiced* audio to be sent.
 * Measured on frames above the threshold only — trailing silence doesn't
 * count toward it, which is what let a door slam through before.
 */
const MIN_VOICED_MS = 400;

/**
 * Flush anyway past this length, so a long monologue still gets answered.
 *
 * Must stay under the transcriber's audio-context window (see AUDIO_CTX in
 * electron/whisper.cjs, ~10s) — anything longer is silently not transcribed,
 * so the tail of a long question would just vanish.
 */
const MAX_UTTERANCE_MS = 9_000;

/**
 * How often to hand over a snapshot of speech that is still in progress.
 *
 * Whisper only transcribes finished audio, so without this nothing appears
 * until the speaker pauses. Re-transcribing the in-flight buffer on a timer
 * is what produces a live, updating caption — the same trick whisper.cpp's
 * own `stream` example uses.
 */
const PARTIAL_INTERVAL_MS = 1200;

/**
 * Stop previewing once the current utterance passes this length.
 *
 * Measured on a Ryzen 5 3500U: previewing 4s of audio costs ~2s, 8s costs
 * ~2.5s, and the transcriber serves one request at a time — so a long preview
 * still running when the speaker stops pushes the *real* transcription behind
 * it and delays the answer. Past this point the earlier text is already on
 * screen, so the preview has little left to add and isn't worth that risk.
 *
 * Set PARTIAL_INTERVAL_MS or this to 0 to turn live captions off entirely.
 */
const PARTIAL_MAX_MS = 6_000;

export interface MicHandlers {
  /** A complete utterance, as 16kHz mono WAV bytes ready for Whisper. */
  onUtterance: (wav: ArrayBuffer) => void;
  /**
   * A snapshot of the utterance so far, while it's still being spoken.
   * Best-effort: the caller is expected to drop these when it's busy, since
   * the finished utterance always matters more than the preview.
   */
  onPartial?: (wav: ArrayBuffer) => void;
  /** Fires when speech starts/stops, so the UI can show a live indicator. */
  onSpeakingChange?: (speaking: boolean) => void;
}

export interface MicSession {
  stop: () => void;
}

/**
 * Wraps Float32 PCM samples in a WAV container.
 *
 * whisper-server accepts a plain WAV upload, and building the 44-byte header
 * here avoids shipping an encoder or making the main process deal with raw
 * sample buffers.
 */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  // Float [-1,1] → signed 16-bit.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

// Runs on the audio thread and forwards raw frames to the main thread. Kept
// as a source string and loaded from a blob URL so it needs no separate entry
// in the Vite build.
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
`;

/**
 * Opens the microphone and calls `onUtterance` once per detected utterance.
 * Throws if mic permission is refused.
 */
export async function startMic(handlers: MicHandlers): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Asking for 16kHz up front means the browser resamples for us.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });

  // An AudioContext created outside a user gesture — this one is built after
  // awaiting getUserMedia, so the gesture may already have lapsed — can start
  // "suspended", in which case the worklet's process() is never called and
  // the mic silently captures nothing at all.
  if (context.state === "suspended") await context.resume();

  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );

  await context.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = context.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(context, "capture");

  let collecting: Float32Array[] = [];
  let collectedSamples = 0;
  let voicedSamples = 0;
  let silenceSamples = 0;
  let speaking = false;
  // Starts at the absolute floor and adapts down to a quiet room or up to a
  // noisy one as soon as we hear what the background sounds like.
  let noiseFloor = ABSOLUTE_RMS_FLOOR;

  const silenceLimit = (SILENCE_HOLD_MS / 1000) * SAMPLE_RATE;
  const minVoiced = (MIN_VOICED_MS / 1000) * SAMPLE_RATE;
  const maxSamples = (MAX_UTTERANCE_MS / 1000) * SAMPLE_RATE;
  const prerollLimit = (PREROLL_MS / 1000) * SAMPLE_RATE;
  const partialInterval = (PARTIAL_INTERVAL_MS / 1000) * SAMPLE_RATE;
  const partialMaxSamples = (PARTIAL_MAX_MS / 1000) * SAMPLE_RATE;
  /** Samples since the last live snapshot. */
  let partialAt = 0;

  // Rolling window of the most recent quiet frames, prepended to an utterance
  // when the gate opens so the onset of the first word isn't clipped.
  let preroll: Float32Array[] = [];
  let prerollSamples = 0;

  const setSpeaking = (next: boolean) => {
    if (next === speaking) return;
    speaking = next;
    handlers.onSpeakingChange?.(next);
  };

  // Merges the frames collected so far into one contiguous buffer.
  const merge = (frames: Float32Array[], total: number) => {
    const merged = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    return merged;
  };

  const flush = () => {
    const total = collectedSamples;
    const voiced = voicedSamples;
    const frames = collecting;
    collecting = [];
    collectedSamples = 0;
    voicedSamples = 0;
    silenceSamples = 0;
    setSpeaking(false);

    // Not enough real speech in there — a cough, a keystroke, a passing car.
    // Sending it anyway is how "Thank you." ends up in the transcript.
    if (voiced < minVoiced) return;

    handlers.onUtterance(encodeWav(merge(frames, total)));
  };

  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const frame = event.data;

    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
    const rms = Math.sqrt(sumSquares / frame.length);

    const threshold = Math.max(ABSOLUTE_RMS_FLOOR, noiseFloor * NOISE_MULTIPLIER);
    const loud = rms > threshold;

    if (loud) {
      // Opening the gate: carry the pre-roll in so the word's onset survives.
      if (collectedSamples === 0 && preroll.length > 0) {
        for (const earlier of preroll) {
          collecting.push(earlier);
          collectedSamples += earlier.length;
        }
        preroll = [];
        prerollSamples = 0;
      }
      setSpeaking(true);
      silenceSamples = 0;
      voicedSamples += frame.length;
    } else {
      // Learn the room from quiet frames only, so someone talking steadily
      // can't drag the floor up and mute themselves.
      noiseFloor += (rms - noiseFloor) * NOISE_ADAPT;

      if (collectedSamples === 0) {
        // Idle: keep only the last PREROLL_MS of quiet audio, discard the rest.
        preroll.push(frame);
        prerollSamples += frame.length;
        while (prerollSamples > prerollLimit && preroll.length > 1) {
          prerollSamples -= preroll[0].length;
          preroll.shift();
        }
        return;
      }
      silenceSamples += frame.length;
    }

    collecting.push(frame);
    collectedSamples += frame.length;

    if (silenceSamples >= silenceLimit || collectedSamples >= maxSamples) {
      flush();
      partialAt = 0;
      return;
    }

    // Mid-utterance snapshot for the live caption. The sample count is the
    // clock here — it advances with the audio itself, so this can't drift
    // from what's actually been captured.
    if (
      handlers.onPartial &&
      partialInterval > 0 &&
      voicedSamples >= minVoiced &&
      collectedSamples <= partialMaxSamples
    ) {
      partialAt += frame.length;
      if (partialAt >= partialInterval) {
        partialAt = 0;
        handlers.onPartial(encodeWav(merge(collecting, collectedSamples)));
      }
    }
  };

  // The OS can suspend the audio graph on its own — a sleep/wake cycle, an
  // audio device change, or the browser reclaiming resources. Nothing
  // surfaces when that happens; the mic just stops producing frames. Bring it
  // back rather than leaving the user staring at a "listening" button that
  // isn't.
  let stopped = false;
  context.onstatechange = () => {
    if (!stopped && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
  };

  source.connect(capture);
  // An AudioWorkletNode only pulls audio while it's connected to the graph.
  // Routing it through a muted gain keeps it running without echoing the
  // microphone back out of the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;
  capture.connect(mute).connect(context.destination);

  return {
    stop() {
      stopped = true;
      context.onstatechange = null;
      capture.port.onmessage = null;
      // Anything still buffered is a real utterance the user just finished.
      flush();
      capture.disconnect();
      source.disconnect();
      mute.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}
