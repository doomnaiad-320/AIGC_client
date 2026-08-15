"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { saveAuthSession } from "../lib/auth-context";
import {
  ApiApplicationError,
  ApiAuthError,
  fetchViewer,
  registerWithPassword,
} from "../lib/server-api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
} as any;

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
} as any;

export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bootstrapWorkspace(
    session: Awaited<ReturnType<typeof registerWithPassword>>["session"],
  ) {
    try {
      await fetchViewer(session.access_token);
      saveAuthSession(session);
      router.replace("/home");
    } catch (err) {
      if (err instanceof ApiAuthError || err instanceof ApiApplicationError) {
        setError(err.message);
      } else {
        setError("Could not finish creating your workspace. Please try again.");
      }
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { session } = await registerWithPassword({
        email: trimmed,
        password,
      });
      await bootstrapWorkspace(session);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not create account. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <AnimatePresence mode="wait">
        <motion.div
          key="form"
          variants={stagger}
          initial="hidden"
          animate="visible"
          exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
          className="space-y-6"
        >
          <motion.div variants={fadeIn} className="space-y-2 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              Create your account
            </h2>
            <p className="text-sm text-muted-foreground">
              Start with email and password
            </p>
          </motion.div>

          <motion.form
            variants={fadeIn}
            onSubmit={handleSubmit}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="register-email">Email</Label>
              <Input
                id="register-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-password">Password</Label>
              <Input
                id="register-password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="register-confirm-password">
                Confirm password
              </Label>
              <Input
                id="register-confirm-password"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </motion.form>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden text-center text-sm text-destructive"
                role="alert"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          <motion.p
            variants={fadeIn}
            className="text-center text-sm text-muted-foreground"
          >
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>
          </motion.p>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
