import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../../settingsStore";
import { CREDENTIALS } from "../../test/settingsFixtures";
import { SignedIn } from "../../test/SignedIn";
import { SettingsButton } from "./SettingsButton";

function OpenFromElsewhere() {
  const { openSettings } = useSettings();
  return <button onClick={openSettings}>open elsewhere</button>;
}

afterEach(() => vi.unstubAllGlobals());

describe("SettingsButton", () => {
  it("opens the Settings modal from the gear button and closes it", async () => {
    const user = userEvent.setup();
    render(
      <SignedIn credentials={CREDENTIALS}>
        <SettingsButton className="x" />
      </SignedIn>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the modal when another component asks the store to open it", async () => {
    const user = userEvent.setup();
    render(
      <SignedIn credentials={CREDENTIALS}>
        <SettingsButton className="x" />
        <OpenFromElsewhere />
      </SignedIn>,
    );
    await user.click(screen.getByRole("button", { name: "open elsewhere" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
});
