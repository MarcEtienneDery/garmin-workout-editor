/*
 * Loaded into every page the recorder (record.ts) drives, before the page's own scripts: headless Chrome draws no pointer, so
 * this draws one. An arrow follows the mouse, a ring shows where it clicks, a white dot where a finger taps. Plain JavaScript,
 * passed to the page as it is.
 */
(() => {
  const add = () => {
    if (document.getElementById("demo-pointer")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-pointer { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647; pointer-events: none; transform: translate(-100px, -100px); }
      #demo-pointer.touch { display: none; }
      .demo-ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 3px solid rgba(255, 196, 0, .95); animation: demo-ring .45s ease-out forwards; }
      .demo-ring.touch { background: rgba(255, 255, 255, .35); border-color: rgba(255, 255, 255, .9); width: 44px; height: 44px; margin: -22px 0 0 -22px; }
      @keyframes demo-ring { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }`;
    document.head.appendChild(style);
    const arrow = document.createElement("div");
    arrow.id = "demo-pointer";
    arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.7 L9.6 13 L15.5 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    if (navigator.maxTouchPoints > 0) arrow.classList.add("touch");
    document.body.appendChild(arrow);
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") arrow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }, true);
    document.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") arrow.classList.add("touch");
      const ring = document.createElement("div");
      ring.className = e.pointerType === "mouse" ? "demo-ring" : "demo-ring touch";
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 500);
    }, true);
  };
  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add);
})();
