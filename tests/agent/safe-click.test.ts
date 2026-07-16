import { describe, it, expect } from "vitest";
import { clickWithoutScriptNavigation } from "../../src/agent/safe-click";

describe("clickWithoutScriptNavigation", () => {
  it("preserves the page click handler while blocking javascript URL navigation", () => {
    document.body.innerHTML = `<a id="close" href="javascript:void(0)"><button id="button">关闭</button></a>`;
    const anchor = document.getElementById("close")!;
    const button = document.getElementById("button")!;
    let handled = false;
    let defaultWasPrevented = false;
    anchor.addEventListener("click", event => {
      handled = true;
      defaultWasPrevented = event.defaultPrevented;
    });

    clickWithoutScriptNavigation(button);

    expect(handled).toBe(true);
    expect(defaultWasPrevented).toBe(true);
  });
});
