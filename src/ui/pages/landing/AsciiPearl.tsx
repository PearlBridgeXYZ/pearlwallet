import { useEffect, useRef } from "react";

/** Decorative only: Lambert diffuse + a soft Blinn highlight on a sphere.
 * Adjacent glyphs crossfade along one density ramp to avoid contour bands. */
export default function AsciiPearl() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ramp = ".:;+x#@";
    let width = 0;
    let height = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let phase = 0;

    function draw() {
      if (!canvas || !context || document.hidden) return;
      context.clearRect(0, 0, width, height);
      const mobile = width < 760;
      const radius = mobile ? Math.min(width * .43, height * .25) : Math.min(width * .245, height * .37);
      const cx = width * (mobile ? .5 : .735);
      const cy = height * (mobile ? .245 : .47);
      const cellX = mobile ? 6 : 7;
      const cellY = mobile ? 9 : 10;
      context.font = `${mobile ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = getComputedStyle(canvas).color;
      // A slow drift gives a faint pearlescent shimmer, without moving the grid.
      const lx = -.5 + Math.sin(phase) * .035;
      const ly = -.55 + Math.cos(phase) * .025;
      const lz = Math.sqrt(1 - lx * lx - ly * ly);
      // Half-vector between the light and viewer (0, 0, 1).
      const halfLength = Math.hypot(lx, ly, lz + 1);
      const hx = lx / halfLength;
      const hy = ly / halfLength;
      const hz = (lz + 1) / halfLength;

      // A faint, soft contact shadow anchors the sphere to the paper.
      for (let y = cy + radius; y < cy + radius * 1.2; y += cellY) {
        for (let x = cx - radius * .85; x < cx + radius * .85; x += cellX) {
          const sx = (x - cx) / (radius * .48);
          const sy = (y - cy - radius * 1.08) / (radius * .055);
          context.globalAlpha = .14 * Math.exp(-2 * (sx * sx + sy * sy));
          context.fillText(".", x, y);
        }
      }
      for (let y = Math.max(cellY / 2, cy - radius); y < Math.min(height, cy + radius); y += cellY) {
        for (let x = Math.max(cellX / 2, cx - radius); x < Math.min(width, cx + radius); x += cellX) {
          const nx = (x - cx) / radius;
          const ny = (y - cy) / radius;
          const r2 = nx * nx + ny * ny;
          if (r2 >= 1) continue;
          const nz = Math.sqrt(1 - r2);
          const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
          const specular = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 18);
          const limb = Math.pow(1 - nz, 3);
          // Paper is light: lower illumination means denser ink. Even the
          // specular peak contains dots, never a punched-out blank disc.
          const density = .8 - .53 * diffuse - .2 * specular + .1 * limb;
          // Fixed, sub-glyph dithering softens the remaining character contours;
          // it does not flicker or form moving noise as the light drifts.
          const seed = Math.sin(Math.floor(x / cellX) * 127.1 + Math.floor(y / cellY) * 311.7) * 43758.5453;
          const texture = (seed - Math.floor(seed) - .5) * .5;
          const position = Math.max(0, Math.min(ramp.length - 1, density * (ramp.length - 1) + texture));
          const lower = Math.floor(position);
          const blend = position - lower;
          const opacity = (.42 + density * .4) * Math.min(1, (1 - r2) * 40);
          context.globalAlpha = opacity * (1 - blend);
          context.fillText(ramp[lower], x, y);
          if (blend > 0) {
            context.globalAlpha = opacity * blend;
            context.fillText(ramp[Math.min(lower + 1, ramp.length - 1)], x, y);
          }
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
