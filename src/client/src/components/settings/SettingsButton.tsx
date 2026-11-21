import { useSettings } from "../../settingsStore";
import { SettingsIcon } from "../icons/SettingsIcon";
import { SettingsModal } from "./SettingsModal";

/** Gear button for the sidebar footer; renders the {@link SettingsModal}, whose open state lives in the settings store so other modals can open it too. */
export function SettingsButton({ className }: { className: string }) {
  const { settingsOpen, openSettings, closeSettings } = useSettings();
  return (
    <>
      <button type="button" onClick={openSettings} aria-label="Settings" title="Settings" aria-haspopup="dialog" className={className}>
        <SettingsIcon className="h-5 w-5" />
      </button>
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </>
  );
}
