import { useEffect, useRef } from "react";

/** Decorative only: a diffuse sphere with a broad upper-left specular light.
 * Character density supplies the shading; no noise or per-cell randomness. */
export default function AsciiPearl() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ramp = " .:-=+x#";
    let width = 0;
    let height = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let phase = 0;

    function draw() {
      if (!canvas || !context || document.hidden) return;
      context.clearRect(0, 0, width, height);
      const mobile = width < 760;
      const radius = mobile ? Math.min(width * .66, height * .43) : Math.min(width * .28, height * .39);
      const cx = width * (mobile ? .68 : .74);
      const cy = height * (mobile ? .39 : .49);
      const cellX = mobile ? 6 : 7;
      const cellY = mobile ? 9 : 10;
      context.font = `${mobile ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = getComputedStyle(canvas).color;
      // A slow, tiny light shift lets the pearl breathe without rotating texture.
      const lx = -.43 + Math.sin(phase) * .025;
      const ly = -.48 + Math.cos(phase) * .02;
      const lz = Math.sqrt(1 - lx * lx - ly * ly);
      for (let y = Math.max(cellY / 2, cy - radius); y < Math.min(height, cy + radius); y += cellY) {
        for (let x = Math.max(cellX / 2, cx - radius); x < Math.min(width, cx + radius); x += cellX) {
          const nx = (x - cx) / radius;
          const ny = (y - cy) / radius;
          const r2 = nx * nx + ny * ny;
          if (r2 >= 1) continue;
          const nz = Math.sqrt(1 - r2);
          const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
          const highlight = Math.exp(-((nx + .29) ** 2 + (ny + .33) ** 2) / .065);
          const rim = Math.pow(1 - nz, 4) * .23;
          const shade = Math.max(.03, Math.min(1, .88 - .63 * diffuse - .42 * highlight - rim));
          const char = ramp[Math.min(ramp.length - 1, Math.floor(shade * ramp.length))];
          context.globalAlpha = (.24 + shade * .55) * Math.min(1, (1 - r2) * 28);
          context.fillText(char, x, y);
        }
      }
      context.globalAlpha = 1;
    }

    function tick() {
      draw();
      phase += .007;
      // 50 ms after each completed frame: never more than 20 frames/second.
      timer = setTimeout(tick, 50);
    }

    function resume() {
      clearTimeout(timer);
      if (document.hidden) return;
      if (motion.matches) draw();
      else tick();
    }

    function resize() {
      if (!canvas || !context) return;
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      resume();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    motion.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    resize();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      motion.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  return <canvas ref={ref} className="ascii-pearl" aria-hidden="true" />;
}
