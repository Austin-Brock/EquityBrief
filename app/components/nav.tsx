"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Brief"],
  ["/chat", "Chat"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center gap-6 px-6 py-3 font-sans text-sm">
        <span className="font-semibold tracking-tight">EquityBrief</span>
        {LINKS.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={path === href ? "font-medium text-neutral-900" : "text-neutral-500 hover:text-neutral-900"}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
