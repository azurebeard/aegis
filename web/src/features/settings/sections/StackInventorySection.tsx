// /admin → Stack inventory section.
//
// Operator-curated stack inventory CRUD lives here (per the 2026-04-28
// reshape — `/stack` was removed, the StackTile remains as the dashboard
// summary, and KEV cross-reference moved to the top-level `/kev` route).
// Admin-only — surfaces add-form, item table with edit/delete, and the
// KEV chip on rows that have catalog matches.

import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  useCreateStackItem,
  useDeleteStackItem,
  useStackCatalog,
  useStackItems,
  useUpdateStackItem,
} from "@/features/stack/queries";
import {
  STACK_CATEGORIES,
  STACK_CATEGORY_LABELS,
  STACK_ENVIRONMENTS,
  STACK_ENVIRONMENT_LABELS,
  type StackCategory,
  type StackEnvironment,
  type StackItem,
} from "@/features/stack/types";

export function StackInventorySection() {
  const itemsQ = useStackItems();
  const catalogQ = useStackCatalog();

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Stack inventory</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Stack inventory
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            Operator-curated list of vendor + product + version. ADR-0031. Cross-referenced daily
            against the CISA KEV catalogue (ADR-0032) — see <a href="/kev">/kev</a> for the exposure
            list.
          </p>
        </div>
      </div>

      {itemsQ.isPending && <p className="t-body t-body--mute">Loading…</p>}
      {itemsQ.isError && (
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load stack inventory.{" "}
          {itemsQ.error instanceof ApiError
            ? `(${itemsQ.error.status}) ${itemsQ.error.message}`
            : (itemsQ.error as Error).message}
        </p>
      )}
      {itemsQ.isSuccess && (
        <>
          <AddStackItemForm
            vendorSuggestions={catalogQ.data?.pairs ?? []}
            cap={itemsQ.data.cap}
            count={itemsQ.data.items.length}
          />
          <StackItemsTable items={itemsQ.data.items} />
        </>
      )}
    </section>
  );
}

function AddStackItemForm({
  vendorSuggestions,
  cap,
  count,
}: {
  vendorSuggestions: readonly { vendor: string; product: string; defaultCategory: StackCategory }[];
  cap: number;
  count: number;
}) {
  const create = useCreateStackItem();
  const [vendor, setVendor] = useState("");
  const [product, setProduct] = useState("");
  const [version, setVersion] = useState("");
  const [category, setCategory] = useState<StackCategory>("application");
  const [environment, setEnvironment] = useState<StackEnvironment>("production");
  const [tagsRaw, setTagsRaw] = useState("");

  const vendors = Array.from(new Set(vendorSuggestions.map((p) => p.vendor))).sort();
  const products = Array.from(
    new Set(
      vendorSuggestions
        .filter((p) => !vendor || p.vendor.toLowerCase() === vendor.trim().toLowerCase())
        .map((p) => p.product),
    ),
  ).sort();

  const atCap = count >= cap;

  function reset() {
    setVendor("");
    setProduct("");
    setVersion("");
    setCategory("application");
    setEnvironment("production");
    setTagsRaw("");
    create.reset();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (atCap) return;
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    await create.mutateAsync({
      vendor: vendor.trim(),
      product: product.trim(),
      version: version.trim(),
      category,
      environment,
      tags,
    });
    reset();
  }

  return (
    <div className="stack-add" style={{ marginTop: "var(--sp-l)" }}>
      <h3 className="t-h3">Add stack item</h3>
      {atCap && (
        <p className="banner banner--warning" role="status">
          Stack inventory is at the {cap}-item cap. Delete an existing item before adding more.
        </p>
      )}
      <form className="stack-add__form" onSubmit={submit}>
        <label className="stack-add__field">
          <span className="t-eyebrow">Vendor</span>
          <input
            type="text"
            list="stack-vendors"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            maxLength={64}
            required
            disabled={create.isPending || atCap}
          />
          <datalist id="stack-vendors">
            {vendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
        <label className="stack-add__field">
          <span className="t-eyebrow">Product</span>
          <input
            type="text"
            list="stack-products"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            maxLength={64}
            required
            disabled={create.isPending || atCap}
          />
          <datalist id="stack-products">
            {products.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="stack-add__field">
          <span className="t-eyebrow">Version</span>
          <input
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            maxLength={32}
            placeholder="optional"
            disabled={create.isPending || atCap}
          />
        </label>
        <label className="stack-add__field">
          <span className="t-eyebrow">Category</span>
          <select
            className="select"
            value={category}
            onChange={(e) => setCategory(e.target.value as StackCategory)}
            disabled={create.isPending || atCap}
          >
            {STACK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {STACK_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="stack-add__field">
          <span className="t-eyebrow">Environment</span>
          <select
            className="select"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as StackEnvironment)}
            disabled={create.isPending || atCap}
          >
            {STACK_ENVIRONMENTS.map((e) => (
              <option key={e} value={e}>
                {STACK_ENVIRONMENT_LABELS[e]}
              </option>
            ))}
          </select>
        </label>
        <label className="stack-add__field">
          <span className="t-eyebrow">Tags</span>
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="comma, separated"
            disabled={create.isPending || atCap}
          />
        </label>
        <div className="stack-add__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={create.isPending || atCap || !vendor.trim() || !product.trim()}
          >
            {create.isPending ? "Adding…" : "Add item"}
          </button>
          <span className="t-caption">
            {count} of {cap} items registered
          </span>
        </div>
      </form>
      {create.isError && (
        <p className="banner banner--danger" role="alert">
          Add failed.{" "}
          {create.error instanceof ApiError
            ? `(${create.error.status}) ${create.error.message}`
            : (create.error as Error).message}
        </p>
      )}
    </div>
  );
}

function StackItemsTable({ items }: { items: readonly StackItem[] }) {
  const update = useUpdateStackItem();
  const del = useDeleteStackItem();

  if (items.length === 0) {
    return (
      <p className="t-body t-body--mute" style={{ marginTop: "var(--sp-l)" }}>
        No items registered yet. Use the form above to add the first.
      </p>
    );
  }

  return (
    <div className="stack-list" style={{ marginTop: "var(--sp-l)" }}>
      <h3 className="t-h3">Registered items ({items.length})</h3>
      <table className="dt" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Product</th>
            <th>Version</th>
            <th>Category</th>
            <th>Environment</th>
            <th>Tags</th>
            <th>Updated</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.vendor}</td>
              <td>
                {it.product}{" "}
                {!it.canonical && (
                  <span
                    className="badge badge--warning"
                    title="No canonical match in the catalog — KEV/CVE matching may not find this."
                  >
                    non-canonical
                  </span>
                )}
                {it.kevMatches && it.kevMatches.length > 0 && (
                  <span
                    className="badge badge--danger"
                    title={it.kevMatches
                      .map(
                        (m) =>
                          `${m.cveID}${m.dueDate ? ` (due ${m.dueDate})` : ""}${
                            m.knownRansomwareCampaignUse === "Known" ? " — ransomware-linked" : ""
                          }`,
                      )
                      .join("\n")}
                    style={{ marginLeft: 4 }}
                  >
                    KEV ({it.kevMatches.length})
                  </span>
                )}
              </td>
              <td>{it.version || <span className="t-body--mute">—</span>}</td>
              <td>{STACK_CATEGORY_LABELS[it.category]}</td>
              <td>{STACK_ENVIRONMENT_LABELS[it.environment]}</td>
              <td>
                {it.tags.length === 0 ? (
                  <span className="t-body--mute">—</span>
                ) : (
                  <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                    {it.tags.map((t) => (
                      <span key={t} className="badge badge--neutral">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className="t-body--mute" style={{ fontSize: "var(--fs-200)" }}>
                {new Date(it.updatedAt).toLocaleDateString()}
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn--small btn--subtle"
                  onClick={() => {
                    const newVersion = window.prompt(
                      "New version (or empty to clear):",
                      it.version,
                    );
                    if (newVersion === null) return;
                    void update.mutate({ id: it.id, patch: { version: newVersion.trim() } });
                  }}
                  disabled={update.isPending || del.isPending}
                >
                  Edit version
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  style={{ marginLeft: 4 }}
                  onClick={() => {
                    if (window.confirm(`Delete ${it.vendor} ${it.product}?`)) {
                      void del.mutate(it.id);
                    }
                  }}
                  disabled={update.isPending || del.isPending}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {update.isError && (
        <p className="banner banner--danger" role="alert">
          Update failed.{" "}
          {update.error instanceof ApiError
            ? `(${update.error.status}) ${update.error.message}`
            : (update.error as Error).message}
        </p>
      )}
      {del.isError && (
        <p className="banner banner--danger" role="alert">
          Delete failed.{" "}
          {del.error instanceof ApiError
            ? `(${del.error.status}) ${del.error.message}`
            : (del.error as Error).message}
        </p>
      )}
    </div>
  );
}
