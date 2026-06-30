// SevStrip — discrete bordered cells in a grid, replacing the
// pre-redesign tile-internal severity grid (which was tile-within-a-tile
// and felt cluttered per design-ask #1). Used by IncidentsTile (5 cells:
// high/medium/low/info/unknown) and RiskyUsersTile (6 cells:
// high/medium/low/hidden/none/unknown).

export type SevTone = "high" | "medium" | "low" | "info" | "zero";

export interface SevItem {
  readonly label: string;
  readonly count: number;
  /** Visual tone — defaults to `zero` when count is 0 and `info`
   *  otherwise; pass an explicit tone for high/medium/low colour
   *  mapping. */
  readonly tone?: SevTone;
}

interface SevStripProps {
  readonly items: readonly SevItem[];
}

export function SevStrip({ items }: SevStripProps): React.ReactElement {
  return (
    <div className="sev-strip" style={{ ["--cols" as string]: items.length }}>
      {items.map((it, i) => {
        const tone = it.tone ?? (it.count === 0 ? "zero" : "info");
        return (
          <div key={`${it.label}-${i}`} className="sev-strip__cell">
            <span className={`sev-strip__count sev-strip__count--${tone}`}>{it.count}</span>
            <span className="sev-strip__label">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}
