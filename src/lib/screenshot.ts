export function screenshotSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

// Anthropic downsizes any image over this on its long edge before analysis
// anyway, and a full-resolution desktop PNG can easily be tens of MB — well
// past what the upload endpoint accepts. Capping + JPEG-encoding here keeps
// uploads small without losing anything Claude would actually use.
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

// Prompts the browser's screen/window/tab picker, grabs a single frame, and
// returns it as a JPEG File ready to go through the normal attachment upload.
export async function captureScreenshot(): Promise<File> {
  if (!screenshotSupported()) {
    throw new Error("Screen capture isn't supported in this browser.");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });
    await video.play();
    // Give the decoder a moment to actually produce a frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create a canvas context.");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode the screenshot."))),
        "image/jpeg",
        JPEG_QUALITY,
      );
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `screenshot-${stamp}.jpg`, { type: "image/jpeg" });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
