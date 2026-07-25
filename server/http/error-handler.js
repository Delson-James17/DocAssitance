/**
 * Express error-handling middleware (4 args — Express recognizes it by
 * arity), so an unexpected error always gets a JSON response instead of
 * leaving the connection hanging.
 */
export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return;
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
}
