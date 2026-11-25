import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk } from 'next/font/google';
import './globals.css';

const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-hanken',
  display: 'swap',
});

const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:3000';
const description = 'Is every launch ready? A launch-readiness board where an AI agent writes the go/no-go brief from live tracker data.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Launch Control',
  description,
  openGraph: { title: 'Launch Control', description, type: 'website', siteName: 'Launch Control' },
  twitter: { card: 'summary_large_image', title: 'Launch Control', description },
  // A demo, not a product: keep it out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a2540' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={hanken.variable}>
      <body>{children}</body>
    </html>
  );
}
