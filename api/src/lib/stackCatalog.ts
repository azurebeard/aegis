// ADR-0031 §2 — bundled vendor+product catalog for soft alignment.
//
// Curated, hand-maintained, committed to repo. Surfaces via
// GET /api/stack/catalog as the source for the admin add-row form's
// HTML5 <datalist> typeahead. The list is suggestions, not enforcement —
// operators may register free-form values for products the catalog
// hasn't seen.
//
// Phase B (KEV cross-reference) adds a fuzzy-match step that suggests
// canonical rewrites for free-form items the operator entered before
// the catalog covered them.
//
// Adding entries: keep `vendor` as the most common short form
// ("Microsoft", "Apache" — not "Microsoft Corporation", "Apache
// Software Foundation"). `products` should mirror the strings
// CISA KEV / NIST NVD use where they exist, so Phase B's match
// pass works out of the box.

export interface CatalogEntry {
  readonly vendor: string;
  readonly products: readonly string[];
  readonly defaultCategory:
    | "os"
    | "application"
    | "network-device"
    | "library"
    | "service"
    | "other";
}

export const STACK_CATALOG: readonly CatalogEntry[] = [
  // --- Microsoft ----------------------------------------------------------
  {
    vendor: "Microsoft",
    defaultCategory: "os",
    products: [
      "Windows 10",
      "Windows 11",
      "Windows Server 2016",
      "Windows Server 2019",
      "Windows Server 2022",
      "Windows Server 2025",
    ],
  },
  {
    vendor: "Microsoft",
    defaultCategory: "application",
    products: [
      "Microsoft 365",
      "Office 365",
      "Exchange Server",
      "Exchange Online",
      "SharePoint Server",
      "SharePoint Online",
      "Teams",
      "OneDrive",
      "Outlook",
      "SQL Server",
      "Visual Studio",
      "Visual Studio Code",
      "Power BI",
      "Power Automate",
      "Dynamics 365",
      "Defender for Endpoint",
      "Defender for Identity",
      "Defender for Cloud Apps",
      "Defender for Office 365",
      "Defender for Cloud",
      "Sentinel",
      "Entra ID",
      "Intune",
      "Purview",
      "Azure DevOps",
      "GitHub Enterprise",
    ],
  },
  // --- Linux distros ------------------------------------------------------
  {
    vendor: "Red Hat",
    defaultCategory: "os",
    products: ["Enterprise Linux", "OpenShift"],
  },
  {
    vendor: "Canonical",
    defaultCategory: "os",
    products: ["Ubuntu", "Ubuntu Server"],
  },
  {
    vendor: "Debian",
    defaultCategory: "os",
    products: ["Debian"],
  },
  {
    vendor: "SUSE",
    defaultCategory: "os",
    products: ["Linux Enterprise Server", "Rancher"],
  },
  {
    vendor: "Alpine Linux",
    defaultCategory: "os",
    products: ["Alpine Linux"],
  },
  {
    vendor: "Amazon",
    defaultCategory: "os",
    products: ["Amazon Linux", "Amazon Linux 2", "Amazon Linux 2023"],
  },
  {
    vendor: "Rocky Linux",
    defaultCategory: "os",
    products: ["Rocky Linux"],
  },
  {
    vendor: "AlmaLinux",
    defaultCategory: "os",
    products: ["AlmaLinux"],
  },
  // --- Apple ---------------------------------------------------------------
  {
    vendor: "Apple",
    defaultCategory: "os",
    products: ["macOS", "iOS", "iPadOS"],
  },
  {
    vendor: "Apple",
    defaultCategory: "application",
    products: ["Safari"],
  },
  // --- Google --------------------------------------------------------------
  {
    vendor: "Google",
    defaultCategory: "os",
    products: ["Android", "Chrome OS"],
  },
  {
    vendor: "Google",
    defaultCategory: "application",
    products: ["Chrome", "Workspace"],
  },
  // --- Mozilla -------------------------------------------------------------
  {
    vendor: "Mozilla",
    defaultCategory: "application",
    products: ["Firefox", "Thunderbird"],
  },
  // --- Web servers + databases --------------------------------------------
  {
    vendor: "Apache",
    defaultCategory: "service",
    products: [
      "HTTP Server",
      "Tomcat",
      "Kafka",
      "ActiveMQ",
      "Cassandra",
      "ZooKeeper",
      "Solr",
    ],
  },
  {
    vendor: "Apache",
    defaultCategory: "library",
    products: ["Log4j", "Struts", "Commons", "Maven"],
  },
  {
    vendor: "F5",
    defaultCategory: "network-device",
    products: ["BIG-IP", "NGINX Plus"],
  },
  {
    vendor: "nginx",
    defaultCategory: "service",
    products: ["nginx"],
  },
  {
    vendor: "MySQL",
    defaultCategory: "service",
    products: ["MySQL Server"],
  },
  {
    vendor: "Oracle",
    defaultCategory: "service",
    products: ["Database", "WebLogic", "MySQL", "Java SE", "JDK"],
  },
  {
    vendor: "PostgreSQL",
    defaultCategory: "service",
    products: ["PostgreSQL"],
  },
  {
    vendor: "MongoDB",
    defaultCategory: "service",
    products: ["MongoDB", "MongoDB Atlas"],
  },
  {
    vendor: "Redis",
    defaultCategory: "service",
    products: ["Redis"],
  },
  {
    vendor: "Elastic",
    defaultCategory: "service",
    products: ["Elasticsearch", "Kibana", "Logstash"],
  },
  // --- Containers + orchestration -----------------------------------------
  {
    vendor: "Docker",
    defaultCategory: "service",
    products: ["Docker Engine", "Docker Desktop"],
  },
  {
    vendor: "Kubernetes",
    defaultCategory: "service",
    products: ["Kubernetes"],
  },
  {
    vendor: "HashiCorp",
    defaultCategory: "service",
    products: ["Terraform", "Vault", "Consul", "Nomad"],
  },
  // --- Network / security appliances --------------------------------------
  {
    vendor: "Cisco",
    defaultCategory: "network-device",
    products: [
      "ASA",
      "IOS",
      "IOS XE",
      "Firepower",
      "Catalyst",
      "Meraki",
      "AnyConnect",
      "Webex",
      "Duo",
      "Umbrella",
    ],
  },
  {
    vendor: "Fortinet",
    defaultCategory: "network-device",
    products: ["FortiGate", "FortiOS", "FortiClient", "FortiAnalyzer", "FortiManager"],
  },
  {
    vendor: "Palo Alto Networks",
    defaultCategory: "network-device",
    products: ["PAN-OS", "GlobalProtect", "Prisma Access", "Cortex XDR"],
  },
  {
    vendor: "Juniper Networks",
    defaultCategory: "network-device",
    products: ["Junos OS", "SRX", "EX", "MX"],
  },
  {
    vendor: "SonicWall",
    defaultCategory: "network-device",
    products: ["SonicOS", "NSA", "TZ"],
  },
  {
    vendor: "Check Point",
    defaultCategory: "network-device",
    products: ["Quantum Security Gateway", "Harmony Endpoint"],
  },
  {
    vendor: "Citrix",
    defaultCategory: "application",
    products: ["NetScaler ADC", "Workspace App", "Virtual Apps and Desktops"],
  },
  {
    vendor: "VMware",
    defaultCategory: "service",
    products: ["vSphere", "ESXi", "vCenter Server", "Workspace ONE", "Horizon", "NSX"],
  },
  // --- Runtimes / languages -----------------------------------------------
  {
    vendor: "Node.js",
    defaultCategory: "library",
    products: ["Node.js"],
  },
  {
    vendor: "Python Software Foundation",
    defaultCategory: "library",
    products: ["Python"],
  },
  {
    vendor: "Microsoft",
    defaultCategory: "library",
    products: [".NET", ".NET Framework", "PowerShell"],
  },
  {
    vendor: "Eclipse Foundation",
    defaultCategory: "library",
    products: ["OpenJDK", "Jetty"],
  },
  // --- DevOps / CI ---------------------------------------------------------
  {
    vendor: "Atlassian",
    defaultCategory: "application",
    products: ["Jira", "Confluence", "Bitbucket"],
  },
  {
    vendor: "GitHub",
    defaultCategory: "service",
    products: ["GitHub Actions", "GitHub Enterprise Server"],
  },
  {
    vendor: "GitLab",
    defaultCategory: "service",
    products: ["GitLab CE", "GitLab EE"],
  },
  {
    vendor: "Jenkins",
    defaultCategory: "service",
    products: ["Jenkins"],
  },
  // --- Identity / SaaS security -------------------------------------------
  {
    vendor: "Okta",
    defaultCategory: "service",
    products: ["Identity Cloud", "Workforce Identity"],
  },
  {
    vendor: "OneLogin",
    defaultCategory: "service",
    products: ["OneLogin"],
  },
  {
    vendor: "Auth0",
    defaultCategory: "service",
    products: ["Auth0"],
  },
  {
    vendor: "CrowdStrike",
    defaultCategory: "application",
    products: ["Falcon"],
  },
  {
    vendor: "SentinelOne",
    defaultCategory: "application",
    products: ["Singularity"],
  },
  // --- Adobe ---------------------------------------------------------------
  {
    vendor: "Adobe",
    defaultCategory: "application",
    products: ["Acrobat Reader", "Acrobat", "ColdFusion", "Commerce", "Experience Manager"],
  },
  // --- Atlassian / collab --------------------------------------------------
  {
    vendor: "Slack",
    defaultCategory: "application",
    products: ["Slack"],
  },
  {
    vendor: "Zoom",
    defaultCategory: "application",
    products: ["Zoom Client"],
  },
];

/** Flat list of `(vendor, product)` pairs for fast typeahead matching. */
export interface CatalogPair {
  readonly vendor: string;
  readonly product: string;
  readonly defaultCategory: CatalogEntry["defaultCategory"];
}

export function flattenCatalog(): readonly CatalogPair[] {
  const out: CatalogPair[] = [];
  for (const e of STACK_CATALOG) {
    for (const p of e.products) {
      out.push({ vendor: e.vendor, product: p, defaultCategory: e.defaultCategory });
    }
  }
  return out;
}

/** Case-insensitive equality for vendor + product matching. Used by the
 *  admin UI's `non-canonical` chip and Phase B's KEV match pass. */
export function isCanonicalPair(vendor: string, product: string): boolean {
  const v = vendor.trim().toLowerCase();
  const p = product.trim().toLowerCase();
  for (const e of STACK_CATALOG) {
    if (e.vendor.toLowerCase() !== v) continue;
    for (const prod of e.products) {
      if (prod.toLowerCase() === p) return true;
    }
  }
  return false;
}
