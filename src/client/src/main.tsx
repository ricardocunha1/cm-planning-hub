import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import "./index.css";
import { appliedTheme, applyTheme, resolveTheme } from "./lib/themePreference";
import { ForecastProvider } from "./monteCarloStore";

// index.html applies the theme before the first paint; this only covers a page served without that script.
if (!appliedTheme()) {
  applyTheme(resolveTheme());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ForecastProvider>
          <App />
        </ForecastProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
