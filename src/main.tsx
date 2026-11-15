import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary, { recordError } from "./ErrorBoundary";
import "./styles.css";

window.addEventListener("error", (e) => recordError("window.onerror", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => recordError("unhandledrejection", e.reason));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
