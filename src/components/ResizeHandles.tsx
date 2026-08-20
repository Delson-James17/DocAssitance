import { useCallback, useRef } from "react";

// Manual edge/corner resize for the desktop window's "Clear" blur mode. A
// transparent BrowserWindow loses Windows' native edge hit-testing (see
// electron/main.cjs), so dragging the border does nothing on its own —
// these invisible strips replace it, driving window:get-bounds/set-bounds
// directly. Pointer capture (not a plain mousemove listener) is what keeps
// the drag tracking correctly even once the cursor crosses outside the
// window's own client area, which happens constantly once the window
// starts shrinking under the cursor.

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResizableDesktopWindow {
  getBounds: () => Promise<Bounds | null>;
  setBounds: (bounds: Bounds) => Promise<void>;
}

interface ResizeHandlesProps {
  desktopWindow: ResizableDesktopWindow;
}

// Mirrors main.cjs's MIN_WINDOW_WIDTH/HEIGHT — clamping here too (rather
// than trusting the main process's own clamp alone) is what keeps the
// dragged edge from visually jumping once the window bottoms out at the
// floor; see the x/y math below.
const MIN_WIDTH = 380;
const MIN_HEIGHT = 420;

const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ResizeHandles({ desktopWindow }: ResizeHandlesProps) {
  const drag = useRef<{ edge: Edge; start: Bounds; startX: number; startY: number } | null>(null);

  const onPointerDown = useCallback(
    (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button only — right-click on these same edge strips is reserved
      // for App.tsx's right-click-drag-to-move, and would otherwise fire
      // both gestures from a single right-click here.
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const startX = e.screenX;
      const startY = e.screenY;
      void desktopWindow.getBounds().then((bounds) => {
        if (bounds) drag.current = { edge, start: bounds, startX, startY };
      });
    },
    [desktopWindow],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state) return;
      const { edge, start, startX, startY } = state;
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;

      let { x, y, width, height } = start;

      if (edge.includes("e")) width = Math.max(MIN_WIDTH, start.width + dx);
      if (edge.includes("s")) height = Math.max(MIN_HEIGHT, start.height + dy);
      if (edge.includes("w")) {
        // Deriving width from dx (then x from width) keeps the right edge
        // anchored and stops x from drifting once width hits its floor —
        // computing x from dx directly would keep moving it past that point.
        width = Math.max(MIN_WIDTH, start.width - dx);
        x = start.x + (start.width - width);
      }
      if (edge.includes("n")) {
        height = Math.max(MIN_HEIGHT, start.height - dy);
        y = start.y + (start.height - height);
      }

      void desktopWindow.setBounds({ x, y, width, height });
    },
    [],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`resize-handle resize-${edge}`}
          onPointerDown={onPointerDown(edge)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      ))}
    </>
  );
}
