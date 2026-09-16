/** Opt-in local development probe; excluded from production builds. */
export function observeHubPerformance(viewport: HTMLElement, minimumVisible=25) {
  let raf = 0, count = 0, previous = 0;
  const intervals: number[] = [];
  const tick = (now: number) => {
    const bounds = viewport.getBoundingClientRect();
    const actors = [...viewport.querySelectorAll('.pixel-hub-actor')];
    const visible = actors.filter(actor => {
      const r = actor.getBoundingClientRect();
      return r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom && actor.querySelector('[data-pixel-state="ready"]');
    }).length;
    if (visible >= minimumVisible && !document.hidden) {
      if (count > 30) intervals.push(now - previous);
      count++;
      if (intervals.length === 300) {
        const sorted = [...intervals].sort((a, b) => a - b);
        console.info('E3_HUB_PERFORMANCE', JSON.stringify({ visible, frames: 300, fps: +(300000 / intervals.reduce((a,b)=>a+b,0)).toFixed(1), medianMs: +sorted[150].toFixed(2), p95Ms: +sorted[285].toFixed(2), viewport: [innerWidth, innerHeight] }));
        return;
      }
    } else { count = 0; intervals.length = 0; }
    previous = now; raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
