import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// styles.css is already linked directly from index.html, so it isn't
// re-imported here to avoid double-bundling the same stylesheet.

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.tsx: #root element not found in side panel document");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
