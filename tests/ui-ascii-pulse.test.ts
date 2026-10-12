import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AsciiPulse from "../src/ui/components/AsciiPulse";

afterEach(() => vi.unstubAllGlobals());

describe("decorative transaction pearl", () => {
  function render(reduced: boolean, receipt?: { id: string; createdAt: number }) {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
    return renderToStaticMarkup(createElement(AsciiPulse, { receipt }));
  }

  it("renders an aria-hidden pearl with no controls", () => {
    const html = render(false);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-phase="playing"');
    expect(html).toContain('class="ascii-pulse-pearl"');
    expect(html).not.toMatch(/button|tabindex|role=|canvas/);
  });

  it("renders the final static frame for reduced motion", () => {
    const html = render(true);
    expect(html).toContain('data-phase="settled"');
    expect(html).not.toContain('data-phase="playing"');
    const frame = (markup: string) => markup.match(/<pre class="ascii-pulse-pearl">(.*?)<\/pre>/s)?.[1];
    expect(frame(html)).toBeTruthy();
    expect(frame(html)).toEqual(frame(render(false)));
  });

  it("keeps historical bridge receipts static", () => {
    expect(render(false, { id: "old-crossing", createdAt: 0 })).toContain('data-phase="settled"');
    expect(render(false, { id: "new-crossing", createdAt: Date.now() })).toContain('data-phase="playing"');
  });
});
