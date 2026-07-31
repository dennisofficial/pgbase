import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from '../components/app-header';
import { StoreProvider } from '../redux/provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Opsboard — pgbase example',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>
          <AppHeader />
          {children}
        </StoreProvider>
      </body>
    </html>
  );
}
