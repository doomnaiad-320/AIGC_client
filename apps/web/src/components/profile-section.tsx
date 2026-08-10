"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ProfileSectionProps {
  displayName: string;
  email: string;
  onSave: (displayName: string) => Promise<void>;
  onPasswordChange: (data: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
}

export function ProfileSection({
  displayName: initialName,
  email,
  onSave,
  onPasswordChange,
}: ProfileSectionProps) {
  const [displayName, setDisplayName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const hasChanges = displayName.trim() !== initialName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) return;

    setSaving(true);
    setFeedback(null);

    try {
      await onSave(trimmed);
      setFeedback({ type: "success", message: "Profile updated." });
    } catch {
      setFeedback({
        type: "error",
        message: "Failed to update profile. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordFeedback(null);

    if (newPassword.length < 8) {
      setPasswordFeedback({
        type: "error",
        message: "New password must contain at least 8 characters.",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({ type: "error", message: "Passwords do not match." });
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordFeedback({
        type: "error",
        message: "Choose a password different from your current one.",
      });
      return;
    }

    setPasswordSaving(true);
    try {
      await onPasswordChange({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordFeedback({ type: "success", message: "Password updated." });
    } catch (error) {
      setPasswordFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unable to update password.",
      });
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Account</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Manage your username and sign-in credentials.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="displayName">Username</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your username"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={email} disabled className="opacity-60" />
          <p className="text-xs text-muted-foreground">Email is your login ID and cannot be changed here.</p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>

      <section className="mt-8 max-w-md border-t border-border pt-7">
        <h3 className="text-sm font-semibold">Password</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm your current password before choosing a new one.
        </p>

        <form onSubmit={handlePasswordSubmit} className="mt-5 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              autoComplete="current-password"
              id="currentPassword"
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              value={currentPassword}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              autoComplete="new-password"
              id="newPassword"
              minLength={8}
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              value={newPassword}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              autoComplete="new-password"
              id="confirmPassword"
              minLength={8}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              value={confirmPassword}
            />
          </div>

          {passwordFeedback && (
            <p
              aria-live="polite"
              className={`text-sm ${passwordFeedback.type === "success" ? "text-success" : "text-destructive"}`}
              role={passwordFeedback.type === "error" ? "alert" : undefined}
            >
              {passwordFeedback.message}
            </p>
          )}

          <Button type="submit" disabled={passwordSaving} size="sm">
            <KeyRound data-icon="inline-start" />
            {passwordSaving ? "Updating..." : "Update password"}
          </Button>
        </form>
      </section>
    </div>
  );
}
