import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "./App";
import { AuthProvider } from "./authStore";
import { ToastProvider } from "./components/Toast";
import "./index.css";
import { appliedTheme, applyTheme, resolveTheme } from "./lib/themePreference";
import { ForecastProvider } from "./monteCarloStore";
import { SettingsProvider } from "./settingsStore";

const router = createBrowserRouter(appRoutes);
// index.html applies the theme before the first paint; this only covers a page served without that script.
if (!appliedTheme()) {
  applyTheme(resolveTheme());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <SettingsProvider>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);
