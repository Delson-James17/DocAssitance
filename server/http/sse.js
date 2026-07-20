/**
 * Wraps an Express response as a Server-Sent Events channel.
 *
 * @param {import("express").Response} res
 */
export function initSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  return {
    /**
     * @param {string} event
     * @param {unknown} data
     */
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    },
  };
}
