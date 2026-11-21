import { useState } from "react";
import { SettingsIcon } from "../icons/SettingsIcon";
import { SettingsModal } from "./SettingsModal";

/** Gear button for the sidebar footer; owns the open state of the {@link SettingsModal}. */
export function SettingsButton({ className }: { className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Settings" title="Settings" aria-haspopup="dialog" className={className}>
        <SettingsIcon className="h-5 w-5" />
      </button>
      <SettingsModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
