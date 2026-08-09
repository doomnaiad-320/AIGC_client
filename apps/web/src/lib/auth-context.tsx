"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { AppAuthSession } from "./server-api";

const STORAGE_KEY = "loomic.auth.session";
const AUTH_CHANGED_EVENT = "loomic-auth-changed";

export type AppAuthUser = AppAuthSession["user"];

interface AuthContextValue {
  user: AppAuthUser | null;
  session: AppAuthSession | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function saveAuthSession(session: AppAuthSession) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function clearAuthSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppAuthSession | null>(null);
  const [user, setUser] = useState<AppAuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function refreshFromStorage() {
      const storedSession = readStoredSession();
      setSession(storedSession);
      setUser(storedSession?.user ?? null);
      setLoading(false);
    }

    refreshFromStorage();
    window.addEventListener(AUTH_CHANGED_EVENT, refreshFromStorage);
    window.addEventListener("storage", refreshFromStorage);

    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, refreshFromStorage);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);

  async function signOut() {
    clearAuthSession();
    setSession(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

function readStoredSession(): AppAuthSession | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as AppAuthSession;
    if (!parsed.access_token || !parsed.user?.id) return null;
    if (parsed.expires_at * 1000 <= Date.now()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}
