# dsh-multi-provider-usage

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that shows the
quotas of **OpenCode GO**, **Command Code** and **GLM Code Plan** in one sidebar
widget. It is modelled on
[`@astervolans/dsh-opencode-go-usage`](https://github.com/Astervolans/dsh-opencode-go-usage)
— same dual-half package, same-origin proxy, same sidebar slot, same Plugins
panel settings page — extended from one provider to three.

> The package name is `dsh-multi-provider-usage` because the unscoped
> `dsh-provider-usage` name is already taken on npm by a different plugin. The
> HTTP routes (`/provider-usage/*`) and chat command (`/provider-usage`) stay
> short and stable.

## Features

![Sidebar widget with the three stacked providers](docs/widget.png)


- **Three providers, one column.** All enabled providers are stacked vertically;
  each header carries a health dot, the provider's primary percentage and its
  top-up balance. Click a provider header to collapse/expand that provider's
  plan windows, quota bars and time bars; the collapse state is remembered
  locally, so any subset can stay folded.
- **OpenCode GO** — 5-hour, weekly and monthly windows (the API calls the 5-hour field `rolling`). Prefers the live
  `dsh-opencode-go` plugin's active account through its `opencodeGoUsage`
  host service, then falls back to the official `GET /v1/usage` endpoint.
- **Command Code** — monthly credit pool, 5-hour window and weekly window from
  the official billing/usage endpoints (`/alpha/billing/*`,
  `/alpha/usage/summary`).
- **GLM Code Plan** — 5-hour token window, weekly token window and monthly MCP
  tool limit from Z.ai / BigModel `/api/monitor/usage/quota/limit`.
- **Top-up balances** — OpenCode GO shows the OpenCode Zen prepaid balance and
  Command Code shows its purchased + free "Extra Credits" balance, both as a
  badge next to the account/plan and in the `/provider-usage` text. The OpenCode
  console token is auto-discovered from `OPENCODE_CONSOLE_TOKEN`, the OpenCode
  CLI auth file, or its local `opencode.db`; the token never leaves the host.
  When that token is missing, the balance slot becomes a clickable "Set up" chip
  that opens the plugin settings instead of silently showing nothing. Command
  Code's tooltip breaks its amount into purchased + free credits; a credits
  response without either pool renders a muted **No top-up** badge.
- **Auto-update** — on boot and every configured interval the host checks the
  GitHub release feed. A local `link:` checkout is fast-forwarded only when it
  is on `main`, clean, and a strict fast-forward; the running Host keeps the old
  module graph, so the widget/settings show "updated — restart DSH". An
  npm/market-installed copy is never modified by the plugin: it reports the
  available version and points at the plugin market. The plugin never restarts
  DSH by itself.
- **Balance-change animation** — the widget polls on its normal interval; when
  a provider's balance differs from the previous poll, the number counts from
  the old value to the refreshed one while a red/green delta chip (for example
  `-0.1`) floats up and fades away. There is no popup and no turn-event
  tracking, so the animation may appear up to one poll interval later.
- **Same-origin proxy** — the browser only talks to `/provider-usage/usage` and
  `/provider-usage/settings`; API keys stay in the host process.
- **Failure isolation** — one broken provider never hides the other two. The
  route answers `200` while any provider succeeds and `502` only when all
  enabled providers fail. Partial endpoint failures keep the provider's numbers
  but turn its health dot amber and name the failed calls in the tooltip.
- **Settings shortcut** — the widget header's **Settings** button opens this
  bundle's page in the sidebar **Plugins** panel, directly on the configuration
  page below.
- **Bundle settings page** — sidebar **Plugins** panel → this bundle's card:
  enable/disable each provider, edit credential refs and endpoints, choose the
  GLM region, and see non-network detection status. Save applies immediately.
  The GLM card also carries the **referral link** (Z.ai "Invite Friends, Get
  Credits") as a clickable, copyable row. The URL is a bundle constant: it never
  goes through the settings route and a settings save cannot overwrite it.
- **`/provider-usage` chat command** — prints every enabled provider's numbers
  as text.
- **Time bars** — under each quota bar, gray is time already elapsed and blue is
  time remaining, matching the reference widget's geometry.
- **`x-opencode-session` fix** — injects the real per-conversation harness
  session id into OpenCode GO chat requests at runtime, without patching DSH.
- **Chinese and English UI** through the DSH locale service.

## Install

From a checkout:

```bash
dsh plugin --profile desktop add /path/to/dsh-provider-usage
```

or, for the web profile:

```bash
dsh plugin --profile web add /path/to/dsh-provider-usage
```

The package declares `dsh.bundle.patch`, so the CLI reconciles it into the
profile's bundle layer stack automatically. The widget and client bundle are
part of the profile's client-modules graph, so **restart DSH once** after
installing (a running host does not rebuild its `window.__DSH_BOOT__` manifest
for a newly linked package).

For a local `link:` dependency pnpm prints a peer-dependency warning
(`@deepseek-ai/schemastery`, `@deepseek-ai/dsh`). That is expected: the linked
checkout resolves schemastery from its own `node_modules` in development; a
normal npm install resolves the peers from the DSH runtime.

## Credentials

All values are resolved through the DSH credentials domain (the process
environment, `$DSH_HOME/.credentials.yaml` and `.env` layers). They are never
returned by the settings route and never reach the browser.

| Provider | Default ref | Resolution order | Fallback source |
|---|---|---|---|
| OpenCode GO | `OPENCODE_GO_API_KEY` | `opencodeGoApiKeyEnv`, the `dsh-opencode-go` active-account ref (only when that entry is enabled), `OPENCODE_GO_API_KEY`, `OPENCODE_API_KEY` | `GET {baseUrl}/v1/usage` |
| Command Code | `COMMANDCODE_API_KEY` | `commandCodeApiKeyEnv`, `COMMANDCODE_API_KEY`, then the CLI auth file | `~/.commandcode/auth.json` (`apiKey`) |
| GLM Code Plan | `ZAI_API_KEY` | `glmApiKeyEnv`, `ZAI_CODING_CN_API_KEY`, `ZAI_API_KEY`, `ZHIPU_API_KEY`, `GLM_API_KEY`, `BIGMODEL_API_KEY` | — |

Set a ref in **Plugins → dsh-multi-provider-usage → settings** (or in the
auto-generated **Settings → Plugins → Plugin configuration** form). A ref is a
name such as `OPENCODE_GO_API_KEY`; the secret itself lives in DSH's credential
store.

### OpenCode console balance

The GO quota API does not include the account's prepaid balance. That comes from
`GET https://opencode.ai/console/api/billing/status`, which needs the OpenCode
**console** OAuth token (the GO API key returns 403 there). The host resolves it
in this order:

1. `opencodeConsoleApiKeyEnv` (`OPENCODE_CONSOLE_TOKEN` by default), resolved
   through DSH credentials;
2. `~/.local/share/opencode/auth.json` (`$XDG_DATA_HOME/opencode/auth.json` when
   set), provider `opencode`;
3. the `credential` table of `~/.local/share/opencode/opencode.db` (read via
   `node:sqlite` when available; this is where current OpenCode releases keep
   the OAuth grant).

The optional `opencodeConsoleAuthFile` overrides the auth file (and its
directory is used for `opencode.db`), `opencodeConsoleOrgId` supplies the
`x-org-id` header, and `opencodeConsoleEnabled: false` turns the whole balance
read off. Balance failures never hide the GO quota: the provider stays `ok` with
`balance: null` and a `meta.balanceError`. A missing console credential is
actionable rather than hidden: the balance slot renders a clickable **Set up**
chip that opens this bundle's page in the Plugins panel, whose tooltip names the
fix (`opencode auth login` or `OPENCODE_CONSOLE_TOKEN`). Any other balance
failure renders a muted **Balance —** badge whose tooltip carries the error.

### Command Code balance

Command Code's quota and balance share one API key and one billing family, so
they cannot diverge the way OpenCode's do: a missing key (`COMMANDCODE_API_KEY`
or `~/.commandcode/auth.json`) fails the whole provider with an explicit
`no API key` message rather than blanking only the balance. Two narrower gaps
are reported instead of hidden:

- when `/alpha/billing/credits` fails, that request carries every window, so the
  provider errors as well; its message now includes the underlying interface and
  status instead of only "no usable quota windows", and `meta.balanceError` lets
  the header show a muted **Balance —** badge carrying the cause;
- when the credits response succeeds but carries neither `purchasedCredits` nor
  `freeCredits`, `balance` stays `null` with `meta.balanceMissing: true` and the
  header shows a muted **No top-up** badge (a real `0` still renders `$0.00`).

### OpenCode GO integration and fallback

When `opencodeGoSource` is `opencode-go` (the default), the host probes:

1. a live loader entry named `opencode-go` / `dsh-opencode-go`;
2. that entry is not disabled;
3. `ctx.get("opencodeGoUsage")` exposes `read()`;
4. `read()` returns valid `rolling` / `weekly` / `monthly` data;
5. the active account is read from that entry's `apiKeyEnv` + `accounts[]`.

If any step fails, the host reads the built-in endpoint and reports a `fallback`
object with one of: `not-installed`, `entry-disabled`, `service-unavailable`,
`read-failed`, `invalid-response`. The widget shows a **Built-in** badge with the
reason and message in its tooltip. `opencodeGoSource: "builtin"` pins the HTTP
path and never touches the other plugin.

## Plan windows

| Provider | Windows | Window length |
|---|---|---|
| OpenCode GO | `rolling`, `weekly`, `monthly` | 5 h, 7 d, ~30 d |
| Command Code | `five-hour`, `weekly`, `monthly` | 5 h, 7 d, real billing period |
| GLM Code Plan | `five-hour`, `weekly`, `mcp` | 5 h, 7 d, monthly |

Percentages are **used** percentages and are clamped to `[0, 100]` for display.
Command Code monthly utilization is
`totalCost / (totalCost + monthlyCredits)`; purchased and free credits are
reported separately in `meta.monthly` and do not change the plan bar, while
their sum is the visible top-up balance (`balance.extra`). The
5-hour/weekly bars use `windowLimits.fiveHour` / `weekly` (`used`, `cap`,
`resetAt`, `exceeded`).

A GLM account without a Coding Plan answers HTTP 200 with
`{ "success": false, "msg": ... }`; the adapter surfaces that message and the
widget shows the provider in an error state.

## Configuration

The loader reads the exported `Config` schema; every field is `.volatile()`, so
the settings page and the auto-generated form hot-apply.

| Field | Default | Meaning |
|---|---|---|
| `opencodeGoEnabled` | `true` | Show OpenCode GO |
| `opencodeGoSource` | `"opencode-go"` | `opencode-go` or `builtin` |
| `opencodeGoApiKeyEnv` | `"OPENCODE_GO_API_KEY"` | Credential ref |
| `opencodeGoBaseUrl` | `"https://opencode.ai/zen/go"` | Gateway base |
| `opencodeConsoleEnabled` | `true` | Read the Zen prepaid balance |
| `opencodeConsoleApiKeyEnv` | `"OPENCODE_CONSOLE_TOKEN"` | Console token ref |
| `opencodeConsoleOrgId` | `""` | Optional `x-org-id` |
| `opencodeConsoleAuthFile` | `""` | Optional auth.json path; empty auto-discovers |
| `opencodeConsoleDbFile` | `""` | Optional opencode.db path; empty derives it |
| `opencodeConsoleBaseUrl` | `"https://opencode.ai"` | Console origin |
| `commandCodeEnabled` | `true` | Show Command Code |
| `commandCodeApiKeyEnv` | `"COMMANDCODE_API_KEY"` | Credential ref |
| `commandCodeBaseUrl` | `"https://api.commandcode.ai"` | API base |
| `commandCodeAuthFile` | `""` | Empty = `~/.commandcode/auth.json` |
| `glmEnabled` | `true` | Show GLM Code Plan |
| `glmApiKeyEnv` | `"ZAI_API_KEY"` | Credential ref |
| `glmBaseUrl` | `""` | Optional base override |
| `glmRegion` | `"auto"` | `auto`, `zai`, `bigmodel`, `custom` |
| `cacheMs` | `30000` | Per-provider host cache TTL |
| `updateCheck` | `true` | npm update check (24 h) |
| `autoUpdate` | `true` | Check GitHub releases; fast-forward a clean local checkout |
| `autoUpdateCheckHours` | `6` | Hours between auto-update checks (1–168) |
| `injectSessionHeader` | `true` | OpenCode GO session-header fix |
| `providerOrder` | all three ids | Provider display order in the widget; drag the cards in the plugin settings to reorder |

`glmRegion: "custom"` requires `glmBaseUrl`; `auto` probes
`https://api.z.ai` first and then `https://open.bigmodel.cn`.

## HTTP API

### `GET /provider-usage/usage`

`?refresh=1` (or `?force=1`) bypasses the host cache.

```json
{
  "ok": true,
  "enabled": ["opencode-go", "command-code", "glm"],
  "providerOrder": ["opencode-go", "command-code", "glm"],
  "providers": [
    {
      "id": "opencode-go",
      "name": "OpenCode GO",
      "short": "GO",
      "status": "ok",
      "account": { "ref": "OPENCODE_GO_API_KEY", "id": null, "name": "" },
      "plan": null,
      "source": "builtin",
      "requested": "opencode-go",
      "fallback": {
        "from": "opencode-go",
        "reason": "not-installed",
        "message": "dsh-opencode-go is not installed, or its profile entry is inactive"
      },
      "balance": {
        "amount": 5.01495352,
        "currency": "USD",
        "labelKey": "balance.zen",
        "source": "opencode-db",
        "details": { "billingMode": "prepaid", "mode": "pay-as-you-go" }
      },
      "windows": [
        {
          "key": "rolling",
          "labelKey": "window.five-hour",
          "hintKey": "window.five-hour.hint",
          "percent": 0,
          "status": "ok",
          "resetsAt": "2026-11-05T13:50:46.363Z",
          "windowMs": 18000000
        }
      ],
      "meta": {}
    }
  ],
  "update": { "current": "0.1.0", "available": false, "latest": null },
  "sessionHeader": { "active": true, "count": 0, "diag": {} }
}
```

Failed providers have `"status": "error"`, `code`, `error` and `windows: []`;
their siblings are still returned. A body with `providers: []` means no provider
is enabled. `meta.balanceError` carries a tolerated balance failure (the
provider still answers `ok`); `meta.balanceMissing` marks a Command Code credits
response without purchased/free pools. `meta.errors` lists partial Command Code
endpoint failures: the numbers stay, the health dot turns amber, and the tooltip
names the failed calls. Error cards keep the plan they already resolved.

### `GET /provider-usage/settings`

Returns the settings descriptor (`namespace`, `revision`, `value`, `base`,
`user`) plus a non-network `detection` report:

```json
{
  "ok": true,
  "namespace": "dsh-multi-provider-usage",
  "revision": 0,
  "value": { "opencodeGoEnabled": true },
  "detection": {
    "providerOrder": ["opencode-go", "command-code", "glm"],
    "enabled": ["opencode-go", "command-code", "glm"],
    "providers": {
      "opencode-go": { "configured": true, "entryFound": false, "fallback": { "...": "..." } },
      "command-code": { "configured": true, "source": "auth-file" },
      "glm": { "configured": true, "region": "auto" }
    }
  }
}
```

`503` means the host has no settings service or the entry has no volatile
fields; the settings page explains how to fix it.

### `POST /provider-usage/settings`

Only the fields in the table above are accepted; anything else is ignored.
`expectedRevision` gets `409` on a concurrent change.

```json
{
  "patch": { "commandCodeEnabled": false, "providerOrder": ["glm", "opencode-go", "command-code"] },
  "expectedRevision": 0
}
```

Cross-origin writes are refused with `403`. The usage route is read-only.

## How it is put together

| Half | File | Role |
|---|---|---|
| host (Node) | `lib/index.js` | Config schema, routes, command, settings/detection, cache, session fix |
| host adapters | `lib/providers.js` | Canonical window shape and the three vendor adapters |
| console balance | `lib/opencode-console.js` | OpenCode console token discovery + billing status |
| session fix | `lib/opencode-session.js` | `globalThis.fetch` wrapper + `llm/stream` ALS context |
| browser | `lib/client.js` | Hand-authored `window.__ModuleLoader__.load({ id, factory })` bundle: widget, settings page, locale dictionaries |
| bundle patch | `cordis.patch.yml` | Inserts the profile entry |

The browser bundle is composed by DSH's official client-modules scan from
`dsh.client` + `exports["./client"]`; it registers into
`sidebar.footer.action` and `plugins.bundle.config`, exactly like the reference
plugin.

The session fix wraps `globalThis.fetch` once and only adds
`x-opencode-session` when the request URL starts with the gateway base carried
by the current `llm/stream` call. The base comes from
`llm-pi-ai.providers.<route>.baseURL`, falling back to `opencodeGoBaseUrl`.

## Compatibility

- DSH `0.1.7` and above, including the `0.2.0` line; verified on `0.2.1-rc.5`.
- `@deepseek-ai/schemastery` `^3.18.4` (volatile fields / settings page).
- Node.js ≥ 18 (global `fetch`, `AbortSignal.timeout`).
- `dsh-opencode-go` is optional; its absence is a normal fallback.
- Command Code's CLI auth file is optional if `COMMANDCODE_API_KEY` is set.
- A DSH runtime that does not expose `plugins.bundle.config` loses only the
  settings page; the sidebar widget and `/provider-usage` keep working. Set the
  config fields in the profile patch or the auto-generated form instead.

## Development

```bash
npm install
npm test
```

The tests are hermetic: a fake `globalThis.fetch` and a stub Cordis context, no
network and no real keys. They cover the schema, all three adapters, OpenCode
GO service integration/fallback, aggregation and error isolation, caching and
forced refresh, settings conflicts/whitelisting, the client bundle contract,
top-up balance discovery (credential and local auth.json) and failure
isolation, and the session-header injection. 75 tests, all offline.

## License

MIT.
