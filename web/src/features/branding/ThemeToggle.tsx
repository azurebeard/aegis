// Header theme toggle (ADR-0029 §Decision.4).
//
// Cycles system → light → dark → system. Displays the currently-active
// mode with an icon; a tooltip explains "follow system" vs explicit
// light/dark. Choice persists to localStorage via the BrandingProvider.

import { Button, Tooltip } from "@fluentui/react-components";
import { WeatherMoonRegular, WeatherSunnyRegular, DesktopRegular } from "@fluentui/react-icons";
import { useBranding } from "./BrandingProvider";

export function ThemeToggle() {
  const { userPreference, tenantDefaultTheme, resolvedTheme, cycleTheme } = useBranding();
  const effective = userPreference ?? tenantDefaultTheme;

  const icon =
    effective === "system" ? (
      <DesktopRegular />
    ) : effective === "dark" ? (
      <WeatherMoonRegular />
    ) : (
      <WeatherSunnyRegular />
    );

  const tooltip =
    effective === "system"
      ? `Following system (currently ${resolvedTheme}). Click for light.`
      : effective === "light"
        ? "Light mode. Click for dark."
        : "Dark mode. Click for system.";

  return (
    <Tooltip content={tooltip} relationship="label">
      <Button
        appearance="subtle"
        icon={icon}
        onClick={cycleTheme}
        aria-label={`Theme: ${effective}. Resolved: ${resolvedTheme}.`}
      />
    </Tooltip>
  );
}
