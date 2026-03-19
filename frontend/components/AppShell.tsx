"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Separator from "@radix-ui/react-separator";
import {
  GearIcon,
  HomeIcon,
  PersonIcon,
  QuestionMarkCircledIcon,
  RocketIcon,
  RowsIcon,
} from "@radix-ui/react-icons";

const primaryLinks = [
  { href: "/", label: "Dashboard", icon: HomeIcon },
  { href: "/tickets", label: "Tickets", icon: RowsIcon },
  { href: "/agents", label: "Agents", icon: PersonIcon },
  { href: "/runs", label: "Runs", icon: RocketIcon },
];

const utilityLinks = [
  { href: "#", label: "Settings", icon: GearIcon },
  { href: "#", label: "Help", icon: QuestionMarkCircledIcon },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2.5 text-[1.7rem] font-extrabold">
            <span>agent lue</span>
          </div>
        </div>
        <ScrollArea.Root type="auto" style={{ flex: 1, minHeight: 0 }}>
          <ScrollArea.Viewport>
            <nav className="grid gap-2">
              {primaryLinks.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="sidebar-link"
                  data-active={pathname === href || (href !== "/" && pathname.startsWith(href))}
                >
                  <Icon />
                  <span>{label}</span>
                </Link>
              ))}
            </nav>
            <Separator.Root
              decorative
              orientation="horizontal"
              style={{ height: 1, background: "var(--line)", margin: "18px 0" }}
            />
            <div className="sidebar-footer-card">
              <p className="eyebrow">Workspace</p>
              <strong>Parallel Agent Control</strong>
              <p>
                Assign linear tasks to Lue and she will create PR's for you
              </p>
            </div>
            <Separator.Root
              decorative
              orientation="horizontal"
              style={{ height: 1, background: "var(--line)", margin: "18px 0" }}
            />
            <nav className="grid gap-2">
              {utilityLinks.map(({ href, label, icon: Icon }) => (
                <Link key={label} href={href} className="sidebar-link" data-active="false">
                  <Icon />
                  <span>{label}</span>
                </Link>
              ))}
            </nav>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" style={{ width: 8 }}>
            <ScrollArea.Thumb
              style={{ flex: 1, borderRadius: 999, background: "rgba(65, 57, 49, 0.16)" }}
            />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </aside>
      <main className="main-panel">
        <div className="main-content">{children}</div>
      </main>
    </div>
  );
}
