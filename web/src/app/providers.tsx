"use client";

import { GoogleOAuthProvider } from "@react-oauth/google";
import { useEffect } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is missing");
  }

  useEffect(() => {
    const interval = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (w.google?.accounts?.id?.initialize) {
        const original = w.google.accounts.id.initialize.bind(w.google.accounts.id);
        w.google.accounts.id.initialize = (config: Record<string, unknown>) => {
          original({ ...config, use_fedcm_for_prompt: false });
        };
        clearInterval(interval);
      }
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <GoogleOAuthProvider clientId={clientId}>
      {children}
    </GoogleOAuthProvider>
  );
}
