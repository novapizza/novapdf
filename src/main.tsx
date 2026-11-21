import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, loadThemePref } from "./lib/theme";

// Before first render, so a saved light/dark choice does not flash the other theme.
applyTheme(loadThemePref());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
