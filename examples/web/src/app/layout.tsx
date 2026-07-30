import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { StoreProvider } from '../redux/provider';

export const metadata: Metadata = {
  title: 'pgbase example',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
