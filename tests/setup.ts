// jsdom 默认无 matchMedia/IntersectionObserver；按需补桩。
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null });
}
