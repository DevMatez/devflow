import Link from 'next/link';
import type { ReactNode } from 'react';

const navItems = [
  { href: '/dashboard', label: 'My Work' },
  { href: '/work-items', label: 'Work Items' },
  { href: '/projects', label: 'Projects' },
  { href: '/reviews', label: 'Reviews' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/settings', label: 'Settings' },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-semibold">Devflow</Link>
          <nav className="flex gap-4 text-sm text-zinc-600">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-zinc-900">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-8">
        {children}
      </div>
    </div>
  );
}
