"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ShortcutsHelp } from "@/components/ui/ShortcutsHelp";
import { SetupWizard } from "@/components/ui/SetupWizard";
import { MobileSidebarProvider } from "@/components/providers/MobileSidebarContext";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

export function ClientShell({ children }: { children: ReactNode }) {
  useKeyboardShortcuts();

  return (
    <ErrorBoundary>
      <MobileSidebarProvider>
        {children}
      </MobileSidebarProvider>
      <SetupWizard />
      <ShortcutsHelp />
    </ErrorBoundary>
  );
}
