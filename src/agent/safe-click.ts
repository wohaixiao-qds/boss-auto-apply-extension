/**
 * 点击页面控件但阻止 javascript: 链接的默认导航。
 *
 * BOSS 的弹窗关闭/留在当前页控件有时是 <a href="javascript:...">。
 * 直接调用 click() 会触发页面 CSP，导致 javascript: URL 被浏览器拦截。
 * 只阻止默认导航，不阻止站点自身的 click handler，保证页面逻辑仍然执行。
 */
export function clickWithoutScriptNavigation(element: HTMLElement): void {
  const anchor = element.closest("a");
  const href = anchor?.getAttribute("href") || "";
  if (!anchor || !/^\s*javascript:/i.test(href)) {
    element.click();
    return;
  }

  const preventScriptNavigation = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (target === anchor) event.preventDefault();
  };
  document.addEventListener("click", preventScriptNavigation, true);
  try {
    element.click();
  } finally {
    document.removeEventListener("click", preventScriptNavigation, true);
  }
}
