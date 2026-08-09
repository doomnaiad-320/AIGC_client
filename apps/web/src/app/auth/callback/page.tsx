"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

import { LoadingScreen } from "../../../components/loading-screen";

function loginErrorUrl(error: string): string {
  return `/login?${new URLSearchParams({ error }).toString()}`;
}

function AuthCallbackPageContent() {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    router.replace(loginErrorUrl("auth_callback_disabled"));
  }, [router]);

  return <LoadingScreen />;
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AuthCallbackPageContent />
    </Suspense>
  );
}
