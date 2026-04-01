"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ReactNode } from 'react';
import ChatWidget2 from '@/components/chat-widget-2';

interface DashboardLayoutProps {
  children: ReactNode;
}

const DashboardLayout = ({ children }: DashboardLayoutProps) => {
  const pathname = usePathname();

  const navItems = [
    { label: 'Pokémons', href: '/dashboard/pokemons' },
    { label: 'Moves', href: '/dashboard/moves' },
    { label: 'Abilities', href: '/dashboard/abilities' },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
        <aside className="fixed left-0 top-0 z-50 flex h-screen w-64 flex-col border-r border-border bg-card">
          <div className="p-6">
            <h1 className="font-mono text-xl font-bold text-primary">PokéPanel</h1>
            <p className="mt-1 text-xs text-muted-foreground">Data Interface v2.0</p>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-3">
            {navItems.map((item) => {
              const isActive = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors" +
                    (isActive ? " bg-primary/10 text-primary" : " text-muted-foreground hover:bg-accent hover:text-foreground")
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-border p-4">
            <p className="font-mono text-xs text-muted-foreground">Powered by PokéAPI</p>
          </div>
        </aside>
        <main className="ml-64 h-screen overflow-y-auto p-4 flex-1">
            {children}
        </main>
        <ChatWidget2 />
    </div>
  );
};

export default DashboardLayout;