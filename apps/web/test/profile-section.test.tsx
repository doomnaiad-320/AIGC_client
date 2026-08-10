// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileSection } from "@/components/profile-section";

describe("ProfileSection", () => {
  afterEach(() => {
    cleanup();
  });

  it("saves a changed username", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <ProfileSection
        displayName="Loomic User"
        email="user@example.com"
        onPasswordChange={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "New Username" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("New Username");
  });

  it("requires matching new passwords before making a password request", async () => {
    const onPasswordChange = vi.fn();

    render(
      <ProfileSection
        displayName="Loomic User"
        email="user@example.com"
        onPasswordChange={onPasswordChange}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords do not match.",
    );
    expect(onPasswordChange).not.toHaveBeenCalled();
  });

  it("submits verified password fields", async () => {
    const onPasswordChange = vi.fn().mockResolvedValue(undefined);

    render(
      <ProfileSection
        displayName="Loomic User"
        email="user@example.com"
        onPasswordChange={onPasswordChange}
        onSave={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "current-password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(onPasswordChange).toHaveBeenCalledWith({
      currentPassword: "current-password",
      newPassword: "new-password",
    });
  });
});
