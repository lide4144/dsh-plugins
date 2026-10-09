/**
 * dsh-quota-readout — browser half (hand-written module-table bundle).
 *
 * Renders a compact quota readout into `conversation.composer.dock` (the band
 * under the composer card, beside the shipped stats line). Polls the host
 * half's `/dsh-quotas/quota` JSON route every 60 s; clicking the line forces
 * an upstream refresh. The status dot and (in the tooltip) per-window bars
 * turn yellow at >= 70% used and red at >= 90%.
 */
window.__ModuleLoader__.load({
  id: "dsh-quota-readout",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const ROUTE = "/dsh-quotas/quota";

    const CSS = [
      ".dsh-quota-line{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}",
      ".dsh-quota-line:hover{color:var(--dsw-alias-label-primary)}",
      ".dsh-quota-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}",
      ".dsh-quota-dot.warn{background:var(--dsw-alias-state-warn-primary)}",
      ".dsh-quota-dot.error{background:var(--dsw-alias-state-error-primary)}",
    ].join("\n");
    const CSS_TAG_ID = "dsh-quota-readout/client.css";

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-quota-readout";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function level(percent) {
      if (percent === null || percent === undefined) return "";
      return percent >= 90 ? "error" : percent >= 70 ? "warn" : "";
    }

    function fmtReset(iso) {
      if (!iso) return "";
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return "";
      const diff = t - Date.now();
      if (diff <= 0) return "已到期";
      const min = Math.round(diff / 60000);
      if (min < 60) return min + " 分钟后重置";
      const h = Math.floor(min / 60);
      if (h < 48) return h + " 小时后重置";
      return Math.floor(h / 24) + " 天后重置";
    }

    function fmtTime(iso) {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function tooltipOf(snap) {
      if (!snap || !snap.ok) return "点击重试";
      const lines = snap.items.map((it) =>
        it.label + " " + it.text + (it.detail ? "（" + it.detail + "）" : "") + (it.resetAt ? " · " + fmtReset(it.resetAt) : "")
      );
      lines.unshift((snap.plan || "模型额度") + " · provider: " + (snap.provider || "?") + (snap.model ? " · model: " + snap.model : ""));
      lines.push("点击刷新 · 更新于 " + fmtTime(snap.fetchedAt));
      return lines.join("\n");
    }

    function useQuota() {
      const snapState = React.useState(null);
      const tickState = React.useState(0);
      const snap = snapState[0];
      const setSnap = snapState[1];
      const tick = tickState[0];
      const setTick = tickState[1];
      React.useEffect(() => {
        let alive = true;
        fetch(ROUTE + (tick > 0 ? "?force=1" : ""), { cache: "no-store" })
          .then((res) => res.json())
          .then((s) => { if (alive) setSnap(s); })
          .catch((e) => { if (alive) setSnap({ ok: false, error: String(e), items: [] }); });
        const id = window.setInterval(() => setTick((n) => n + 1), 60000);
        return () => { alive = false; window.clearInterval(id); };
      }, [tick]);
      return { snap, refresh: () => setTick((n) => n + 1) };
    }

    function worstPercent(snap) {
      if (!snap || !snap.ok || !snap.items || snap.items.length === 0) return null;
      let worst = 0;
      for (const item of snap.items) {
        if (typeof item.percent === "number" && item.percent > worst) worst = item.percent;
      }
      return worst;
    }

    function QuotaLine() {
      const q = useQuota();
      const snap = q.snap;
      let text;
      if (!snap) {
        text = "额度查询中…";
      } else if (!snap.ok) {
        text = "额度不可用: " + (snap.error || "未知错误");
      } else {
        const parts = snap.items.map((it) => it.label + " " + it.text);
        text = (snap.model ? snap.model + " · " : "") + parts.join(" · ");
      }
      const dotClass = !snap ? "" : !snap.ok ? "error" : level(worstPercent(snap));
      return React.createElement("span", {
        className: "dsh-quota-line",
        title: tooltipOf(snap),
        onClick: () => q.refresh(),
      },
        React.createElement("span", { className: "dsh-quota-dot " + dotClass }),
        text);
    }

    /** Required client services: the slot registry the dock lives in. */
    const inject = ["slots"];

    function apply(ctx) {
      ensureStyles();
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "dsh-quota",
        order: 10,
        label: "API 额度",
      }, QuotaLine));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
