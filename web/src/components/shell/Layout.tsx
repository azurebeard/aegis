// Layout — outer shell that wraps every authenticated route with the
// AppHeader + AppFooter. Page content renders inside `<Outlet />`, which
// itself supplies the per-page PageSubheader (via the page component's
// own JSX) and `<main className="app-main">`.
//
// React-router pattern: this is a parent route element with `<Outlet />`
// — children render in the slot, the chrome stays mounted across
// navigations (no flicker on tab switch).

import { Outlet } from "react-router-dom";
import { AppHeader } from "@/components/shell/AppHeader";
import { AppFooter } from "@/components/shell/AppFooter";
import { CommandPalette } from "@/components/CommandPalette";
import { useCommandPalette } from "@/features/common/commandPalette";

export function Layout(): React.ReactElement {
  // Mount the ⌘K palette here so it's available across every route under
  // the layout. The hook owns the global keyboard binding; the modal
  // itself only renders when `open` is true (no a11y-tree footprint when
  // closed). AppHeader receives the toggle handler so its visible
  // discoverability button uses the same state.
  const palette = useCommandPalette();
  return (
    <>
      <AppHeader onOpenCommandPalette={palette.toggle} />
      <Outlet />
      <AppFooter />
      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </>
  );
}
