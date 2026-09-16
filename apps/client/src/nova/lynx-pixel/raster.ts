/** Pixel-preserving joint operations shared by every character surface. */
export type PixelKey = { sourceY: number; targetY: number; dx: number };
export function bendPixels(source: Uint8ClampedArray, keys: readonly PixelKey[]) {
  const output = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 0; y < 128; y++) {
    const i = keys.findIndex((key, i) => i < keys.length - 1 && y >= key.targetY && y <= keys[i + 1].targetY);
    if (i < 0) continue;
    const a = keys[i], b = keys[i + 1], t = (y - a.targetY) / (b.targetY - a.targetY);
    const sy = Math.round(a.sourceY + (b.sourceY - a.sourceY) * t), dx = a.dx + (b.dx - a.dx) * t;
    if (sy < 0 || sy >= 128) continue;
    for (let x = 0; x < 128; x++) {
      const sx = Math.round(x - dx); if (sx < 0 || sx >= 128) continue;
      const p = (sy * 128 + sx) * 4;
      if (source[p + 3]) output.set(source.subarray(p, p + 4), (y * 128 + x) * 4);
    }
  }
  return output;
}

export function largestPixelComponent(source: Uint8ClampedArray) {
  const seen = new Uint8Array(128 * 128); let largest: number[] = [];
  for (let i = 0; i < seen.length; i++) if (!seen[i] && source[i * 4 + 3]) {
    const group = [i]; seen[i] = 1;
    for (let j = 0; j < group.length; j++) {
      const p = group[j], x = p % 128, y = Math.floor(p / 128);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const tx = x + dx, ty = y + dy, n = ty * 128 + tx;
        if (tx < 0 || tx >= 128 || ty < 0 || ty >= 128 || seen[n] || !source[n * 4 + 3]) continue;
        seen[n] = 1; group.push(n);
      }
    }
    if (group.length > largest.length) largest = group;
  }
  const output = new Uint8ClampedArray(source.length);
  for (const p of largest) output.set(source.subarray(p * 4, p * 4 + 4), p * 4);
  return output;
}

/** Reconstruct concealed far-arm pixels from its same-view near-arm drawing.
 * The far wrist keeps its own original endpoint and every visible source pixel.
 * This is an underlay; it never replaces the far limb with a mirrored pose. */
export function completeFarArm(far: Uint8ClampedArray, near: Uint8ClampedArray, farShoulder: readonly number[], nearShoulder: readonly number[]) {
  const endpoint = (source: Uint8ClampedArray) => {
    let last = 0, sum = 0, count = 0;
    for (let y = 60; y < 108; y++) for (let x = 0; x < 128; x++) if (source[(y * 128 + x) * 4 + 3]) last = y;
    for (let y = last - 2; y <= last; y++) for (let x = 0; x < 128; x++) if (source[(y * 128 + x) * 4 + 3]) { sum += x; count++; }
    return { x: sum / Math.max(1, count), y: last, count };
  };
  const end = endpoint(far), nearEnd = endpoint(near);
  if (!end.count || !nearEnd.count || end.y <= farShoulder[1]) return far;
  const output = new Uint8ClampedArray(far.length);
  for (let y = Math.floor(farShoulder[1]); y <= end.y; y++) {
    const t = (y - farShoulder[1]) / (end.y - farShoulder[1]);
    const sy = Math.round(nearShoulder[1] + (nearEnd.y - nearShoulder[1]) * t);
    const nearCenter = nearShoulder[0] + (nearEnd.x - nearShoulder[0]) * t;
    const center = farShoulder[0] + (end.x - farShoulder[0]) * t;
    for (let x = 0; x < 128; x++) {
      const sx = Math.round(nearCenter + (x - center) / .82);
      if (sx < 0 || sx >= 128) continue;
      const p = (sy * 128 + sx) * 4;
      if (near[p + 3]) output.set(near.subarray(p, p + 4), (y * 128 + x) * 4);
    }
  }
  for (let p = 0; p < far.length; p += 4) if (far[p + 3]) output.set(far.subarray(p, p + 4), p);
  return output;
}

export const torsoEnvelopes = [
  [[60,55,76],[70,51,78],[85,48,79],[93,48,79],[98,58,70]],
  [[60,50,72],[70,44,76],[83,47,78],[93,53,80],[98,59,74]],
  [[60,53,68],[70,49,75],[85,47,75],[93,47,75],[98,56,70]],
  [[60,54,73],[70,52,75],[85,50,78],[93,49,79],[98,58,71]],
  [[60,54,78],[70,52,79],[85,49,80],[93,49,80],[98,58,71]],
  [[60,53,77],[70,51,76],[85,49,76],[93,48,76],[98,56,68]],
  [[60,57,75],[70,54,78],[85,54,79],[93,54,79],[98,59,72]],
  [[60,55,78],[70,61,84],[78,59,82],[90,57,79],[94,57,77],[98,59,71]],
] as const;
