import { defineContentScript } from "wxt/sandbox";

const API_BRIDGE_SOURCE = "boss-auto-apply-api-bridge";

export default defineContentScript({
  matches: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    const page = window as typeof window & { __bossAutoApplyApiBridge?: boolean };
    if (page.__bossAutoApplyApiBridge) return;
    page.__bossAutoApplyApiBridge = true;

    const publish = (url: string, payload: unknown) => {
      window.postMessage({ source: API_BRIDGE_SOURCE, type: "response", url, payload }, "*");
    };

    const captureResponse = async (url: string, response: Response) => {
      if (!isLikelyJobApi(url)) return;
      try {
        publish(url, await response.clone().json());
      } catch {
        // 非 JSON 响应交给 DOM 兜底。
      }
    };

    const originalFetch = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const request = originalFetch.call(window, input, init);
      // 页面自身的请求可能因网络、登录状态或取消而失败；监听器不能把这个
      // rejected Promise 变成未捕获异常，否则 DevTools 会显示插件脚本报错。
      void request
        .then((response) => captureResponse(new URL(url, location.href).href, response))
        .catch(() => {
          // 保持页面原始 fetch 的失败语义，不向控制台额外抛出异常。
        });
      return request;
    }) as typeof window.fetch;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const callOpen = originalOpen as (this: XMLHttpRequest, method: string, url: string, async: boolean, username?: string | null, password?: string | null) => void;
    const requestUrls = new WeakMap<XMLHttpRequest, string>();

    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
      requestUrls.set(this, new URL(String(url), location.href).href);
      return callOpen.call(this, method, String(url), async, username, password);
    };

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      this.addEventListener("load", () => {
        const url = requestUrls.get(this) || "";
        if (!isLikelyJobApi(url)) return;
        try {
          publish(url, JSON.parse(this.responseText));
        } catch {
          // 非 JSON 响应交给 DOM 兜底。
        }
      }, { once: true });
      return originalSend.call(this, body);
    };
  },
});

function isLikelyJobApi(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    if (!/(^|\.)zhipin\.com$/i.test(parsed.hostname)) return false;
    return /api|wapi|ajax|job|geek|search|recommend/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}
