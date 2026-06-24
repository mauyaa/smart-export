// Live camera helpers — used by the Capture screen for in-browser preview
// and (where supported) a torch toggle. Fall back gracefully to the
// native file-input capture flow when getUserMedia or torch is unavailable.

export interface CameraSession {
  stream: MediaStream;
  hasTorch: boolean;
  setTorch: (on: boolean) => Promise<boolean>;
  stop: () => void;
}

interface TorchConstraint {
  advanced?: Array<{ torch?: boolean }>;
}

export async function openRearCamera(): Promise<CameraSession> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not available");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
    audio: false,
  });
  const [track] = stream.getVideoTracks();
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
  const hasTorch = !!caps.torch;

  const setTorch = async (on: boolean) => {
    if (!hasTorch) return false;
    try {
      await track.applyConstraints({
        advanced: [{ torch: on }],
      } as TorchConstraint as MediaTrackConstraints);
      return true;
    } catch {
      return false;
    }
  };

  const stop = () => {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
  };

  return { stream, hasTorch, setTorch, stop };
}

// Capture the current video frame to a JPEG File.
export async function captureFrame(video: HTMLVideoElement): Promise<File> {
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 960;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");
  ctx.drawImage(video, 0, 0, w, h);
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Capture failed");
  return new File([blob], `label-${Date.now()}.jpg`, { type: "image/jpeg" });
}
