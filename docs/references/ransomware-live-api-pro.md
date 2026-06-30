# Ransomware.live API PRO — Usage Guidance

> Reference for future sessions. Authenticated REST API for ransomware threat intelligence.
> Spec: Swagger 2.0 at `https://api-pro.ransomware.live/swagger.json` (the `/docs` page is a JS-rendered Swagger UI and reads as empty to raw fetchers — pull `/swagger.json` instead).

## Connection

| Item | Value |
|------|-------|
| Base URL | `https://api-pro.ransomware.live` |
| Auth | `X-API-KEY` header on **every** endpoint |
| Get a key | <https://www.ransomware.live/my> (free) |
| Validate key | `GET /validate` — returns client identifier if active |
| Rate limit | 500,000 req/month per key — HTTP 429 when exceeded |
| Exempt from rate limit | `/iocs*` endpoints (fair use applies) |

## Conventions

- **Victim IDs** = Base64 of `post_title@group_name`. Take from the `id` field of any listing.
- **Dates:** `attackdate` = estimated attack/publication date; `discovered` = first observed by ransomware.live.
- **Country codes:** ISO 3166-1 alpha-2 (e.g. `US`, `GB`, `FR`). `/csirt/{country}` also accepts alpha-3.
- **Month padding:** use zero-padded (`06`, `03`). Spec example uses `month=03`; `06` vs `6` not formally documented, so prefer `06`.
- **No pagination:** there is **no** `limit` / `page` / `offset` / `count` parameter anywhere in the spec.

## Filtering to fewer results (key gotcha)

`/victims/recent` and `/press/recent` are **hard-capped at 100** and have no size control. To get fewer / targeted results, use the filterable endpoints below and slice client-side for an exact N (results are pre-sorted).

### Victims

- **`/victims/`** — server-side AND-logic filters, **not capped at 100**, returns exactly what matches. **At least one filter required.**
  - Filters: `country`, `sector` (values from `/listsectors`), `group`, `year`, `month`
  - Current-month example (June 2026): `GET /victims/?country=GB&year=2026&month=06`
  - Spec examples: `?group=lockbit` · `?country=US&sector=Healthcare&year=2024` · `?year=2023&month=03`
- **`/victims/search?q=`** — substring (case-insensitive) match on victim name + website; optional `group` / `sector` / `country`.
- For a fixed top-N, take the first N of the returned (sorted) array client-side.

### Press

- **`/press/all`** — supports `country` + `year` + `month`, sorted by date desc. Use this for country + current month:
  - `GET /press/all?country=GB&year=2026&month=06`
- `/press/recent` only accepts `country` and still caps at 100 — avoid when you need month filtering.

## Endpoint reference (all GET, all require `X-API-KEY`)

### Victims endpoints

| Endpoint | Purpose |
|----------|---------|
| `/victims/recent` | 100 most recent active victims, enriched (screenshot, infostealer, press, permalink) |
| `/victims/` | Filtered victims; ≥1 filter required; AND logic; uncapped |
| `/victims/search?q=` | Full-text search over name + website (+ optional filters) |
| `/victim/{victim_id}` | Single enriched victim by Base64 id; 404 if taken down/missing |

Victim object fields: `victim`, `group`, `attackdate`, `discovered`, `country`, `activity`, `website`, `screenshot`, `infostealer`, `press`, `id`, `permalink`.

### Groups endpoints

| Endpoint | Purpose |
|----------|---------|
| `/groups` | All tracked groups + victim counts (`group`, `altname`, `victims`) |
| `/group/{groupname}` or `/groups/{groupname}` | Full group intel: description, firstseen/lastseen, leak-site `locations`, MITRE `ttps`, etc. |

### Threat-hunting artifacts

| Endpoint | Purpose |
|----------|---------|
| `/iocs` | Groups that have IOCs + type breakdown; `?type=` filter (md5/sha256/ip/domain/email/btc/url) |
| `/iocs/{group}` | IOCs for a group, by type; `?type=` to narrow. **Not rate-limited.** |
| `/yara`, `/yara/{group}` | YARA rules (`filename` + full `content`) |
| `/ransomnotes`, `/ransomnotes/{group}`, `/ransomnotes/{group}/{note_name}` | Ransom note text (.txt/.html/.md tried in order; `extension` + `content` returned) |
| `/negotiations`, `/negotiations/{group}`, `/negotiations/{group}/{chat_id}` | Leaked ransom chat logs, demands, payment outcome (`paid` bool) |

### Context & enrichment

| Endpoint | Purpose |
|----------|---------|
| `/press/all` | All cyberattack press, HudsonRock-enriched; filters `country`/`year`/`month`; sorted desc |
| `/press/recent` | 100 most recent press; optional `country` only |
| `/8k` | SEC Form 8-K cyber filings (Item 1.05 + 8.01); `?item105=false` to vary |
| `/csirt/{country}` | CSIRT/CERT contacts (ENISA + FIRST); alpha-2 or alpha-3 |
| `/listsectors` | Unique sector values + victim counts — feed into `?sector=` filters |
| `/stats` | Totals: victims, groups, press entries + latest-discovered timestamp |
| `/validate` | Check API key validity |

## Quick examples

```bash
# Verify key
curl https://api-pro.ransomware.live/validate -H 'X-API-KEY: <key>'

# UK victims this month (June 2026)
curl 'https://api-pro.ransomware.live/victims/?country=GB&year=2026&month=06' -H 'X-API-KEY: <key>'

# UK press this month
curl 'https://api-pro.ransomware.live/press/all?country=GB&year=2026&month=06' -H 'X-API-KEY: <key>'

# LockBit IP IOCs (not rate-limited)
curl 'https://api-pro.ransomware.live/iocs/lockbit3?type=ip' -H 'X-API-KEY: <key>'
```

```python
import requests

BASE = "https://api-pro.ransomware.live"
HEADERS = {"X-API-KEY": "<key>"}

def get(path, **params):
    r = requests.get(f"{BASE}{path}", headers=HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

# Current month, country-filtered, then take top N client-side (no server limit param)
victims = get("/victims/", country="GB", year=2026, month="06")
top10 = victims[:10] if isinstance(victims, list) else victims
press = get("/press/all", country="GB", year=2026, month="06")
```

> Note: response shapes (list vs wrapped object) not exhaustively documented in the spec — inspect once live and adjust slicing accordingly.
