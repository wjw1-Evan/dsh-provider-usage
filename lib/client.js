// dsh-multi-provider-usage — browser half.
//
// Hand-authored client bundle in the DSH module-loader factory format:
// `window.__ModuleLoader__.load({ id, factory })`. The factory receives the
// module-table `require`, so only shell-externalized modules may be imported
// (react / react/jsx-runtime are in the static table). It registers a widget
// into the sidebar's `sidebar.footer.action` list slot and polls the
// same-origin `/provider-usage/usage` proxy owned by the host half — API keys
// never enter the browser. UI strings are bilingual via the DSH locale
// service (dictionaries under the `dsh-multi-provider-usage` namespace).
//
// Every declaration that must not collide with another plugin's classic-script
// globals is kept INSIDE the factory: the shell evaluates all client bundles
// in one shared global lexical scope, so a top-level `const PACKAGE_NAME`
// would make the whole web boot fail with "Identifier has already been
// declared".
window.__ModuleLoader__.load({
	id: "dsh-multi-provider-usage",
	factory: (require) => {
		const PACKAGE_NAME = "dsh-multi-provider-usage";
		const CONFIG_KEY = PACKAGE_NAME;
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ── styles (injected once, same pattern as built-in client plugins) ──
		const CSS_ID = "dsh-multi-provider-usage/widget.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-multi-provider-usage";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dpu-widget{box-sizing:border-box;width:100%;min-width:0;padding:6px 6px 4px;display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
				".dpu-widget:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dpu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;line-height:18px}",
				".dpu-brand{white-space:nowrap;flex:none}",
				".dpu-headright{display:flex;align-items:center;gap:6px;min-width:0}",
				".dpu-refresh{cursor:pointer;border:none;background:none;padding:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}",
				".dpu-refresh:hover{color:var(--dsw-alias-label-primary)}",
				".dpu-providers{display:flex;flex-direction:column;gap:1px;min-width:0}",
				".dpu-provider{box-sizing:border-box;min-width:0;padding:2px 0;border-top:1px solid var(--dsw-alias-border-l2)}",
				".dpu-provider:first-child{border-top:none;padding-top:0}",
				".dpu-provider-head{display:flex;align-items:center;gap:5px;width:100%;min-width:0;border:none;background:transparent;border-radius:6px;padding:1px 2px;font:inherit;color:inherit;cursor:pointer;text-align:left}",
				".dpu-provider-head:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dpu-chevron{flex:none;width:9px;font-size:9px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
				".dpu-provider-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}",
				".dpu-provider-pct{flex:none;font-size:11px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-primary)}",
				".dpu-provider-balance{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border-radius:6px;font-size:9px;line-height:15px;font-weight:600;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".dpu-provider-balance.dpu-muted{color:var(--dsw-alias-label-tertiary)}",
				".dpu-provider-body{display:flex;flex-direction:column;gap:4px;min-width:0;padding:2px 0 3px 14px}",
				".dpu-provider-error{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}",
				".dpu-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}",
				".dpu-dot.dpu-ok{background:var(--dsw-alias-state-success-primary)}",
				".dpu-dot.dpu-error{background:var(--dsw-alias-state-error-primary)}",
				".dpu-dot.dpu-warn{background:var(--dsw-alias-state-warn-primary)}",
				".dpu-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}",
				".dpu-account{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dpu-plan{flex:none;padding:0 4px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-size:9px;line-height:14px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
				".dpu-badge{flex:none;padding:0 5px;border-radius:8px;font-size:9px;line-height:15px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;cursor:default}",
				".dpu-row{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".dpu-row-label{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}",
				".dpu-row-label b{font-weight:500;color:var(--dsw-alias-label-primary)}",
				".dpu-meta{display:flex;align-items:center;gap:6px;min-width:0}",
				".dpu-meta .dpu-bars{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
				".dpu-meta>span{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}",
				".dpu-track{box-sizing:border-box;flex:none;height:5px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden}",
				".dpu-fill{height:100%;border-radius:3px;transition:width .4s ease}",
				".dpu-timetrack{box-sizing:border-box;flex:none;display:flex;width:100%;height:5px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-border-l2)}",
				".dpu-timeelapsed{height:100%;flex:none;background:var(--dsw-alias-border-l2);border-radius:3px;transition:width .4s ease}",
				".dpu-timeremain{height:100%;flex:1 1 auto;min-width:0;background:var(--dsw-static-deepseek-450, #5686fe);border-radius:3px;transition:width .4s ease}",
				".dpu-err{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}",
				".dpu-ok{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
				".dpu-rail{box-sizing:border-box;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:10px;font-weight:700;color:var(--dsw-alias-label-primary);cursor:default}",
				".dpu-rail:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dpu-update{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);text-decoration:none;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}",
				".dpu-toast{position:absolute;top:var(--dsh-frame-overlay-top, 68px);right:20px;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:min(380px, calc(100vw - 40px));max-height:min(70vh, 520px);overflow:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3, #16181d);box-shadow:0 12px 32px rgba(0,0,0,.2);color:var(--dsw-alias-label-primary);pointer-events:auto;animation:dpu-toast-in .18s ease}",
				".dpu-toast-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}",
				".dpu-toast-title{font-size:12px;font-weight:600;line-height:18px}",
				".dpu-toast-close{cursor:pointer;border:none;background:none;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:18px}",
				".dpu-toast-close:hover{color:var(--dsw-alias-label-primary)}",
				".dpu-toast-provider{display:flex;flex-direction:column;gap:3px;min-width:0;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2)}",
				".dpu-toast-provider:first-of-type{border-top:none;padding-top:0}",
				".dpu-toast-provider-head{display:flex;align-items:center;gap:5px;min-width:0}",
				".dpu-toast-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;line-height:16px}",
				".dpu-toast-balance{margin-left:auto;flex:none;padding:0 5px;border-radius:6px;font-size:9px;line-height:15px;font-weight:600;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}",
				".dpu-toast-change{flex:none;font-size:9px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
				".dpu-toast-windows{display:flex;flex-wrap:wrap;gap:2px 8px;min-width:0;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}",
				".dpu-toast-window{white-space:nowrap}",
				".dpu-toast-window b{font-weight:500;color:var(--dsw-alias-label-primary)}",
				".dpu-toast-window.dpu-over{color:var(--dsw-alias-state-error-primary)}",
				".dpu-toast-window.dpu-over b{color:var(--dsw-alias-state-error-primary)}",
				".dpu-toast-line{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}",
				".dpu-toast-error{font-size:10px;line-height:15px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}",
				"@keyframes dpu-toast-in{0%{opacity:0;transform:translateY(-4px)}100%{opacity:1;transform:none}}"
			].join("");
			document.head.appendChild(tag);
		}

		// ── locale dictionaries ──
		const NS = "dsh-multi-provider-usage";
		const zh = {
			"window.rolling": "滚动窗口 (5h)",
			"window.five-hour": "滚动窗口 (5h)",
			"window.weekly": "周窗口",
			"window.monthly": "月窗口",
			"window.mcp": "MCP 工具 (月)",
			"window.token": "Token 窗口",
			"window.other": "其他窗口",
			"window.rolling.hint": "5h",
			"window.five-hour.hint": "5h",
			"window.mcp.hint": "月",
			"time.soon": "即将重置",
			"time.minutes": "{n}分",
			"time.hours": "{n}小时{m}分",
			"time.days": "{n}天{m}小时",
			"time.elapsed.title": "本窗口时间进度:已流逝 {pct}%,剩余 {rest}%",
			"refresh": "刷新",
			"loading": "加载中…",
			"error": "错误",
			"noProviders": "未启用任何服务商。请在插件设置中启用。",
			"provider.opencode-go": "OpenCode GO",
			"provider.command-code": "Command Code",
			"provider.glm": "GLM Code Plan",
			"status.ok": "正常",
			"status.exceeded": "已超限",
			"status.rate-limited": "限流中",
			"status.error": "失败",
			"status.disabled": "已禁用",
			"status.unknown": "未知",
			"rail.plain": "用量",
			"rail.all": "服务商用量:{summary}",
			"rail.error": "{provider}: 读取失败",
			"rail.title": "{provider} · {pct}%",
			"rail.title.account": "{provider} · {account} · {pct}%",
			"widget.brand": "服务商用量",
			"widget.account.title": "当前账号:{name}",
			"widget.fallback": "内置",
			"widget.fallback.title": "实际来源:{source};请求来源:{requested};回退原因:{reason}{message}",
			"balance.extra": "充值余额",
			"balance.zen": "充值余额",
			"balance.short": "余额",
			"balance.none": "余额 —",
			"balance.title": "订阅外充值余额 {amount}(来源:{source})",
			"balance.none.title": "充值余额不可用:{error}",
			"turnUsage.title": "本轮用量",
			"turnUsage.close": "关闭",
			"turnUsage.loading": "正在读取用量…",
			"turnUsage.failed": "读取用量失败:{error}",
			"turnUsage.none": "该服务商未启用",
			"turnUsage.hint": "本对话使用了以下服务商",
			"turnUsage.balanceChange": "本轮",
			"turnUsage.balanceChange.title": "本轮开始 {from} → 现在 {to}",
			"turnUsage.window.5h": "5h",
			"turnUsage.window.week": "周",
			"turnUsage.window.month": "月",
			"turnUsage.window.mcp": "MCP",
			"widget.noData": "暂无数据",
			"source.opencode-go": "dsh-opencode-go 当前账号",
			"source.builtin": "DSH 内置提供商",
			"reason.not-installed": "未安装 dsh-opencode-go",
			"reason.entry-disabled": "dsh-opencode-go 已禁用",
			"reason.service-unavailable": "宿主服务不可用",
			"reason.read-failed": "读取额度失败",
			"reason.invalid-response": "额度数据不合法",
			"reason.unknown": "未知原因",
			"update.available": "新版本 v{v}",
			"update.title": "点击查看升级说明",

			// settings page (Plugins panel)
			"cfg.summary": "在一个侧边栏组件中查看 OpenCode GO、Command Code 与 GLM Code Plan 的套餐用量。",
			"cfg.title": "服务商用量设置",
			"cfg.lead": "选择要显示的服务商、凭据引用与接口地址。保存后立即生效,无需重启。API Key 保存在 DSH 凭据域中,不会出现在这里。",
			"cfg.providers": "服务商",
			"cfg.general": "通用",
			"cfg.console": "订阅外充值余额",
			"cfg.console.enabled": "查询 OpenCode Zen 充值余额",
			"cfg.console.credential": "控制台凭据引用 (可选)",
			"cfg.console.orgId": "控制台组织 ID (可选)",
			"cfg.console.authFile": "OpenCode auth.json (可选)",
			"cfg.console.hint": "默认从 OPENCODE_CONSOLE_TOKEN 或本机 OpenCode 登录态读取;只读余额,不展示令牌。",
			"cfg.console.status": "充值余额",
			"cfg.enabled": "启用",
			"cfg.credential": "凭据引用 (apiKeyEnv)",
			"cfg.credential.hint": "环境变量 / DSH credential 名称,例如 OPENCODE_GO_API_KEY。",
			"cfg.baseUrl": "接口地址 (baseUrl)",
			"cfg.authFile": "CLI 登录文件 (可选)",
			"cfg.authFile.hint": "留空则使用 ~/.commandcode/auth.json。",
			"cfg.region": "区域",
			"cfg.region.auto": "自动 (先 z.ai,再 bigmodel)",
			"cfg.region.zai": "Z.ai (国际)",
			"cfg.region.bigmodel": "BigModel (中国)",
			"cfg.region.custom": "自定义 (使用接口地址)",
			"cfg.opencodeGoSource": "OpenCode GO 来源",
			"cfg.opencodeGoSource.opencode-go": "优先 dsh-opencode-go 当前账号",
			"cfg.opencodeGoSource.builtin": "始终使用内置接口",
			"cfg.defaultProvider": "置顶服务商",
			"cfg.defaultProvider.auto": "自动 (宿主顺序)",
			"cfg.cacheMs": "缓存时间 (毫秒)",
			"cfg.updateCheck": "检查 npm 新版本",
			"cfg.injectSessionHeader": "注入 x-opencode-session (OpenCode GO)",
			"cfg.status": "检测状态",
			"cfg.status.configured": "已配置",
			"cfg.status.notConfigured": "未配置",
			"cfg.status.enabled": "已启用",
			"cfg.status.disabled": "已禁用",
			"cfg.status.account": "账号",
			"cfg.status.source": "来源",
			"cfg.status.fallback": "回退",
			"cfg.status.none": "无",
			"cfg.status.unknown": "—",
			"cfg.loading": "正在加载设置…",
			"cfg.save": "保存",
			"cfg.saving": "保存中…",
			"cfg.reload": "重新加载",
			"cfg.reloading": "加载中…",
			"cfg.reloaded": "已重新加载。",
			"cfg.retry": "重试",
			"cfg.saved": "已保存,设置已更新。",
			"cfg.noChanges": "没有需要保存的更改。",
			"cfg.unsaved": "未保存",
			"cfg.conflict": "保存冲突:设置已被其他会话修改,请点击「重新加载」后再保存。",
			"cfg.saveFailed": "保存失败:{error}",
			"cfg.loadFailed": "加载设置失败:{error}",
			"cfg.unsupported": "宿主未提供设置描述符 (503)。请确认插件以 profile 条目安装,且 schemastery 版本 ≥ 3.18.4。",
			"cfg.revision": "revision {n}",
			"cfg.hint.missing": "未检测到该服务商:启用后仍需配置凭据。"
		};
		const en = {
			"window.rolling": "Rolling (5h)",
			"window.five-hour": "Rolling (5h)",
			"window.weekly": "Weekly",
			"window.monthly": "Monthly",
			"window.mcp": "MCP tools (monthly)",
			"window.token": "Token window",
			"window.other": "Other window",
			"window.rolling.hint": "5h",
			"window.five-hour.hint": "5h",
			"window.mcp.hint": "mo",
			"time.soon": "resets soon",
			"time.minutes": "{n}m",
			"time.hours": "{n}h{m}m",
			"time.days": "{n}d{m}h",
			"time.elapsed.title": "Window time: {pct}% elapsed, {rest}% left",
			"refresh": "Refresh",
			"loading": "Loading…",
			"error": "Error",
			"noProviders": "No providers are enabled. Enable one in the plugin settings.",
			"provider.opencode-go": "OpenCode GO",
			"provider.command-code": "Command Code",
			"provider.glm": "GLM Code Plan",
			"status.ok": "ok",
			"status.exceeded": "exceeded",
			"status.rate-limited": "rate-limited",
			"status.error": "failed",
			"status.disabled": "disabled",
			"status.unknown": "unknown",
			"rail.plain": "Usage",
			"rail.all": "Provider usage: {summary}",
			"rail.error": "{provider}: read failed",
			"rail.title": "{provider} · {pct}%",
			"rail.title.account": "{provider} · {account} · {pct}%",
			"widget.brand": "Provider usage",
			"widget.account.title": "Active account: {name}",
			"widget.fallback": "Built-in",
			"widget.fallback.title": "Effective source: {source}; requested: {requested}; fallback reason: {reason}{message}",
			"balance.extra": "Top-up",
			"balance.zen": "Top-up",
			"balance.short": "Bal.",
			"balance.none": "Balance —",
			"balance.title": "Top-up balance {amount} (source: {source})",
			"balance.none.title": "Top-up balance unavailable: {error}",
			"turnUsage.title": "Turn usage",
			"turnUsage.close": "Close",
			"turnUsage.loading": "Reading usage…",
			"turnUsage.failed": "Could not read usage: {error}",
			"turnUsage.none": "Provider is not enabled",
			"turnUsage.hint": "This conversation used",
			"turnUsage.balanceChange": "this turn",
			"turnUsage.balanceChange.title": "Turn start {from} → now {to}",
			"turnUsage.window.5h": "5h",
			"turnUsage.window.week": "W",
			"turnUsage.window.month": "M",
			"turnUsage.window.mcp": "MCP",
			"widget.noData": "No data",
			"source.opencode-go": "dsh-opencode-go current account",
			"source.builtin": "DSH built-in provider",
			"reason.not-installed": "dsh-opencode-go not installed",
			"reason.entry-disabled": "dsh-opencode-go disabled",
			"reason.service-unavailable": "host service unavailable",
			"reason.read-failed": "quota read failed",
			"reason.invalid-response": "invalid quota response",
			"reason.unknown": "unknown reason",
			"update.available": "v{v} available",
			"update.title": "Click for upgrade instructions",

			// settings page (Plugins panel)
			"cfg.summary": "OpenCode GO, Command Code and GLM Code Plan plan usage in one sidebar widget.",
			"cfg.title": "Provider usage settings",
			"cfg.lead": "Choose which providers to show, their credential refs and endpoints. Changes apply immediately; no restart needed. API keys stay in the DSH credentials domain and are never shown here.",
			"cfg.providers": "Providers",
			"cfg.general": "General",
			"cfg.console": "Top-up balance",
			"cfg.console.enabled": "Read OpenCode Zen top-up balance",
			"cfg.console.credential": "Console credential ref (optional)",
			"cfg.console.orgId": "Console org id (optional)",
			"cfg.console.authFile": "OpenCode auth.json (optional)",
			"cfg.console.hint": "Defaults to OPENCODE_CONSOLE_TOKEN, then the local OpenCode login. Only the balance is read; the token is never shown.",
			"cfg.console.status": "Top-up balance",
			"cfg.enabled": "Enabled",
			"cfg.credential": "Credential ref (apiKeyEnv)",
			"cfg.credential.hint": "Environment / DSH credential name, e.g. OPENCODE_GO_API_KEY.",
			"cfg.baseUrl": "Endpoint (baseUrl)",
			"cfg.authFile": "CLI auth file (optional)",
			"cfg.authFile.hint": "Empty uses ~/.commandcode/auth.json.",
			"cfg.region": "Region",
			"cfg.region.auto": "Auto (z.ai first, then bigmodel)",
			"cfg.region.zai": "Z.ai (international)",
			"cfg.region.bigmodel": "BigModel (China)",
			"cfg.region.custom": "Custom (use endpoint)",
			"cfg.opencodeGoSource": "OpenCode GO source",
			"cfg.opencodeGoSource.opencode-go": "Prefer dsh-opencode-go current account",
			"cfg.opencodeGoSource.builtin": "Always use the built-in endpoint",
			"cfg.defaultProvider": "Pinned provider",
			"cfg.defaultProvider.auto": "Auto (host order)",
			"cfg.cacheMs": "Cache TTL (ms)",
			"cfg.updateCheck": "Check npm for updates",
			"cfg.injectSessionHeader": "Inject x-opencode-session (OpenCode GO)",
			"cfg.status": "Detection status",
			"cfg.status.configured": "configured",
			"cfg.status.notConfigured": "not configured",
			"cfg.status.enabled": "enabled",
			"cfg.status.disabled": "disabled",
			"cfg.status.account": "Account",
			"cfg.status.source": "Source",
			"cfg.status.fallback": "Fallback",
			"cfg.status.none": "none",
			"cfg.status.unknown": "—",
			"cfg.loading": "Loading settings…",
			"cfg.save": "Save",
			"cfg.saving": "Saving…",
			"cfg.reload": "Reload",
			"cfg.reloading": "Loading…",
			"cfg.reloaded": "Reloaded.",
			"cfg.retry": "Retry",
			"cfg.saved": "Saved — settings updated.",
			"cfg.noChanges": "Nothing to save.",
			"cfg.unsaved": "unsaved",
			"cfg.conflict": "Save conflict: the settings were changed by another session. Click Reload, then save again.",
			"cfg.saveFailed": "Save failed: {error}",
			"cfg.loadFailed": "Failed to load settings: {error}",
			"cfg.unsupported": "The host exposes no settings descriptor (503). Make sure the plugin is installed as a profile entry and schemastery is ≥ 3.18.4.",
			"cfg.revision": "revision {n}",
			"cfg.hint.missing": "Provider not detected — enable it and configure a credential."
		};

		// ── data helpers ──────────────────────────────────────────────────
		const PROVIDER_META = [
			{ id: "opencode-go", short: "GO" },
			{ id: "command-code", short: "CC" },
			{ id: "glm", short: "GLM" }
		];

		/** Fraction of the window ALREADY elapsed, derived from its reset time. */
		function timeElapsedFraction(resetsAt, windowMs) {
			if (!resetsAt || !windowMs) return null;
			const reset = new Date(resetsAt).getTime();
			if (!Number.isFinite(reset)) return null;
			const elapsed = (windowMs - (reset - Date.now())) / windowMs;
			return Math.max(0, Math.min(1, elapsed));
		}

		/** Short human relative time until `iso`, localized. */
		function timeUntil(iso, t) {
			const target = new Date(iso).getTime();
			if (!Number.isFinite(target)) return "";
			const diff = target - Date.now();
			if (diff <= 0) return t("time.soon");
			const mins = Math.floor(diff / 60000);
			if (mins < 60) return t("time.minutes", { n: mins });
			const hours = Math.floor(mins / 60);
			if (hours < 24) return t("time.hours", { n: hours, m: mins % 60 });
			return t("time.days", { n: Math.floor(hours / 24), m: hours % 24 });
		}

		/** Fill color by usage percent — themed alias tokens (light/dark safe). */
		function fillColor(percent) {
			if (percent >= 90) return "var(--dsw-alias-state-error-primary)";
			if (percent >= 70) return "var(--dsw-alias-state-warn-primary)";
			return "var(--dsw-alias-state-success-primary)";
		}

		// ── defensive display helpers ─────────────────────────────────────
		function asText(value) {
			if (typeof value === "string") return value;
			if (value === null || value === undefined) return "";
			return String(value);
		}

		/** One-decimal display percentage; null/NaN renders as an em dash. */
		function formatPercent(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			const rounded = Math.round(value * 10) / 10;
			return String(rounded);
		}

		/** Format a provider balance for the badge. */
		function formatMoney(balance) {
			if (!balance || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) return "";
			const amount = balance.amount.toFixed(2);
			return balance.currency === "USD" || !balance.currency ? "$" + amount : amount + " " + balance.currency;
		}

		/** Snapshot the current balances keyed by provider id. */
		function balancesFromProviders(providers) {
			const out = {};
			for (const provider of providers ?? []) {
				const balance = provider?.balance;
				if (!balance || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) continue;
				out[provider.id] = {
					amount: balance.amount,
					currency: typeof balance.currency === "string" && balance.currency.length > 0 ? balance.currency : "USD"
				};
			}
			return out;
		}

		/** Balance delta from the turn-start snapshot to the refreshed provider. */
		function balanceChangeFor(baseline, provider) {
			const balance = provider?.balance;
			const before = baseline?.[provider?.id];
			if (!balance || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) return null;
			if (!before || typeof before.amount !== "number" || !Number.isFinite(before.amount)) return null;
			const currency = typeof balance.currency === "string" && balance.currency.length > 0 ? balance.currency : "USD";
			const beforeCurrency = typeof before.currency === "string" && before.currency.length > 0 ? before.currency : "USD";
			if (currency !== beforeCurrency) return null;
			const raw = balance.amount - before.amount;
			if (!Number.isFinite(raw)) return null;
			// Money is displayed in cents; rounding here keeps 5.14 - 4.88 from
			// surfacing as -0.2600000000000006.
			const amount = Math.round(raw * 100) / 100;
			return { amount, currency, from: before.amount, to: balance.amount };
		}

		/** Signed money for the per-turn balance delta. */
		function formatSignedMoney(change) {
			if (!change || typeof change.amount !== "number" || !Number.isFinite(change.amount)) return "";
			const amount = Math.abs(change.amount) < 0.005 ? 0 : change.amount;
			const absolute = Math.abs(amount).toFixed(2);
			const sign = amount < 0 ? "-" : amount > 0 ? "+" : "";
			return change.currency === "USD" || !change.currency ? sign + "$" + absolute : sign + absolute + " " + change.currency;
		}

		/** The window whose percentage is shown on the collapsed rail. */
		function primaryWindow(provider) {
			if (!provider || !Array.isArray(provider.windows)) return null;
			return provider.windows.find((window) => window.key === "monthly")
				?? provider.windows.find((window) => window.key === "rolling" || window.key === "five-hour")
				?? provider.windows[0]
				?? null;
		}

		function primaryPercent(provider) {
			const window = primaryWindow(provider);
			return window && typeof window.percent === "number" ? window.percent : null;
		}

		function statusText(t, status) {
			const key = "status." + (typeof status === "string" && status !== "" ? status : "unknown");
			const label = t(key);
			if (label !== key) return label;
			return typeof status === "string" && status !== "" ? status : t("status.unknown");
		}

		function sourceLabel(t, source) {
			if (source === "opencode-go") return t("source.opencode-go");
			if (source === "builtin") return t("source.builtin");
			return asText(source);
		}

		function reasonLabel(t, reason) {
			const key = "reason." + (typeof reason === "string" && reason !== "" ? reason : "unknown");
			const label = t(key);
			return label === key ? t("reason.unknown") : label;
		}

		function fallbackTitle(t, fallback, source) {
			const requested = fallback && (fallback.from === "builtin" || fallback.from === "opencode-go") ? fallback.from : source;
			const raw = asText(fallback && fallback.message);
			return t("widget.fallback.title", {
				source: sourceLabel(t, source),
				requested: sourceLabel(t, requested),
				reason: reasonLabel(t, fallback && fallback.reason),
				message: raw === "" ? "" : " · " + raw
			});
		}

		function providerStatusClass(provider) {
			if (provider?.status === "error") return "dpu-dot dpu-error";
			if (provider?.status === "ok") return "dpu-dot dpu-ok";
			return "dpu-dot dpu-warn";
		}

		function providerPctText(provider) {
			const pct = primaryPercent(provider);
			return pct === null ? "—" : formatPercent(pct) + "%";
		}

		/** Compact balance label for a provider header (empty when unavailable). */
		function formatBalanceShort(t, provider) {
			const balance = provider?.balance;
			if (!balance || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) return "";
			return t("balance.short") + " " + formatMoney(balance);
		}

		function collapseStorageKey() {
			return PACKAGE_NAME + ":collapsed";
		}

		function readCollapsedProviders() {
			try {
				const raw = window.localStorage.getItem(collapseStorageKey());
				const parsed = raw === null ? [] : JSON.parse(raw);
				return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
			} catch (_error) {
				return new Set();
			}
		}

		function storeCollapsedProviders(value) {
			try {
				window.localStorage.setItem(collapseStorageKey(), JSON.stringify([...value]));
			} catch (_error) {
				// private mode / storage disabled: collapse state is session-only
			}
		}

		/** Apply the configured preferred provider as the first section. */
		function orderedProviders(data) {
			const providers = data && Array.isArray(data.providers) ? data.providers : [];
			const preferred = data && typeof data.defaultProvider === "string" ? data.defaultProvider : "auto";
			if (preferred === "auto") return providers;
			const first = providers.find((provider) => provider.id === preferred);
			return first === undefined ? providers : [first, ...providers.filter((provider) => provider !== first)];
		}

		function railSummary(t, providers) {
			return providers.map((provider) => {
				const name = provider.name || t("provider." + provider.id);
				const pct = primaryPercent(provider);
				const money = formatMoney(provider.balance);
				return name + " " + (pct === null ? "—" : formatPercent(pct) + "%") + (money === "" ? "" : " · " + money);
			}).join(" · ");
		}

		const USAGE_PROVIDER_NAMES = {
			"opencode-go": "OpenCode GO",
			"command-code": "Command Code",
			"glm": "GLM Code Plan"
		};

		/** Map one DSH provider route to this plugin's provider id. */
		function usageProviderFor(provider) {
			const value = typeof provider === "string" ? provider.trim().toLowerCase() : "";
			if (value.length === 0) return null;
			if (value.includes("opencode")) return "opencode-go";
			if (value.includes("command") || value.includes("cmdcode") || value.includes("cmd-code")) return "command-code";
			if (value.includes("zai") || value.includes("z-ai") || value.includes("glm") || value.includes("zhipu") || value.includes("bigmodel")) return "glm";
			return null;
		}

		/** Fold one durable session event into the current turn's provider set. */
		function turnUsageStep(used, event) {
			const next = new Set(used);
			if (!event || typeof event.type !== "string") return { used: next, show: null };
			if (event.type === "turn/start") return { used: new Set(), show: null };
			if (event.type === "assistant/message") {
				const source = event.data && event.data.message ? event.data.message.source : null;
				const id = usageProviderFor(source && source.provider);
				if (id !== null) next.add(id);
				return { used: next, show: null };
			}
			if (event.type === "turn/end") return { used: new Set(), show: next.size > 0 ? [...next] : null };
			return { used: next, show: null };
		}

		/** The session id currently selected in the main view, if any. */
		function currentUsageSessionId(uiSession) {
			try {
				const snapshot = uiSession && uiSession.current ? uiSession.current.getSnapshot() : null;
				return snapshot && typeof snapshot.key === "string" && snapshot.key.length > 0 ? snapshot.key : null;
			} catch (_error) {
				return null;
			}
		}

		/** Compact window label used by the turn-usage toast. */
		function toastWindowLabel(t, window) {
			if (window.key === "rolling" || window.key === "five-hour") return t("turnUsage.window.5h");
			if (window.key === "weekly") return t("turnUsage.window.week");
			if (window.key === "monthly") return t("turnUsage.window.month");
			if (window.key === "mcp") return t("turnUsage.window.mcp");
			return windowLabel(t, window);
		}

		/**
		 * Create the floating "turn usage" card. It watches the current session's
		 * durable event stream: `assistant/message` events contribute their
		 * provider route, and `turn/end` triggers one usage read for the routes
		 * that map to OpenCode GO, Command Code or GLM Code Plan.
		 */
		function createTurnUsageToast(deps) {
			return function TurnUsageToast(props) {
				const t = translateFor(props);
				const tRef = react.useRef(t);
				tRef.current = t;
				const [sessionId, setSessionId] = react.useState(() => currentUsageSessionId(deps.uiSession));
				const [toast, setToast] = react.useState(null);
				const timerRef = react.useRef(null);
				const toastSeq = react.useRef(0);
				const mountedRef = react.useRef(true);
				const baselineRef = react.useRef(null);
				const baselinePromiseRef = react.useRef(null);
				const baselineSeq = react.useRef(0);

				const clearTimer = () => {
					if (timerRef.current !== null) {
						window.clearTimeout(timerRef.current);
						timerRef.current = null;
					}
				};

				const dismiss = react.useCallback(() => {
					toastSeq.current += 1;
					clearTimer();
					setToast(null);
				}, []);

				const fetchUsageProviders = react.useCallback(async (force) => {
					const res = await fetch("/provider-usage/usage" + (force ? "?refresh=1" : ""), { cache: "no-store" });
					const json = await res.json().catch(() => null);
					if (json === null) throw new Error("HTTP " + res.status);
					if (json.error && (!Array.isArray(json.providers) || json.providers.length === 0)) {
						throw new Error(String(json.error));
					}
					return Array.isArray(json.providers) ? json.providers : [];
				}, []);

				const captureBaseline = react.useCallback(() => {
					const seq = ++baselineSeq.current;
					baselineRef.current = null;
					const promise = fetchUsageProviders(false)
						.then((providers) => {
							const balances = balancesFromProviders(providers);
							if (seq === baselineSeq.current) baselineRef.current = balances;
							return balances;
						})
						.catch(() => null);
					baselinePromiseRef.current = promise;
				}, [fetchUsageProviders]);

				const showUsage = react.useCallback(async (ids, turnId, baselinePromise) => {
					const seq = ++toastSeq.current;
					clearTimer();
					setToast({ status: "loading", ids });
					let baseline = null;
					try {
						baseline = baselinePromise === null ? baselineRef.current : await baselinePromise;
					} catch (_error) {
						baseline = null;
					}
					let next;
					try {
						const all = await fetchUsageProviders(true);
						const providers = ids.map((id) => {
							const found = all.find((provider) => provider.id === id);
							if (found === undefined) {
								return {
									id,
									name: USAGE_PROVIDER_NAMES[id] || id,
									status: "error",
									error: tRef.current("turnUsage.none"),
									windows: []
								};
							}
							const change = balanceChangeFor(baseline, found);
							return change === null ? found : { ...found, balanceChange: change };
						});
						next = { status: "ready", providers };
					} catch (error) {
						next = {
							status: "error",
							error: tRef.current("turnUsage.failed", { error: error instanceof Error ? error.message : String(error) })
						};
					}
					if (!mountedRef.current || seq !== toastSeq.current || turnId !== baselineSeq.current) return;
					setToast(next);
					timerRef.current = window.setTimeout(() => {
						if (seq === toastSeq.current) setToast(null);
					}, 12000);
				}, [fetchUsageProviders]);

				react.useEffect(() => {
					mountedRef.current = true;
					return () => {
						mountedRef.current = false;
						toastSeq.current += 1;
						if (timerRef.current !== null) window.clearTimeout(timerRef.current);
					};
				}, []);

				react.useEffect(() => {
					const source = deps.uiSession && deps.uiSession.current;
					if (!source || typeof source.subscribe !== "function") return;
					const update = () => {
						setSessionId(currentUsageSessionId(deps.uiSession));
						baselineRef.current = null;
						baselinePromiseRef.current = null;
						baselineSeq.current += 1;
					};
					update();
					return source.subscribe(update);
				}, []);

				react.useEffect(() => {
					if (sessionId === null) return;
					let binding = null;
					try {
						binding = deps.sessions && typeof deps.sessions.binding === "function" ? deps.sessions.binding(sessionId) : null;
					} catch (_error) {
						binding = null;
					}
					const eventSource = binding && binding.eventSource;
					if (!eventSource || typeof eventSource.subscribe !== "function") return;
					let used = new Set();
					const stop = eventSource.subscribe(() => {
						const snapshot = eventSource.getSnapshot();
						const change = snapshot && snapshot.change;
						if (!change || change.kind !== "append" || !Array.isArray(change.entries)) return;
						for (const entry of change.entries) {
							const event = entry && entry.event ? entry.event : entry;
							if (event && event.type === "turn/start") captureBaseline();
							const step = turnUsageStep(used, event);
							used = step.used;
							if (step.show !== null) {
								void showUsage(step.show, baselineSeq.current, baselinePromiseRef.current);
							}
						}
					});
					return () => stop();
				}, [sessionId, showUsage, captureBaseline]);

				if (toast === null) return null;
				const providers = toast.providers || [];
				const lines = providers.map((provider) => {
					const windows = providerWindows(provider).map((window) => {
						const over = window.status !== "ok" && window.status !== undefined;
						return react_jsx_runtime.jsx("span", {
							className: over ? "dpu-toast-window dpu-over" : "dpu-toast-window",
							title: statusText(t, window.status),
							children: [
								react_jsx_runtime.jsx("b", { children: toastWindowLabel(t, window) }),
								" " + formatPercent(window.percent) + "%"
							]
						}, window.key);
					});
					const balance = provider.balance && typeof provider.balance.amount === "number"
						? formatMoney(provider.balance)
						: "";
					const change = provider.balanceChange && typeof provider.balanceChange.amount === "number"
						? provider.balanceChange
						: null;
					return react_jsx_runtime.jsx("div", {
						className: "dpu-toast-provider",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "dpu-toast-provider-head",
								children: [
									react_jsx_runtime.jsx("span", { className: providerStatusClass(provider) }),
									react_jsx_runtime.jsx("span", {
										className: "dpu-toast-name",
										children: provider.name || USAGE_PROVIDER_NAMES[provider.id] || provider.id
									}),
									balance === "" ? null : react_jsx_runtime.jsx("span", {
										className: "dpu-toast-balance",
										children: t("balance.short") + " " + balance
									}),
									change === null ? null : react_jsx_runtime.jsx("span", {
										className: "dpu-toast-change",
										title: t("turnUsage.balanceChange.title", {
											from: formatMoney({ amount: change.from, currency: change.currency }),
											to: formatMoney({ amount: change.to, currency: change.currency })
										}),
										children: "(" + t("turnUsage.balanceChange") + " " + formatSignedMoney(change) + ")"
									})
								]
							}),
							provider.status === "error"
								? react_jsx_runtime.jsx("div", {
									className: "dpu-toast-error",
									children: asText(provider.error) || t("turnUsage.none")
								})
								: react_jsx_runtime.jsx("div", {
									className: "dpu-toast-windows",
									children: windows.length > 0 ? windows : t("widget.noData")
								})
						]
					}, provider.id);
				});

				return react_jsx_runtime.jsx("div", {
					className: "dpu-toast",
					role: "status",
					"aria-live": "polite",
					children: [
						react_jsx_runtime.jsx("div", {
							className: "dpu-toast-head",
							children: [
								react_jsx_runtime.jsx("span", { className: "dpu-toast-title", children: t("turnUsage.title") }),
								react_jsx_runtime.jsx("button", {
									type: "button",
									className: "dpu-toast-close",
									onClick: dismiss,
									title: t("turnUsage.close"),
									children: "×"
								})
							]
						}),
						react_jsx_runtime.jsx("div", { className: "dpu-toast-line", children: t("turnUsage.hint") }),
						toast.status === "loading"
							? react_jsx_runtime.jsx("div", { className: "dpu-toast-line", children: t("turnUsage.loading") })
							: null,
						toast.status === "error"
							? react_jsx_runtime.jsx("div", { className: "dpu-toast-error", children: toast.error })
							: null,
						lines
					]
				});
			};
		}

		function registerTurnUsageToast(ctx) {
			if (typeof ctx.get !== "function") return;
			let timer = null;
			let done = false;
			let attempts = 0;
			const attempt = () => {
				if (done) return;
				let sessions = null;
				let uiSession = null;
				try {
					sessions = ctx.get("sessions");
					uiSession = ctx.get("uiSession");
				} catch (_error) {
					sessions = null;
					uiSession = null;
				}
				if (!sessions || !uiSession) {
					// Client plugins can apply before the session controller does;
					// retry briefly instead of silently losing the card.
					if (attempts < 40) {
						attempts += 1;
						timer = window.setTimeout(attempt, 250);
					}
					return;
				}
				done = true;
				const component = createTurnUsageToast({ sessions, uiSession });
				try {
					ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay",
						id: PACKAGE_NAME + ":turn-usage",
						order: 100,
						locale: NS
					}, component));
				} catch (_error) {
					// older host without a shell overlay slot: the widget still works
				}
			};
			ctx.effect(() => {
				attempt();
				return () => {
					done = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, "dsh-multi-provider-usage: turn usage toast");
		}

		function providerTitle(t, provider) {
			const parts = [provider.name || t("provider." + provider.id), providerPctText(provider)];
			const account = provider.account && typeof provider.account.name === "string" ? provider.account.name.trim() : "";
			if (account !== "") parts.push(account);
			const plan = provider.plan && typeof provider.plan.name === "string" ? provider.plan.name.trim() : "";
			if (plan !== "") parts.push(plan);
			const money = formatMoney(provider.balance);
			if (money !== "") parts.push(money);
			if (provider.status === "error" && typeof provider.error === "string") parts.push(provider.error);
			return parts.join(" · ");
		}

		/** Detect zh vs en for the tests and for hosts without a locale seat. */
		function detectLang() {
			try {
				const lang = (typeof document !== "undefined" && document.documentElement && document.documentElement.lang)
					|| (typeof navigator !== "undefined" && navigator.language)
					|| "";
				return String(lang).toLowerCase();
			} catch (_error) {
				return "";
			}
		}

		function fallbackT(key, params) {
			const table = detectLang().indexOf("zh") === 0 ? zh : en;
			let raw = table[key] !== undefined ? table[key] : zh[key] !== undefined ? zh[key] : key;
			if (params === null || params === undefined) return raw;
			return String(raw).replace(/\{(\w+)\}/g, (match, name) => (params[name] === null || params[name] === undefined ? "" : String(params[name])));
		}

		function translateFor(props) {
			return props && typeof props.t === "function" ? props.t : fallbackT;
		}

		/** Applicable windows for a provider, skipping malformed rows. */
		function providerWindows(provider) {
			return Array.isArray(provider?.windows)
				? provider.windows.filter((window) => window && typeof window.percent === "number")
				: [];
		}

		function windowLabel(t, window) {
			const key = typeof window.labelKey === "string" && window.labelKey.length > 0 ? window.labelKey : "window." + window.key;
			const label = t(key);
			const base = label === key ? asText(window.key) : label;
			return typeof window.note === "string" && window.note.length > 0 ? base + " · " + window.note : base;
		}

		// ── widget component ──────────────────────────────────────────────
		/**
		 * All enabled providers are stacked in one column. Each provider header
		 * collapses/expands its own body; collapse state is persisted locally.
		 * @param {{ wide?: boolean, t?: Function }} props - owner share from the
		 * sidebar (`sidebar.footer.action` is rendered with `{ wide }`) plus the
		 * locale translate seat declared by this registration.
		 */
		function Widget(props) {
			const t = props.t || ((key) => key);
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [stamp, setStamp] = react.useState(0);
			const [collapsed, setCollapsed] = react.useState(readCollapsedProviders);

			react.useEffect(() => {
				let alive = true;
				const load = async (force) => {
					try {
						const url = "/provider-usage/usage" + (force ? "?refresh=1" : "");
						const res = await fetch(url, { cache: "no-store" });
						const json = await res.json().catch(() => null);
						if (!alive) return;
						if (json === null || (typeof json.error === "string" && (!Array.isArray(json.providers) || json.providers.length === 0))) {
							setError(asText(json?.error) || "HTTP " + res.status);
							setData(null);
						} else {
							setData(json);
							setError(null);
						}
					} catch (e) {
						if (!alive) return;
						setError(asText(e && e.message) || String(e));
						setData(null);
					}
				};
				// The manual refresh forces one immediate upstream read; the
				// minute poll afterwards must use the host cache again.
				load(stamp > 0);
				const timer = window.setInterval(() => load(false), 60000);
				return () => { alive = false; window.clearInterval(timer); };
			}, [stamp]);

			// Slow tick purely for the time-remaining bars: they derive from
			// `Date.now()`, so without a re-render they would only move once per
			// 60 s poll. 30 s keeps them visibly progressing without busy work.
			const [, setTick] = react.useState(0);
			react.useEffect(() => {
				const timer = window.setInterval(() => setTick((n) => n + 1), 30000);
				return () => window.clearInterval(timer);
			}, []);

			const providers = orderedProviders(data);

			const toggleProvider = (id) => {
				setCollapsed((prev) => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					storeCollapsedProviders(next);
					return next;
				});
			};

			// Collapsed rail: a single compact badge summarising all providers.
			if (!props.wide) {
				const maxPct = providers.reduce((max, provider) => {
					const pct = primaryPercent(provider);
					return pct !== null && (max === null || pct > max) ? pct : max;
				}, null);
				const title = error !== null
					? error
					: providers.length === 0 ? t("rail.plain") : t("rail.all", { summary: railSummary(t, providers) });
				return react_jsx_runtime.jsx("div", {
					className: "dpu-rail",
					title: title,
					children: maxPct === null ? (providers.length === 0 ? "—" : t("rail.plain")) : formatPercent(maxPct) + "%"
				});
			}

			const sections = providers.map((provider) => {
				const isCollapsed = collapsed.has(provider.id);
				const pctText = providerPctText(provider);
				const balanceText = formatBalanceShort(t, provider);
				const balance = provider.balance && typeof provider.balance.amount === "number" ? provider.balance : null;
				const rawBalanceError = provider.meta && typeof provider.meta.balanceError === "string" ? provider.meta.balanceError : "";
				// A missing optional console credential is not a visible failure;
				// the settings page explains how to enable the balance.
				const balanceError = rawBalanceError !== "" && !/no console credential/i.test(rawBalanceError) ? rawBalanceError : "";

				const accountName = provider.account && typeof provider.account.name === "string" ? provider.account.name.trim() : "";
				const planName = provider.plan && typeof provider.plan.name === "string" ? provider.plan.name.trim() : "";
				const fallback = provider.fallback && typeof provider.fallback === "object" ? provider.fallback : null;

				const sub = [];
				if (accountName !== "") {
					sub.push(react_jsx_runtime.jsx("span", {
						className: "dpu-account",
						title: t("widget.account.title", { name: accountName }),
						children: accountName
					}, "account"));
				}
				if (planName !== "") sub.push(react_jsx_runtime.jsx("span", { className: "dpu-plan", children: planName }, "plan"));
				if (fallback !== null) {
					sub.push(react_jsx_runtime.jsx("span", {
						className: "dpu-badge",
						title: fallbackTitle(t, fallback, provider.source),
						children: t("widget.fallback")
					}, "fallback"));
				}

				const rows = [];
				if (provider.status === "ok") {
					for (const win of providerWindows(provider)) {
						const elapsed = timeElapsedFraction(win.resetsAt, win.windowMs);
						rows.push(react_jsx_runtime.jsx("div", {
							className: "dpu-row",
							children: [
								react_jsx_runtime.jsx("div", {
									className: "dpu-row-label",
									children: [
										react_jsx_runtime.jsx("b", { children: windowLabel(t, win) }),
										react_jsx_runtime.jsx("b", { children: formatPercent(win.percent) + "%" })
									]
								}),
								react_jsx_runtime.jsx("div", {
									className: "dpu-meta",
									children: [
										react_jsx_runtime.jsx("div", {
											className: "dpu-bars",
											children: [
												react_jsx_runtime.jsx("div", {
													className: "dpu-track",
													children: react_jsx_runtime.jsx("div", {
														className: "dpu-fill",
														style: {
															width: Math.max(0, Math.min(100, win.percent)) + "%",
															background: fillColor(win.percent)
														}
													})
												}),
												elapsed === null ? null : react_jsx_runtime.jsx("div", {
													className: "dpu-timetrack",
													title: t("time.elapsed.title", { pct: Math.round(elapsed * 100), rest: Math.round((1 - elapsed) * 100) }),
													children: [
														react_jsx_runtime.jsx("div", {
															className: "dpu-timeelapsed",
															style: { width: (elapsed * 100) + "%" }
														}),
														react_jsx_runtime.jsx("div", {
															className: "dpu-timeremain",
															style: { width: ((1 - elapsed) * 100) + "%" }
														})
													]
												})
											]
										}),
										react_jsx_runtime.jsx("span", {
											children: win.status === "ok"
												? (win.resetsAt ? timeUntil(win.resetsAt, t) : (win.hintKey ? t(win.hintKey) : ""))
												: statusText(t, win.status)
										})
									]
								})
							]
						}, win.key));
					}
				}

				const body = [];
				if (sub.length > 0) {
					body.push(react_jsx_runtime.jsx("div", { className: "dpu-sub", children: sub }, "sub"));
				}
				if (provider.status === "error") {
					const message = asText(provider.error) || t("status.error");
					body.push(react_jsx_runtime.jsx("div", {
						className: "dpu-provider-error",
						title: message,
						children: message
					}, "error"));
				} else if (rows.length === 0) {
					body.push(react_jsx_runtime.jsx("div", { className: "dpu-provider-error", children: t("widget.noData") }, "empty"));
				} else {
					body.push(react_jsx_runtime.jsx(react.Fragment, { children: rows }, "rows"));
				}

				const balanceBadge = balance !== null
					? react_jsx_runtime.jsx("span", {
						className: "dpu-provider-balance",
						title: t("balance.title", { amount: formatMoney(balance), source: asText(balance.source) }),
						children: balanceText
					}, "balance")
					: balanceError !== ""
						? react_jsx_runtime.jsx("span", {
							className: "dpu-provider-balance dpu-muted",
							title: t("balance.none.title", { error: balanceError }),
							children: t("balance.none")
						}, "balance-error")
						: null;

				return react_jsx_runtime.jsx("div", {
					className: "dpu-provider",
					children: [
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dpu-provider-head",
							onClick: () => toggleProvider(provider.id),
							title: providerTitle(t, provider),
							"aria-expanded": !isCollapsed,
							children: [
								react_jsx_runtime.jsx("span", {
									className: "dpu-chevron",
									children: isCollapsed ? "▸" : "▾"
								}),
								react_jsx_runtime.jsx("span", { className: providerStatusClass(provider) }),
								react_jsx_runtime.jsx("span", {
									className: "dpu-provider-name",
									children: provider.name || t("provider." + provider.id)
								}),
								react_jsx_runtime.jsx("span", {
									className: "dpu-provider-pct",
									children: pctText
								}),
								balanceBadge
							]
						}, "head"),
						isCollapsed ? null : react_jsx_runtime.jsx("div", { className: "dpu-provider-body", children: body }, "body")
					]
				}, provider.id);
			});

			return react_jsx_runtime.jsx("div", {
				className: "dpu-widget",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dpu-head",
						children: [
							react_jsx_runtime.jsx("span", { className: "dpu-brand", children: t("widget.brand") }),
							react_jsx_runtime.jsx("div", {
								className: "dpu-headright",
								children: [
									(data && data.update && data.update.available && data.update.latest
										? react_jsx_runtime.jsx("a", {
											className: "dpu-update",
											href: "https://www.npmjs.com/package/" + PACKAGE_NAME,
											target: "_blank",
											rel: "noreferrer",
											title: t("update.title"),
											children: t("update.available", { v: data.update.latest })
										})
										: null),
									react_jsx_runtime.jsx("button", {
										className: "dpu-refresh",
										onClick: () => setStamp(stamp + 1),
										children: t("refresh")
									})
								]
							})
						]
					}),
					sections.length > 0 ? react_jsx_runtime.jsx("div", { className: "dpu-providers", children: sections }) : null,
					error ? react_jsx_runtime.jsx("div", { className: "dpu-err", children: error }) : null,
					!error && data === null ? react_jsx_runtime.jsx("div", { className: "dpu-ok", children: t("loading") }) : null,
					data !== null && providers.length === 0
						? react_jsx_runtime.jsx("div", { className: "dpu-err", children: t("noProviders") })
						: null
				]
			});
		}

		// ── settings page (Plugins panel → this bundle) ───────────────────
		//
		// `plugins.bundle.config` is a KEYED slot: the plugin manager asks a
		// bundle for its configuration page by PACKAGE NAME and renders it above
		// the bundle's rows. The slot component branches on `props.view` before
		// any hook: `summary` is a plain string and `page` mounts SettingsPage.
		const SETTINGS_PATH = "/provider-usage/settings";
		const PROVIDER_FORMS = [
			{
				id: "opencode-go",
				nameKey: "provider.opencode-go",
				credentialKey: "opencodeGoApiKeyEnv",
				credentialDefault: "OPENCODE_GO_API_KEY",
				baseKey: "opencodeGoBaseUrl",
				baseDefault: "https://opencode.ai/zen/go",
				enabledKey: "opencodeGoEnabled",
				sourceKey: "opencodeGoSource",
				console: true
			},
			{
				id: "command-code",
				nameKey: "provider.command-code",
				credentialKey: "commandCodeApiKeyEnv",
				credentialDefault: "COMMANDCODE_API_KEY",
				baseKey: "commandCodeBaseUrl",
				baseDefault: "https://api.commandcode.ai",
				enabledKey: "commandCodeEnabled",
				authFileKey: "commandCodeAuthFile"
			},
			{
				id: "glm",
				nameKey: "provider.glm",
				credentialKey: "glmApiKeyEnv",
				credentialDefault: "ZAI_API_KEY",
				baseKey: "glmBaseUrl",
				baseDefault: "",
				enabledKey: "glmEnabled",
				regionKey: "glmRegion"
			}
		];

		function emptyForm() {
			return {
				opencodeGoEnabled: true,
				opencodeGoSource: "opencode-go",
				opencodeGoApiKeyEnv: "OPENCODE_GO_API_KEY",
				opencodeGoBaseUrl: "https://opencode.ai/zen/go",
				opencodeConsoleEnabled: true,
				opencodeConsoleApiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
				opencodeConsoleOrgId: "",
				opencodeConsoleAuthFile: "",
				opencodeConsoleDbFile: "",
				opencodeConsoleBaseUrl: "https://opencode.ai",
				commandCodeEnabled: true,
				commandCodeApiKeyEnv: "COMMANDCODE_API_KEY",
				commandCodeBaseUrl: "https://api.commandcode.ai",
				commandCodeAuthFile: "",
				glmEnabled: true,
				glmApiKeyEnv: "ZAI_API_KEY",
				glmBaseUrl: "",
				glmRegion: "auto",
				cacheMs: 30000,
				updateCheck: true,
				injectSessionHeader: true,
				defaultProvider: "auto"
			};
		}

		function formFromValue(value) {
			const form = emptyForm();
			if (value !== null && typeof value === "object") {
				for (const key of Object.keys(form)) {
					if (value[key] !== undefined) form[key] = value[key];
				}
				if (typeof form.cacheMs !== "number" || !Number.isFinite(form.cacheMs)) form.cacheMs = 30000;
			}
			return form;
		}

		/** Call one of this plugin's routes. */
		async function callApi(method, path, body) {
			const init = { method: method, cache: "no-store", credentials: "same-origin" };
			if (body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(body);
			}
			const res = await fetch(path, init);
			let payload = null;
			try {
				payload = await res.json();
			} catch (_error) {
				payload = null;
			}
			return { status: res.status, payload: payload };
		}

		// Inline styles on the DSH design tokens. Keeping them inline means the
		// page needs no extra CSS rule to be picked up.
		const PS = {
			wrap: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 8px" },
			card: {
				background: "var(--dsw-alias-bg-layer-3, #16181d)",
				border: "1px solid var(--dsw-alias-border-l2, #2a2d34)",
				borderRadius: 10,
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: 10
			},
			title: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e8e8e8)" },
			hint: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
			providerRow: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "10px 12px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2, #2a2d34)"
			},
			providerHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
			providerName: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #e8e8e8)" },
			status: { fontSize: 11, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, #8a8f98)", overflowWrap: "anywhere" },
			field: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
			fieldLabel: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
			input: {
				font: "inherit",
				fontSize: 12,
				color: "var(--dsw-alias-label-primary, #e8e8e8)",
				background: "var(--dsw-alias-bg-layer-2, #101216)",
				border: "1px solid var(--dsw-alias-border-l2, #2a2d34)",
				borderRadius: 7,
				padding: "6px 8px",
				minWidth: 0
			},
			row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
			checkbox: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary, #a8adb8)" },
			ok: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-success-primary, #5dbb76)" },
			warn: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-warn-primary, #d6a64b)" },
			err: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #e5484d)" },
			info: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
			button: {
				font: "inherit",
				cursor: "pointer",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, #a8adb8)",
				border: "1px solid var(--dsw-alias-border-l2, #2a2d34)",
				borderRadius: 8,
				padding: "6px 14px",
				fontSize: 12
			},
			buttonPrimary: {
				font: "inherit",
				cursor: "pointer",
				background: "var(--dsw-alias-label-primary, #0f1115)",
				color: "var(--dsw-alias-bg-layer-3, #ffffff)",
				border: "1px solid transparent",
				borderRadius: 8,
				padding: "7px 16px",
				fontSize: 12,
				fontWeight: 500
			},
			buttonDisabled: { opacity: 0.4, cursor: "not-allowed" }
		};

		function Field(props) {
			return react_jsx_runtime.jsx("label", {
				style: PS.field,
				children: [
					react_jsx_runtime.jsx("span", { style: PS.fieldLabel, children: props.label }),
					props.children
				]
			});
		}

		function StatusLine(props) {
			return react_jsx_runtime.jsx("div", {
				style: props.error ? PS.err : PS.status,
				children: props.children
			});
		}

		/**
		 * The configuration page itself. Mounted only for `view: "page"`.
		 *
		 * Mount → GET /provider-usage/settings → `phase: "ready"` with the
		 * redacted `value` and the non-network `detection` report. Save POSTs
		 * only the changed fields; 409 shows a reload hint, 503 explains the
		 * missing settings descriptor.
		 */
		function SettingsPage(props) {
			const t = translateFor(props);
			const [state, setState] = react.useState({ phase: "loading", revision: 0, value: {}, detection: null, error: null });
			const [form, setForm] = react.useState(emptyForm);
			const [busy, setBusy] = react.useState({ save: false, reload: false });
			const [message, setMessage] = react.useState(null);
			const tRef = react.useRef(t);
			tRef.current = t;

			const reload = react.useCallback(async (announce) => {
				const tt = tRef.current;
				try {
					const res = await callApi("GET", SETTINGS_PATH);
					const payload = res.payload;
					if (res.status === 200 && payload !== null) {
						const value = payload.value && typeof payload.value === "object" ? payload.value : {};
						setState({
							phase: "ready",
							revision: typeof payload.revision === "number" ? payload.revision : 0,
							value: value,
							detection: payload.detection && typeof payload.detection === "object" ? payload.detection : null,
							error: null
						});
						setForm(formFromValue(value));
						setMessage(announce === true ? { kind: "ok", text: tt("cfg.reloaded") } : null);
						return true;
					}
					const detail = (payload && (payload.error || payload.hint)) || "";
					setState((prev) => ({
						...prev,
						phase: "error",
						error: (res.status === 503 ? tt("cfg.unsupported") : tt("cfg.loadFailed", { error: "HTTP " + res.status })) + (detail === "" ? "" : " [" + detail + "]")
					}));
					return false;
				} catch (error) {
					setState((prev) => ({ ...prev, phase: "error", error: tt("cfg.loadFailed", { error: (error && error.message) || String(error) }) }));
					return false;
				}
			}, []);

			react.useEffect(() => {
				reload(false);
			}, [reload]);

			const update = (key, value) => {
				setForm((prev) => ({ ...prev, [key]: value }));
				setMessage(null);
			};

			const save = async () => {
				if (busy.save) return;
				const tt = tRef.current;
				const server = formFromValue(state.value || {});
				const patch = {};
				for (const key of Object.keys(form)) {
					if (form[key] !== server[key]) patch[key] = form[key];
				}
				if (Object.keys(patch).length === 0) {
					setMessage({ kind: "info", text: tt("cfg.noChanges") });
					return;
				}
				setBusy((b) => ({ ...b, save: true }));
				setMessage(null);
				try {
					const res = await callApi("POST", SETTINGS_PATH, { patch: patch, expectedRevision: state.revision });
					const payload = res.payload;
					if (res.status === 200 && payload !== null) {
						await reload(false);
						setMessage({ kind: "ok", text: tt("cfg.saved") });
					} else if (res.status === 409) {
						setMessage({ kind: "warn", text: tt("cfg.conflict") });
					} else {
						setMessage({ kind: "err", text: tt("cfg.saveFailed", { error: (payload && payload.error) || ("HTTP " + res.status) }) });
					}
				} catch (error) {
					setMessage({ kind: "err", text: tt("cfg.saveFailed", { error: (error && error.message) || String(error) }) });
				} finally {
					setBusy((b) => ({ ...b, save: false }));
				}
			};

			const onReload = async () => {
				if (busy.reload) return;
				setBusy((b) => ({ ...b, reload: true }));
				try {
					await reload(true);
				} finally {
					setBusy((b) => ({ ...b, reload: false }));
				}
			};

			if (state.phase === "loading") {
				return react_jsx_runtime.jsx("div", { style: PS.wrap, children: react_jsx_runtime.jsx("p", { style: PS.hint, children: t("cfg.loading") }) });
			}
			if (state.phase === "error") {
				return react_jsx_runtime.jsx("div", {
					style: PS.wrap,
					children: [
						react_jsx_runtime.jsx("p", { style: PS.err, children: state.error }),
						react_jsx_runtime.jsx("div", {
							style: PS.row,
							children: react_jsx_runtime.jsx("button", {
								style: busy.reload ? { ...PS.button, ...PS.buttonDisabled } : PS.button,
								disabled: busy.reload,
								onClick: onReload,
								children: t("cfg.retry")
							})
						})
					]
				});
			}

			const detection = state.detection && typeof state.detection === "object" ? state.detection : {};
			const detected = detection.providers && typeof detection.providers === "object" ? detection.providers : {};
			const disabled = busy.save || busy.reload;
			const server = formFromValue(state.value || {});
			const dirty = Object.keys(form).some((key) => form[key] !== server[key]);

			const providerCards = PROVIDER_FORMS.map((definition) => {
				const info = detected[definition.id] && typeof detected[definition.id] === "object" ? detected[definition.id] : {};
				const enabled = form[definition.enabledKey] !== false;
				const statusLines = [];
				statusLines.push(info.configured === true ? t("cfg.status.configured") : t("cfg.status.notConfigured"));
				statusLines.push(enabled ? t("cfg.status.enabled") : t("cfg.status.disabled"));
				if (typeof info.credentialRef === "string" && info.credentialRef !== "") statusLines.push(info.credentialRef);
				if (info.account && typeof info.account.name === "string" && info.account.name !== "") {
					statusLines.push(t("cfg.status.account") + ": " + info.account.name);
				}
				if (info.fallback && typeof info.fallback === "object") {
					statusLines.push(t("cfg.status.fallback") + ": " + reasonLabel(t, info.fallback.reason));
				}
				if (typeof info.error === "string" && info.error !== "") statusLines.push(info.error);

				const children = [
					react_jsx_runtime.jsx("div", {
						style: PS.providerHead,
						children: [
							react_jsx_runtime.jsx("span", { style: PS.providerName, children: t(definition.nameKey) }),
							react_jsx_runtime.jsx("label", {
								style: { ...PS.checkbox, marginLeft: "auto" },
								children: [
									react_jsx_runtime.jsx("input", {
										type: "checkbox",
										checked: enabled,
										disabled: disabled,
										onChange: (event) => update(definition.enabledKey, event.target.checked)
									}),
									t("cfg.enabled")
								]
							})
						]
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("cfg.credential"),
						children: react_jsx_runtime.jsx("input", {
							style: PS.input,
							type: "text",
							value: asText(form[definition.credentialKey]),
							disabled: disabled || !enabled,
							placeholder: definition.credentialDefault,
							onChange: (event) => update(definition.credentialKey, event.target.value)
						})
					})
				];

				if (definition.sourceKey !== undefined) {
					children.push(react_jsx_runtime.jsx(Field, {
						label: t("cfg.opencodeGoSource"),
						children: react_jsx_runtime.jsx("select", {
							style: PS.input,
							value: asText(form[definition.sourceKey]),
							disabled: disabled || !enabled,
							onChange: (event) => update(definition.sourceKey, event.target.value),
							children: [
								react_jsx_runtime.jsx("option", { value: "opencode-go", children: t("cfg.opencodeGoSource.opencode-go") }),
								react_jsx_runtime.jsx("option", { value: "builtin", children: t("cfg.opencodeGoSource.builtin") })
							]
						})
					}));
				}

				children.push(react_jsx_runtime.jsx(Field, {
					label: t("cfg.baseUrl"),
					children: react_jsx_runtime.jsx("input", {
						style: PS.input,
						type: "text",
						value: asText(form[definition.baseKey]),
						disabled: disabled || !enabled,
						placeholder: definition.baseDefault,
						onChange: (event) => update(definition.baseKey, event.target.value)
					})
				}));

				if (definition.console === true) {
					const consoleInfo = info.console && typeof info.console === "object" ? info.console : null;
					children.push(react_jsx_runtime.jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 4, borderTop: "1px dashed var(--dsw-alias-border-l2, #2a2d34)" },
						children: [
							react_jsx_runtime.jsx("div", { style: PS.fieldLabel, children: t("cfg.console") }),
							react_jsx_runtime.jsx("label", {
								style: PS.checkbox,
								children: [
									react_jsx_runtime.jsx("input", {
										type: "checkbox",
										checked: form.opencodeConsoleEnabled !== false,
										disabled: disabled || !enabled,
										onChange: (event) => update("opencodeConsoleEnabled", event.target.checked)
									}),
									t("cfg.console.enabled")
								]
							}),
							react_jsx_runtime.jsx(Field, {
								label: t("cfg.console.credential"),
								children: react_jsx_runtime.jsx("input", {
									style: PS.input,
									type: "text",
									value: asText(form.opencodeConsoleApiKeyEnv),
									disabled: disabled || !enabled || form.opencodeConsoleEnabled === false,
									placeholder: "OPENCODE_CONSOLE_TOKEN",
									onChange: (event) => update("opencodeConsoleApiKeyEnv", event.target.value)
								})
							}),
							react_jsx_runtime.jsx(Field, {
								label: t("cfg.console.orgId"),
								children: react_jsx_runtime.jsx("input", {
									style: PS.input,
									type: "text",
									value: asText(form.opencodeConsoleOrgId),
									disabled: disabled || !enabled || form.opencodeConsoleEnabled === false,
									placeholder: "org_...",
									onChange: (event) => update("opencodeConsoleOrgId", event.target.value)
								})
							}),
							react_jsx_runtime.jsx(Field, {
								label: t("cfg.console.authFile"),
								children: react_jsx_runtime.jsx("input", {
									style: PS.input,
									type: "text",
									value: asText(form.opencodeConsoleAuthFile),
									disabled: disabled || !enabled || form.opencodeConsoleEnabled === false,
									placeholder: "~/.local/share/opencode/auth.json",
									onChange: (event) => update("opencodeConsoleAuthFile", event.target.value)
								})
							}),
							react_jsx_runtime.jsx("p", { style: PS.hint, children: t("cfg.console.hint") }),
							consoleInfo === null ? null : react_jsx_runtime.jsx(StatusLine, {
								error: typeof consoleInfo.error === "string" && consoleInfo.error !== "",
								children: t("cfg.console.status") + ": " + (consoleInfo.configured === true ? t("cfg.status.configured") : t("cfg.status.notConfigured")) + (consoleInfo.source ? " · " + consoleInfo.source : "")
							})
						]
					}));
				}

				if (definition.authFileKey !== undefined) {
					children.push(react_jsx_runtime.jsx(Field, {
						label: t("cfg.authFile"),
						children: react_jsx_runtime.jsx("input", {
							style: PS.input,
							type: "text",
							value: asText(form[definition.authFileKey]),
							disabled: disabled || !enabled,
							placeholder: "~/.commandcode/auth.json",
							onChange: (event) => update(definition.authFileKey, event.target.value)
						})
					}));
				}

				if (definition.regionKey !== undefined) {
					children.push(react_jsx_runtime.jsx(Field, {
						label: t("cfg.region"),
						children: react_jsx_runtime.jsx("select", {
							style: PS.input,
							value: asText(form[definition.regionKey]),
							disabled: disabled || !enabled,
							onChange: (event) => update(definition.regionKey, event.target.value),
							children: ["auto", "zai", "bigmodel", "custom"].map((region) => react_jsx_runtime.jsx("option", {
								value: region,
								children: t("cfg.region." + region)
							}, region))
						})
					}));
				}

				children.push(react_jsx_runtime.jsx(StatusLine, {
					error: typeof info.error === "string" && info.error !== "",
					children: statusLines.join(" · ")
				}));

				return react_jsx_runtime.jsx("div", { style: PS.providerRow, children: children }, definition.id);
			});

			const messageStyle = message === null
				? PS.info
				: message.kind === "ok" ? PS.ok : message.kind === "warn" ? PS.warn : message.kind === "err" ? PS.err : PS.info;

			return react_jsx_runtime.jsx("div", {
				style: PS.wrap,
				children: [
					react_jsx_runtime.jsx("section", {
						style: PS.card,
						children: [
							react_jsx_runtime.jsx("div", { style: PS.title, children: t("cfg.title") }),
							react_jsx_runtime.jsx("p", { style: PS.hint, children: t("cfg.lead") }),
							react_jsx_runtime.jsx("div", { style: PS.title, children: t("cfg.providers") }),
							react_jsx_runtime.jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: 8 },
								children: providerCards
							})
						]
					}),
					react_jsx_runtime.jsx("section", {
						style: PS.card,
						children: [
							react_jsx_runtime.jsx("div", { style: PS.title, children: t("cfg.general") }),
							react_jsx_runtime.jsx(Field, {
								label: t("cfg.defaultProvider"),
								children: react_jsx_runtime.jsx("select", {
									style: PS.input,
									value: asText(form.defaultProvider),
									disabled: disabled,
									onChange: (event) => update("defaultProvider", event.target.value),
									children: [
										react_jsx_runtime.jsx("option", { value: "auto", children: t("cfg.defaultProvider.auto") }),
										...PROVIDER_META.map((provider) => react_jsx_runtime.jsx("option", {
											value: provider.id,
											children: t("provider." + provider.id)
										}, provider.id))
									]
								})
							}),
							react_jsx_runtime.jsx(Field, {
								label: t("cfg.cacheMs"),
								children: react_jsx_runtime.jsx("input", {
									style: PS.input,
									type: "number",
									min: 0,
									max: 3600000,
									value: asText(form.cacheMs),
									disabled: disabled,
									onChange: (event) => update("cacheMs", Number(event.target.value))
								})
							}),
							react_jsx_runtime.jsx("div", {
								style: PS.row,
								children: [
									react_jsx_runtime.jsx("label", {
										style: PS.checkbox,
										children: [
											react_jsx_runtime.jsx("input", {
												type: "checkbox",
												checked: form.updateCheck !== false,
												disabled: disabled,
												onChange: (event) => update("updateCheck", event.target.checked)
											}),
											t("cfg.updateCheck")
										]
									}),
									react_jsx_runtime.jsx("label", {
										style: PS.checkbox,
										children: [
											react_jsx_runtime.jsx("input", {
												type: "checkbox",
												checked: form.injectSessionHeader !== false,
												disabled: disabled,
												onChange: (event) => update("injectSessionHeader", event.target.checked)
											}),
											t("cfg.injectSessionHeader")
										]
									})
								]
							})
						]
					}),
					react_jsx_runtime.jsx("section", {
						style: PS.card,
						children: [
							react_jsx_runtime.jsx("div", {
								style: PS.row,
								children: [
									react_jsx_runtime.jsx("button", {
										style: disabled ? { ...PS.buttonPrimary, ...PS.buttonDisabled } : PS.buttonPrimary,
										disabled: disabled,
										onClick: save,
										children: busy.save ? t("cfg.saving") : t("cfg.save")
									}),
									react_jsx_runtime.jsx("button", {
										style: disabled ? { ...PS.button, ...PS.buttonDisabled } : PS.button,
										disabled: disabled,
										onClick: onReload,
										children: busy.reload ? t("cfg.reloading") : t("cfg.reload")
									}),
									dirty ? react_jsx_runtime.jsx("span", { style: PS.warn, children: t("cfg.unsaved") }) : null,
									react_jsx_runtime.jsx("span", {
										style: { ...PS.hint, marginLeft: "auto" },
										children: t("cfg.revision", { n: state.revision })
									})
								]
							}),
							message === null ? null : react_jsx_runtime.jsx("p", { style: messageStyle, children: message.text })
						]
					})
				]
			});
		}

		/** One-line description the panel may render as the bundle's summary. */
		const SUMMARY = "OpenCode GO / Command Code / GLM Code Plan 套餐用量:一个侧边栏组件、同源代理与 /provider-usage 命令。";

		/**
		 * The `plugins.bundle.config` occupant. The `view` branch is a component
		 * boundary on purpose: SettingsPage opens with hooks, so the summary —
		 * rendered as a plain string by the panel — must not pass through a
		 * hook-bearing parent.
		 */
		function BundleConfig(props) {
			if (props !== null && props !== undefined && props.view === "summary") {
				try {
					return translateFor(props)("cfg.summary");
				} catch (_error) {
					return SUMMARY;
				}
			}
			return react_jsx_runtime.jsx(SettingsPage, props && typeof props.t === "function" ? { t: props.t } : {});
		}

		// ── cordis plugin entry ──
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-multi-provider-usage: dictionaries");
			registerTurnUsageToast(ctx);
			const registerWidget = () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: PACKAGE_NAME,
				order: 0,
				label: "Provider usage",
				locale: NS
			}, Widget);
			const registerConfig = () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: CONFIG_KEY,
				locale: NS
			}, BundleConfig);
			// The settings page is additive: a host that predates the Plugins
			// panel (or a slots service without `inject`) must lose only this
			// page, never the widget.
			const registerConfigSafely = () => {
				try {
					registerConfig();
				} catch (_error) {
					// no plugins.bundle.config slot in this composition
				}
			};
			if (typeof ctx.slots.inject === "function") {
				ctx.slots.inject("sidebar.footer.action", registerWidget);
				try {
					ctx.slots.inject("plugins.bundle.config", registerConfigSafely);
				} catch (_error) {
					// older slots service: the widget alone still works
				}
			} else {
				ctx.effect(registerWidget, "dsh-multi-provider-usage: widget registration");
				ctx.effect(registerConfigSafely, "dsh-multi-provider-usage: settings page registration");
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.CONFIG_KEY = CONFIG_KEY;
		exports.SUMMARY = SUMMARY;
		exports.Widget = Widget;
		exports.BundleConfig = BundleConfig;
		exports.SettingsPage = SettingsPage;
		exports.usageProviderFor = usageProviderFor;
		exports.turnUsageStep = turnUsageStep;
		exports.balanceChangeFor = balanceChangeFor;
		exports.formatSignedMoney = formatSignedMoney;
		exports.createTurnUsageToast = createTurnUsageToast;
		return module.exports;
	}
});
