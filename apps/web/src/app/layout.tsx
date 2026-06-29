import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Group Video Call',
  description: 'mediasoup SFU group video call',
};

/**
 * Root layout wrapping all pages.
 * @param {{children: ReactNode}} props Layout props (destructured in body).
 * @returns {JSX.Element} The HTML shell.
 */
export default function RootLayout(props: { children: ReactNode }) {
  const { children } = props;
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
