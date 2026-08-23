import darkLogoUrl from "@/assets/logo-dark.png";
import lightLogoUrl from "@/assets/logo-light.png";
import { useAppStore } from "@/glyph/store";

export function FontSeruLogo() {
  const theme = useAppStore((state) => state.theme);
  const logoUrl = theme === "light" ? lightLogoUrl : darkLogoUrl;

  return (
    <div className="fm-logo" data-testid="app-brand" aria-label="FontSeru">
      <img className="fm-logo-image" src={logoUrl} alt="FontSeru" />
    </div>
  );
}
