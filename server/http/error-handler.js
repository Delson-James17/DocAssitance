/**
 * Express error-handling middleware (4 args — Express recognizes it by
 * arity), so an unexpected error always gets a JSON response instead of
 * leaving the connection hanging.
 */
export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return;
  console.error(err);

  // A body-parser rejection is the one failure a user can actually act on,
  // and "Something went wrong." told them nothing — an oversized import looked
  // identical to a server crash.
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error:
        "That import is too large to send in one request. Split the file into " +
        "smaller batches and import them one at a time.",
    });
  }

  res.status(500).json({ error: "Something went wrong." });
}
