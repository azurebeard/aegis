// AppFooter — single-line legal + tenancy reminder. Mounted by the Layout
// route component once, below `<Outlet />`, so every page gets a footer
// without per-page boilerplate. Footer text is operator-controlled via
// the Branding row (`branding.footerText`) — falls back to the default
// when no operator override is present.

import { useBranding } from "@/features/branding/BrandingProvider";

const DEFAULT_FOOTER = "Aegis · Apache 2.0 · Single-tenant — your data stays in your subscription";

export function AppFooter(): React.ReactElement {
  const { footerText } = useBranding();
  const text = footerText && footerText.trim() !== "" ? footerText : DEFAULT_FOOTER;
  return <footer className="app-footer">{text}</footer>;
}
