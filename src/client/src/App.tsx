import { Navigate, Route, Routes } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";
import { ConfirmPage } from "./pages/monteCarlo/ConfirmPage";
import { DataSourcePage } from "./pages/monteCarlo/DataSourcePage";
import { HubHomePage } from "./pages/HubHomePage";
import { InputPage } from "./pages/monteCarlo/InputPage";
import { ReleasePlanBoardPage } from "./pages/ReleasePlanBoardPage";
import { ReleasePlanHomePage } from "./pages/ReleasePlanHomePage";
import { ResultsPage } from "./pages/monteCarlo/ResultsPage";
import { ReleasePlanProvider } from "./releasePlanStore";

/**
 * Route table: hub home at `/`, the Monte Carlo flow under `/monte-carlo` (data source choice at `/monte-carlo`,
 * parameters form at `/monte-carlo/input`, then `/confirm` and `/results`), Release Plan under `/release-plan`
 * (`/release-plan/:id` and, for now, `/release-plan/board` for the board), anything else redirects home. Mounts the `ReleasePlanProvider`
 * (localStorage autosave) around the routes.
 */
export function App() {
  return (
    <ReleasePlanProvider>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<HubHomePage />} />
        <Route path="/monte-carlo" element={<DataSourcePage />} />
        <Route path="/monte-carlo/input" element={<InputPage />} />
        <Route path="/monte-carlo/confirm" element={<ConfirmPage />} />
        <Route path="/monte-carlo/results" element={<ResultsPage />} />
        <Route path="/release-plan" element={<ReleasePlanHomePage />} />
        <Route path="/release-plan/board" element={<ReleasePlanBoardPage />} />
        <Route path="/release-plan/:id" element={<ReleasePlanBoardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ReleasePlanProvider>
  );
}
