import { useEffect, useState } from "react";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { IncidentsList } from "@/features/incidents/IncidentsList";
import { IncidentsTrendsChart } from "@/features/incidents/IncidentsTrendsChart";
import { IncidentDetailDrawer } from "@/features/incidents/IncidentDetailDrawer";

export function IncidentsPage() {
  const user = useCurrentUser();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/incidents");
    }
  }, [user.isLoading, user.isAuthenticated]);

  if (user.isLoading || !user.isAuthenticated) {
    return null;
  }

  return (
    <>
      <PageSubheader
        title="Incidents"
        sub="Defender XDR incidents merged from Graph + detail blob."
      />
      <main className="app-main">
        <div className="surface" style={{ padding: "var(--sp-l) var(--sp-xl)" }}>
          <IncidentsTrendsChart days={30} />
        </div>
        <IncidentsList onSelect={(id) => setSelected(id)} selectedId={selected} />
        <IncidentDetailDrawer
          open={selected !== null}
          incidentId={selected}
          onClose={() => setSelected(null)}
        />
      </main>
    </>
  );
}
