// Greedy decomposition of a boolean tile mask into disjoint rectangles.
//
// The generator works on a tile grid, but drawing one box per tile would mean
// tens of thousands of boxes per floor. Merging runs of tiles into maximal
// rectangles first cuts that to a couple of hundred — few enough that the whole
// floor batches into a handful of draw calls, and few enough to use directly as
// player collision AABBs.

// Returns rects as { x0, y0, x1, y1 } with exclusive maxima, in tile units.
// `test(value)` decides which tile values belong to the mask.
export function maskToRects(mask, W, H, test) {
  const used = new Uint8Array(W * H);
  const rects = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (used[i] || !test(mask[i])) continue;

      // Grow right along this row as far as the mask holds.
      let x1 = x;
      while (x1 + 1 < W && !used[y * W + x1 + 1] && test(mask[y * W + x1 + 1])) x1++;

      // Then grow down, but only while the whole span still matches.
      let y1 = y;
      grow: while (y1 + 1 < H) {
        const yy = y1 + 1;
        for (let xx = x; xx <= x1; xx++) {
          const j = yy * W + xx;
          if (used[j] || !test(mask[j])) break grow;
        }
        y1 = yy;
      }

      for (let yy = y; yy <= y1; yy++) {
        for (let xx = x; xx <= x1; xx++) used[yy * W + xx] = 1;
      }
      rects.push({ x0: x, y0: y, x1: x1 + 1, y1: y1 + 1 });
    }
  }

  return rects;
}
