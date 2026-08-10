import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Marks the document when running inside the desktop shell. The app then
// fills the window edge to edge instead of floating in the middle of a page
// with a margin around it — in a native window that gap is just wasted space,
// and the window itself already supplies the rounded corners and border.
if ((window as unknown as { desktop?: unknown }).desktop) {
  document.documentElement.dataset.desktop = "true";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
